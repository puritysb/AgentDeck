/**
 * Daemon relay — a worker machine's daemon publishes the sessions it OBSERVES
 * to a hub daemon on another machine, and the hub drives them back down the
 * same socket (#273, Discussion #278).
 *
 * This is the daemon-first counterpart of managed remote attach
 * (`agentdeck claude --remote-daemon`, `daemon-ws-client.ts` +
 * `session-push-channel.ts`). It is ADDITIVE: the managed path keeps working
 * unchanged, and nothing here replaces it.
 *
 * The properties the managed design established are kept on purpose:
 *
 * - **Opt-in.** A worker relays only when the user configured a hub
 *   (`agentdeck relay set <host[:port]>`, persisted in `relay.json`). Nothing
 *   is discovered or attached on ambient state.
 * - **Outbound only.** The worker dials the hub; commands come back down that
 *   socket. The hub never dials a worker, so an SSH-only / NAT'd worker needs
 *   no inbound reachability (an `ssh -L` forward is enough).
 * - **Capability-gated.** The worker refuses a hub whose `/health` does not
 *   advertise `daemonRelay` (the Swift daemon does not implement it).
 * - **Token-authenticated.** Non-loopback hubs require the hub's pairing
 *   token; the token is never logged.
 *
 * What is relayed is a row of the worker's own `sessions_list` — the same
 * object every deck on the worker already renders — so the hub shows a remote
 * observed session exactly as it shows a local one. What is NOT relayed:
 * managed rows (they have their own remote path), the OpenClaw Gateway row,
 * and rows the worker itself received from a relay (no loops).
 *
 * Controls are what an observed session supports on the worker: device
 * approval of a held tool gate, AskUserQuestion answers, a prompt queued for
 * the end of the turn, a stop at the next tool call, and terminal injection
 * where the worker's platform has a rung for it. The worker accepts only that
 * allow-list, and only for sessions it is currently relaying.
 */
import WebSocket from 'ws';
import { sanitizeWeightForWire } from '@agentdeck/shared';
import type { EnrichedSession } from './session-aggregator.js';
import type { PluginCommand } from './types.js';
import { debug } from './logger.js';
import { formatHostForUrl, isLoopbackHost } from './session-registry.js';

const TAG = 'relay';

/** Bumped only when an existing frame changes meaning. */
export const RELAY_PROTOCOL_VERSION = 1;
/** Worker resends its snapshot at least this often, changed or not. */
export const RELAY_SNAPSHOT_HEARTBEAT_MS = 15_000;
/** Hub forgets a worker's rows when no frame arrived for this long. */
export const RELAY_ROW_TTL_MS = 45_000;
/** Upper bound on rows accepted from one worker. */
export const RELAY_MAX_ROWS = 64;
/** Worker checks for roster changes this often. */
export const RELAY_POLL_MS = 2_000;
/** A worker whose hub stops answering pings is torn down after this long. */
export const RELAY_PONG_TIMEOUT_MS = 45_000;
/** A hub that accepts the socket but never answers relay_hello is dropped after this long. */
export const RELAY_ACK_TIMEOUT_MS = 10_000;
/** Redial delay after a refusal the user has to act on (capability, token, self-relay). */
export const RELAY_REFUSED_RETRY_MS = 60_000;
/** WS close code the hub's auth gate uses for a missing or wrong token. */
const WS_CLOSE_UNAUTHORIZED = 4001;

/**
 * Fields recomputed from other fields on every build. `elapsedSec` ticks once
 * a second (card-feed.ts excludes it for the same reason), so diffing a
 * snapshot that carries it sends — and makes the hub rebroadcast — every poll.
 * The hub derives it again from `startedAt`.
 */
const RELAY_VOLATILE_FIELDS = ['elapsedSec'] as const;

/** Inner command types a relayed `session_command` may carry. */
export const RELAY_SESSION_COMMANDS: ReadonlySet<string> = new Set([
  'interrupt', 'escape', 'send_prompt', 'respond', 'select_option',
]);

export interface RelayHello {
  type: 'relay_hello';
  v: number;
  /** Random per-process id; lets a hub refuse a relay to itself. */
  instanceId: string;
  /** Worker host label, for logs and diagnostics. */
  host: string;
}

