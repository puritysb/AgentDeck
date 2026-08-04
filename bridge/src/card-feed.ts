/**
 * Card Feed pull sync (M6) — the HTTP counterpart to the WS live mode for
 * wake-sync-sleep battery clients (XTeink X3/X4). Pure builders/appliers; the
 * HTTP routes live in daemon-server.ts. Contract: shared/src/protocol.ts
 * § Card Feed Pull Sync + docs/esp32-client-contract.md § Pull sync.
 *
 * M6 derives every card from a live session (the same rows `sessions_list`
 * broadcasts). M7 generalizes to daemon card modules (NUDGE / QUEST / …) that
 * will produce `day`-class cards; until then no producer emits `day`.
 */

import type {
  SessionInfo,
  FeedCard,
  CardFeedResponse,
  CardFeedGlance,
  GlanceEvent,
  GlanceUsageRow,
  GlanceWeather,
  OutboxDecision,
  OutboxDecisionResult,
  OutboxPushRequest,
  OutboxPushResponse,
} from '@agentdeck/shared';
import {
  CARD_FEED_IDLE_PULL_SEC,
  CARD_FEED_ACTIVE_PULL_SEC,
  GLANCE_MAX_WRAPUP_LINES,
  GLANCE_MAX_USAGE_ROWS,
  GLANCE_LINE_MAX_BYTES,
} from '@agentdeck/shared';
import type { UsageEvent } from './types.js';
import {
  buildModuleCards,
  applyModuleChoice,
  DEFAULT_CARD_MODULES,
  type CardModule,
} from './card-modules.js';

/** A pulled permission gate is answerable only while the PreToolUse long-poll
 *  still holds the hook open (~60s) — pulled copies are honest about that. */
export const PERMISSION_GATE_TTL_MS = 60_000;
/** Awaiting PTY prompts stay interactive until the awaiting backstop reaps
 *  them (AWAITING_STUCK_TIMEOUT_MS) — same 10 min bound. */
export const AWAITING_PROMPT_TTL_MS = 10 * 60 * 1000;

const isAwaitingState = (s: SessionInfo): boolean =>
  typeof s.state === 'string' && s.state.startsWith('awaiting');

/** Offline-validity class for a session-derived card. Permission gates and
 *  interactive prompts are `live` (grey out offline, TTL-expire); everything
 *  else is a read-only `info` row. */
export function classifySessionCard(
  s: SessionInfo,
  now: number,
): Pick<FeedCard, 'actionClass' | 'expiresAt'> {
  if (s.requestId) return { actionClass: 'live', expiresAt: now + PERMISSION_GATE_TTL_MS };
  if (isAwaitingState(s)) return { actionClass: 'live', expiresAt: now + AWAITING_PROMPT_TTL_MS };
  return { actionClass: 'info' };
}

// ===== Glance (sleep dashboard) builders =====

/** UTF-8 byte-budget trim on a rune boundary — the device caps are bytes,
 *  never code points (CJK is 3 bytes/char). */
export function trimUtf8Bytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  let bytes = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > maxBytes - 1) break; // reserve one byte for the ellipsis dot
    out += ch;
    bytes += b;
  }
  return `${out.trimEnd()}.`;
}

const hmFromIso = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const pct = (n?: number): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : undefined;

/** Provider quota rows from the daemon's aggregate usage event. Claude first
 *  (the primary subscription on this product), then Codex. A provider with no
 *  numbers at all gets no row — the glance never renders an empty gauge. */
export function buildGlanceUsage(usage: UsageEvent | undefined): GlanceUsageRow[] {
  if (!usage) return [];
  const rows: GlanceUsageRow[] = [];
  const claude5h = pct(usage.fiveHourPercent);
  const claude7d = pct(usage.sevenDayPercent);
  if (claude5h !== undefined || claude7d !== undefined) {
    rows.push({
      provider: 'claude',
      label: 'Claude',
      ...(claude5h !== undefined ? { primaryPercent: claude5h } : {}),
      ...(hmFromIso(usage.fiveHourResetsAt) ? { primaryResetHm: hmFromIso(usage.fiveHourResetsAt) } : {}),
      ...(claude7d !== undefined ? { secondaryPercent: claude7d } : {}),
      stale: usage.usageStale === true,
    });
  }
  const rl = usage.codexRateLimits;
  const codex5h = pct(rl?.primary?.usedPercent);
  const codex7d = pct(rl?.secondary?.usedPercent);
  if (codex5h !== undefined || codex7d !== undefined) {
    rows.push({
      provider: 'codex',
      label: 'Codex',
      ...(codex5h !== undefined ? { primaryPercent: codex5h } : {}),
      ...(hmFromIso(rl?.primary?.resetsAt) ? { primaryResetHm: hmFromIso(rl?.primary?.resetsAt) } : {}),
      ...(codex7d !== undefined ? { secondaryPercent: codex7d } : {}),
      stale: rl?.primary?.stale === true && (codex7d === undefined || rl?.secondary?.stale === true),
    });
  }
  return rows.slice(0, GLANCE_MAX_USAGE_ROWS);
}

