import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http, { type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { collectConnectionDiagnostic, formatConnectionDiagnostic, probeConnectionPid } from '../connection-diagnostics.js';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function registry(data: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ad-connection-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'daemon.json');
  await writeFile(path, JSON.stringify(data));
  return path;
}

async function server(handler: RequestListener = (_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', mode: 'daemon', pid: process.pid, build: 'abcdef123456',
    pairingToken: 'PRIVATE-TOKEN', sessions: [{ title: 'PRIVATE-TITLE' }], path: '/PRIVATE-HOME' }));
}, options: { noPong?: boolean; reject?: boolean } = {}) {
  const srv = http.createServer(handler);
  const ws = new WebSocketServer({ noServer: true, autoPong: !options.noPong });
  srv.on('upgrade', (req, socket, head) => {
    if (options.reject) { socket.end('HTTP/1.1 401 PRIVATE-TOKEN\r\nConnection: close\r\n\r\n'); return; }
    ws.handleUpgrade(req, socket, head, client => {
      client.send(JSON.stringify({ type: 'sessions_list', sessions: [{ title: 'PRIVATE-TITLE' }] }));
    });
  });
  await new Promise<void>(resolve => srv.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>(resolve => ws.close(() => resolve()));
    srv.closeAllConnections();
    await new Promise<void>(resolve => srv.close(() => resolve()));
  });
  return (srv.address() as AddressInfo).port;
}

describe('local connection diagnostics', () => {
  it('probes real health and ping/pong without copying private frames or modifying the registry', async () => {
    const port = await server();
    const path = await registry({ pid: process.pid, port, token: 'PRIVATE-TOKEN' });
    const before = await readFile(path, 'utf8');
    const result = await collectConnectionDiagnostic({ paths: [path] });
    expect(result).toMatchObject({ ok: true, identity: 'match', health: { status: 'ok', build: 'abcdef123456' }, websocket: { status: 'pong' } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|daemon\.json/);
    expect(formatConnectionDiagnostic(result)).toContain('CLI process only');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('keeps an EPERM PID inconclusive and still probes the endpoint', async () => {
    const denied = (() => { throw Object.assign(new Error('PRIVATE-TOKEN'), { code: 'EPERM' }); }) as typeof process.kill;
    expect(probeConnectionPid(123, denied)).toBe('unknown');
    const port = await server();
    const path = await registry({ pid: process.pid, port });
    const result = await collectConnectionDiagnostic({ paths: [path], probePid: pid => probeConnectionPid(pid, denied) });
    expect(result.registry[0].process).toBe('unknown');
    expect(result.ok).toBe(true);
  });

  it('skips dead entries without deleting them and uses the next usable registry', async () => {
    const missing = (() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); }) as typeof process.kill;
    expect(probeConnectionPid(999, missing)).toBe('dead');
    const dead = await registry({ pid: 999, port: 1 });
    const port = await server();
    const live = await registry({ pid: process.pid, port });
    const result = await collectConnectionDiagnostic({ paths: [dead, live], probePid: pid => pid === 999 ? 'dead' : 'alive' });
    expect(result).toMatchObject({ ok: true, target: { candidate: 1, port } });
    expect(JSON.parse(await readFile(dead, 'utf8')).pid).toBe(999);
  });

  it('reports missing, unreadable and invalid registries without probing an assumed default port', async () => {
    const path = await registry({ pid: process.pid, port: 99999, secret: 'PRIVATE-TOKEN' });
    const result = await collectConnectionDiagnostic({ paths: [path, `${path}.missing`, join(path, '..')] });
    expect(result.registry.map(row => row.status)).toEqual(['invalid', 'missing', 'unreadable']);
    expect(result.target).toBeUndefined();
    expect(result.health).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('rejects a reused PID even when health and WebSocket work', async () => {
    const port = await server();
    const path = await registry({ pid: 123, port });
    const result = await collectConnectionDiagnostic({ paths: [path], probePid: () => 'alive' });
    expect(result).toMatchObject({ ok: false, identity: 'mismatch', websocket: { status: 'pong' } });
  });

  it('supports separate HTTP and WS ports and an explicit target without registry identity claims', async () => {
    const port = await server();
    const httpPort = await server();
    const path = await registry({ pid: process.pid, port, httpPort });
    const discovered = await collectConnectionDiagnostic({ paths: [path] });
    expect(discovered).toMatchObject({ ok: true, target: { port, httpPort } });
    const explicit = await collectConnectionDiagnostic({ paths: [], port });
    expect(explicit).toMatchObject({ ok: true, identity: 'unknown', target: { source: 'explicit', port } });
    await expect(collectConnectionDiagnostic({ paths: [], port: 1.5 })).rejects.toThrow('Port must');
  });

  it('distinguishes HTTP reachability from a rejected WebSocket and strips rejection text', async () => {
    const port = await server(undefined, { reject: true });
    const result = await collectConnectionDiagnostic({ paths: [], port });
    expect(result).toMatchObject({ ok: false, health: { status: 'ok' }, websocket: { status: 'rejected', httpStatus: 401 } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('bounds an endless HTTP body and a WebSocket which never pongs', async () => {
    const port = await server((_req, res) => { res.writeHead(200); res.write('{'); }, { noPong: true });
    const result = await collectConnectionDiagnostic({ paths: [], port, timeoutMs: 100 });
    expect(result).toMatchObject({ ok: false, health: { status: 'timeout' }, websocket: { status: 'timeout' } });
  });

  it('rejects malformed or non-daemon health and never echoes its body', async () => {
    const port = await server((_req, res) => res.end('PRIVATE-TOKEN'));
    const result = await collectConnectionDiagnostic({ paths: [], port });
    expect(result).toMatchObject({ ok: false, health: { status: 'invalid' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('caps a large HTTP response instead of retaining a full diagnostic dump', async () => {
    const port = await server((_req, res) => res.end('PRIVATE-TOKEN'.repeat(100_000)));
    const result = await collectConnectionDiagnostic({ paths: [], port });
    expect(result).toMatchObject({ ok: false, health: { status: 'too-large' } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});
