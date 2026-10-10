import { afterEach, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOT_LIMITS } from '@agentdeck/shared';
import { PrivateCredentials, RESOURCE, TunnelSession, credentialsFrom, serveStdio, type Credentials, type CredentialStore } from '../tunnel-stdio.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tokens = (access = 'a', refresh = 'r') => ({ access_token: access.repeat(43), refresh_token: refresh.repeat(43),
  token_type: 'Bearer', expires_in: 300, resource: RESOURCE, scope: 'agentdeck:read agentdeck:report' });
const request = (id = 1) => ({ jsonrpc: '2.0', id, method: 'ping' });
function memory(expired = false) {
  let state = credentialsFrom(tokens(), Date.now() - (expired ? 300_000 : 0));
  const store: CredentialStore = { read: () => structuredClone(state), save: value => { state = structuredClone(value); } };
  return store;
}
function responder(url: unknown, init?: RequestInit): Promise<Response> {
  if (String(url).endsWith('/oauth/token')) return Promise.resolve(Response.json(tokens('b', 's')));
  return Promise.resolve(Response.json({ jsonrpc: '2.0', id: JSON.parse(String(init?.body)).id, result: {} }));
}
it('rotates before forwarding; concurrent requests share one refresh and use the new access token', async () => {
  const store = memory(true), fetcher = vi.fn(responder), session = new TunnelSession(store, fetcher as typeof fetch);
  await Promise.all([session.forward(request(1)), session.forward(request(2))]);
  expect(fetcher.mock.calls.filter(([u]) => String(u).endsWith('/oauth/token'))).toHaveLength(1);
  expect(store.read().refresh).toBe('s'.repeat(43));
  for (const [url, init] of fetcher.mock.calls) {
    expect(String(url).startsWith(RESOURCE + '/')).toBe(true);
    expect(init?.signal).toBeInstanceOf(AbortSignal); expect(init?.redirect).toBe('error');
    if (String(url).endsWith('/mcp')) expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer ' + 'b'.repeat(43));
  }
});
it('marks uncertain rotation durably and never replays it, including after adapter restart', async () => {
  const store = memory(true), fetcher = vi.fn(async () => { expect(store.read().refreshing).toBe(true); throw new Error('secret response lost'); });
  const session = new TunnelSession(store, fetcher);
  expect(await session.forward(request())).toHaveProperty('error');
  await session.forward(request(2));
  await new TunnelSession(store, fetcher).forward(request(3));
  expect(fetcher).toHaveBeenCalledTimes(1); expect(store.read().refreshing).toBe(true);
});
it('does not replay a report on network error, and refuses further calls after revocation', async () => {
  const requestWrite = { ...request(), method: 'tools/call', params: { name: 'report_update', arguments: { state: 'working' } } };
  const network = vi.fn(async () => { throw new Error('unknown outcome'); });
  expect(await new TunnelSession(memory(), network).forward(requestWrite)).toHaveProperty('error');
  expect(network).toHaveBeenCalledTimes(1);
  const revoked = vi.fn(async () => new Response('', { status: 401 }));
  const session = new TunnelSession(memory(), revoked);
  await session.forward(request()); await session.forward(request(2));
  expect(revoked).toHaveBeenCalledTimes(1);
});
it('rejects scope escalation and wrong resources in token responses', () => {
  for (const patch of [{ scope: 'agentdeck:read agentdeck:report agentdeck:subscribe' }, { resource: 'https://foreign.example' }, { expires_in: 3600 }])
    expect(() => credentialsFrom({ ...tokens(), ...patch }, Date.now())).toThrow();
});
it('does not contact operator routes, arbitrary tools or Events; bounds input and output', async () => {
  const fetcher = vi.fn(responder), session = new TunnelSession(memory(), fetcher as typeof fetch);
  for (const input of [{ ...request(), method: '/operator/status' }, { ...request(), method: 'events/subscribe' },
    { ...request(), method: 'tools/call', params: { name: 'exec' } }, { ...request(), params: 'x'.repeat(DOT_LIMITS.bodyBytes) }])
    expect(await session.forward(input)).toHaveProperty('error');
  expect(fetcher).not.toHaveBeenCalled();
  const huge = new TunnelSession(memory(), vi.fn(async () => new Response('x'.repeat(DOT_LIMITS.bodyBytes + 1))));
  expect(await huge.forward(request())).toHaveProperty('error');
});
it('handles split stdio frames, parse errors and notifications without inventing a response', async () => {
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const v = JSON.parse(String(init?.body)); return v.id === undefined ? new Response(null, { status: 202 }) : Response.json({ jsonrpc: '2.0', id: v.id, result: {} });
  });
  const lines: string[] = [], session = new TunnelSession(memory(), fetcher as typeof fetch);
  async function* input() { yield '{bad}\n' + JSON.stringify(request()).slice(0, 10); yield JSON.stringify(request()).slice(10) + '\n' + JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'; }
  await serveStdio(input(), async line => { lines.push(line); }, session);
  expect(lines.map(l => JSON.parse(l))).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }, { jsonrpc: '2.0', id: 1, result: {} }]);
  async function* oversized() { yield 'x'.repeat(DOT_LIMITS.bodyBytes + 1); }
  await expect(serveStdio(oversized(), async () => {}, session)).rejects.toThrow('limit');
});
it.skipIf(process.platform === 'win32')('uses exclusive private credentials and refuses symlinks or group-readable files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dot-tunnel-')); dirs.push(directory); chmodSync(directory, 0o700);
  const path = join(directory, 'credentials.json'), store = new PrivateCredentials(path);
  try {
    store.save(credentialsFrom(tokens(), Date.now()));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(store.read().access).toBe('a'.repeat(43));
    expect(() => new PrivateCredentials(path)).toThrow();
    chmodSync(path, 0o640); expect(() => store.read()).toThrow('Unsafe'); chmodSync(path, 0o600);
    const link = join(directory, 'link.json'); symlinkSync(path, link); const linked = new PrivateCredentials(link);
    try { expect(() => linked.read()).toThrow(); } finally { linked.close(); }
    expect(readFileSync(path, 'utf8')).not.toContain('operator');
  } finally { store.close(); }
  const reopened = new PrivateCredentials(path); reopened.close();
});
it('fails closed if replacement token persistence fails after rotation', async () => {
  const base = memory(true);
  const store: CredentialStore = { read: base.read, save: (v: Credentials) => { if (!v.refreshing) throw new Error('disk full'); base.save(v); } };
  const fetcher = vi.fn(responder), session = new TunnelSession(store, fetcher as typeof fetch);
  expect(await session.forward(request())).toHaveProperty('error');
  await session.forward(request(2)); expect(fetcher).toHaveBeenCalledTimes(1); expect(base.read().refreshing).toBe(true);
});
