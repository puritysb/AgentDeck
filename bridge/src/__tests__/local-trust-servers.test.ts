/**
 * Same-machine trust, end to end through the real servers and the real
 * `auth.ts`: a web page in a browser here connects from 127.0.0.1 like a local
 * program, and only its `Host` and `Origin` headers tell it apart
 * (shared/src/local-trust.ts). Every test connects over loopback, so
 * `isLocalConnection` is genuinely true; the token is a real one in a
 * throwaway data directory.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request, type Server } from 'http';
import type { AddressInfo } from 'net';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import WebSocket from 'ws';
import { getOrCreateToken } from '../auth.js';
import { HookServer } from '../hook-server.js';
import type { BridgeEvent } from '../types.js';
import { WsServer } from '../ws-server.js';

let dataDir: string;
let previousDataDir: string | undefined;
let token: string;

beforeAll(() => {
  previousDataDir = process.env.AGENTDECK_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), 'agentdeck-local-trust-'));
  process.env.AGENTDECK_DATA_DIR = dataDir;
  token = getOrCreateToken();
});

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.AGENTDECK_DATA_DIR;
  else process.env.AGENTDECK_DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('WsServer: a same-machine WebSocket', () => {
  let http: Server;
  let server: WsServer;
  let port: number;
  const knocks: string[] = [];

  beforeAll(async () => {
    http = createServer();
    server = new WsServer(http);
    server.setPairingApprovalHooks({
      isApproved: () => true,
      record: (ip) => { knocks.push(ip); },
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    port = (http.address() as AddressInfo).port;
  });

  afterAll(() => {
    server.close();
    http.close();
  });

  /** A refused socket completes the handshake and is then closed 4001. */
  function attempt(query: string, headers: Record<string, string> = {}): Promise<{ ok: boolean; code?: number }> {
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/${query}`, { headers });
      let settled = false;
      const done = (r: { ok: boolean; code?: number }) => {
        if (settled) return;
        settled = true;
        resolve(r);
        try { ws.close(); } catch { /* ignore */ }
      };
      ws.on('open', () => { setTimeout(() => done({ ok: true }), 60); });
      ws.on('close', (code) => done({ ok: false, code }));
      ws.on('error', () => { /* close follows */ });
    });
  }

  it('admits a local program, which sends no Origin', async () => {
    expect((await attempt('')).ok).toBe(true);
  });

  it('admits the literal file:// the ESP32 WebSocket library sends', async () => {
    expect((await attempt('', { Origin: 'file://' })).ok).toBe(true);
  });

  it('refuses a web page, and records no pairing knock for it', async () => {
    knocks.length = 0;
    const r = await attempt('', { Origin: 'https://evil.example' });
    expect(r).toEqual({ ok: false, code: 4001 });
    // The approval hook answers yes to everything here: a page must not reach it.
    expect(knocks).toEqual([]);
  });

  it('refuses a DNS-rebinding page by its Host', async () => {
    const r = await attempt('', { Host: `rebind.example:${port}` });
    expect(r).toEqual({ ok: false, code: 4001 });
  });

  it("admits a page the daemon served, by the daemon's own origin", async () => {
    expect((await attempt('', { Origin: `http://127.0.0.1:${port}` })).ok).toBe(true);
    expect((await attempt('', { Origin: `http://localhost:${port}` })).ok).toBe(true);
  });

  it('admits a web page that carries the pairing token', async () => {
    expect((await attempt(`?token=${token}`, { Origin: 'https://evil.example' })).ok).toBe(true);
    expect((await attempt('?token=wrong', { Origin: 'https://evil.example' })).code).toBe(4001);
  });
});

describe('HookServer: a same-machine POST', () => {
  let hooks: HookServer;
  let port: number;
  const emitted: string[] = [];

  beforeAll(async () => {
    hooks = new HookServer();
    hooks.on('hook', (e: { event: string }) => { emitted.push(e.event); });
    await hooks.listen(0);
    const raw = (hooks as unknown as { server: { address(): AddressInfo | string | null } }).server;
    port = (raw.address() as AddressInfo).port;
  });

  afterAll(async () => { await hooks.close(); });

  /** `http.request` rather than fetch, which will not send a chosen Host. */
  function post(path: string, headers: Record<string, string>, body: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  it('accepts a hook from a local program', async () => {
    emitted.length = 0;
    const status = await post('/hooks/Notification', { 'Content-Type': 'application/json' }, '{}');
    expect(status).toBe(200);
    expect(emitted).toEqual(['Notification']);
  });

  it('refuses a cross-origin text/plain POST, which a browser sends without a preflight', async () => {
    emitted.length = 0;
    const status = await post('/hooks/SessionEnd', { 'Content-Type': 'text/plain', Origin: 'https://evil.example' }, '{}');
    expect(status).toBe(401);
    expect(emitted).toEqual([]);
  });

  it('refuses a DNS-rebinding page by its Host', async () => {
    const status = await post('/hooks/Stop', { 'Content-Type': 'application/json', Host: `rebind.example:${port}` }, '{}');
    expect(status).toBe(401);
  });

  it('accepts such a page with the pairing token', async () => {
    const status = await post(`/hooks/Notification?token=${token}`, { 'Content-Type': 'text/plain', Origin: 'https://evil.example' }, '{}');
    expect(status).toBe(200);
  });

  // A GET keeps local trust whatever page sent it, so a page may open the
  // session's event stream; without this header the browser keeps it unread.
  it('opens /sse for a cross-origin page without letting it read the stream', async () => {
    // The head goes out with the first event, which is the cached state.
    hooks.broadcastSse({ type: 'state_update', state: 'idle' } as unknown as BridgeEvent);
    const answer = await new Promise<{ status?: number; acao?: string | string[] }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/sse', headers: { Origin: 'https://evil.example' } }, (res) => {
        resolve({ status: res.statusCode, acao: res.headers['access-control-allow-origin'] });
        req.destroy();
      });
      req.on('error', reject);
      req.end();
    });
    expect(answer).toEqual({ status: 200, acao: undefined });
  });

  /** A top-level navigation: a GET with no Origin, which keeps local trust. */
  function page(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.end();
    });
  }

  // Any page may navigate the browser here, and a script /status runs is on
  // the bridge's own origin, which every route trusts: a reflected ?token=
  // used to put the visitor's script there.
  it('reflects no visitor-supplied token into the /status script', async () => {
    const crafted = encodeURIComponent('");document.title="PWNED";//');
    const html = await page(`/status?token=${crafted}`);
    expect(html).not.toContain('PWNED');
    expect(html).toContain('new EventSource("/sse")');
  });

  it('keeps the issued token for a /status page opened with it', async () => {
    const html = await page(`/status?token=${token}`);
    expect(html).toContain(`new EventSource(${JSON.stringify(`/sse?token=${encodeURIComponent(token)}`)})`);
  });
});
