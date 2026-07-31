import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WebSocket } from 'ws';
import { createPushChannelHandler, type PushChannelCore } from '../session-push-channel.js';
import { SessionFocusRelay } from '../session-focus-relay.js';
import { getRemoteSession, getRemoteSender, removeRemoteSession, listRemoteEnriched } from '../remote-sessions.js';
import { getPushState, clearSiblingStateCache } from '../session-aggregator.js';
import type { BridgeEvent } from '../types.js';

/**
 * Integration tests through the REAL registration / state / reverse-event
 * handler the daemon installs (`createPushChannelHandler`) — the same code
 * path production frames take, driven with fake sockets. Covers the
 * review-required regressions: ssh -L loopback registration, overlapping
 * old/new sockets, and event ownership.
 */

interface FakeSocket extends Record<string, unknown> {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  emitClose: () => void;
}

function fakeSocket(): FakeSocket {
  const closeHandlers: Array<() => void> = [];
  return {
    readyState: 1, // WebSocket.OPEN
    send: vi.fn(),
    once: vi.fn((event: string, cb: () => void) => {
      if (event === 'close') closeHandlers.push(cb);
    }),
    emitClose: () => { for (const cb of closeHandlers.splice(0)) cb(); },
  };
}

function frames(sock: FakeSocket): any[] {
  return sock.send.mock.calls.map((c) => JSON.parse(c[0] as string));
}

const ID = 'push-chan-sess';