export interface RelaySessions {
  type: 'relay_sessions';
  sessions: EnrichedSession[];
}

export interface RelayCommandDown {
  type: 'relay_command_down';
  command: PluginCommand;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Rows of the worker's roster that may leave the machine: observed sessions
 * only. `excludeIds` carries ids this daemon itself received from a relay.
 */
export function selectRelayableRows(rows: EnrichedSession[], excludeIds: ReadonlySet<string> = new Set()): EnrichedSession[] {
  return rows
    .filter((s) =>
      typeof s?.id === 'string'
      && s.id.length > 0
      && s.controlMode !== 'managed'
      && s.id !== 'openclaw-gateway'
      && !excludeIds.has(s.id))
    .map((s) => {
      const copy = { ...s } as Record<string, unknown>;
      for (const f of RELAY_VOLATILE_FIELDS) delete copy[f];
      return copy as unknown as EnrichedSession;
    });
}

// Typed allow-list for a relayed row. The hub's roster pipeline calls string
// methods on these fields (`state.startsWith`, …) and every client decodes
// them strictly, so one wrongly-typed value in a peer's row would otherwise
// throw inside the enricher and blank `sessions_list` for every device.
const RELAY_STRING_FIELDS = [
  'displayName', 'projectName', 'agentType', 'state', 'modelName', 'effortLevel',
  'permissionMode', 'startedAt', 'currentTool', 'cwd', 'currentTask', 'activity', 'goal',
  'question', 'questionDetail', 'requestId', 'reviewStatus', 'reviewRisk', 'promptType',
  'lastEventText', 'lastEventTask', 'lastEventHm',
] as const;
const RELAY_NUMBER_FIELDS = [
  'groupSize', 'contextPercent', 'totalTokens', 'queuedDirectives', 'reviewFindings',
  'askGroupIndex', 'askGroupCount', 'backgroundTaskCount',
] as const;
const RELAY_BOOLEAN_FIELDS = ['stopRequested', 'liveAnswerable'] as const;
const RELAY_OBJECT_FIELDS = ['subagents', 'coordination'] as const;
const RELAY_MAX_STRING = 4_000;
const RELAY_MAX_OPTIONS = 16;

function plainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sanitizeRelayedRow(row: Record<string, unknown>): EnrichedSession {
  const out: Record<string, unknown> = {
    id: row.id,
    port: 0,
    alive: row.alive !== false,
    controlMode: 'observed',
    projectName: 'remote',
  };
  for (const f of RELAY_STRING_FIELDS) {
    const v = row[f];
    if (typeof v === 'string' && v) out[f] = v.slice(0, RELAY_MAX_STRING);
  }
  for (const f of RELAY_NUMBER_FIELDS) {
    const v = row[f];
    if (typeof v === 'number' && Number.isFinite(v)) out[f] = v;
  }
  for (const f of RELAY_BOOLEAN_FIELDS) {
    if (typeof row[f] === 'boolean') out[f] = row[f];
  }
  for (const f of RELAY_OBJECT_FIELDS) {
    if (plainObject(row[f])) out[f] = row[f];
  }
  // An explicit null clears a CI wait on retain-on-absent clients; keep it.
  if (row.waitingOn === null || plainObject(row.waitingOn)) out.waitingOn = row.waitingOn;
  const weight = sanitizeWeightForWire(row.weight);
  if (weight !== undefined) out.weight = weight;
  if (Array.isArray(row.options)) {
    out.options = row.options
      .filter((o): o is Record<string, unknown> => plainObject(o) && typeof o.label === 'string')
      .slice(0, RELAY_MAX_OPTIONS)
      .map((o) => Object.fromEntries(Object.entries(o).filter(([, v]) =>
        typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))));
  }
  if (Array.isArray(row.foldedSessionIds)) {
    out.foldedSessionIds = row.foldedSessionIds.filter((x): x is string => typeof x === 'string').slice(0, RELAY_MAX_ROWS);
  }
  return out as unknown as EnrichedSession;
}

