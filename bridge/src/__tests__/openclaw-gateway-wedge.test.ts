/**
 * The daemon's OpenClaw adapter must never outlive its socket unnoticed.
 *
 * 2026-09-26 00:16 KST: OpenClaw restarted itself, the daemon's 5 s probe saw
 * port 18789 open again 4 s before the Gateway was `ready`, and the Gateway
 * logged "closed before connect (handshake pending)". The daemon creates its
 * adapter with `autoReconnect:false`, the adapter never reported that its only
 * socket had closed, and the probe fired its connect callback on the rising
 * edge only — the port stayed open, so no edge ever came again. OpenClaw was
 * absent from every surface until a manual daemon restart (same wedge as
 * 2026-09-16, 16.5 h). Both halves are pinned here.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocketServer } from 'ws';

vi.mock('../gateway-probe.js', () => ({
  probeGateway: vi.fn(async () => ({ available: true })),
  checkGatewayHealth: vi.fn(async () => ({ known: false, hasError: false, reason: 'unknown' })),
}));

import { OpenClawAdapter } from '../adapters/openclaw.js';
import { BridgeCore } from '../bridge-core.js';

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** A Gateway that accepts the WS upgrade and drops it before any handshake. */
async function gatewayClosingBeforeHandshake(): Promise<string> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  wss.on('connection', (ws) => ws.close());
  closers.push(() => new Promise<void>((resolve) => wss.close(() => resolve())));
  const addr = wss.address();
  return `ws://127.0.0.1:${addr && typeof addr === 'object' ? addr.port : 0}`;
}

function start(adapter: OpenClawAdapter, gatewayUrl: string): void {
  const server: Server = createServer();
  closers.push(() => { adapter.shutdown().catch(() => {}); });
  adapter.start({ port: 0, externalServer: server, gatewayUrl } as never);
}

describe('OpenClaw adapter without autoReconnect', () => {
  it('reports exit when the Gateway closes the socket before the handshake', async () => {
    const adapter = new OpenClawAdapter({ autoReconnect: false });
    const exited = new Promise<void>((resolve) => adapter.once('exit', () => resolve()));
    start(adapter, await gatewayClosingBeforeHandshake());
    await exited;
    expect(adapter.isAlive()).toBe(false);
  });

  it('does not report exit when it reconnects by itself', async () => {
    const adapter = new OpenClawAdapter();
    const onExit = vi.fn();
    adapter.on('exit', onExit);
    start(adapter, await gatewayClosingBeforeHandshake());
    await new Promise((r) => setTimeout(r, 150));
    expect(onExit).not.toHaveBeenCalled();
  });
});

describe('BridgeCore Gateway probe', () => {
  it('calls onAvailable on every tick the port stays open, not only on the rising edge', async () => {
    const httpServer = createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = httpServer.address();
    const core = new BridgeCore({
      port: typeof addr === 'object' && addr ? addr.port : 0,
      projectName: 'Test',
      httpServer,
    });
    closers.push(async () => {
      for (const iv of (core as unknown as { intervals: NodeJS.Timeout[] }).intervals) clearInterval(iv);
      core.wsServer.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    });

    const onAvailable = vi.fn();
    const onDisappeared = vi.fn();
    core.startGatewayProbe(20, onAvailable, onDisappeared);
    await vi.waitFor(() => expect(onAvailable.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(onDisappeared).not.toHaveBeenCalled();
  });
});
