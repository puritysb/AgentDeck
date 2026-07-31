import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { WebSocket as WsSocket } from 'ws';
import { WsServer } from '../ws-server.js';
import { DaemonWsClient } from '../daemon-ws-client.js';
import type { BridgeEvent, PluginCommand } from '../types.js';

/**
 * End-to-end proof of the same-socket reverse path: a worker's DaemonWsClient
 * opens ONE outbound socket to the daemon's WsServer, and the daemon then drives
 * the session back down that same socket — no inbound dial to the worker. This
 * is the property that makes NAT'd / SSH-only workers controllable.
 */
describe('same-socket reverse control (worker ↔ daemon, real sockets)', () => {
  let http: Server;
  let server: WsServer;
  let port: number;
  let client: DaemonWsClient;
  let sender: WsSocket;           // daemon-side push socket the worker opened
  const upFrames: any[] = [];     // frames the daemon received from the worker
  const applied: PluginCommand[] = [];

  beforeAll(async () => {
    http = createServer();
    server = new WsServer(http);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    port = (http.address() as any).port;

    // Daemon: capture the worker's push socket + collect everything it sends up.
    server.onRawMessage((msg, ws) => {
      upFrames.push(msg);
      if (msg.type === 'session_push_register') sender = ws;
      return true; // consume — no command handler in this harness
    });

    // Worker: attach to the daemon and enable same-socket reverse control.
    // remoteEnabled + a capability-advertising target mirrors the ssh -L
    // topology: loopback endpoint, but the user opted in and the daemon is
    // capable, so the registration must carry remoteAttach.
    client = new DaemonWsClient('sess-e2e', 4321, 'claude-code', 'demo',
      undefined,
      async () => ({ host: '127.0.0.1', port, sameSocketControl: true }),
      undefined, /* remoteEnabled */ true);
    client.setReverseControl(
      (cmd) => applied.push(cmd),
      () => [{ type: 'state_update' } as BridgeEvent],
    );
    // Seed the target so the first dial is immediate (connect(null) would wait a
    // full backoff before its first attempt). Note the provider's result —
    // null included — replaces this seed on every resolution; it works here
    // only because the provider above always returns the same live target.
    client.connect({ host: '127.0.0.1', port });

    // Wait until the worker registered (we now hold its push socket).
    await vi.waitFor(() => { if (!sender) throw new Error('not registered yet'); }, { timeout: 2000 });
  });

  afterAll(() => {
    client.close();
    server.close();
    http.close();
  });

  it('registers over a single outbound socket with explicit remoteAttach intent', () => {
    // Explicit flag, not IP heuristics: the daemon-side classifier must be able
    // to register this loopback (ssh -L style) worker as remote.
    expect(upFrames.find((f) => f.type === 'session_push_register')).toMatchObject({
      sessionId: 'sess-e2e', port: 4321, remoteAttach: true,
    });
  });

  it('ignores down-frames addressed to a foreign session', async () => {
    // Focus/command frames for another sessionId must not drive this worker.
    sender.send(JSON.stringify({ type: 'session_command_down', sessionId: 'someone-else', command: { type: 'escape' } }));
    sender.send(JSON.stringify({ type: 'session_focus_down', sessionId: 'someone-else' }));
    await new Promise((r) => setTimeout(r, 150));
    expect(applied.map((c) => c.type)).not.toContain('escape');
    // The foreign focus_down must not have flipped the worker into forwarding.
    const before = upFrames.filter((f) => f.type === 'session_event_up').length;
    client.forwardEvent({ type: 'usage_update' } as BridgeEvent);
    await new Promise((r) => setTimeout(r, 150));
    expect(upFrames.filter((f) => f.type === 'session_event_up').length).toBe(before);
  });

  it('emits the focus snapshot up when the daemon focuses (session_focus_down)', async () => {
    sender.send(JSON.stringify({ type: 'session_focus_down', sessionId: 'sess-e2e' }));
    await vi.waitFor(() => {
      expect(upFrames.some((f) => f.type === 'session_event_up' && f.event?.type === 'state_update')).toBe(true);
    }, { timeout: 2000 });
  });

  it('applies a command sent down the same socket (session_command_down)', async () => {
    sender.send(JSON.stringify({ type: 'session_command_down', sessionId: 'sess-e2e', command: { type: 'interrupt' } }));
    await vi.waitFor(() => { expect(applied.map((c) => c.type)).toContain('interrupt'); }, { timeout: 2000 });
  });

  it('forwards live events up only while focused', async () => {
    const before = upFrames.filter((f) => f.type === 'session_event_up').length;
    client.forwardEvent({ type: 'usage_update' } as BridgeEvent);
    await vi.waitFor(() => {
      expect(upFrames.filter((f) => f.type === 'session_event_up').length).toBe(before + 1);
    }, { timeout: 2000 });

    // After unfocus, forwarded events are dropped at the worker.
    sender.send(JSON.stringify({ type: 'session_unfocus_down', sessionId: 'sess-e2e' }));
    await new Promise((r) => setTimeout(r, 150)); // let the unfocus frame arrive
    const settled = upFrames.filter((f) => f.type === 'session_event_up').length;
    client.forwardEvent({ type: 'usage_update' } as BridgeEvent);
    await new Promise((r) => setTimeout(r, 150));
    expect(upFrames.filter((f) => f.type === 'session_event_up').length).toBe(settled);
  });
});