const wrapupStateWord = (s: SessionInfo): string => {
  if (s.requestId) return 'needs approval';
  if (isAwaitingState(s)) return 'needs you';
  if (s.state === 'processing') return 'working';
  if (s.state === 'error') return 'error';
  return 'idle';
};

/** Work wrap-up lines — "what was being worked on", one line per session,
 *  attention first. Pre-trimmed to the device byte budget; the renderer only
 *  draws. */
export function buildGlanceWrapup(sessions: SessionInfo[]): string[] {
  const rank = (s: SessionInfo): number =>
    s.requestId ? 0 : isAwaitingState(s) ? 1 : s.state === 'processing' ? 2 : 3;
  const ordered = [...sessions].sort((a, b) => rank(a) - rank(b));
  const lines: string[] = [];
  const overflow = ordered.length - GLANCE_MAX_WRAPUP_LINES;
  const take = overflow > 0 ? GLANCE_MAX_WRAPUP_LINES - 1 : ordered.length;
  for (const s of ordered.slice(0, take)) {
    const what = (typeof s.activity === 'string' && s.activity.trim())
      || (typeof s.currentTask === 'string' && s.currentTask.trim())
      || wrapupStateWord(s);
    lines.push(trimUtf8Bytes(`${s.projectName} · ${what}`, GLANCE_LINE_MAX_BYTES));
  }
  if (overflow > 0) lines.push(`+${ordered.length - take} more sessions`);
  return lines;
}

export function buildGlance(input: {
  sessions: SessionInfo[];
  usage?: UsageEvent;
  weather?: GlanceWeather;
  events?: GlanceEvent[];
}): CardFeedGlance | undefined {
  const glance: CardFeedGlance = {};
  if (input.weather) glance.weather = input.weather;
  const usage = buildGlanceUsage(input.usage);
  if (usage.length > 0) glance.usage = usage;
  const wrapup = buildGlanceWrapup(input.sessions);
  if (wrapup.length > 0) glance.wrapup = wrapup;
  if (input.events && input.events.length > 0) glance.events = input.events;
  return Object.keys(glance).length > 0 ? glance : undefined;
}

// ===== Conditional pull — the content signature =====

/** Fields excluded from the deck signature because they are derived from the
 *  CURRENT CLOCK rather than from content. Any such field makes the signature
 *  change on every build, so the conditional pull can never match and the whole
 *  feature silently does nothing:
 *
 *  - `FeedCard.expiresAt` — re-stamped `now + TTL` on every build.
 *  - `SessionInfo.elapsedSec` — ticks once a second (measured: an otherwise
 *    idle roster produced a fresh signature every second, 2026-07-31).
 *
 *  A device that short-circuits therefore keeps a slightly stale elapsed time
 *  in its cached deck. That is the correct trade: the cache is explicitly a
 *  snapshot and renders its own sync age, whereas a signature that never
 *  stabilizes costs a full feed on every wake forever.
 *
 *  When adding a field to `SessionInfo`, ask whether it is a function of the
 *  clock; if it is, it belongs here. */
const VOLATILE_SESSION_FIELDS = ['elapsedSec'] as const;

/** FNV-1a 32-bit over the canonical feed content: cards with volatile fields
 *  stripped (see `VOLATILE_SESSION_FIELDS`) plus the glance verbatim. Matching
 *  sigs mean the device's cached deck is still exactly what the daemon would
 *  send. */