/**
 * Normalize rows received from a worker. They are a peer's data: bound the
 * count, require an id, and force the fields whose meaning is local to the
 * hub — a relayed session has no bridge port here and is always observed.
 */
export function sanitizeRelayedRows(raw: unknown): EnrichedSession[] {
  if (!Array.isArray(raw)) return [];
  const out: EnrichedSession[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (out.length >= RELAY_MAX_ROWS) break;
    if (!r || typeof r !== 'object') continue;
    const row = r as Record<string, unknown>;
    if (typeof row.id !== 'string' || !row.id || seen.has(row.id)) continue;
    if (row.controlMode === 'managed' || row.id === 'openclaw-gateway') continue;
    seen.add(row.id);
    out.push(sanitizeRelayedRow(row));
  }
  return out;
}

/**
 * Worker-side gate for a command that came down the relay socket. Returns the
 * command to execute, or null. Only steering an observed session supports is
 * accepted, and only for a session the worker is relaying right now.
 */
export function acceptRelayedCommand(
  cmd: unknown,
  relayedIds: ReadonlySet<string>,
  relayedRequestIds: ReadonlySet<string>,
): PluginCommand | null {
  if (!cmd || typeof cmd !== 'object') return null;
  const c = cmd as Record<string, unknown>;
  if (c.type === 'session_command') {
    const inner = c.command as Record<string, unknown> | undefined;
    if (typeof c.sessionId !== 'string' || !relayedIds.has(c.sessionId)) return null;
    if (!inner || typeof inner.type !== 'string' || !RELAY_SESSION_COMMANDS.has(inner.type)) return null;
    // Same fall-through as below for the option answers: only the observed
    // Claude route answers respond/select_option without a focused fallback.
    if ((inner.type === 'respond' || inner.type === 'select_option') && !c.sessionId.startsWith('observed:claude:')) return null;
    return { type: 'session_command', sessionId: c.sessionId, command: inner } as unknown as PluginCommand;
  }
  if (c.type === 'select_option') {
    if (typeof c.sessionId !== 'string' || !relayedIds.has(c.sessionId)) return null;
    // Only an observed Claude session answers a session-scoped select_option
    // on the daemon. For any other id the daemon's handler falls through to
    // whatever session the worker's own deck has focused — a press meant for
    // this row would land in a different session.
    if (!c.sessionId.startsWith('observed:claude:')) return null;
    if (typeof c.index !== 'number' || !Number.isInteger(c.index)) return null;
    return {
      type: 'select_option', sessionId: c.sessionId, index: c.index,
      ...(typeof c.question === 'string' ? { question: c.question } : {}),
    } as unknown as PluginCommand;
  }
  if (c.type === 'permission_decision') {
    if (typeof c.requestId !== 'string' || !relayedRequestIds.has(c.requestId)) return null;
    if (c.decision !== 'allow' && c.decision !== 'deny') return null;
    return { type: 'permission_decision', requestId: c.requestId, decision: c.decision } as unknown as PluginCommand;
  }
  return null;
}

/** Bare commands a deck sends after `focus_session` instead of a session-scoped wrapper. */
const BARE_FOCUSED_COMMANDS: ReadonlySet<string> = new Set(['interrupt', 'escape', 'send_prompt', 'respond', 'select_option']);

/**
 * Hub-side routing decision: which relayed session (if any) a device command
 * addresses, and the command to send down. Pure — the hub supplies lookups.
 */