describe('session push channel (real handler, fake sockets)', () => {
  let core: PushChannelCore & { broadcastSessionsList: ReturnType<typeof vi.fn>; maybeBroadcastSessionsList: ReturnType<typeof vi.fn> };
  let relay: SessionFocusRelay;
  let relayed: BridgeEvent[];
  let senderIps: Map<FakeSocket, string>;
  let handle: (msg: { type?: string }, sender: WebSocket) => boolean;

  beforeEach(() => {
    removeRemoteSession(ID);
    // The push-state cache is module-global — clear it so assertions on
    // getPushState are not order-dependent across tests in this file.
    clearSiblingStateCache(ID);
    core = {
      broadcastSessionsList: vi.fn(async () => {}),
      maybeBroadcastSessionsList: vi.fn(),
    };
    relay = new SessionFocusRelay();
    relayed = [];
    relay.setEventHandler((e) => relayed.push(e));
    relay.setSameSocketResolver((id) => (getRemoteSender(id) as WebSocket | undefined) ?? null);
    senderIps = new Map();
    handle = createPushChannelHandler({
      core,
      focusRelay: relay,
      getSenderIp: (s) => senderIps.get(s as unknown as FakeSocket) ?? '',
    });
  });

  function register(sock: FakeSocket, opts: { ip: string; remoteAttach?: boolean; weight?: number }): void {
    senderIps.set(sock, opts.ip);
    const consumed = handle({
      type: 'session_push_register', sessionId: ID, port: 4321,
      agentType: 'claude-code', projectName: 'demo',
      ...(opts.remoteAttach !== undefined ? { remoteAttach: opts.remoteAttach } : {}),
      ...(opts.weight !== undefined ? { weight: opts.weight } : {}),
    } as any, sock as unknown as WebSocket);
    expect(consumed).toBe(true);
  }

  it('registers an ssh -L (loopback) worker as remote via the explicit remoteAttach flag', () => {
    const sock = fakeSocket();
    register(sock, { ip: '127.0.0.1', remoteAttach: true });

    // Registered despite the loopback source IP — the flag wins.
    expect(getRemoteSession(ID)).toBeDefined();
    expect(getRemoteSender(ID)).toBe(sock as unknown as WebSocket);
    // Listable for the daemon sessions enricher…
    expect(listRemoteEnriched().map((s) => s.id)).toContain(ID);
    // …and focusable via same-socket reverse control.
    relay.focus(ID);
    expect(relay.getFocusedSessionId()).toBe(ID);
    expect(frames(sock).some((f) => f.type === 'session_focus_down')).toBe(true);
    // Ack was sent.
    expect(frames(sock).some((f) => f.type === 'session_push_ack')).toBe(true);
  });

  it('carries the session weight into the remote sessions list', () => {
    const sock = fakeSocket();
    register(sock, { ip: '127.0.0.1', remoteAttach: true, weight: -4 });

    expect(getRemoteSession(ID)?.weight).toBe(-4);
    expect(listRemoteEnriched().find((s) => s.id === ID)?.weight).toBe(-4);
  });

  it('does NOT register a plain local worker (loopback, no flag) — but still acks', () => {
    const sock = fakeSocket();
    register(sock, { ip: '127.0.0.1' });

    expect(getRemoteSession(ID)).toBeUndefined();
    // The unconditional ack is load-bearing: the worker's isConnected flag needs it.
    expect(frames(sock).some((f) => f.type === 'session_push_ack')).toBe(true);
    expect(core.broadcastSessionsList).not.toHaveBeenCalled();
  });

  it('still registers a flag-less worker from a non-local IP (pre-flag back-compat)', () => {
    const sock = fakeSocket();
    register(sock, { ip: '::ffff:192.168.1.55' });

    expect(getRemoteSession(ID)).toBeDefined();
    expect(getRemoteSession(ID)!.host).toBe('192.168.1.55');
  });

  it('worker reconnect: new socket takes over, old close cannot kill the new registration or focus', () => {
    const oldSock = fakeSocket();
    register(oldSock, { ip: '127.0.0.1', remoteAttach: true });
    relay.focus(ID);
    expect(relay.getFocusedSessionId()).toBe(ID);

    // New socket registers while the old one is still open (reconnect race).
    const newSock = fakeSocket();
    register(newSock, { ip: '127.0.0.1', remoteAttach: true });

    // Focus migrated: old told to unfocus, new told to focus.
    expect(frames(oldSock).some((f) => f.type === 'session_unfocus_down')).toBe(true);
    expect(frames(newSock).some((f) => f.type === 'session_focus_down')).toBe(true);

    // The OLD socket's close handler finally fires — must be a no-op.
    oldSock.emitClose();
    expect(getRemoteSession(ID)).toBeDefined();
    expect(getRemoteSender(ID)).toBe(newSock as unknown as WebSocket);
    expect(relay.getFocusedSessionId()).toBe(ID);

    // Commands route down the NEW socket.
    newSock.send.mockClear();
    expect(relay.routeCommand({ type: 'interrupt' } as any)).toBe(true);
    expect(frames(newSock).some((f) => f.type === 'session_command_down')).toBe(true);

    // The NEW socket's close is the real teardown.
    newSock.emitClose();
    expect(getRemoteSession(ID)).toBeUndefined();
    expect(relay.getFocusedSessionId()).toBeNull();
  });

  it('session_event_up: only the registered sender may speak for a session', () => {
    const sock = fakeSocket();
    register(sock, { ip: '127.0.0.1', remoteAttach: true });
    relay.focus(ID);

    const stranger = fakeSocket();
    handle({ type: 'session_event_up', sessionId: ID, event: { type: 'state_update' } } as any,
      stranger as unknown as WebSocket);
    expect(relayed).toHaveLength(0);

    handle({ type: 'session_event_up', sessionId: ID, event: { type: 'state_update' } } as any,
      sock as unknown as WebSocket);
    expect(relayed.map((e) => e.type)).toEqual(['state_update']);
  });

  function pushState(sock: FakeSocket, state: string, extra: Record<string, unknown> = {}): void {
    handle({ type: 'session_push_state', sessionId: ID, state, ...extra } as any,
      sock as unknown as WebSocket);
  }

  it('session_push_state overlap: a pre-reconnect socket can change neither the remote registry nor the effective push-state cache', () => {
    // Worker reconnect: OLD socket still open when the NEW one registers.
    const oldSock = fakeSocket();
    register(oldSock, { ip: '127.0.0.1', remoteAttach: true });
    const newSock = fakeSocket();
    register(newSock, { ip: '127.0.0.1', remoteAttach: true });

    // The live sender seeds known state…
    pushState(newSock, 'processing', { modelName: 'opus' });
    expect(getPushState(ID)).toMatchObject({ state: 'processing' });
    expect(getRemoteSession(ID)!.state).toBe('processing');

    // …then the stale socket tries to overwrite it. In the dual-registration
    // (local + --remote-daemon) case the sessions list dedups to the LOCAL row,
    // which displays getPushState — so the aggregator cache must be
    // sender-owned too, not just the remote registry.
    pushState(oldSock, 'idle', { modelName: 'haiku' });
    expect(getPushState(ID)).toMatchObject({ state: 'processing', modelName: 'opus' });
    expect(getRemoteSession(ID)!.state).toBe('processing');

    // The live sender still updates both.
    pushState(newSock, 'awaiting_option', { permissionMode: 'acceptEdits' });
    expect(getPushState(ID)).toMatchObject({ state: 'awaiting_option' });
    expect(getRemoteSession(ID)!.state).toBe('awaiting_option');
    expect(getRemoteSession(ID)!.permissionMode).toBe('acceptEdits');
    expect(core.maybeBroadcastSessionsList).toHaveBeenCalled();
  });

  it('session_push_state from a never-registered stranger socket is fully rejected', () => {
    const sock = fakeSocket();
    register(sock, { ip: '127.0.0.1', remoteAttach: true });

    const stranger = fakeSocket();
    core.maybeBroadcastSessionsList.mockClear();
    pushState(stranger, 'processing', { modelName: 'opus' });
    expect(getPushState(ID)).toBeUndefined();
    expect(getRemoteSession(ID)!.state).toBeUndefined();
    // A rejected write is a non-change: no sessions-list broadcast.
    expect(core.maybeBroadcastSessionsList).not.toHaveBeenCalled();
  });

  it('session_push_state with no remote registration keeps the plain unguarded local path', () => {
    // A pure-local session bridge never registers in the remote registry —
    // its pushes must keep flowing into the aggregator cache unconditionally.
    const sock = fakeSocket();
    register(sock, { ip: '127.0.0.1' }); // plain local: acked, NOT remote-registered
    expect(getRemoteSession(ID)).toBeUndefined();

    pushState(sock, 'processing', { modelName: 'opus' });
    expect(getPushState(ID)).toMatchObject({ state: 'processing', modelName: 'opus' });
    expect(core.maybeBroadcastSessionsList).toHaveBeenCalled();
  });

  it('leaves non-push frames unconsumed', () => {
    const sock = fakeSocket();
    expect(handle({ type: 'deck_slot_map' } as any, sock as unknown as WebSocket)).toBe(false);
  });
});
