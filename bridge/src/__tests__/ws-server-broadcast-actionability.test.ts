import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { State } from '@agentdeck/shared';
import type { BridgeEvent } from '../types.js';

/**
 * Issue #272 step 1: "measure what the current e-ink face actually does".
 * The daemon's live daemon-stderr.log could answer HOW OFTEN a frame is
 * pushed to trmnl_75 (device_info.repaintCount/fullRefreshCount, already
 * instrumented on-device) but NOT whether any given push carried something a
 * human could act on — nothing at the daemon's one push site (`WsServer
 * .broadcast()`) recorded that. `broadcastActionability` is the one-line fix:
 * a pure classifier over the event the daemon is about to push, logged at
 * that single call site. These tests cover the classifier's truth table and
 * confirm the debug() line actually fires on every broadcast (not just that
 * the function *could* be called correctly).
 */

const debugSpy = vi.fn();
vi.mock('../logger.js', () => ({
  debug: (...args: unknown[]) => debugSpy(...args),
  log: () => {},
}));

import { WsServer, broadcastActionability } from '../ws-server.js';

describe('broadcastActionability (pure classifier)', () => {
  it('flags a state_update in an AWAITING_* state as actionable', () => {
    for (const state of [State.AWAITING_PERMISSION, State.AWAITING_OPTION, State.AWAITING_DIFF]) {
      const event = { type: 'state_update', state, permissionMode: 'default' } as BridgeEvent;
      expect(broadcastActionability(event)).toBe('actionable');
    }
  });

  it('flags a state_update in IDLE/PROCESSING/DISCONNECTED as cosmetic', () => {
    for (const state of [State.IDLE, State.PROCESSING, State.DISCONNECTED]) {
      const event = { type: 'state_update', state, permissionMode: 'default' } as BridgeEvent;
      expect(broadcastActionability(event)).toBe('cosmetic');
    }
  });

  it('flags a sessions_list carrying any awaiting session as actionable', () => {
    const event = {
      type: 'sessions_list',
      sessions: [
        { id: 'a', port: 1, projectName: 'p', alive: true, state: 'idle' },
        { id: 'b', port: 2, projectName: 'p', alive: true, state: 'awaiting_option' },
      ],
    } as unknown as BridgeEvent;
    expect(broadcastActionability(event)).toBe('actionable');
  });

  it('flags a sessions_list with no awaiting session as cosmetic', () => {
    const event = {
      type: 'sessions_list',
      sessions: [
        { id: 'a', port: 1, projectName: 'p', alive: true, state: 'idle' },
        { id: 'b', port: 2, projectName: 'p', alive: true, state: 'processing' },
      ],
    } as unknown as BridgeEvent;
    expect(broadcastActionability(event)).toBe('cosmetic');
  });

  it('flags an empty sessions_list as cosmetic, not actionable', () => {
    const event = { type: 'sessions_list', sessions: [] } as unknown as BridgeEvent;
    expect(broadcastActionability(event)).toBe('cosmetic');
  });

  it('answers n/a for event types with no session-state field', () => {
    const event = { type: 'timeline_event', entry: {}, upsert: false } as unknown as BridgeEvent;
    expect(broadcastActionability(event)).toBe('n/a');
  });
});

describe('WsServer.broadcast() emits the actionability line', () => {
  let http: Server;
  let server: WsServer;

  beforeAll(async () => {
    http = createServer();
    server = new WsServer(http);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  });

  afterAll(() => {
    server.close();
    http.close();
  });

  it('fires one debug() call per broadcast naming type, client count, and actionability', () => {
    debugSpy.mockClear();
    const event = {
      type: 'state_update',
      state: State.AWAITING_OPTION,
      permissionMode: 'default',
    } as BridgeEvent;
    server.broadcast(event);
    const lines = debugSpy.mock.calls.map((call) => call.join(' '));
    const hit = lines.find((l) => l.includes('broadcast(state_update)'));
    expect(hit).toBeDefined();
    expect(hit).toContain('actionability=actionable');
  });

  it('reports cosmetic for an idle state_update on the same push site', () => {
    debugSpy.mockClear();
    const event = { type: 'state_update', state: State.IDLE, permissionMode: 'default' } as BridgeEvent;
    server.broadcast(event);
    const hit = debugSpy.mock.calls.map((call) => call.join(' ')).find((l) => l.includes('broadcast(state_update)'));
    expect(hit).toContain('actionability=cosmetic');
  });
  it('counts attempts without clients or logging and returns isolated snapshots', () => {
    debugSpy.mockImplementation(() => {});
    const before = server.getBroadcastMetrics();
    server.onBroadcast(() => { throw new Error('serial relay unavailable'); });
    server.broadcast({ type: 'sessions_list', sessions: [
      { state: State.AWAITING_PERMISSION }, { state: State.AWAITING_OPTION },
    ] } as unknown as BridgeEvent);
    server.broadcast({ type: 'sessions_list', sessions: [] } as unknown as BridgeEvent);
    server.broadcast({ type: 'timeline_event', entry: {}, upsert: false } as unknown as BridgeEvent);
    const after = server.getBroadcastMetrics();
    expect(after.total - before.total).toBe(3);
    expect(after.actionable - before.actionable).toBe(1);
    expect(after.cosmetic - before.cosmetic).toBe(1);
    expect(after.unclassified - before.unclassified).toBe(1);
    expect(after.instanceId).toBe(before.instanceId);
    expect(after.startedAt).toBe(before.startedAt);
    expect(after.elapsedMs).toBeGreaterThanOrEqual(before.elapsedMs);
    after.actionable = -100;
    expect(server.getBroadcastMetrics().actionable).toBe(before.actionable + 1);
  });

  it('starts a new measurement identity and zero counts for a new server', async () => {
    const nextHttp = createServer();
    const next = new WsServer(nextHttp);
    await new Promise<void>((resolve) => nextHttp.listen(0, '127.0.0.1', resolve));
    try {
      const snapshot = next.getBroadcastMetrics();
      expect(snapshot.instanceId).not.toBe(server.getBroadcastMetrics().instanceId);
      expect(snapshot).toMatchObject({ total: 0, actionable: 0, cosmetic: 0, unclassified: 0 });
      expect(Number.isInteger(snapshot.startedAt)).toBe(true);
      expect(Number.isInteger(snapshot.capturedAt)).toBe(true);
      expect(Number.isInteger(snapshot.elapsedMs)).toBe(true);
    } finally {
      next.close();
      nextHttp.close();
    }
  });

});
