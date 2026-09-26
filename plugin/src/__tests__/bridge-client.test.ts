/**
 * BridgeClient — port provider + backoff behavior.
 *
 * Uses real WebSocket servers to exercise the reconnect path. Time is not
 * mocked; tests rely on the backoff ladder starting at 1000ms but use short
 * waits and observe counters rather than precise timings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'http';

vi.mock('../log.js', () => ({
  dlog: vi.fn(),
  dinfo: vi.fn(),
  dwarn: vi.fn(),
  derr: vi.fn(),
  dtrace: vi.fn(),
}));

import { BridgeClient, BRIDGE_HANDSHAKE_TIMEOUT_MS } from '../bridge-client.js';

interface TestServer {
  port: number;
  httpServer: Server;
  wss: WebSocketServer;
  close: () => Promise<void>;
}

async function createTestServer(): Promise<TestServer> {
  return new Promise((resolve) => {
    const httpServer = createServer();
    const wss = new WebSocketServer({ server: httpServer });
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port,
        httpServer,
        wss,
        close: () => new Promise<void>((res) => {
          wss.clients.forEach((c) => c.close());
          wss.close();
          httpServer.close(() => res());
          setTimeout(res, 200);
        }),
      });
    });
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('BridgeClient — port provider', () => {
  let client: BridgeClient;

  afterEach(() => {
    if (client) client.disconnect();
  });

  it('counts a real pong as activity and clears a stale connection', async () => {
    const server = await createTestServer();
    try {
      client = new BridgeClient();
      client.connect(server.port);
      await vi.waitFor(() => expect(client.isConnected()).toBe(true));
      const internal = client as any;
      internal._lastActivityAt = 0;
      internal.setStale(true);
      internal.ws.ping(); // the real ws server replies automatically
      await vi.waitFor(() => expect(client.isStale()).toBe(false));
      expect(internal._lastActivityAt).toBeGreaterThan(0);
      expect(client.isConnected()).toBe(true);
    } finally {
      client.disconnect();
      await server.close();
    }
  });

  it('retries an in-flight connection without leaving the old generation stuck', async () => {
    const server = await createTestServer();
    try {
      client = new BridgeClient();
      client.connect(server.port);
      client.connect(server.port); // first socket is still CONNECTING
      await vi.waitFor(() => expect(client.isConnected()).toBe(true));
      expect(client.getPort()).toBe(server.port);
    } finally {
      client.disconnect();
      await server.close();
    }
  });

  it('does not reconnect after an explicit disconnect', async () => {
    const server = await createTestServer();
    try {
      client = new BridgeClient();
      const connected = vi.fn();
      client.on('connected', connected);
      client.connect(server.port);
      await vi.waitFor(() => expect(client.isConnected()).toBe(true));
      client.disconnect();
      await wait(1200); // crosses the first reconnect interval
      expect(client.isConnected()).toBe(false);
      expect(connected).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it('bounds a silent handshake and advances to another daemon candidate', async () => {
    const silent = createServer();
    const sockets = new Set<import('net').Socket>();
    silent.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    silent.on('upgrade', () => {}); // accept TCP but never complete WebSocket
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as import('net').AddressInfo).port;
    const healthy = await createTestServer();
    try {
      client = new BridgeClient();
      let failed = false;
      const failures: number[] = [];
      client.on('connection-attempt-failed', failedPort => {
        failures.push(failedPort);
        failed = true;
      });
      client.setPortProvider(() => failed ? healthy.port : port);
      client.connect();
      await vi.waitFor(() => expect(client.isConnected()).toBe(true), {
        timeout: BRIDGE_HANDSHAKE_TIMEOUT_MS + 3000,
      });
      expect(failures).toEqual([port]);
      expect(client.getPort()).toBe(healthy.port);
    } finally {
      client.disconnect();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => silent.close(() => resolve()));
      await healthy.close();
    }
  }, 12_000);

  it('skips connect when provider returns null', async () => {
    client = new BridgeClient();
    const provider = vi.fn().mockReturnValue(null);
    client.setPortProvider(provider);

    const connectedSpy = vi.fn();
    client.on('connected', connectedSpy);

    client.connect();

    // Give the event loop a tick for the first attempt.
    await wait(50);

    expect(provider).toHaveBeenCalled();
    expect(connectedSpy).not.toHaveBeenCalled();
    expect(client.isConnected()).toBe(false);
  });

  it('connects once provider returns a live port', async () => {
    const server = await createTestServer();
    try {
      client = new BridgeClient();
      // First call: daemon absent. Second: daemon appeared.
      let resolved: number | null = null;
      client.setPortProvider(() => resolved);

      const connectedSpy = vi.fn();
      client.on('connected', connectedSpy);

      client.connect();
      await wait(50);
      expect(connectedSpy).not.toHaveBeenCalled();

      // Simulate daemon appearing. Backoff starts at 1000ms so we need to
      // wait slightly longer than that for the next scheduled attempt.
      resolved = server.port;
      await wait(1200);

      expect(connectedSpy).toHaveBeenCalledTimes(1);
      expect(client.isConnected()).toBe(true);
      expect(client.getPort()).toBe(server.port);
    } finally {
      await server.close();
    }
  }, 10_000);

  it('rebinds to a new port when provider value changes', async () => {
    const first = await createTestServer();
    const second = await createTestServer();
    try {
      client = new BridgeClient();
      let active = first.port;
      client.setPortProvider(() => active);

      const connects: number[] = [];
      client.on('connected', () => connects.push(client.getPort()));

      client.connect();
      await wait(300);
      expect(client.isConnected()).toBe(true);
      expect(client.getPort()).toBe(first.port);

      // Kill the first server — client.close triggers scheduleReconnect.
      await first.close();
      active = second.port;

      // Wait long enough for at least one backoff tick (1000ms) + reconnect.
      await wait(1800);

      expect(client.isConnected()).toBe(true);
      expect(client.getPort()).toBe(second.port);
      expect(connects.length).toBeGreaterThanOrEqual(2);
      expect(connects[connects.length - 1]).toBe(second.port);
    } finally {
      await second.close();
    }
  }, 15_000);
});
