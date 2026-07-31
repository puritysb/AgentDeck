import { describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { Socket } from 'net';
import { DaemonWsClient } from '../daemon-ws-client.js';
import { WsServer } from '../ws-server.js';
import { resolveDaemonTarget, type DaemonTarget } from '../session-registry.js';
import { SESSION_WEIGHT_MAX } from '@agentdeck/shared';

/**
 * Regression for the Node-session → Swift-daemon discovery shape: the Swift
 * daemon cannot read the CLI's sessions.json, so `session_push_register` is the
 * only path a managed session's weight can reach the App Store dashboards.
 * The frame must always carry a concrete integer weight — receivers merge
 * retain-on-absent, so an omitted key would make a weight settable but never
 * resettable (the usageStale latch bug class).
 */
describe('DaemonWsClient register frame', () => {
  it('always includes an explicit integer weight (unweighted ⇒ 0, never omitted)', () => {
    const client = new DaemonWsClient('sess-1', 9121, 'claude-code', 'AgentDeck');
    const frame = client.buildRegisterFrame();
    expect(frame).toMatchObject({
      type: 'session_push_register',
      sessionId: 'sess-1',
      port: 9121,
      agentType: 'claude-code',
      projectName: 'AgentDeck',
      weight: 0,
    });
    expect(Object.prototype.hasOwnProperty.call(frame, 'weight')).toBe(true);
    client.close();
  });

  it('carries the launch-time --weight value', () => {
    const client = new DaemonWsClient('sess-2', 9122, 'codex-cli', 'AgentDeck', 2);
    expect(client.buildRegisterFrame().weight).toBe(2);
    client.close();
  });

  it('normalizes garbage weights so the wire only ever sees in-range integers', () => {
    const client = new DaemonWsClient('sess-3', 9123, 'claude-code', 'AgentDeck', 2 ** 40);
    expect(client.buildRegisterFrame().weight).toBe(SESSION_WEIGHT_MAX);
    client.close();
  });
});

/**
 * Stale-target lifecycle over a REAL socket: after one successful remote
 * attach, the target provider's result must replace the cached target on
 * every resolution — null included. Retaining the old target (with its old
 * token and sameSocketControl) would let the client keep dialing a daemon
 * that disappeared or was replaced by an incapable one, bypassing the
 * capability refusal that gates the first connect.
 */
describe('DaemonWsClient target re-resolution (real socket, short backoff)', () => {
  // Ephemeral port per server (listen(0)) — Windows parallel-vitest history.
  async function startServer(): Promise<{
    http: Server; server: WsServer; port: number;
    tcpConnections: () => number; destroySockets: () => void;
  }> {
    const http = createServer();
    const server = new WsServer(http);
    server.onRawMessage(() => true); // consume push frames; registration still acked by nothing — client ack not needed here
    let count = 0;
    const sockets = new Set<Socket>();
    http.on('connection', (s: Socket) => {
      count += 1;
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as { port: number }).port;
    return {
      http, server, port,
      tcpConnections: () => count,
      destroySockets: () => { for (const s of sockets) s.destroy(); },
    };
  }

  it('clears the cached target on a null resolution and only redials once a valid target resolves again', async () => {
    const srv = await startServer();
    let target: DaemonTarget | null = { host: '127.0.0.1', port: srv.port, sameSocketControl: true };
    const provider = vi.fn(async () => target);
    const client = new DaemonWsClient('sess-relife', 4321, 'claude-code', 'demo',
      undefined, provider, undefined, /* remoteEnabled */ true, /* reconnectBaseMs */ 25);
    try {
      client.connect({ host: '127.0.0.1', port: srv.port });
      await vi.waitFor(() => { expect(srv.tcpConnections()).toBe(1); }, { timeout: 2000 });

      // Daemon "disappears": resolution starts failing, the live socket drops.
      target = null;
      const callsAtDrop = provider.mock.calls.length;
      srv.destroySockets();

      // The reconnect loop keeps consulting the provider…
      await vi.waitFor(() => {
        expect(provider.mock.calls.length).toBeGreaterThanOrEqual(callsAtDrop + 2);
      }, { timeout: 2000 });
      // …but never opens a socket to the (still-listening!) old endpoint:
      // the cached target was cleared, not retained.
      expect(srv.tcpConnections()).toBe(1);

      // Resolution recovers → the client reconnects on its own.
      target = { host: '127.0.0.1', port: srv.port, sameSocketControl: true };
      await vi.waitFor(() => { expect(srv.tcpConnections()).toBe(2); }, { timeout: 2000 });
    } finally {
      client.close();
      srv.server.close();
      srv.http.close();
    }
  });

  it('capability downgrade through the REAL resolver: incapable local daemon ⇒ no new socket (reviewer end-to-end case)', async () => {
    const srv = await startServer();
    // The resolver sees a loopback daemon whose /health capability flips.
    let local: { port: number; sameSocketControl: boolean } = { port: srv.port, sameSocketControl: true };
    const warn = vi.fn();
    const provider = vi.fn(() => resolveDaemonTarget({ remote: true }, {
      findLocal: async () => local,
      probeHealth: async () => null,
      discover: async () => [],
      warn,
    }));
    const client = new DaemonWsClient('sess-downgrade', 4322, 'claude-code', 'demo',
      undefined, provider, undefined, /* remoteEnabled */ true, /* reconnectBaseMs */ 25);
    try {
      client.connect(null);
      await vi.waitFor(() => { expect(srv.tcpConnections()).toBe(1); }, { timeout: 2000 });

      // Daemon replaced by an incapable build (e.g. pre-remediation restart).
      local = { port: srv.port, sameSocketControl: false };
      const callsAtDrop = provider.mock.calls.length;
      srv.destroySockets();

      await vi.waitFor(() => {
        expect(provider.mock.calls.length).toBeGreaterThanOrEqual(callsAtDrop + 2);
      }, { timeout: 2000 });
      // The resolver refused (warned once) and the client never redialed.
      expect(srv.tcpConnections()).toBe(1);
      expect(warn).toHaveBeenCalledWith(`local:127.0.0.1:${srv.port}`, expect.stringContaining('does not support remote attach'));

      // Upgrade back to a capable daemon → reattaches.
      local = { port: srv.port, sameSocketControl: true };
      await vi.waitFor(() => { expect(srv.tcpConnections()).toBe(2); }, { timeout: 2000 });
    } finally {
      client.close();
      srv.server.close();
      srv.http.close();
    }
  });

  it('client guard: refuses to dial a non-null capability-less target under remote intent', async () => {
    const srv = await startServer();
    // A (hypothetical, resolver-drift) provider that returns an incapable
    // target under remote intent — the client itself must treat it as null.
    const provider = vi.fn(async (): Promise<DaemonTarget | null> => (
      { host: '127.0.0.1', port: srv.port, sameSocketControl: false }
    ));
    const client = new DaemonWsClient('sess-guard', 4323, 'claude-code', 'demo',
      undefined, provider, undefined, /* remoteEnabled */ true, /* reconnectBaseMs */ 25);
    try {
      client.connect(null);
      await vi.waitFor(() => {
        expect(provider.mock.calls.length).toBeGreaterThanOrEqual(3);
      }, { timeout: 2000 });
      expect(srv.tcpConnections()).toBe(0);
    } finally {
      client.close();
      srv.server.close();
      srv.http.close();
    }
  });
});
