// codex-otel.ts — Ingest OTLP/HTTP JSON spans emitted by Codex (CLI and the
// ChatGPT.app Codex desktop app) and turn them into session state.
//
// Codex's OTel exporter is configured to POST at the daemon
// (`[otel.trace_exporter.otlp-http] endpoint = ".../otel/v1/traces"`), but only
// the Swift daemon implemented that route — the Node daemon answered 404 and
// every span was discarded. This is the Node port of
// `apple/AgentDeck/Daemon/Modules/CodexTelemetryModule.swift`; keep the two
// aligned when Codex's span vocabulary moves. The parser half is a faithful
// mirror (same span names, attribute aliases, cwd tiers, durable-id rules); the
// tracker half is deliberately Node-specific, because this daemon also has the
// ps/lsof passive observer that Swift (App Store, no subprocesses) cannot have —
// see `CodexOtelTracker`.
//
// Codex's OTel keys are not a documented stable API, so we accept several
// naming variants (dotted vs underscored, `codex.thread_id` vs `thread.id`) and
// silently drop anything unrecognized.
//
// What today's builds actually emit (measured 2026-08-04 against ChatGPT.app
// 150.0.7871.182 / `codex-app-server` 0.146.0-alpha.9.2, 11.5k spans):
// **no conversation identity at all**. `thread.id` there is the tokio worker
// thread ("3", "8", …) — which `isDurableSessionId` correctly rejects — and the
// build emits no turn-boundary span, only mid-turn `run_sampling_request` /
// `receiving` / tool spans. So every span folds onto the anonymous key and this
// module drives nothing for that build; the session comes from the ps/lsof
// observer, whose rollout carries the identity the spans lack. See the live
// fixture in `__tests__/codex-otel.test.ts` — that test is where a future build
// gaining `codex.thread_id` UUIDs or `turn/start` spans will show up first.
// Ingest cost on that traffic is ~0.44 ms per batch, so serving the route is
// cheap even while it yields nothing.

import { rawSessionId } from '@agentdeck/shared';
import type { ObservedSession } from './passive-observer.js';
import { resolveProjectNameFromCwdCached } from './utils/project-name.js';

/** Distilled span events — the only vocabulary the daemon acts on. */
export type CodexSpanEvent =
  | { kind: 'turnStart'; threadId: string; turnId: string; cwd?: string }
  | { kind: 'toolCall'; threadId: string; turnId: string; tool: string; cwd?: string }
  | { kind: 'toolResult'; threadId: string; turnId: string }
  | { kind: 'turnEnd'; threadId: string; turnId: string }
  | { kind: 'activity'; threadId: string; turnId: string; name: string; cwd?: string };

/** Singleton key for trace-backed spans that carry no durable thread id. */
export const ANONYMOUS_OTEL_THREAD_ID = 'otel-active';

/**
 * Route Codex's OTel exporter posts to. `hooks/src/codex-install.ts`
 * (`buildOtelEndpoint`) writes this path into `~/.codex/config.toml` and
 * `CodexOtelRoutes` serves it on the Swift daemon — the three must agree. The
 * hooks package carries its own literal because it has no workspace deps.
 */
export const CODEX_OTEL_TRACES_PATH = '/otel/v1/traces';

type Attrs = Record<string, string | number | boolean>;

/**
 * Span names that start a user turn. Their own `cwd` attribute is session-level
 * (the workspace), unlike tool spans whose `cwd` may be subprocess-scoped. Keep
 * aligned with the `turnStart` dispatch case below.
 */
const TURN_START_SPAN_NAMES = new Set([
  'codex.turn',
  'codex.turn.start',
  'turn.start',
  'op.dispatch.user.turn',
  'op.dispatch.user.input.with.turn.context',
]);

const TOOL_CALL_SPAN_NAMES = new Set([
  'codex.tool.call', 'tool.call', 'turn.tool.call', 'build.tool.call',
  'handle.tool.call', 'handle.tool.call.with.source', 'exec.command', 'mcp.tools.call',
]);

const TOOL_RESULT_SPAN_NAMES = new Set([
  'codex.tool.result', 'tool.result', 'tool.call.duration.ms',
  'dispatch.tool.call.with.code.mode.result', 'handle.output.item.done',
]);

const TURN_END_SPAN_NAMES = new Set(['codex.turn.end', 'turn.end', 'session.task.turn']);

const ACTIVITY_SPAN_NAMES = new Set([
  'receiving', 'handle.responses', 'responses.websocket.stream.request',
  'model.client.stream.responses.websocket', 'stream.request',
]);

