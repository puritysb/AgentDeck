import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { expect, it } from 'vitest';
import { startDirectHost } from '../runtime.js';
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
async function freePort() {
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done())); return port;
}
it('hosts local-consent OAuth over verified HTTPS, isolates operator routes and persists revocation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-runtime-'));
  const config = { enabled: true, origin: 'https://relay.example', port: await freePort(), controlPort: await freePort(),
    certificatePath: fixture('localhost-test.crt'), keyPath: fixture('localhost-test.key'),
    clientId: 'registered-chatgpt-client', clientSecret: 's'.repeat(48), redirectURI: 'https://chatgpt.com/connector_platform_oauth_redirect' };
  let host = await startDirectHost(config, directory);
  const call = (path: string, body?: string, bearer?: string, form = false) => new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', servername: 'relay.example', port: config.port, path,
      agent: false, ca: readFileSync(config.certificatePath), timeout: 2000, method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } }, res => {
      let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode!, location: res.headers.location, body: data }));
    }); req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.end(body);
  });
  const operator = async (path: string, body?: object, authenticated = true) => fetch(`http://127.0.0.1:${config.controlPort}/operator/${path}`, {
    method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(2000),
    headers: { Connection: 'close', 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${readFileSync(join(directory, 'dot-operator-token'), 'utf8')}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    expect(host.deckSnapshot()).toEqual({ configured: true, hosting: true, reportState: null, reportedAt: null, expiresAt: null });
    expect((await call('/operator/status')).status).toBe(404);
    expect((await operator('status', undefined, false)).status).toBe(401);
    const verifier = 'v'.repeat(64);
    const auth = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectURI,
      resource: config.origin, scope: 'agentdeck:read agentdeck:report agentdeck:subscribe', state: 'original',
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    const started = await call(`/oauth/authorize?${auth}`); expect(started.status).toBe(302);
    expect((await call(started.location!)).body).toContain('Approve in AgentDeck');
    const pending = await (await operator('status')).json() as { pending: { id: string }[] };
    expect((await operator('consent', { id: pending.pending[0].id, approve: true })).status).toBe(200);
    const approved = new URL((await call(started.location!)).location!);
    expect(approved.searchParams.get('iss')).toBe(config.origin);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code: approved.searchParams.get('code')!,
      client_id: config.clientId, client_secret: config.clientSecret, redirect_uri: config.redirectURI, resource: config.origin, code_verifier: verifier });
    const tokens = JSON.parse((await call('/oauth/token', form.toString(), undefined, true)).body);
    expect(tokens.access_token).toBeTypeOf('string');
    const rpc = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(JSON.parse((await call('/mcp', rpc, tokens.access_token)).body).result.tools).toHaveLength(5);
    expect((await call('/operator/status', undefined, tokens.access_token)).status).toBe(404);
    await host.stop();
    expect(host.deckSnapshot().hosting).toBe(false);
    host = await startDirectHost(config, directory);
    expect((await call('/mcp', rpc, tokens.access_token)).status).toBe(200);
    const status = await (await operator('status')).json() as { grants: { id: string }[] };
    expect((await operator('revoke', { grantId: status.grants[0].id })).status).toBe(200);
    expect((await call('/mcp', rpc, tokens.access_token)).status).toBe(401);
    await host.stop(); host = await startDirectHost(config, directory);
    expect((await call('/mcp', rpc, tokens.access_token)).status).toBe(401);
  } finally { await host.stop(); rmSync(directory, { recursive: true, force: true }); }
});
it('binds local MCP explicitly, rejects foreign Host/Origin and creates requests without webhook delivery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-local-'));
  const config = { enabled: true, mode: 'local' as const, port: await freePort(), controlPort: await freePort() };
  await expect(startDirectHost({ ...config, bind: '0.0.0.0' }, directory)).rejects.toThrow('loopback');
  const host = await startDirectHost(config, directory);
  const call = (path: string, init: RequestInit = {}) => fetch(host.origin + path, { redirect: 'manual', signal: AbortSignal.timeout(2000), ...init });
  const operator = (path: string, body?: object) => fetch(`http://127.0.0.1:${config.controlPort}/operator/${path}`, {
    signal: AbortSignal.timeout(2000), method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json',
      Authorization: `Bearer ${readFileSync(join(directory, 'dot-operator-token'), 'utf8')}` }, ...(body ? { body: JSON.stringify(body) } : {}) });
  try {
    expect((await call('/mcp')).status).toBe(401);
    const foreignHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(host.origin + '/mcp', { headers: { Host: 'evil.example' }, timeout: 2000 }, res => { res.resume(); resolve(res.statusCode!); });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end();
    });
    expect(foreignHost).toBe(403);
    expect((await call('/mcp', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await call('/operator/status')).status).toBe(404);
    const metadata = await (await call('/.well-known/oauth-authorization-server')).json();
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(['none']);
    const verifier = 'v'.repeat(64), callback = 'http://127.0.0.1:38472/callback';
    const params = new URLSearchParams({ client_id: 'agentdeck-local-plugin', resource: host.origin, redirect_uri: callback,
      response_type: 'code', state: 'test', scope: 'agentdeck:read agentdeck:report', code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    const begin = await call('/oauth/authorize?' + params);
    const pending = await (await operator('status')).json();
    await operator('consent', { id: pending.pending[0].id, approve: true });
    const approved = await fetch(new URL(begin.headers.get('location')!, host.origin), { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const token = await (await call('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: 'agentdeck-local-plugin', resource: host.origin, redirect_uri: callback, grant_type: 'authorization_code', code, code_verifier: verifier }) })).json();
    expect(token.access_token).toBeTypeOf('string');
    const status = await (await operator('status')).json(), grantId = status.grants[0].id;
    const response = await operator('request', { grantId, integrationId: 'desk', context: 'explicitly shared context', capturedAt: Date.now(), idempotencyKey: 'local-request-key' });
    expect(response.status).toBe(201); const row = await response.json();
    expect(row.delivery).toBe('local'); expect(row.attempts).toBe(0);
    const rpc = () => call('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.access_token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect((await rpc()).status).toBe(200);
    const tool = async (name: string, args: object) => {
      const response = await call('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token.access_token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) });
      return (await response.json()).result;
    };
    expect((await tool('get_request', { requestId: row.requestId })).structuredContent.delivery).toBe('local');
    expect((await tool('get_context', { requestId: row.requestId })).structuredContent.context).toBe('explicitly shared context');
    const claim = (await tool('claim_request', { requestId: row.requestId, idempotencyKey: 'local-claim' })).structuredContent;
    const update = { requestId: row.requestId, attemptId: claim.attemptId, idempotencyKey: 'working', sequence: 1, state: 'working', summary: 'Reviewing' };
    expect((await tool('report_update', update)).structuredContent.accepted).toBe(true);
    expect(host.deckSnapshot().reportState).toBe('working');
    expect((await tool('report_update', { ...update, idempotencyKey: 'done', sequence: 2, state: 'completed' })).structuredContent.accepted).toBe(true);
    expect(host.deckSnapshot().reportState).toBe('completed');
    await operator('revoke', { grantId }); expect((await rpc()).status).toBe(401);
  } finally { await host.stop(); rmSync(directory, { recursive: true, force: true }); }
});