export function routeRelayCommand(
  cmd: PluginCommand,
  ctx: {
    owns: (sessionId: string) => boolean;
    ownerOfRequest: (requestId: string) => string | undefined;
    focusedSessionId: string | null;
    resolveId: (raw: unknown) => string;
  },
): { sessionId: string; command: PluginCommand } | null {
  const c = cmd as unknown as Record<string, unknown>;
  if (c.type === 'session_command') {
    const sessionId = ctx.resolveId(c.sessionId);
    if (!sessionId || !ctx.owns(sessionId)) return null;
    return { sessionId, command: { ...c, sessionId } as unknown as PluginCommand };
  }
  if (c.type === 'select_option' && typeof c.sessionId === 'string') {
    const sessionId = ctx.resolveId(c.sessionId);
    if (!sessionId || !ctx.owns(sessionId)) return null;
    return { sessionId, command: { ...c, sessionId } as unknown as PluginCommand };
  }
  if (c.type === 'permission_decision' && typeof c.requestId === 'string') {
    const sessionId = ctx.ownerOfRequest(c.requestId);
    return sessionId ? { sessionId, command: cmd } : null;
  }
  if (typeof c.sessionId !== 'string' && BARE_FOCUSED_COMMANDS.has(String(c.type))) {
    const sessionId = ctx.focusedSessionId;
    if (!sessionId || !ctx.owns(sessionId)) return null;
    return { sessionId, command: { type: 'session_command', sessionId, command: cmd } as unknown as PluginCommand };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

interface WorkerEntry {
  instanceId: string;
  host: string;
  rows: EnrichedSession[];
  rowsJson: string;
  lastFrameAt: number;
  /** Set once the TTL sweep has announced this worker's rows as gone. */
  expiredAnnounced?: boolean;
}

export interface RelayHubOptions {
  /** This daemon's own relay instance id (a relay to oneself is refused). */
  instanceId: string;
  /** Roster changed — the daemon should rebroadcast sessions_list. */
  onChange: () => void;
  /**
   * A session this daemon itself shows. Its commands are never routed to a
   * worker: any authenticated peer can say relay_hello, and a row claiming a
   * local id must not capture that session's presses.
   */
  isLocalSession?: (sessionId: string) => boolean;
  /** A request id this daemon itself holds (a local gate or a local row's prompt). */
  isLocalRequest?: (requestId: string) => boolean;
  now?: () => number;
}

/**
 * Hub side: the registry of relayed rows, keyed by the worker socket that
 * delivered them. A socket's rows disappear when it closes, when it stops
 * sending for `RELAY_ROW_TTL_MS`, or when it sends a new snapshot.
 */
export class RelayHub {
  private readonly workers = new Map<WebSocket, WorkerEntry>();
  private readonly now: () => number;

  constructor(private readonly opts: RelayHubOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Consume a relay frame. Returns true when the frame was a relay frame. */
  handleFrame(msg: { type?: string }, sender: WebSocket): boolean {
    if (msg.type === 'relay_hello') {
      const hello = msg as Partial<RelayHello>;
      const reply = (frame: Record<string, unknown>) => {
        try { sender.send(JSON.stringify(frame)); } catch { /* closing */ }
      };
      if (hello.v !== RELAY_PROTOCOL_VERSION) {
        reply({ type: 'relay_refused', reason: `unsupported relay protocol ${String(hello.v)} (hub speaks ${RELAY_PROTOCOL_VERSION})` });
        return true;
      }
      if (typeof hello.instanceId !== 'string' || !hello.instanceId) {
        reply({ type: 'relay_refused', reason: 'missing instanceId' });
        return true;
      }
      if (hello.instanceId === this.opts.instanceId) {
        reply({ type: 'relay_refused', reason: 'this daemon is the relay worker itself' });
        return true;
      }
      const host = typeof hello.host === 'string' && hello.host
        ? hello.host.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'remote'
        : 'remote';
      // A reconnecting worker opens a new socket; its old entry (same
      // instance) is superseded so its rows never show twice.
      for (const [ws, w] of this.workers) {
        if (w.instanceId === hello.instanceId && ws !== sender) this.workers.delete(ws);
      }
      const known = this.workers.has(sender);
      this.workers.set(sender, { instanceId: hello.instanceId, host, rows: [], rowsJson: '[]', lastFrameAt: this.now() });
      if (!known) sender.once('close', () => this.dropSocket(sender));
      debug(TAG, `relay worker attached: ${host}`);
      reply({ type: 'relay_ack', v: RELAY_PROTOCOL_VERSION });
      this.opts.onChange();
      return true;
    }
    if (msg.type === 'relay_sessions') {
      const w = this.workers.get(sender);
      if (!w) return true; // no hello on this socket — ignore, consumed
      const wasExpired = this.now() - w.lastFrameAt > RELAY_ROW_TTL_MS;
      const rows = sanitizeRelayedRows((msg as Partial<RelaySessions>).sessions);
      const json = JSON.stringify(rows);
      w.lastFrameAt = this.now();
      // A heartbeat that changes nothing must not cost every device a roster.
      if (json === w.rowsJson && !wasExpired) return true;
      w.rows = rows;
      w.rowsJson = json;
      this.opts.onChange();
      return true;
    }
    return false;
  }

  dropSocket(sender: WebSocket): void {
    const w = this.workers.get(sender);
    if (!w) return;
    this.workers.delete(sender);
    debug(TAG, `relay worker detached: ${w.host}`);
    this.opts.onChange();
  }

  /**
   * Announce rows that just aged out. TTL expiry is noticed on read, so
   * without a sweep a silent worker's rows would linger on devices until an
   * unrelated broadcast. Returns true when anything expired.
   */
  sweep(): boolean {
    const now = this.now();
    let expired = false;
    for (const w of this.workers.values()) {
      const stale = now - w.lastFrameAt > RELAY_ROW_TTL_MS;
      if (stale && !w.expiredAnnounced && w.rows.length > 0) {
        w.expiredAnnounced = true;
        expired = true;
      } else if (!stale) {
        w.expiredAnnounced = false;
      }
    }
    if (expired) this.opts.onChange();
    return expired;
  }

  /** Live relayed rows. Rows of a worker that went silent are not served. */
  rows(): EnrichedSession[] {
    const now = this.now();
    const out: EnrichedSession[] = [];
    const seen = new Set<string>();
    for (const w of this.workers.values()) {
      if (now - w.lastFrameAt > RELAY_ROW_TTL_MS) continue;
      for (const r of w.rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
      }
    }
    return out;
  }

  /** Ids this hub received from a relay — never relayed onward. */
  relayedIds(): Set<string> {
    return new Set(this.rows().map((r) => r.id));
  }

  owns(sessionId: string): boolean {
    if (this.opts.isLocalSession?.(sessionId)) return false;
    return this.socketFor(sessionId) !== undefined;
  }

  ownerOfRequest(requestId: string): string | undefined {
    if (this.opts.isLocalRequest?.(requestId)) return undefined;
    for (const r of this.rows()) {
      if (r.requestId === requestId && this.owns(r.id)) return r.id;
    }
    return undefined;
  }

  /**
   * Route a device command to the worker that owns its session. Returns true
   * when the command was a relayed session's and was handed down (or could
   * not be — a silent worker's session is not anyone else's to handle).
   */
  route(
    cmd: PluginCommand,
    focusedSessionId: string | null,
    resolveId: (raw: unknown) => string,
  ): boolean {
    const decision = routeRelayCommand(cmd, {
      owns: (id) => this.owns(id),
      ownerOfRequest: (id) => this.ownerOfRequest(id),
      focusedSessionId,
      resolveId,
    });
    if (!decision) return false;
    const ws = this.socketFor(decision.sessionId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      debug(TAG, `relayed ${String((cmd as { type?: unknown }).type)} for ${decision.sessionId.slice(0, 24)} dropped: worker not connected`);
      return true;
    }
    const frame: RelayCommandDown = { type: 'relay_command_down', command: decision.command };
    try { ws.send(JSON.stringify(frame)); } catch { /* closing */ }
    debug(TAG, `relayed ${String((decision.command as { type?: unknown }).type)} → ${decision.sessionId.slice(0, 24)}`);
    return true;
  }

  /** Diagnostic summary for `/health`-style surfaces. */
  summary(): Array<{ host: string; sessions: number; ageMs: number }> {
    const now = this.now();
    return [...this.workers.values()].map((w) => ({ host: w.host, sessions: w.rows.length, ageMs: now - w.lastFrameAt }));
  }

  private socketFor(sessionId: string): WebSocket | undefined {
    const now = this.now();
    for (const [ws, w] of this.workers) {
      if (now - w.lastFrameAt > RELAY_ROW_TTL_MS) continue;
      if (w.rows.some((r) => r.id === sessionId)) return ws;
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface RelayTarget {
  host: string;
  port: number;
  token?: string;
}

export interface RelayUplinkOptions {
  target: RelayTarget;
  instanceId: string;
  hostLabel: string;
  /** The worker's current roster (the sessions_list pipeline, unbroadcast). */
  snapshot: () => Promise<EnrichedSession[]>;
  /** Ids this daemon received from a relay itself — never sent onward. */
  excludeIds?: () => ReadonlySet<string>;
  /** Run an accepted command through the daemon's own device-command path. */
  execute: (cmd: PluginCommand) => void;
  /** Confirms the hub advertises `daemonRelay` before each dial. */
  probeHealth: (host: string, port: number) => Promise<Record<string, unknown> | null>;
  log: (line: string) => void;
}

/** Worker side: one outbound socket to the hub, kept alive with backoff. */
export class RelayUplink {
  private ws: WebSocket | null = null;
  private closed = false;
  private acked = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 2_000;
  private lastSentJson = '';
  private lastSentAt = 0;
  private lastPongAt = 0;
  private relayedIds = new Set<string>();
  private relayedRequestIds = new Set<string>();
  private refusedReason: string | null = null;
  private refusedUntilRetry = false;
  private ackTimer: NodeJS.Timeout | null = null;
  private sending = false;

  constructor(private readonly opts: RelayUplinkOptions) {}

  start(): void {
    this.closed = false;
    void this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.disposeSocket();
  }

  status(): { connected: boolean; target: string; sessions: number; refused?: string } {
    return {
      connected: this.acked && this.ws?.readyState === WebSocket.OPEN,
      target: `${this.opts.target.host}:${this.opts.target.port}`,
      sessions: this.relayedIds.size,
      ...(this.refusedReason ? { refused: this.refusedReason } : {}),
    };
  }

  /** Send the roster now if it changed (also called after each command). */
  async pushSnapshot(force = false): Promise<void> {
    if (!this.acked || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.sending) return;
    this.sending = true;
    try {
      const rows = selectRelayableRows(await this.opts.snapshot(), this.opts.excludeIds?.() ?? new Set());
      const json = JSON.stringify(rows);
      const due = Date.now() - this.lastSentAt >= RELAY_SNAPSHOT_HEARTBEAT_MS;
      if (!force && !due && json === this.lastSentJson) return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.ws.send(`{"type":"relay_sessions","sessions":${json}}`);
      this.lastSentJson = json;
      this.lastSentAt = Date.now();
      this.relayedIds = new Set(rows.map((r) => r.id));
      this.relayedRequestIds = new Set(rows.map((r) => r.requestId).filter((x): x is string => typeof x === 'string'));
    } catch (err) {
      debug(TAG, `snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.sending = false;
    }
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const { host, port, token } = this.opts.target;
    const label = `${formatHostForUrl(host)}:${port}`;
    const health = await this.opts.probeHealth(host, port).catch(() => null);
    if (this.closed) return;
    if (!health || health.mode !== 'daemon') {
      debug(TAG, `hub ${label} not answering /health — retrying`);
      this.scheduleReconnect();
      return;
    }
    if (health.daemonRelay !== true) {
      this.setRefused(`hub ${label} does not support the daemon relay (no daemonRelay capability — a current Node CLI daemon is required)`);
      this.scheduleReconnect(RELAY_REFUSED_RETRY_MS);
      return;
    }
    if (!isLoopbackHost(host) && !token) {
      this.setRefused(`no pairing token for hub ${label} — run \`agentdeck relay set ${label} --token <token>\` (the value is in ~/.agentdeck/auth-token on the hub)`);
      this.scheduleReconnect(RELAY_REFUSED_RETRY_MS);
      return;
    }
    // Loopback (an ssh -L forward included) is same-machine to the listener
    // and needs no token. Never log the URL: it can carry the token.
    const url = isLoopbackHost(host)
      ? `ws://127.0.0.1:${port}`
      : `ws://${label}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    debug(TAG, `connecting to hub ws://${label} (token: ${token ? 'yes' : 'no'})`);
    const ws = new WebSocket(url, { handshakeTimeout: 5_000 });
    this.ws = ws;

    ws.on('open', () => {
      this.lastPongAt = Date.now();
      const hello: RelayHello = {
        type: 'relay_hello', v: RELAY_PROTOCOL_VERSION,
        instanceId: this.opts.instanceId, host: this.opts.hostLabel,
      };
      ws.send(JSON.stringify(hello));
      // Peer silence is a signal: a hub that took the socket and never
      // answers the hello is torn down and redialed, not waited on forever.
      this.ackTimer = setTimeout(() => {
        if (this.ws === ws && !this.acked) {
          debug(TAG, `hub ${label} did not answer relay_hello within ${RELAY_ACK_TIMEOUT_MS} ms`);
          ws.terminate();
        }
      }, RELAY_ACK_TIMEOUT_MS);
      this.ackTimer.unref?.();
    });
    ws.on('pong', () => { this.lastPongAt = Date.now(); });
    ws.on('message', (raw: Buffer | string) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
      if (msg.type === 'relay_ack') {
        if (this.ackTimer) clearTimeout(this.ackTimer);
        this.ackTimer = null;
        this.acked = true;
        this.refusedReason = null;
        this.reconnectDelay = 2_000;
        this.opts.log(`[relay] publishing observed sessions to hub ${label}`);
        this.startTimers();
        void this.pushSnapshot(true);
        return;
      }
      if (msg.type === 'relay_refused') {
        this.setRefused(`hub ${label} refused the relay: ${String(msg.reason ?? 'no reason').slice(0, 200)}`);
        this.refusedUntilRetry = true;
        ws.close();
        return;
      }
      if (msg.type === 'relay_command_down') {
        const accepted = acceptRelayedCommand(msg.command, this.relayedIds, this.relayedRequestIds);
        if (!accepted) {
          debug(TAG, `refused relayed command ${String((msg.command as { type?: unknown } | undefined)?.type)}`);
          return;
        }
        try { this.opts.execute(accepted); } catch (err) {
          debug(TAG, `relayed command failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Answer fast: the state a press produced should reach the hub on the
        // next tick rather than the next poll.
        setTimeout(() => { void this.pushSnapshot(true); }, 150);
      }
    });
    ws.on('close', (code: number) => {
      if (this.ws !== ws) return;
      const wasAcked = this.acked;
      this.disposeSocket();
      if (code === WS_CLOSE_UNAUTHORIZED) {
        this.setRefused(`hub ${label} rejected the pairing token — run \`agentdeck relay set ${label} --token <token>\` with the value in ~/.agentdeck/auth-token on the hub`);
        this.refusedUntilRetry = true;
      } else if (wasAcked) {
        this.opts.log(`[relay] hub ${label} disconnected — reconnecting`);
      }
      const refused = this.refusedUntilRetry;
      this.refusedUntilRetry = false;
      this.scheduleReconnect(refused ? RELAY_REFUSED_RETRY_MS : undefined);
    });
    ws.on('error', (err) => {
      debug(TAG, `hub socket error: ${err.message}`);
    });
  }

  private startTimers(): void {
    this.stopTimers();
    this.pollTimer = setInterval(() => { void this.pushSnapshot(); }, RELAY_POLL_MS);
    this.pollTimer.unref?.();
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Peer silence is a signal: a half-open link answers no pings, and
      // without this the worker would believe it is publishing forever.
      if (Date.now() - this.lastPongAt > RELAY_PONG_TIMEOUT_MS) {
        debug(TAG, 'hub stopped answering pings — tearing the link down');
        ws.terminate();
        return;
      }
      try { ws.ping(); } catch { /* closing */ }
    }, RELAY_SNAPSHOT_HEARTBEAT_MS);
    this.pingTimer.unref?.();
  }

  private stopTimers(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pollTimer = null;
    this.pingTimer = null;
  }

  private setRefused(reason: string): void {
    if (this.refusedReason !== reason) this.opts.log(`[relay] ${reason}`);
    this.refusedReason = reason;
  }

  private disposeSocket(): void {
    this.stopTimers();
    if (this.ackTimer) clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.acked = false;
    this.lastSentJson = '';
    this.lastSentAt = 0;
    this.relayedIds = new Set();
    this.relayedRequestIds = new Set();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners('message');
      ws.removeAllListeners('close');
      ws.on('error', () => {});
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = delayMs ?? this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