/**
 * Attribute aliases under which Codex builds have been observed publishing the
 * workspace directory. Centralised so the resource-level scan, the span-level
 * scan, and the classifier read the same list.
 */
const CWD_ATTRIBUTE_KEYS = [
  'cwd', 'codex.cwd', 'working.directory', 'working_directory', 'working.dir',
  'workdir', 'workspace.path', 'workspace.root', 'workspace_root',
  'project.path', 'project.root', 'project_root', 'repo.path',
  'repository.path', 'terminal.cwd', 'process.cwd',
];

const THREAD_ID_KEYS = ['codex.thread_id', 'codex.thread.id', 'thread.id', 'thread_id', 'threadId'];
const TURN_ID_KEYS = ['codex.turn_id', 'turn.id', 'turn_id'];
const TOOL_NAME_KEYS = ['tool.name', 'tool', 'codex.tool', 'mcp.tool.name', 'mcp.tool'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/**
 * OTLP attributes are arrays of `{ key, value: { <type>Value } }`. Flatten to a
 * plain map so callers can dot-key into it without re-parsing the envelope.
 */
function flattenAttrs(raw: unknown): Attrs {
  const out: Attrs = {};
  for (const kv of recordArray(raw)) {
    const key = kv.key;
    const wrap = kv.value;
    if (typeof key !== 'string' || !isRecord(wrap)) continue;
    if (typeof wrap.stringValue === 'string') { out[key] = wrap.stringValue; continue; }
    if (wrap.intValue !== undefined) {
      // OTLP encodes int64 as a number or a stringified number depending on SDK
      // version — accept both so an exporter swap doesn't silently drop keys.
      if (typeof wrap.intValue === 'number') out[key] = wrap.intValue;
      else if (typeof wrap.intValue === 'string' && /^-?\d+$/.test(wrap.intValue)) out[key] = Number(wrap.intValue);
      continue;
    }
    if (typeof wrap.boolValue === 'boolean') { out[key] = wrap.boolValue; continue; }
    if (typeof wrap.doubleValue === 'number') { out[key] = wrap.doubleValue; continue; }
  }
  return out;
}

/** First non-empty string/int attribute among `keys`. */
function stringAttr(attrs: Attrs, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function stripCodexPrefix(raw: string): string {
  return raw.startsWith('codex:') ? raw.slice('codex:'.length) : raw;
}

/**
 * A thread id worth synthesizing a session row for: long enough to be a real
 * conversation id and not purely numeric. Short numeric ids (`thread.id: "11"`)
 * are turn-scoped companion-task counters — accepting them spawned ghost
 * creatures on the dashboard.
 */
function isDurableSessionId(raw: string): boolean {
  const trimmed = stripCodexPrefix(raw).trim();
  if (trimmed.length < 12) return false;
  return /\D/.test(trimmed);
}

/**
 * First attribute among `keys` whose value is durable — a preference order, not
 * a winner-take-all early exit. Some Codex builds emit both a turn-scoped short
 * id (`codex.thread_id: "11"`) and the real UUID (`thread.id: "019dee40-…"`) on
 * the same span; taking the first non-empty one would drop the good id.
 */
function firstDurableAttr(attrs: Attrs, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'string' && value.length > 0 && isDurableSessionId(value)) return value;
    if (typeof value === 'number' && isDurableSessionId(String(value))) return String(value);
  }
  return undefined;
}

function threadIdAttr(attrs: Attrs): string | undefined {
  const threadId = firstDurableAttr(attrs, THREAD_ID_KEYS);
  if (threadId) return stripCodexPrefix(threadId);
  const sessionId = firstDurableAttr(attrs, ['session_id', 'session.id']);
  if (sessionId) return stripCodexPrefix(sessionId);
  return undefined;
}

