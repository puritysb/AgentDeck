import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import type { WebSocket } from 'ws';
import { WsServer } from '../ws-server.js';
import {
  RelayHub,
  RelayUplink,
  RELAY_PROTOCOL_VERSION,
  RELAY_ROW_TTL_MS,
  RELAY_MAX_ROWS,
  acceptRelayedCommand,
  routeRelayCommand,
  sanitizeRelayedRows,
  selectRelayableRows,
} from '../daemon-relay.js';
import type { EnrichedSession } from '../session-aggregator.js';
import type { PluginCommand } from '../types.js';

/**
 * Daemon relay (#273): a worker daemon publishes the sessions it observes to a
 * hub daemon, and the hub steers them back down the same outbound socket.
 */

const CLAUDE = 'observed:claude:11111111-2222-3333-4444-555555555555';
const CODEX = 'observed:codex:019a0000-0000-7000-8000-000000000001';

function row(id: string, extra: Partial<EnrichedSession> = {}): EnrichedSession {
  return { id, port: 0, projectName: 'demo', alive: true, controlMode: 'observed', ...extra };
}

interface FakeSocket extends Record<string, unknown> {
  readyState: number;
  send: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  emitClose: () => void;
}

function fakeSocket(): FakeSocket {
  const closeHandlers: Array<() => void> = [];
  return {
    readyState: 1,
    send: vi.fn(),
    once: vi.fn((event: string, cb: () => void) => { if (event === 'close') closeHandlers.push(cb); }),
    emitClose: () => { for (const cb of closeHandlers.splice(0)) cb(); },
  };
}

const sent = (s: FakeSocket) => s.send.mock.calls.map((c) => JSON.parse(c[0] as string));
const asWs = (s: FakeSocket) => s as unknown as WebSocket;
const hello = (instanceId: string, v = RELAY_PROTOCOL_VERSION) => ({ type: 'relay_hello', v, instanceId, host: 'worker-a' });

describe('selectRelayableRows', () => {
  it('relays observed rows only — never managed, the Gateway row, or rows received from a relay', () => {
    const rows = [
      row(CLAUDE),
      row('claude-managed-1', { controlMode: 'managed', port: 9121 }),
      row('openclaw-gateway', { controlMode: 'managed' }),
      row(CODEX),
      row('observed:claude:from-another-worker'),
    ];
    expect(selectRelayableRows(rows, new Set(['observed:claude:from-another-worker'])).map((r) => r.id))
      .toEqual([CLAUDE, CODEX]);
  });
});

describe('sanitizeRelayedRows', () => {
  it('forces the hub-local meaning of port and controlMode', () => {
    const [r] = sanitizeRelayedRows([{ id: CLAUDE, port: 9123, pid: 42, projectName: 'x', alive: true, controlMode: 'observed', liveAnswerable: true }]);
    expect(r).toMatchObject({ id: CLAUDE, port: 0, controlMode: 'observed', liveAnswerable: true });
    expect(r.pid).toBeUndefined();
  });

  it('drops malformed, duplicate and managed rows and bounds the count', () => {
    const many = Array.from({ length: RELAY_MAX_ROWS + 10 }, (_, i) => ({ id: `observed:claude:${i}` }));
    expect(sanitizeRelayedRows(many)).toHaveLength(RELAY_MAX_ROWS);
    expect(sanitizeRelayedRows([null, 7, { id: '' }, { id: CLAUDE }, { id: CLAUDE }, { id: 'm', controlMode: 'managed' }]).map((r) => r.id))
      .toEqual([CLAUDE]);
    expect(sanitizeRelayedRows('nope')).toEqual([]);
  });
});

