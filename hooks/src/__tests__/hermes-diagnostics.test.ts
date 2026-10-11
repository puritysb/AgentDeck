import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { collectHermesDiagnostic } from '../hermes-diagnostics.js';
import { installHermesObserver } from '../hermes-install.js';
const homes: string[] = [];
const servers: http.Server[] = [];
function home() { const dir = mkdtempSync(join(tmpdir(), 'hermes-diag-')); homes.push(dir); return dir; }
async function server(body: unknown) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => { requests.push(`${req.method} ${req.url}`); res.end(JSON.stringify(body)); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as { port: number }).port, requests };
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  homes.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});

describe('Hermes setup readiness', () => {
  it('reports both missing plugin and missing registry without assuming a default port', async () => {
    const dir = home();
    const result = await collectHermesDiagnostic({ home: dir, dataDir: dir });
    expect(result).toMatchObject({ ok: false, plugin: 'missing', enablement: 'disabled', discovery: 'missing', receiver: 'not-probed' });
    expect(result.nextSteps.join(' ')).toContain('--port');
    expect(JSON.stringify(result)).not.toContain(dir);
  });
  it('checks an explicitly selected sandbox receiver without a registry or hook POST', async () => {
    const dir = home(); const daemon = await server({ mode: 'daemon', hermesObserver: 1, pairingToken: 'secret' });
    installHermesObserver(dir, { port: daemon.port });
    writeFileSync(join(dir, 'config.yaml'), 'plugins:\n  enabled: [agentdeck-observer]\n');
    const result = await collectHermesDiagnostic({ home: dir, dataDir: dir });
    expect(result).toMatchObject({ ok: true, discovery: 'explicit', receiver: 'supported' });
    expect(daemon.requests).toEqual(['GET /health']);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain(dir);
  });
  it('disabled wins over enabled and the environment opt-out is reported', async () => {
    const dir = home();
    writeFileSync(join(dir, 'config.yaml'), 'plugins: {enabled: [agentdeck-observer], disabled: [agentdeck-observer]}');
    vi.stubEnv('AGENTDECK_NO_HERMES_HOOKS', '1');
    expect(await collectHermesDiagnostic({ home: dir, dataDir: dir })).toMatchObject({ ok: false, enablement: 'disabled', hooks: 'disabled' });
  });
  it.each(['1', ' TRUE ', 'on'])('HERMES_SAFE_MODE=%s means Hermes loads no plugin, even an enabled one', async value => {
    const dir = home();
    writeFileSync(join(dir, 'config.yaml'), 'plugins: {enabled: [agentdeck-observer]}');
    vi.stubEnv('HERMES_SAFE_MODE', value);
    const result = await collectHermesDiagnostic({ home: dir, dataDir: dir });
    expect(result).toMatchObject({ ok: false, enablement: 'enabled', hooks: 'disabled' });
    expect(result.nextSteps.join(' ')).toContain('HERMES_SAFE_MODE');
    expect(result.nextSteps.join(' ')).not.toContain('AGENTDECK_NO_HERMES_HOOKS');
  });
  it.each(['0', 'false', ''])('HERMES_SAFE_MODE=%s leaves hooks allowed', async value => {
    const dir = home();
    vi.stubEnv('HERMES_SAFE_MODE', value);
    expect((await collectHermesDiagnostic({ home: dir, dataDir: dir })).hooks).toBe('allowed');
  });
  it.each(['plugins: [', 'plugins: 42', 'false', 'plugins: {enabled: wrong}'])('malformed config %s is unknown, never disabled', async config => {
    const dir = home(); writeFileSync(join(dir, 'config.yaml'), config);
    expect((await collectHermesDiagnostic({ home: dir, dataDir: dir })).enablement).toBe('unknown');
  });
  it('invalid explicit selection does not fall back to a working registry', async () => {
    const dir = home(); const daemon = await server({ mode: 'daemon', hermesObserver: 1 });
    const target = installHermesObserver(dir);
    writeFileSync(join(target, 'connection.json'), '{"port":true}');
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ port: daemon.port }));
    expect(await collectHermesDiagnostic({ home: dir, dataDir: dir })).toMatchObject({ discovery: 'invalid', receiver: 'not-probed' });
    expect(daemon.requests).toEqual([]);
  });
  it('unreadable explicit selection is unknown and never falls back', async () => {
    const dir = home(); const target = installHermesObserver(dir);
    // Reading a directory fails on supported desktop platforms without relying on chmod under root.
    const { mkdirSync } = await import('node:fs'); mkdirSync(join(target, 'connection.json'));
    expect(await collectHermesDiagnostic({ home: dir, dataDir: dir })).toMatchObject({ discovery: 'unknown', receiver: 'not-probed' });
  });
  it('uses registry httpPort and distinguishes unsupported from malformed health', async () => {
    const dir = home(); const daemon = await server({ mode: 'daemon', hermesObserver: 0 });
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ port: 1, httpPort: daemon.port }));
    expect(await collectHermesDiagnostic({ home: dir, dataDir: dir })).toMatchObject({ discovery: 'registry', port: daemon.port, receiver: 'unsupported' });
    const malformed = await server({ pairingToken: 'secret' });
    writeFileSync(join(dir, 'daemon.json'), JSON.stringify({ port: malformed.port }));
    expect((await collectHermesDiagnostic({ home: dir, dataDir: dir })).receiver).toBe('unknown');
  });
  it('bounds a peer which accepts HTTP but never finishes', async () => {
    const dir = home(); const pending = http.createServer(() => {}); servers.push(pending);
    await new Promise<void>(resolve => pending.listen(0, '127.0.0.1', resolve));
    installHermesObserver(dir, { port: (pending.address() as { port: number }).port });
    expect((await collectHermesDiagnostic({ home: dir, dataDir: dir, timeoutMs: 30 })).receiver).toBe('unknown');
  });
});
