import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server, type IncomingMessage } from 'http';
import { EventEmitter } from 'node:events';
import WebSocket, { type WebSocketServer } from 'ws';

const trust = vi.hoisted(() => ({ local: false, verdict: 'trusted' }));

// Force the remote-auth branch: treat every connection as non-local so the
// token check actually runs (otherwise 127.0.0.1 is auto-trusted).
vi.mock('../auth.js', () => ({
  isLocalConnection: () => trust.local,
  localTrustOf: () => trust.verdict,
  logLocalTrustRefusal: vi.fn(),
  validateToken: (t: string) => t === 'machine-token',
}));

import { WsServer } from '../ws-server.js';

beforeEach(() => { trust.local = false; trust.verdict = 'trusted'; });

let http: Server;
let server: WsServer;
let port: number;

beforeAll(async () => {
  http = createServer();
  server = new WsServer(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  port = (http.address() as any).port;
});

afterAll(() => {
  server.close();
  http.close();
});

/**
 * Resolve the outcome of a connection attempt. A rejected connection still
 * completes the WS handshake (client 'open' fires) and is then closed with
 * 4001, so we treat "stayed open past a short grace window" as accepted and
 * any close as rejected.
 */
function attempt(query: string): Promise<{ ok: boolean; code?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${query}`);
    let settled = false;
    const done = (r: { ok: boolean; code?: number }) => {
      if (settled) return;
      settled = true;
      resolve(r);
      try { ws.close(); } catch { /* ignore */ }
    };
    ws.on('open', () => { setTimeout(() => done({ ok: true }), 60); });
    ws.on('close', (code) => done({ ok: false, code }));
    ws.on('error', () => { /* close will follow */ });
  });
}

describe('WsServer remote auth', () => {
  it('rejects a remote connection with no token', async () => {
    const r = await attempt('');
    expect(r.ok).toBe(false);
    expect(r.code).toBe(4001);
  });

  it('accepts the machine token', async () => {
    const r = await attempt('?token=machine-token');
    expect(r.ok).toBe(true);
  });

  it('rejects any non-machine token — the machine token is the ONLY accepted credential', async () => {
    // The dial-back ephemeral-token surface was removed with the dial-back
    // fallback itself: same-socket reverse control needs no inbound auth.
    const r = await attempt('?token=ephemeral-xyz');
    expect(r.ok).toBe(false);
    expect(r.code).toBe(4001);
  });
});


describe('WsServer request URL isolation', () => {
  function syntheticConnection(target: string, host: string) {
    // Exercise the actual listener without directing a malformed request at any
    // daemon. This socket never leaves the test process or joins wss.clients.
    const ws = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN,
      close: vi.fn(),
      ping: vi.fn(),
    });
    const req = { url: target, headers: { host }, socket: { remoteAddress: '192.0.2.1' } } as IncomingMessage;
    const connect = () => (server as unknown as { wss: WebSocketServer }).wss.emit('connection', ws, req);
    return { ws, connect };
  }

  it('ignores an untrusted Host value when reading remote query parameters', async () => {
    const { ws, connect } = syntheticConnection('/?token=wrong-token', 'invalid host');
    expect(connect).not.toThrow();
    expect(ws.close).toHaveBeenCalledWith(4001, 'Unauthorized');
    // The same listener still admits an ordinary paired client afterward.
    expect((await attempt('/?token=machine-token')).ok).toBe(true);
  });

  it('keeps authenticated query-based board classification independent of Host', () => {
    const snapshot = vi.fn();
    server.onClientConnect(snapshot);
    snapshot.mockClear();
    const { ws, connect } = syntheticConnection('/?token=machine-token&clientType=esp32', 'invalid host');
    try {
      expect(connect).not.toThrow();
      expect(ws.close).not.toHaveBeenCalled();
      expect(snapshot).toHaveBeenCalledWith(ws);
      expect(server.isEsp32Client(ws as unknown as WebSocket)).toBe(true);
    } finally {
      ws.emit('close');
    }
  });

  it.each(['remote', 'browser', 'program'])('refuses a malformed target only on its %s connection', (kind) => {
    trust.local = kind !== 'remote';
    trust.verdict = kind === 'browser' ? 'untrusted-host' : 'trusted';
    const snapshot = vi.fn();
    const record = vi.fn();
    server.onClientConnect(snapshot);
    snapshot.mockClear();
    server.setPairingApprovalHooks({ isApproved: () => true, record });
    const { ws, connect } = syntheticConnection('http://[', 'localhost');
    try {
      expect(connect).not.toThrow();
      expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid request URL');
      expect(snapshot).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
    } finally {
      server.setPairingApprovalHooks(null);
    }
  });
});


it('disconnects existing sockets when credentials require reauthentication', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=machine-token`);
  await new Promise<void>((resolve,reject) => {ws.once('open',resolve);ws.once('error',reject);});
  const closed = new Promise<number>(resolve => ws.once('close',resolve));
  server.reauthenticateClients();
  expect(await closed).toBe(1006);
  expect((await attempt('?token=machine-token')).ok).toBe(true);
});