describe('acceptRelayedCommand (worker-side allow-list)', () => {
  const ids = new Set([CLAUDE]);
  const reqs = new Set(['perm-1']);

  it('accepts observed steering for a session it is relaying', () => {
    for (const type of ['interrupt', 'escape', 'send_prompt', 'respond', 'select_option']) {
      expect(acceptRelayedCommand({ type: 'session_command', sessionId: CLAUDE, command: { type } }, ids, reqs))
        .toMatchObject({ type: 'session_command', sessionId: CLAUDE, command: { type } });
    }
    expect(acceptRelayedCommand({ type: 'select_option', sessionId: CLAUDE, index: 1 }, ids, reqs)).not.toBeNull();
    expect(acceptRelayedCommand({ type: 'permission_decision', requestId: 'perm-1', decision: 'deny' }, ids, reqs))
      .toEqual({ type: 'permission_decision', requestId: 'perm-1', decision: 'deny' });
  });

  it('refuses everything else — the hub cannot drive the worker daemon itself', () => {
    expect(acceptRelayedCommand({ type: 'session_command', sessionId: 'observed:claude:other', command: { type: 'interrupt' } }, ids, reqs)).toBeNull();
    expect(acceptRelayedCommand({ type: 'session_command', sessionId: CLAUDE, command: { type: 'switch_mode' } }, ids, reqs)).toBeNull();
    expect(acceptRelayedCommand({ type: 'session_command', sessionId: CLAUDE }, ids, reqs)).toBeNull();
    expect(acceptRelayedCommand({ type: 'permission_decision', requestId: 'perm-2', decision: 'allow' }, ids, reqs)).toBeNull();
    expect(acceptRelayedCommand({ type: 'permission_decision', requestId: 'perm-1', decision: 'maybe' }, ids, reqs)).toBeNull();
    expect(acceptRelayedCommand({ type: 'select_option', sessionId: CLAUDE }, ids, reqs)).toBeNull();
    for (const type of ['switch_agent', 'voice', 'set_session_setting', 'review_run', 'focus_session']) {
      expect(acceptRelayedCommand({ type, sessionId: CLAUDE }, ids, reqs)).toBeNull();
    }
    expect(acceptRelayedCommand(null, ids, reqs)).toBeNull();
  });
});

describe('routeRelayCommand (hub-side decision)', () => {
  const ctx = (focused: string | null = null) => ({
    owns: (id: string) => id === CLAUDE,
    ownerOfRequest: (r: string) => (r === 'perm-1' ? CLAUDE : undefined),
    focusedSessionId: focused,
    // Devices with narrow id buffers echo a truncated id; the hub restores it.
    resolveId: (raw: unknown) => (typeof raw === 'string' && CLAUDE.startsWith(raw) ? CLAUDE : String(raw)),
  });
  const cmd = (c: Record<string, unknown>) => c as unknown as PluginCommand;

  it('routes session-scoped commands for a relayed session, restoring a truncated id', () => {
    expect(routeRelayCommand(cmd({ type: 'session_command', sessionId: CLAUDE.slice(0, 31), command: { type: 'interrupt' } }), ctx()))
      .toEqual({ sessionId: CLAUDE, command: { type: 'session_command', sessionId: CLAUDE, command: { type: 'interrupt' } } });
    expect(routeRelayCommand(cmd({ type: 'select_option', sessionId: CLAUDE, index: 0 }), ctx())?.sessionId).toBe(CLAUDE);
  });

  it('routes a permission decision by the request id the relayed row carries', () => {
    expect(routeRelayCommand(cmd({ type: 'permission_decision', requestId: 'perm-1', decision: 'allow' }), ctx())?.sessionId).toBe(CLAUDE);
    expect(routeRelayCommand(cmd({ type: 'permission_decision', requestId: 'local-gate', decision: 'allow' }), ctx())).toBeNull();
  });

  it('wraps a bare command for a focused relayed session, and leaves everything else to local routing', () => {
    expect(routeRelayCommand(cmd({ type: 'interrupt' }), ctx(CLAUDE)))
      .toEqual({ sessionId: CLAUDE, command: { type: 'session_command', sessionId: CLAUDE, command: { type: 'interrupt' } } });
    expect(routeRelayCommand(cmd({ type: 'interrupt' }), ctx('observed:claude:local'))).toBeNull();
    expect(routeRelayCommand(cmd({ type: 'interrupt' }), ctx(null))).toBeNull();
    expect(routeRelayCommand(cmd({ type: 'session_command', sessionId: 'observed:claude:local', command: { type: 'interrupt' } }), ctx())).toBeNull();
    expect(routeRelayCommand(cmd({ type: 'switch_agent', agent: 'claude-code' }), ctx(CLAUDE))).toBeNull();
  });
});

