import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Webhook } from 'standardwebhooks';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { EVENT, LIMITS, VERSION, type Principal } from '../contracts.js';
import { Relay } from '../relay.js';
import { Store } from '../store.js';
import { callbackUrl, publicAddress, sendPublic, signingKey, type Send } from '../webhook.js';
import { createRelayServer, jwtAuth } from '../server.js';

const owner: Principal = { subject: 'alice', scopes: ['agentdeck:read', 'agentdeck:report', 'agentdeck:subscribe', 'agentdeck:device'] };
const other: Principal = { ...owner, subject: 'bob' };
const secret = `whsec_${randomBytes(32).toString('base64')}`;
const subscribe = (overrides: Record<string, unknown> = {}) => ({ name: EVENT, arguments: { integrationId: 'desk' },
  delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret }, cursor: null, ...overrides });
const echo: Send = async (_url, body) => ({ status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) });
let dir: string, path: string, store: Store, relay: Relay, now: number;
let send: ReturnType<typeof vi.fn<Send>>;
const requestInput = () => ({ integrationId: 'desk', idempotencyKey: 'press-1', context: 'AgentDeck: reviewing tests', capturedAt: now });
async function call(name: string, args: object, p = owner) {
  return await relay.rpc(p, 'tools/call', { name, arguments: args }) as { isError?: boolean; structuredContent: any; content: any[] };
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dot-relay-')); path = join(dir, 'state.json');
  store = new Store(path); now = Date.now(); send = vi.fn(echo);
  relay = new Relay(store, send, () => now);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('Dot event and report contracts', () => {
  it('discovers the exact experimental version, event and scoped tools', async () => {
    expect(await relay.rpc(owner, 'server/discover')).toMatchObject({ supportedVersions: [VERSION], capabilities: { events: {} } });
    expect(await relay.rpc(owner, 'events/list')).toMatchObject({ events: [{ name: EVENT, delivery: ['webhook'] }] });
    const readOnly = { ...owner, scopes: ['agentdeck:read'] };
    expect((await relay.rpc(readOnly, 'tools/list') as any).tools.map((t: any) => t.name)).toEqual(['get_request', 'get_context']);
    await expect(relay.rpc(readOnly, 'events/list')).rejects.toThrow('scope');
    await expect(relay.rpc(owner, 'events/subscribe', subscribe({ arguments: { integrationId: 'desk', accountId: 'bob' } }))).rejects.toThrow('schema');
    await expect(relay.rpc(owner, 'events/subscribe', subscribe({ cursor: 'invented-replay' }))).rejects.toThrow('schema');
  });

  it('requires signed challenge success, persists one idempotent subscription and honors finite TTL', async () => {
    const first = await relay.rpc(owner, 'events/subscribe', subscribe({ ttlMs: 2000 })) as any;
    expect(first).toMatchObject({ cursor: null, truncated: false });
    const [, body, hdr] = send.mock.calls[0];
    expect(new Webhook(secret).verify(body, hdr)).toMatchObject({ type: 'verification' });
    now += 100;
    const again = await relay.rpc(owner, 'events/subscribe', subscribe({ ttlMs: 1000 })) as any;
    expect(first.id).toBe(again.id); expect(send).toHaveBeenCalledTimes(1);
    expect(Date.parse(again.refreshBefore)).toBe(now + 1000);
    expect(store.read().subscriptions).toHaveLength(1);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    now += 1001;
    expect(() => relay.create(owner, requestInput())).toThrow('No active subscription');
  });

  it('does not activate invalid callbacks or allow a conflicting primary subscription', async () => {
    send.mockResolvedValueOnce({ status: 200, body: '{"challenge":"wrong"}' });
    await expect(relay.rpc(owner, 'events/subscribe', subscribe())).rejects.toMatchObject({ code: -32015, reason: 'challenge_failed' });
    expect(store.read().subscriptions).toEqual([]);
    await relay.rpc(owner, 'events/subscribe', subscribe());
    await expect(relay.rpc(owner, 'events/subscribe', subscribe({ delivery: { mode: 'webhook', url: 'https://receiver.example/other', secret } }))).rejects.toThrow('primary');
  });

  it('reverifies after bounded verification cache expires and dual-signs a secret rotation', async () => {
    await relay.rpc(owner, 'events/subscribe', subscribe());
    now += LIMITS.rotationMs + 1;
    await relay.rpc(owner, 'events/subscribe', subscribe());
    expect(send).toHaveBeenCalledTimes(2);
    now = Date.now(); // Cryptographic verification below uses the verifier's real wall clock.
    const replacement = `whsec_${randomBytes(32).toString('base64')}`;
    await relay.rpc(owner, 'events/subscribe', subscribe({ delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret: replacement } }));
    relay.create(owner, requestInput()); await relay.deliver();
    const [, body, hdr] = send.mock.calls.at(-1)!;
    expect(new Webhook(secret).verify(body, hdr)).toMatchObject({ name: EVENT });
    expect(new Webhook(replacement).verify(body, hdr)).toMatchObject({ name: EVENT });
  });

  it('recovers durable pending delivery after restart without manufacturing a report', async () => {
    await relay.rpc(owner, 'events/subscribe', subscribe());
    const r = relay.create(owner, requestInput());
    expect(() => new Store(path)).toThrow();
    store.close(); store = new Store(path); relay = new Relay(store, send, () => now);
    await relay.deliver();
    const result = relay.get(owner, r.requestId);
    expect(result).toMatchObject({ delivery: 'accepted', report: null, claim: null });
    const [, bytes, hdr] = send.mock.calls.at(-1)!;
    const event = new Webhook(secret).verify(bytes, hdr) as any;
    expect(event.data.requestId).toBe(r.requestId);
    expect(bytes).not.toContain('reviewing tests');
  });

  it('deduplicates button presses and rejects a reused key with different input', async () => {
    await relay.rpc(owner, 'events/subscribe', subscribe());
    const a = requestInput(); const first = relay.create(owner, a);
    expect(relay.create(owner, a)).toEqual(first);
    expect(() => relay.create(owner, { ...a, context: 'changed' })).toThrow('Idempotency');
    expect(store.read().requests).toHaveLength(1);
  });

  it('retries transient and uncertain receipts with the same event ID and body', async () => {
    await relay.rpc(owner, 'events/subscribe', subscribe());
    const r = relay.create(owner, requestInput());
    send.mockRejectedValueOnce(new Error('timeout'));
    await relay.deliver(); expect(relay.get(owner, r.requestId).delivery).toBe('pending');
    const first = send.mock.calls.at(-1)!;
    now += 5000; await relay.deliver();
    const second = send.mock.calls.at(-1)!;
    expect(second[1]).toBe(first[1]);
    expect(second[2]['webhook-id']).toBe(first[2]['webhook-id']);
    expect(second[2]['webhook-signature']).not.toBe(first[2]['webhook-signature']);
    expect(relay.get(owner, r.requestId)).toMatchObject({ delivery: 'accepted', attempts: 2 });
  });

  it.each([410, 413, 302, 401])('does not retry permanent response %s', async status => {
    await relay.rpc(owner, 'events/subscribe', subscribe());
    const r = relay.create(owner, requestInput()); send.mockResolvedValueOnce({ status, body: '' });
    await relay.deliver(); now += 60_000; await relay.deliver();
    expect(relay.get(owner, r.requestId).delivery).toBe('failed');
    expect(send).toHaveBeenCalledTimes(2);
    expect(store.read().subscriptions).toHaveLength(status === 410 ? 0 : 1);
  });

  it('bounds transient retries and never delivers an expired request', async () => {
    await relay.rpc(owner, 'events/subscribe', subscribe());
    const r = relay.create(owner, requestInput()); send.mockResolvedValue({ status: 503, body: '' });
    for (let i = 0; i < 9; i++) { await relay.deliver(); now += 65_000; }
    expect(relay.get(owner, r.requestId)).toMatchObject({ attempts: LIMITS.attempts, delivery: 'failed' });
    const expired = relay.create(owner, { ...requestInput(), idempotencyKey: 'next' });
    now += LIMITS.requestMs; await relay.deliver();
    expect(relay.get(owner, expired.requestId).delivery).toBe('expired');
  });

  it('cancels queued deliveries on unsubscribe; repeat unsubscribe is harmless', async () => {
    await relay.rpc(owner, 'events/subscribe', subscribe());
    const r = relay.create(owner, requestInput());
    const params = { name: EVENT, arguments: { integrationId: 'desk' }, delivery: { mode: 'webhook', url: 'https://receiver.example/callback' } };
    await relay.rpc(owner, 'events/unsubscribe', params); await relay.rpc(owner, 'events/unsubscribe', params);
    await relay.deliver(); expect(send).toHaveBeenCalledTimes(1);
    expect(relay.get(owner, r.requestId).delivery).toBe('cancelled');
  });

  it('isolates accounts and revokes data and pending sends durably', async () => {
    await relay.rpc(owner, 'events/subscribe', subscribe());
    const r = relay.create(owner, requestInput());
    expect(() => relay.get(other, r.requestId)).toThrow('not found');
    expect((await call('get_context', { requestId: r.requestId }, other)).isError).toBe(true);
    relay.revoke(owner); await relay.deliver(); expect(send).toHaveBeenCalledTimes(1);
    store.close(); store = new Store(path); relay = new Relay(store, send, () => now);
    await expect(relay.rpc(owner, 'events/list')).rejects.toThrow('revoked');
    expect(readFileSync(path, 'utf8')).not.toContain('reviewing tests');
  });

  it('claims once and rejects conflicting, reversed and terminal-overwriting reports', async () => {
    await relay.rpc(owner, 'events/subscribe', subscribe());
    const r = relay.create(owner, requestInput());
    const claim = { requestId: r.requestId, idempotencyKey: 'claim' };
    const a = (await call('claim_request', claim)).structuredContent;
    expect((await call('claim_request', claim)).structuredContent).toEqual(a);
    expect((await call('claim_request', { ...claim, idempotencyKey: 'competitor' })).isError).toBe(true);
    const update = { requestId: r.requestId, attemptId: a.attemptId, idempotencyKey: 'report', sequence: 2, state: 'completed', summary: 'Tests reviewed.' };
    expect((await call('report_update', update)).structuredContent.accepted).toBe(true);
    expect((await call('report_update', update)).structuredContent.accepted).toBe(true);
    expect((await call('report_update', { ...update, summary: 'Changed' })).isError).toBe(true);
    expect((await call('report_update', { ...update, sequence: 1, idempotencyKey: 'old' })).isError).toBe(true);
    expect((await call('report_update', { ...update, sequence: 3, state: 'working', idempotencyKey: 'new' })).isError).toBe(true);
    expect(store.read().requests).toHaveLength(1); // A report never creates a new wake event.
  });

  it('does not automatically reclaim a silent attempt', async () => {
    await relay.rpc(owner, 'events/subscribe', subscribe()); const r = relay.create(owner, requestInput());
    const a = (await call('claim_request', { requestId: r.requestId, idempotencyKey: 'claim' })).structuredContent;
    now += LIMITS.claimMs + 1;
    expect((await call('claim_request', { requestId: r.requestId, idempotencyKey: 'other' })).isError).toBe(true);
    expect((await call('report_update', { requestId: r.requestId, attemptId: a.attemptId, idempotencyKey: 'late', sequence: 1, state: 'completed', summary: 'late' })).isError).toBe(true);
  });

  it('fails closed on corrupt store data without retaining its lock', () => {
    store.close(); writeFileSync(path, '{broken');
    expect(() => new Store(path)).toThrow();
    writeFileSync(path, JSON.stringify({ version: 1, subscriptions: [], requests: [], revoked: [] }));
    store = new Store(path);
  });
});

