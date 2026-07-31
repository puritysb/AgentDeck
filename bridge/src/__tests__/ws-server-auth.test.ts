import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'http';
import WebSocket from 'ws';

// Force the remote-auth branch: treat every connection as non-local so the
// token check actually runs (otherwise 127.0.0.1 is auto-trusted).
vi.mock('../auth.js', () => ({
  isLocalConnection: () => false,
  validateToken: (t: string) => t === 'machine-token',
}));

import { WsServer } from '../ws-server.js';

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