describe('RelayHub', () => {
  function hub(now = { t: 1_000_000 }) {
    const onChange = vi.fn();
    const h = new RelayHub({ instanceId: 'hub-self', onChange, now: () => now.t });
    return { h, onChange, now };
  }

  it('refuses a hello from itself or from another protocol version', () => {
    const { h } = hub();
    const self = fakeSocket();
    expect(h.handleFrame(hello('hub-self'), asWs(self))).toBe(true);
    expect(sent(self)[0]).toMatchObject({ type: 'relay_refused' });
    const old = fakeSocket();
    h.handleFrame(hello('w1', RELAY_PROTOCOL_VERSION + 1), asWs(old));
    expect(sent(old)[0]).toMatchObject({ type: 'relay_refused' });
    h.handleFrame({ type: 'relay_sessions', sessions: [row(CLAUDE)] } as never, asWs(old));
    expect(h.rows()).toEqual([]);
  });

  it('serves a worker’s rows after hello, and drops them on close', () => {
    const { h, onChange } = hub();
    const w = fakeSocket();
    h.handleFrame(hello('w1'), asWs(w));
    expect(sent(w)[0]).toEqual({ type: 'relay_ack', v: RELAY_PROTOCOL_VERSION });
    h.handleFrame({ type: 'relay_sessions', sessions: [row(CLAUDE, { requestId: 'perm-1' })] } as never, asWs(w));
    expect(h.rows().map((r) => r.id)).toEqual([CLAUDE]);
    expect(h.owns(CLAUDE)).toBe(true);
    expect(h.ownerOfRequest('perm-1')).toBe(CLAUDE);
    w.emitClose();
    expect(h.rows()).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('stops serving a silent worker after the row TTL — its sessions cannot be steered', () => {
    const { h, now } = hub();
    const w = fakeSocket();
    h.handleFrame(hello('w1'), asWs(w));
    h.handleFrame({ type: 'relay_sessions', sessions: [row(CLAUDE)] } as never, asWs(w));
    now.t += RELAY_ROW_TTL_MS + 1;
    expect(h.rows()).toEqual([]);
    expect(h.owns(CLAUDE)).toBe(false);
  });

  it('a reconnecting worker supersedes its previous socket', () => {
    const { h } = hub();
    const a = fakeSocket();
    const b = fakeSocket();
    h.handleFrame(hello('w1'), asWs(a));
    h.handleFrame({ type: 'relay_sessions', sessions: [row(CLAUDE)] } as never, asWs(a));
    h.handleFrame(hello('w1'), asWs(b));
    h.handleFrame({ type: 'relay_sessions', sessions: [row(CODEX)] } as never, asWs(b));
    expect(h.rows().map((r) => r.id)).toEqual([CODEX]);
    a.emitClose(); // the old close must not remove the new registration
    expect(h.rows().map((r) => r.id)).toEqual([CODEX]);
  });

  it('routes a command down the socket of the worker that owns the session', () => {
    const { h } = hub();
    const w1 = fakeSocket();
    const w2 = fakeSocket();
    h.handleFrame(hello('w1'), asWs(w1));
    h.handleFrame(hello('w2'), asWs(w2));
    h.handleFrame({ type: 'relay_sessions', sessions: [row(CLAUDE)] } as never, asWs(w1));
    h.handleFrame({ type: 'relay_sessions', sessions: [row(CODEX)] } as never, asWs(w2));
    const id = (raw: unknown) => String(raw);
    expect(h.route({ type: 'session_command', sessionId: CODEX, command: { type: 'send_prompt', text: 'go on' } } as never, null, id)).toBe(true);
    expect(sent(w2).at(-1)).toEqual({
      type: 'relay_command_down',
      command: { type: 'session_command', sessionId: CODEX, command: { type: 'send_prompt', text: 'go on' } },
    });
    expect(sent(w1).filter((f) => f.type === 'relay_command_down')).toEqual([]);
    expect(h.route({ type: 'session_command', sessionId: 'observed:claude:local', command: { type: 'interrupt' } } as never, null, id)).toBe(false);
  });

  it('ignores relay frames on a socket that never said hello, and passes other frames through', () => {
    const { h } = hub();
    const s = fakeSocket();
    expect(h.handleFrame({ type: 'relay_sessions', sessions: [row(CLAUDE)] } as never, asWs(s))).toBe(true);
    expect(h.rows()).toEqual([]);
    expect(h.handleFrame({ type: 'deck_slot_map' }, asWs(s))).toBe(false);
  });
});

describe('relay over real sockets (worker uplink ↔ hub WsServer)', () => {
  let http: Server;
  let server: WsServer;
  let port: number;
  let relayHub: RelayHub;
  let uplink: RelayUplink;
  let roster: EnrichedSession[];
  const executed: PluginCommand[] = [];
  const logs: string[] = [];

  beforeAll(async () => {
    http = createServer();
    server = new WsServer(http);
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    port = (http.address() as { port: number }).port;
    relayHub = new RelayHub({ instanceId: 'hub', onChange: () => {} });
    server.onRawMessage((msg, ws) => relayHub.handleFrame(msg as { type?: string }, ws));

    roster = [
      row(CLAUDE, { state: 'awaiting_permission', requestId: 'perm-9', liveAnswerable: true }),
      row('claude-managed', { controlMode: 'managed', port: 9122 }),
    ];
    uplink = new RelayUplink({
      target: { host: '127.0.0.1', port },
      instanceId: 'worker',
      hostLabel: 'worker-a',
      snapshot: async () => roster,
      execute: (cmd) => executed.push(cmd),
      probeHealth: async () => ({ mode: 'daemon', daemonRelay: true }),
      log: (l) => logs.push(l),
    });
    uplink.start();
    await vi.waitFor(() => { if (!relayHub.owns(CLAUDE)) throw new Error('not relayed yet'); }, { timeout: 3000 });
  });

  afterAll(() => {
    uplink.stop();
    server.close();
    http.close();
  });

  it('publishes the worker’s observed rows over one outbound socket', () => {
    expect(relayHub.rows().map((r) => r.id)).toEqual([CLAUDE]);
    expect(relayHub.rows()[0]).toMatchObject({ state: 'awaiting_permission', requestId: 'perm-9', port: 0 });
    expect(uplink.status()).toMatchObject({ connected: true, sessions: 1 });
    expect(relayHub.summary()).toEqual([expect.objectContaining({ host: 'worker-a', sessions: 1 })]);
  });

  it('carries a deck decision down to the worker, which executes only what it accepts', async () => {
    expect(relayHub.route({ type: 'permission_decision', requestId: 'perm-9', decision: 'allow' } as never, null, String)).toBe(true);
    expect(relayHub.route({ type: 'interrupt' } as never, CLAUDE, String)).toBe(true);
    await vi.waitFor(() => { if (executed.length < 2) throw new Error('waiting'); }, { timeout: 2000 });
    expect(executed).toEqual([
      { type: 'permission_decision', requestId: 'perm-9', decision: 'allow' },
      { type: 'session_command', sessionId: CLAUDE, command: { type: 'interrupt' } },
    ]);
  });

  it('a row change reaches the hub without waiting for the heartbeat', async () => {
    roster = [row(CLAUDE, { state: 'processing' })];
    await vi.waitFor(() => {
      if (relayHub.rows()[0]?.state !== 'processing') throw new Error('stale');
    }, { timeout: 3000 });
  });
});

describe('RelayUplink refusals', () => {
  it('does not dial a hub that lacks the daemonRelay capability', async () => {
    const logs: string[] = [];
    const up = new RelayUplink({
      target: { host: '127.0.0.1', port: 1 },
      instanceId: 'w', hostLabel: 'w',
      snapshot: async () => [],
      execute: () => {},
      probeHealth: async () => ({ mode: 'daemon', sameSocketControl: true }),
      log: (l) => logs.push(l),
    });
    up.start();
    await vi.waitFor(() => { if (!up.status().refused) throw new Error('waiting'); }, { timeout: 2000 });
    up.stop();
    expect(up.status()).toMatchObject({ connected: false });
    expect(logs.join('\n')).toMatch(/daemonRelay/);
  });

  it('refuses a non-loopback hub without a pairing token', async () => {
    const up = new RelayUplink({
      target: { host: '192.0.2.10', port: 9120 },
      instanceId: 'w', hostLabel: 'w',
      snapshot: async () => [],
      execute: () => {},
      probeHealth: async () => ({ mode: 'daemon', daemonRelay: true }),
      log: () => {},
    });
    up.start();
    await vi.waitFor(() => { if (!up.status().refused) throw new Error('waiting'); }, { timeout: 2000 });
    up.stop();
    expect(up.status().refused).toMatch(/pairing token/);
  });
});