function traceIdAttr(span: Record<string, unknown>): string | undefined {
  for (const key of ['traceId', 'traceID', 'trace_id']) {
    const value = span[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Some Codex App / app-server batches carry useful progress spans but omit a
 * durable thread id. Rather than drop them, fold them onto one anonymous key so
 * liveness is still observable — a singleton, so internal traces can't spawn one
 * sprite each. Real thread ids always win.
 */
function anonymousThreadIdIfTraceBacked(span: Record<string, unknown>): string | undefined {
  return traceIdAttr(span) === undefined ? undefined : ANONYMOUS_OTEL_THREAD_ID;
}

function normalizeSpanName(rawName: string): string {
  return rawName.replaceAll('_', '.').replaceAll('/', '.');
}

function isTurnStartSpan(span: Record<string, unknown>): boolean {
  const rawName = span.name;
  if (typeof rawName !== 'string') return false;
  return TURN_START_SPAN_NAMES.has(normalizeSpanName(rawName));
}

function cwdFromAttributes(attrs: Attrs): string | undefined {
  return stringAttr(attrs, CWD_ATTRIBUTE_KEYS);
}

function inferredToolName(normalizedSpanName: string): string {
  return normalizedSpanName === 'exec.command' ? 'exec' : 'tool';
}

function* eachSpan(json: Record<string, unknown>): Generator<{ span: Record<string, unknown>; resourceAttrs: Attrs }> {
  for (const resource of recordArray(json.resourceSpans)) {
    const resourceAttrs = flattenAttrs(isRecord(resource.resource) ? resource.resource.attributes : undefined);
    for (const scope of recordArray(resource.scopeSpans)) {
      for (const span of recordArray(scope.spans)) {
        yield { span, resourceAttrs };
      }
    }
  }
}

/**
 * Per-thread session cwd, in two priority tiers — never batch-wide (that leaks
 * A→B across concurrent sessions) and never from a tool/activity span's own cwd
 * attribute (those carry per-call subprocess cwd like `exec_command`'s
 * `process.cwd` pointing at /tmp). A wrong first value would permanently lock a
 * session's project label, because the tracker's upgrade guard only fires once.
 *
 *  Tier 1 — turnStart spans' own cwd. Session-level per Codex's contract.
 *  Tier 2 — resource-level cwd. Workspace-scoped for every thread under it.
 */
function buildCwdByThread(json: Record<string, unknown>): Map<string, string> {
  const cwdByThread = new Map<string, string>();
  for (const { span, resourceAttrs } of eachSpan(json)) {
    if (!isTurnStartSpan(span)) continue;
    const spanAttrs = flattenAttrs(span.attributes);
    const cwd = cwdFromAttributes(spanAttrs);
    if (!cwd) continue;
    const merged = { ...resourceAttrs, ...spanAttrs };
    const threadId = threadIdAttr(merged) ?? anonymousThreadIdIfTraceBacked(span);
    if (threadId && !cwdByThread.has(threadId)) cwdByThread.set(threadId, cwd);
  }
  for (const { span, resourceAttrs } of eachSpan(json)) {
    const resourceCwd = cwdFromAttributes(resourceAttrs);
    if (!resourceCwd) continue;
    const merged = { ...resourceAttrs, ...flattenAttrs(span.attributes) };
    const threadId = threadIdAttr(merged) ?? anonymousThreadIdIfTraceBacked(span);
    if (threadId && !cwdByThread.has(threadId)) cwdByThread.set(threadId, resourceCwd);
  }
  return cwdByThread;
}

function classify(
  span: Record<string, unknown>,
  resourceAttrs: Attrs,
  cwdByThread: Map<string, string>,
): CodexSpanEvent | undefined {
  const rawName = span.name;
  if (typeof rawName !== 'string') return undefined;
  const attrs = { ...resourceAttrs, ...flattenAttrs(span.attributes) };

  const threadId = threadIdAttr(attrs) ?? anonymousThreadIdIfTraceBacked(span);
  if (!threadId) return undefined;
  const turnId = stringAttr(attrs, TURN_ID_KEYS) ?? traceIdAttr(span) ?? '';

  // turnStart trusts its own cwd attr, falling back to the thread map. Every
  // other span type IGNORES its own cwd attr (subprocess-scoped) and uses only
  // the thread-scoped fallback built above.
  const cwd = isTurnStartSpan(span)
    ? (cwdFromAttributes(attrs) ?? cwdByThread.get(threadId))
    : cwdByThread.get(threadId);

  const normalized = normalizeSpanName(rawName);
  if (TURN_START_SPAN_NAMES.has(normalized)) return { kind: 'turnStart', threadId, turnId, cwd };
  if (TOOL_CALL_SPAN_NAMES.has(normalized)) {
    const tool = stringAttr(attrs, TOOL_NAME_KEYS) ?? inferredToolName(normalized);
    return { kind: 'toolCall', threadId, turnId, tool, cwd };
  }
  if (TOOL_RESULT_SPAN_NAMES.has(normalized)) return { kind: 'toolResult', threadId, turnId };
  if (TURN_END_SPAN_NAMES.has(normalized)) return { kind: 'turnEnd', threadId, turnId };
  if (ACTIVITY_SPAN_NAMES.has(normalized)) return { kind: 'activity', threadId, turnId, name: rawName, cwd };
  return undefined;
}

/** Parse an OTLP/HTTP `ExportTraceServiceRequest` body into ordered events. */
export function parseCodexSpans(json: unknown): CodexSpanEvent[] {
  if (!isRecord(json)) return [];
  const cwdByThread = buildCwdByThread(json);
  const events: CodexSpanEvent[] = [];
  for (const { span, resourceAttrs } of eachSpan(json)) {
    const event = classify(span, resourceAttrs, cwdByThread);
    if (event) events.push(event);
  }
  return events;
}

/** Diagnostic for unrecognized future schemas — span names, not whole bodies. */
export function spanNameSummary(json: unknown, limit = 12): string {
  if (!isRecord(json)) return '';
  const names: string[] = [];
  for (const { span } of eachSpan(json)) {
    if (typeof span.name === 'string' && span.name.length > 0) names.push(span.name);
    if (names.length >= limit) break;
  }
  return names.join(',');
}

/**
 * A thread OTel is reporting on. `turnEnd` sets `terminalAt`; a later
 * `turnStart` clears it (the same re-engagement Swift allows on
 * `codex_user_prompt_submit`), so a follow-up prompt revives the row instead of
 * leaving the creature dead until the next scan.
 */
export interface CodexOtelThread {
  threadId: string;
  cwd?: string;
  state: 'processing' | 'idle';
  currentTool?: string;
  servicedTurnId?: string;
  startedAt: number;
  lastEventAt: number;
  terminalAt?: number;
}

/** A turn OTel says ended stops driving a synthesized row after this long. */
const POST_TERMINAL_TTL_MS = 60_000;
/** Any thread this quiet is dropped — a dead exporter must not pin a creature. */
const THREAD_IDLE_TTL_MS = 5 * 60_000;
/**
 * How long an OTel observation may override the ps observer's state. Beyond
 * this the rollout tail is the fresher signal again.
 */
const STATE_OVERLAY_TTL_MS = 2 * 60_000;

/**
 * Thread state distilled from OTLP spans, projected onto the sessions list.
 *
 * The division of labour is Node-specific. Swift has no process visibility, so
 * there OTel is the *only* Codex-app session source. Here the ps/lsof observer
 * already produces a richer row (model, tokens, goal, context) for any Codex
 * that holds a rollout open, so OTel plays two narrower parts:
 *
 *  1. Overlay — turn boundaries land in milliseconds, where the observer only
 *     re-reads the rollout tail every scan interval. When both describe the same
 *     thread, a fresh OTel state/tool wins.
 *  2. Fallback — when no observed row matches (rollout not open, lsof blind,
 *     a Codex the process scan can't see), synthesize a `codex-app` row so the
 *     session still appears. This is the Swift-parity path.
 */
export class CodexOtelTracker {
  private readonly threads = new Map<string, CodexOtelThread>();

  /** Fired when ingestion changed something worth broadcasting. */
  onChanged: (() => void) | undefined;

  /** Ingest one OTLP body. Returns the number of recognized events. */
  ingest(json: unknown, now = Date.now()): number {
    const events = parseCodexSpans(json);
    let changed = false;
    for (const event of events) {
      // Anonymous trace-backed spans are liveness noise, not an identity: they
      // must never synthesize or drive a session row (Swift parity —
      // `shouldUseCodexOtelThreadForSessionState`).
      if (event.threadId === ANONYMOUS_OTEL_THREAD_ID) continue;
      changed = this.apply(event, now) || changed;
    }
    this.sweep(now);
    if (changed) this.onChanged?.();
    return events.length;
  }

  private apply(event: CodexSpanEvent, now: number): boolean {
    const existing = this.threads.get(event.threadId);
    // Progress-only spans keep a live turn from ageing out; they must never
    // revive a finished or idle thread, nor open one (Swift
    // `shouldUseCodexOtelActivityForState`). Bailing before the `lastEventAt`
    // bump is what keeps a dead thread expiring on schedule.
    if (event.kind === 'activity'
      && (!existing || existing.terminalAt !== undefined || existing.state !== 'processing')) {
      return false;
    }
    const thread: CodexOtelThread = existing ?? {
      threadId: event.threadId,
      state: 'idle',
      startedAt: now,
      lastEventAt: now,
    };
    const before = JSON.stringify(thread);
    thread.lastEventAt = now;

    // cwd upgrades once, empty→set. Later spans can only carry a subprocess cwd
    // (the parser already restricts the source), so overwriting would lock the
    // project label onto the wrong path.
    if (!thread.cwd && event.kind !== 'toolResult' && event.kind !== 'turnEnd' && event.cwd) {
      thread.cwd = event.cwd;
    }

    switch (event.kind) {
      case 'turnStart':
        thread.servicedTurnId = event.turnId;
        thread.terminalAt = undefined;
        thread.state = 'processing';
        thread.currentTool = undefined;
        break;
      case 'toolCall':
        if (thread.terminalAt !== undefined) break; // late span from a finished turn
        thread.state = 'processing';
        thread.currentTool = usefulToolName(event.tool);
        break;
      case 'toolResult':
        if (thread.terminalAt !== undefined) break;
        thread.state = 'processing';
        thread.currentTool = undefined;
        break;
      case 'turnEnd':
        // Stop-drift guard: a `turnEnd` can land seconds late, by which point a
        // newer prompt already opened a fresh turn. Close only the turn OTel is
        // actually servicing; when OTel never saw this turn's start, let it
        // close (nothing else here knows better).
        if (thread.servicedTurnId && event.turnId && thread.servicedTurnId !== event.turnId) break;
        thread.state = 'idle';
        thread.currentTool = undefined;
        thread.servicedTurnId = undefined;
        thread.terminalAt = now;
        break;
      case 'activity':
        // Guarded above; reaching here only refreshes `lastEventAt`.
        break;
    }

    this.threads.set(event.threadId, thread);
    return JSON.stringify(thread) !== before;
  }

  private sweep(now: number): void {
    for (const [threadId, thread] of this.threads) {
      const terminalExpired = thread.terminalAt !== undefined
        && now - thread.terminalAt > POST_TERMINAL_TTL_MS;
      if (terminalExpired || now - thread.lastEventAt > THREAD_IDLE_TTL_MS) {
        this.threads.delete(threadId);
      }
    }
  }

  /** Live thread snapshot (diagnostics / tests). */
  snapshot(): CodexOtelThread[] {
    return [...this.threads.values()];
  }

  /**
   * Overlay fresh OTel state onto matching observed rows, and append a
   * `codex-app` row for every thread the process scan didn't find.
   */
  applyTo(observed: ObservedSession[], now = Date.now()): ObservedSession[] {
    this.sweep(now);
    if (this.threads.size === 0) return observed;

    const matched = new Set<string>();
    const overlaid = observed.map((session) => {
      if (session.agentType !== 'codex-cli' && session.agentType !== 'codex-app') return session;
      const thread = this.threads.get(rawSessionId(session.id));
      if (!thread) return session;
      matched.add(thread.threadId);
      if (now - thread.lastEventAt > STATE_OVERLAY_TTL_MS) return session;
      return {
        ...session,
        state: thread.state,
        // `currentTask` is the observer's rollout-derived label; only replace it
        // while OTel has a tool in flight, so a finished turn falls back to the
        // richer text instead of blanking.
        ...(thread.currentTool ? { currentTask: thread.currentTool } : {}),
      };
    });

    const synthesized: ObservedSession[] = [];
    for (const thread of this.threads.values()) {
      if (matched.has(thread.threadId)) continue;
      const cwd = thread.cwd;
      synthesized.push({
        id: `observed:codex-app:${thread.threadId}`,
        port: 0,
        pid: 0,
        // No cwd yet means no project: borrowing a sibling session's name is how
        // the macOS dashboard once labelled Codex with a neighbour's project.
        projectName: cwd ? resolveProjectNameFromCwdCached(cwd) : 'Codex',
        agentType: 'codex-app',
        alive: true,
        state: thread.state,
        controlMode: 'observed',
        cwd,
        currentTask: thread.currentTool,
        startedAt: new Date(thread.startedAt).toISOString(),
      });
    }
    return synthesized.length > 0 ? [...overlaid, ...synthesized] : overlaid;
  }
}

/**
 * Drop tool labels that carry no information for a dashboard row. Codex emits
 * `tool`/`unknown` placeholders on spans whose name attribute is missing.
 */
function usefulToolName(tool: string): string | undefined {
  const trimmed = tool.trim();
  if (!trimmed || trimmed === 'tool' || trimmed === 'unknown') return undefined;
  return trimmed;
}
