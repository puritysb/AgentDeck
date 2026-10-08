import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { request } from 'node:https';
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