describe('callback network boundary', () => {
  it.each(['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1'])('rejects non-public %s', ip => {
    expect(publicAddress(ip)).toBe(false);
  });
  it('accepts globally routable addresses but rejects redirect/credential URL tricks', async () => {
    expect(publicAddress('8.8.8.8')).toBe(true); expect(publicAddress('2606:4700::1111')).toBe(true);
    for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com:9120', 'https://example.com/#secret']) {
      expect(() => callbackUrl(url)).toThrow();
    }
    await expect(sendPublic('https://127.0.0.1/', '{}', {})).rejects.toThrow('Non-public');
    for (const key of ['secret', 'whsec_AA==', `whsec_${randomBytes(65).toString('base64')}`]) expect(() => signingKey(key)).toThrow();
  });
});

describe('authenticated HTTP round trip', () => {
  it('bounds stateless transport methods, versions and notification handling', async () => {
    const server = createRelayServer(relay, async () => owner, 'https://relay.example', 'https://issuer.example');
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
    const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
    const post = (data: unknown, extra = {}) => fetch(base, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(data) });
    try {
      for (const method of ['GET', 'DELETE']) {
        const response = await fetch(base, { method, headers });
        expect(response.status).toBe(405); expect(response.headers.get('allow')).toBe('POST');
      }
      expect((await fetch(base)).status).toBe(401);
      const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      expect(initialized.status).toBe(202); expect(await initialized.text()).toBe('');
      expect((await post({ jsonrpc: '2.0', method: 'tools/call', params: {} })).status).toBe(400);
      expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': '2099-01-01' })).status).toBe(400);
      expect(await (await post({ jsonrpc: '2.0', id: 1, method: 'events/list' }, { 'MCP-Protocol-Version': '2025-11-25' })).json())
        .toMatchObject({ error: { code: -32601 } });
      expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://attacker.example' })).status).toBe(403);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('uses real JWT verification and real loopback HTTP for ten correlated mock-receiver requests', async () => {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey); jwk.kid = 'pilot';
    const issuer = 'https://issuer.example', resource = 'https://relay.example';
    const auth = jwtAuth(issuer, resource, createLocalJWKSet({ keys: [jwk] }));
    const token = await new SignJWT({ scope: owner.scopes.join(' ') }).setProtectedHeader({ alg: 'ES256', kid: 'pilot' })
      .setIssuer(issuer).setAudience(resource).setSubject(owner.subject).setExpirationTime('5m').sign(privateKey);
    const wrong = await new SignJWT({ scope: owner.scopes.join(' ') }).setProtectedHeader({ alg: 'ES256', kid: 'pilot' })
      .setIssuer(issuer).setAudience('https://another.example').setSubject(owner.subject).setExpirationTime('5m').sign(privateKey);
    await expect(auth(wrong)).rejects.toThrow();
    const server = createRelayServer(relay, auth, resource, issuer);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number }; const base = `http://127.0.0.1:${address.port}`;
    const post = (url: string, data: object, bearer = token) => fetch(base + url, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const rpc = async (method: string, params = {}) => (await (await post('/mcp', { jsonrpc: '2.0', id: 1, method, params })).json()) as any;
    try {
      expect((await post('/mcp', {}, wrong)).status).toBe(401);
      expect((await fetch(base + '/experiment/requests')).status).toBe(401);
      expect((await (await fetch(base + '/.well-known/oauth-protected-resource')).json()) as any).toMatchObject({ resource });
      expect((await rpc('server/discover')).result.supportedVersions).toEqual([VERSION]);
      expect((await rpc('events/subscribe', subscribe())).error).toBeUndefined();
      const client = new Client({ name: 'agentdeck-interop-test', version: '0.0.0' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }));
        expect(client.getServerCapabilities()).toEqual({ tools: {} });
        expect(client.getInstructions()).toContain('claim_request');
        expect((await client.listTools()).tools).toHaveLength(5);
        await client.ping();
        const r = relay.create(owner, { ...requestInput(), idempotencyKey: 'sdk-request' });
        await relay.deliver();
        expect((await client.callTool({ name: 'get_request', arguments: { requestId: r.requestId } })).structuredContent)
          .toMatchObject({ requestId: r.requestId, expired: false });
        expect((await client.callTool({ name: 'get_context', arguments: { requestId: r.requestId } })).structuredContent)
          .toMatchObject({ context: requestInput().context });
        const claim = await client.callTool({ name: 'claim_request', arguments: { requestId: r.requestId, idempotencyKey: 'sdk-claim' } });
        expect((await client.callTool({ name: 'report_interaction', arguments: { requestId: r.requestId,
          attemptId: claim.structuredContent!.attemptId, relationId: 'sdk-edge', sequence: 1, idempotencyKey: 'sdk-edge-1',
          kind: 'message', direction: 'agent_to_dot', stage: 'delivered', targetRef: null, summary: 'Message received' } })).structuredContent)
          .toMatchObject({ accepted: true, sequence: 1 });
        expect((await client.callTool({ name: 'report_update', arguments: { requestId: r.requestId,
          attemptId: claim.structuredContent!.attemptId, sequence: 1, idempotencyKey: 'sdk-done', state: 'completed', summary: 'SDK briefing' } })).structuredContent)
          .toMatchObject({ accepted: true });
      } finally { await client.close(); }

      for (let i = 0; i < 10; i++) {
        const r = await (await post('/experiment/requests', { ...requestInput(), idempotencyKey: `press-${i}` })).json() as any;
        await relay.deliver();
        const event = new Webhook(secret).verify(send.mock.calls.at(-1)![1], send.mock.calls.at(-1)![2]) as any;
        expect(event.data.requestId).toBe(r.requestId);
        const got = await rpc('tools/call', { name: 'get_context', arguments: { requestId: r.requestId } });
        expect(got.result.structuredContent.context).toBe(requestInput().context);
        const claim = await rpc('tools/call', { name: 'claim_request', arguments: { requestId: r.requestId, idempotencyKey: 'claim' } });
        const result = await rpc('tools/call', { name: 'report_update', arguments: { requestId: r.requestId,
          attemptId: claim.result.structuredContent.attemptId, sequence: 1, idempotencyKey: 'done', state: 'completed', summary: `Briefing ${i}` } });
        expect(result.result.structuredContent.accepted).toBe(true);
        const shown = await (await fetch(base + `/experiment/requests/${r.requestId}`, { headers: { Authorization: `Bearer ${token}` } })).json() as any;
        expect(shown.report.summary).toBe(`Briefing ${i}`);
        expect(JSON.stringify(shown)).not.toContain(secret);
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});

it('erases expired context and removes retained history without pretending to stop remote work', async () => {
  await relay.rpc(owner, 'events/subscribe', subscribe());
  const request = relay.create(owner, requestInput());
  now += LIMITS.requestMs;
  relay.maintenance();
  expect(store.read().requests[0].context).toBe('');
  expect(relay.get(owner, request.requestId).report).toBeNull();
  now += LIMITS.retentionMs;
  relay.maintenance();
  expect(store.read().requests).toEqual([]);
  expect(store.read().subscriptions).toEqual([]);
});
it('drains an in-flight verification on shutdown without activating its subscription', async () => {
  let complete!: () => void;
  send.mockImplementationOnce(async (_url, body) => {
    await new Promise<void>(resolve => { complete = resolve; });
    return { status: 200, body: JSON.stringify({ challenge: JSON.parse(body).challenge }) };
  });
  const pending = relay.rpc(owner, 'events/subscribe', subscribe());
  await Promise.resolve();
  const refused = expect(pending).rejects.toThrow('revoked');
  const stopped = relay.stop(); complete();
  await refused; await stopped;
  expect(store.read().subscriptions).toEqual([]);
  await expect(relay.rpc(owner, 'tools/list')).rejects.toThrow('revoked');
});

it('records scoped interaction history without promoting Dot claims into target acknowledgements', async () => {
  await relay.rpc(owner, 'events/subscribe', subscribe());
  const request = relay.create(owner, requestInput());
  const claim = (await call('claim_request', { requestId: request.requestId, idempotencyKey: 'claim-edge' })).structuredContent;
  const edge = { requestId: request.requestId, attemptId: claim.attemptId, idempotencyKey: 'edge-1', relationId: 'delegation-1',
    sequence: 1, kind: 'delegation', direction: 'dot_to_agent', stage: 'requested', targetRef: 'codex-session-ref', summary: 'Run targeted tests' };
  expect((await call('report_interaction', edge)).structuredContent).toMatchObject({ accepted: true });
  expect((await call('report_interaction', edge)).structuredContent).toMatchObject({ accepted: true });
  expect(store.read().requests[0].interactions).toHaveLength(1);
  await expect(call('report_interaction', { ...edge, evidence: 'agent_acknowledgement' })).rejects.toThrow('schema');
  expect((await call('report_interaction', { ...edge, idempotencyKey: 'rebind', sequence: 2, targetRef: 'other-session' })).isError).toBe(true);
  expect((await call('report_interaction', { ...edge, idempotencyKey: 'edge-2', sequence: 2, stage: 'accepted' })).structuredContent).toMatchObject({ accepted: true });
  expect((await call('report_interaction', { ...edge, idempotencyKey: 'regression', sequence: 3 })).isError).toBe(true);
  expect((await call('report_interaction', { ...edge, idempotencyKey: 'edge-3', sequence: 3, stage: 'completed' })).structuredContent).toMatchObject({ accepted: true });
  expect((await call('report_interaction', { ...edge, idempotencyKey: 'resurrect', sequence: 4, stage: 'running' })).isError).toBe(true);
  expect((await call('report_interaction', edge, other)).isError).toBe(true);
  store.close(); store = new Store(path); relay = new Relay(store, send, () => now);
  const result = (await call('get_request', { requestId: request.requestId })).structuredContent;
  expect(result.interactions.map((e: any) => e.stage)).toEqual(['requested', 'accepted', 'completed']);
  expect(result.interactions.every((e: any) => e.evidence === 'dot_report' && Number.isInteger(e.receivedAt))).toBe(true);
  expect(result.report).toBeNull(); // An interaction completion does not complete the parent briefing.
  relay.revoke(owner); expect(store.read().requests).toEqual([]);
});
it('bounds interaction history and rejects reports after the claim expires', async () => {
  await relay.rpc(owner, 'events/subscribe', subscribe());
  const request = relay.create(owner, requestInput());
  const claim = (await call('claim_request', { requestId: request.requestId, idempotencyKey: 'claim-edge' })).structuredContent;
  const input = { requestId: request.requestId, attemptId: claim.attemptId, relationId: 'r', kind: 'message', direction: 'agent_to_dot', stage: 'running', targetRef: null, summary: 'Message received' };
  for (let i = 1; i <= LIMITS.interactionEvents; i++) expect((await call('report_interaction', { ...input, sequence: i, idempotencyKey: `e${i}` })).isError).not.toBe(true);
  expect((await call('report_interaction', { ...input, sequence: LIMITS.interactionEvents + 1, idempotencyKey: 'overflow' })).isError).toBe(true);
  now += LIMITS.claimMs;
  expect((await call('report_interaction', { ...input, relationId: 'new', sequence: 1, idempotencyKey: 'expired' })).isError).toBe(true);
});

it('rejects forged persisted interaction provenance on restart', async () => {
  await relay.rpc(owner, 'events/subscribe', subscribe());
  const request = relay.create(owner, requestInput());
  const claim = (await call('claim_request', { requestId: request.requestId, idempotencyKey: 'claim' })).structuredContent;
  await call('report_interaction', { requestId: request.requestId, attemptId: claim.attemptId, idempotencyKey: 'edge', relationId: 'r',
    sequence: 1, kind: 'control', direction: 'dot_to_agent', stage: 'requested', targetRef: null, summary: 'Reported control' });
  store.close();
  const saved = readFileSync(path, 'utf8');
  writeFileSync(path, saved.replace('dot_report', 'agent_acknowledgement'));
  expect(() => new Store(path)).toThrow('schema');
  writeFileSync(path, saved); store = new Store(path);
});