export function computeDeckSig(cards: FeedCard[], glance?: CardFeedGlance): string {
  const canonical = JSON.stringify({
    cards: cards.map(({ expiresAt: _volatile, session, ...rest }) => {
      if (!session) return rest;
      const stable = { ...session } as Record<string, unknown>;
      for (const f of VOLATILE_SESSION_FIELDS) delete stable[f];
      return { ...rest, session: stable };
    }),
    glance: glance ?? null,
  });
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface BuildCardFeedOpts {
  /** Sleep-dashboard summary to embed (and cover with the signature). */
  glance?: CardFeedGlance;
  /** `?sig=` echo from the device — when it matches the current signature the
   *  response short-circuits to `unchanged: true` with empty cards. */
  echoSig?: string;
}

export function buildCardFeed(
  sessions: SessionInfo[],
  now: number = Date.now(),
  modules: CardModule[] = DEFAULT_CARD_MODULES,
  opts: BuildCardFeedOpts = {},
): CardFeedResponse {
  const cards: FeedCard[] = sessions.map((s) => ({
    cardId: `session:${s.id}`,
    ...classifySessionCard(s, now),
    session: s,
  }));
  // Module cards (M7) come after the session projections: what is happening
  // outranks what the daemon wants to say about it. A client that predates
  // modules skips bodies it doesn't recognise.
  cards.push(...buildModuleCards({ sessions, now }, modules));
  const active = sessions.some((s) => s.state === 'processing' || isAwaitingState(s));
  const d = new Date(now);
  const serverHm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const deckSig = computeDeckSig(cards, opts.glance);
  const base = {
    type: 'card_feed' as const,
    rev: 1 as const,
    serverTime: now,
    serverHm,
    nextPullSec: active ? CARD_FEED_ACTIVE_PULL_SEC : CARD_FEED_IDLE_PULL_SEC,
    deckSig,
  };
  if (opts.echoSig && opts.echoSig === deckSig) {
    // Conditional-pull short-circuit: the device keeps its cached deck, skips
    // parse/persist, and re-sleeps immediately. serverTime/nextPullSec still
    // ride along — the clock re-anchor and the cadence are per-pull, not
    // per-content.
    return { ...base, unchanged: true, cards: [] };
  }
  return { ...base, ...(opts.glance ? { glance: opts.glance } : {}), cards };
}

export interface OutboxApplyDeps {
  /** Current enriched roster — validity checks run against *live* state. */
  sessions: SessionInfo[];
  /** Whether a permission gate is still held open (permission-resolver). */
  isPendingRequest(requestId: string): boolean;
  /** The daemon's device-command dispatch (handleDeviceCommand). Routing is
   *  fire-and-forget, so `applied` means accepted-for-delivery. */
  dispatch(cmd: Record<string, unknown>): void;
  now?: number;
  /** Card modules a `card_choice` may route to (M7). Defaults to the
   *  registered set — overridden in tests. */
  modules?: CardModule[];
}

const OUTBOX_ACTIONS = new Set([
  'permission_decision', 'select_option', 'respond', 'send_prompt', 'dismiss', 'card_choice',
]);

function sessionIdOf(d: OutboxDecision): string | undefined {
  if (typeof d.sessionId === 'string' && d.sessionId) return d.sessionId;
  if (typeof d.cardId === 'string' && d.cardId.startsWith('session:')) return d.cardId.slice('session:'.length);
  return undefined;
}

function applyOne(d: OutboxDecision, deps: OutboxApplyDeps): OutboxDecisionResult {
  const cardId = typeof d.cardId === 'string' ? d.cardId : '';
  const fail = (status: OutboxDecisionResult['status'], reason: string): OutboxDecisionResult =>
    ({ cardId, status, reason });
  if (!cardId || typeof d.action !== 'string' || !OUTBOX_ACTIONS.has(d.action)) {
    return fail('rejected', 'malformed decision');
  }
  // Device-local dismissal — acknowledged so the device can drop it; the
  // daemon has nothing to mutate (dismissal memory lives on the device).
  if (d.action === 'dismiss') return { cardId, status: 'applied' };

  // Module card (M7): the authoring module owns what the choice means. This is
  // the `day` class in practice — the press may have happened hours ago and
  // offline, so nothing here is validated against live session state.
  if (d.action === 'card_choice') {
    const outcome = applyModuleChoice(d, { sessions: deps.sessions, now: deps.now ?? Date.now() }, deps.modules);
    return { cardId, status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  }

  if (d.action === 'permission_decision') {
    if (typeof d.requestId !== 'string' || !d.requestId || (d.decision !== 'allow' && d.decision !== 'deny')) {
      return fail('rejected', 'requestId and decision required');
    }
    // A gate that is no longer held must NOT be re-resolved — the terminal
    // already answered it, or the hook long-poll gave up. Honest expiry.
    if (!deps.isPendingRequest(d.requestId)) return fail('expired', 'permission gate no longer pending');
    deps.dispatch({ type: 'permission_decision', requestId: d.requestId, decision: d.decision });
    return { cardId, status: 'applied' };
  }

  const sessionId = sessionIdOf(d);
  if (!sessionId) return fail('rejected', 'sessionId required');
  const session = deps.sessions.find((s) => s.id === sessionId);
  if (!session) return fail('unknown_card', 'session not in current roster');

  if (d.action === 'select_option' || d.action === 'respond') {
    // Option decisions answer a *specific* prompt. The session must still be
    // awaiting, and when the device echoed the question it must match the
    // session's current one — an hour-old index must never press a different,
    // newer prompt.
    if (!isAwaitingState(session) && !session.requestId) {
      return fail('expired', 'session is no longer awaiting');
    }
    if (typeof d.question === 'string' && d.question && session.question && d.question !== session.question) {
      return fail('expired', 'prompt changed since the decision was recorded');
    }
    if (d.action === 'select_option') {
      if (typeof d.index !== 'number' || !Number.isInteger(d.index) || d.index < 0) {
        return fail('rejected', 'index required');
      }
      deps.dispatch({ type: 'select_option', index: d.index, sessionId });
    } else {
      if (typeof d.value !== 'string' || !d.value) return fail('rejected', 'value required');
      deps.dispatch({ type: 'session_command', sessionId, command: { type: 'respond', value: d.value } });
    }
    return { cardId, status: 'applied' };
  }

  // send_prompt — deliverable to any alive session; observed sessions queue
  // it as a turn-end directive via the session_command steering path.
  if (typeof d.text !== 'string' || !d.text) return fail('rejected', 'text required');
  deps.dispatch({ type: 'session_command', sessionId, command: { type: 'send_prompt', text: d.text } });
  return { cardId, status: 'applied' };
}

// ===== Pull observability — the only trace a sleeping client leaves =====
//
// A wake-sync-sleep client that has nothing queued sends exactly one request
// per wake: `GET /feed`. It carries no board id and no body, so without this
// the daemon cannot answer the question the power ladder is judged by — *did
// the timer wake actually fire, and how far did the internal clock drift?*
// The tracker turns each pull into that measurement by comparing the gap
// against the cadence the daemon itself advertised on the previous pull.

/** Observed cadence within this fraction of the advertised `nextPullSec`
 *  counts as honoured — the device really slept and its timer really woke it.
 *  The XTeink boards run a drifty internal timer (no usable RTC alarm), so
 *  the band is generous; anything outside it is a wake worth looking at. */
export const PULL_CADENCE_TOLERANCE = 0.25;

export interface FeedPullEvent {
  /** Client IP — the only identity a `GET /feed` carries. */
  client: string;
  /** Board id, learned from an outbox push or the WiFi WS registry. */
  board?: string;
  at: number;
  cards: number;
  /** Cadence advertised to this client on *this* pull. */
  nextPullSec: number;
  /** Seconds since this client's previous pull. Absent on its first pull. */
  sinceLastSec?: number;
  /** Cadence advertised on the previous pull — what the gap should have been. */
  expectedSec?: number;
  /** Signed relative error of the observed gap, 3 decimals (+0.01 = 1% late). */
  driftPct?: number;
  /** Gap within `PULL_CADENCE_TOLERANCE` of the advertised cadence. */
  cadenceHonoured?: boolean;
  /** Conditional pull answered `unchanged` — the deck signature matched. */
  unchanged?: boolean;
  /** Device telemetry from the `GET /feed` query string (`batt`/`mv`/`rssi`) —
   *  the only battery/link observability a wake-sync-sleep device has. */
  battPct?: number;
  battMv?: number;
  rssiDbm?: number;
}

export interface FeedPullClient {
  client: string;
  board?: string;
  pulls: number;
  firstPullAt: number;
  lastPullAt: number;
  /** Cadence advertised on the most recent pull. */
  lastNextPullSec: number;
  lastIntervalSec?: number;
  /** Median observed interval — the device's effective cadence. */
  medianIntervalSec?: number;
  /** Intervals that landed inside the tolerance band, out of `pulls - 1`. */
  cadenceHonouredCount: number;
  /** Latest reported telemetry (absent until the device sends it). */
  lastBattPct?: number;
  lastBattMv?: number;
  lastRssiDbm?: number;
  /** Pulls answered `unchanged` — how often the conditional pull saved work. */
  unchangedCount: number;
}

/** `::ffff:192.168.68.77` and `::1` are the same peers as their v4 forms. */
export function normalizeClientIp(ip: string): string {
  const s = (ip || '').trim();
  if (s.startsWith('::ffff:')) return s.slice('::ffff:'.length);
  if (s === '::1') return '127.0.0.1';
  return s;
}

interface PullState {
  board?: string;
  pulls: number;
  firstPullAt: number;
  lastPullAt: number;
  lastNextPullSec: number;
  lastIntervalSec?: number;
  intervals: number[];
  cadenceHonouredCount: number;
  lastBattPct?: number;
  lastBattMv?: number;
  lastRssiDbm?: number;
  unchangedCount: number;
}

/** Telemetry that rides the `GET /feed` query string. */
export interface PullTelemetry {
  battPct?: number;
  battMv?: number;
  rssiDbm?: number;
}

/** Parse `batt`/`mv`/`rssi` query params, dropping anything non-numeric or
 *  out of physical range — telemetry is advisory, never trusted blindly. */
export function parsePullTelemetry(params: URLSearchParams): PullTelemetry {
  const out: PullTelemetry = {};
  const batt = Number(params.get('batt'));
  if (Number.isFinite(batt) && batt >= 0 && batt <= 100) out.battPct = Math.round(batt);
  const mv = Number(params.get('mv'));
  if (Number.isFinite(mv) && mv > 0 && mv < 10000) out.battMv = Math.round(mv);
  const rssi = Number(params.get('rssi'));
  if (Number.isFinite(rssi) && rssi >= -120 && rssi < 0) out.rssiDbm = Math.round(rssi);
  return out;
}

/** In-memory (daemon-lifetime) record of card-feed pulls, keyed by client IP.
 *  Deliberately not persisted: it answers "is the cadence working *now*". */
export class FeedPullTracker {
  private readonly states = new Map<string, PullState>();
  private readonly history: FeedPullEvent[] = [];
  private readonly historyLimit: number;
  /** Kept past the WiFi registry's 1h TTL: a client that sleeps for an hour
   *  ages out of the roster but must not lose its name here. */
  private readonly boards = new Map<string, string>();
  private readonly intervalWindow = 16;

  constructor(opts: { historyLimit?: number } = {}) {
    this.historyLimit = opts.historyLimit ?? 32;
  }

  /** Bind a board id to a client IP (outbox `board`, or a WiFi WS lookup). */
  noteBoard(client: string, board?: string): void {
    const ip = normalizeClientIp(client);
    if (!ip || !board) return;
    this.boards.set(ip, board);
    const st = this.states.get(ip);
    if (st) st.board = board;
  }

  record(
    client: string,
    info: { cards: number; nextPullSec: number; now?: number; unchanged?: boolean; telemetry?: PullTelemetry },
  ): FeedPullEvent {
    const ip = normalizeClientIp(client);
    const at = info.now ?? Date.now();
    const prev = this.states.get(ip);
    const board = this.boards.get(ip) ?? prev?.board;

    const event: FeedPullEvent = { client: ip, at, cards: info.cards, nextPullSec: info.nextPullSec };
    if (board) event.board = board;
    if (info.unchanged) event.unchanged = true;
    const tel = info.telemetry;
    if (tel?.battPct !== undefined) event.battPct = tel.battPct;
    if (tel?.battMv !== undefined) event.battMv = tel.battMv;
    if (tel?.rssiDbm !== undefined) event.rssiDbm = tel.rssiDbm;

    if (prev) {
      const sinceLastSec = Math.round((at - prev.lastPullAt) / 1000);
      event.sinceLastSec = sinceLastSec;
      const expectedSec = prev.lastNextPullSec;
      if (expectedSec > 0) {
        event.expectedSec = expectedSec;
        event.driftPct = Math.round(((sinceLastSec - expectedSec) / expectedSec) * 1000) / 1000;
        event.cadenceHonoured = Math.abs(event.driftPct) <= PULL_CADENCE_TOLERANCE;
      }
      prev.pulls += 1;
      prev.lastPullAt = at;
      prev.lastNextPullSec = info.nextPullSec;
      prev.lastIntervalSec = sinceLastSec;
      prev.intervals.push(sinceLastSec);
      if (prev.intervals.length > this.intervalWindow) prev.intervals.shift();
      if (event.cadenceHonoured) prev.cadenceHonouredCount += 1;
      if (board) prev.board = board;
      if (info.unchanged) prev.unchangedCount += 1;
      if (tel?.battPct !== undefined) prev.lastBattPct = tel.battPct;
      if (tel?.battMv !== undefined) prev.lastBattMv = tel.battMv;
      if (tel?.rssiDbm !== undefined) prev.lastRssiDbm = tel.rssiDbm;
    } else {
      this.states.set(ip, {
        board,
        pulls: 1,
        firstPullAt: at,
        lastPullAt: at,
        lastNextPullSec: info.nextPullSec,
        intervals: [],
        cadenceHonouredCount: 0,
        unchangedCount: info.unchanged ? 1 : 0,
        ...(tel?.battPct !== undefined ? { lastBattPct: tel.battPct } : {}),
        ...(tel?.battMv !== undefined ? { lastBattMv: tel.battMv } : {}),
        ...(tel?.rssiDbm !== undefined ? { lastRssiDbm: tel.rssiDbm } : {}),
      });
    }

    this.history.push(event);
    if (this.history.length > this.historyLimit) this.history.shift();
    return event;
  }

  /** Most recent pulls, newest first. */
  recent(limit = 8): FeedPullEvent[] {
    return this.history.slice(-limit).reverse();
  }

  clients(): FeedPullClient[] {
    const out: FeedPullClient[] = [];
    for (const [client, st] of this.states) {
      const sorted = [...st.intervals].sort((a, b) => a - b);
      const median = sorted.length
        ? (sorted.length % 2
          ? sorted[(sorted.length - 1) / 2]
          : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2))
        : undefined;
      out.push({
        client,
        ...(st.board ? { board: st.board } : {}),
        pulls: st.pulls,
        firstPullAt: st.firstPullAt,
        lastPullAt: st.lastPullAt,
        lastNextPullSec: st.lastNextPullSec,
        ...(st.lastIntervalSec !== undefined ? { lastIntervalSec: st.lastIntervalSec } : {}),
        ...(median !== undefined ? { medianIntervalSec: median } : {}),
        cadenceHonouredCount: st.cadenceHonouredCount,
        ...(st.lastBattPct !== undefined ? { lastBattPct: st.lastBattPct } : {}),
        ...(st.lastBattMv !== undefined ? { lastBattMv: st.lastBattMv } : {}),
        ...(st.lastRssiDbm !== undefined ? { lastRssiDbm: st.lastRssiDbm } : {}),
        unchangedCount: st.unchangedCount,
      });
    }
    return out.sort((a, b) => b.lastPullAt - a.lastPullAt);
  }
}

/** One-line log form. `+3.2%` is the sleeping client's timer drift against the
 *  cadence the daemon advertised — the M6 power-ladder verification signal. */
export function formatFeedPull(ev: FeedPullEvent): string {
  const who = ev.board ? `${ev.board} (${ev.client})` : ev.client;
  const what = ev.unchanged ? 'unchanged' : `${ev.cards} card${ev.cards === 1 ? '' : 's'}`;
  const tel = [
    ev.battPct !== undefined ? `batt ${ev.battPct}%` : undefined,
    ev.battMv !== undefined ? `${ev.battMv}mV` : undefined,
    ev.rssiDbm !== undefined ? `rssi ${ev.rssiDbm}` : undefined,
  ].filter(Boolean).join(' ');
  const head = `card feed pull from ${who}: ${what}, next ${ev.nextPullSec}s${tel ? ` [${tel}]` : ''}`;
  if (ev.sinceLastSec === undefined) return `${head} — first pull`;
  if (ev.expectedSec === undefined) return `${head} — ${ev.sinceLastSec}s since last pull`;
  const pct = `${ev.driftPct !== undefined && ev.driftPct >= 0 ? '+' : ''}${((ev.driftPct ?? 0) * 100).toFixed(1)}%`;
  const verdict = ev.cadenceHonoured ? 'cadence ok' : 'off cadence';
  return `${head} — ${ev.sinceLastSec}s since last pull (expected ${ev.expectedSec}s, ${pct}, ${verdict})`;
}

/** Apply a pushed outbox batch. Results keep request order; every decision is
 *  acknowledged (the device deletes acknowledged entries regardless of
 *  status — a rejection is terminal, not retryable). */
export function applyOutboxDecisions(req: OutboxPushRequest, deps: OutboxApplyDeps): OutboxPushResponse {
  const decisions = Array.isArray(req?.decisions) ? req.decisions : [];
  const results = decisions.map((d) => {
    try {
      return applyOne(d ?? ({} as OutboxDecision), deps);
    } catch (err) {
      return {
        cardId: typeof d?.cardId === 'string' ? d.cardId : '',
        status: 'error' as const,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  });
  return { ok: results.every((r) => r.status !== 'error'), results };
}
