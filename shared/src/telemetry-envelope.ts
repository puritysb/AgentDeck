/**
 * AgentDeck telemetry envelope — internal OTel-shape struct for APME ingestion.
 *
 * Goal: every agent's lifecycle events (Claude hooks, Claude PTY parser, OpenClaw/
 * OpenCode timeline, Codex OTLP, Codex PTY) emit the same `TelemetrySpan` struct.
 * The APME collector consumes only this struct via `ingestSpan(...)`. New agents
 * plug in by writing one adapter; collector plumbing stays untouched.
 *
 * **Not an external wire format.** This struct is bridge-internal. Codex CLI's
 * real OTLP/HTTP traffic is handled separately by the Swift daemon
 * (`apple/AgentDeck/Daemon/Modules/CodexOtelRoutes.swift`).
 *
 * Naming: where a sensible OpenTelemetry GenAI semantic convention exists
 * (`gen_ai.request.model`, `gen_ai.tool.name`, etc.) we mirror it. Where it
 * doesn't (response_kind, vibe, judge axes), we keep our `agentdeck.*` namespace.
 * GenAI semconv is currently in "Development" status — we reference but do not
 * pin to it. See docs/otel-standardization-study.md.
 */

import type { AgentType } from './adapter.js';

/** Discriminator for what a span describes. Each kind has a contract about
 *  which attributes are required (see `TelemetryAttributes`). */
export type TelemetrySpanKind =
  /** A user prompt was received → open a new turn. Carries `agentdeck.prompt_text`. */
  | 'turn_start'
  /** Assistant response captured → set on the active turn. Carries `agentdeck.response_text`. */
  | 'turn_response'
  /** Explicit turn close. Carries `agentdeck.turn_end_source` (a
   *  `TurnEndSource`) naming WHICH signal closed the turn — a dropped close is
   *  otherwise byte-identical to a normal one, so its rate is unmeasurable.
   *  Most sources never emit this and auto-close on the next `turn_start`;
   *  OpenClaw does, because its `chat.final` IS the turn's stop signal and
   *  waiting for the next prompt would leave a single-turn conversation's turn
   *  open until the run closes. */
  | 'turn_end'
  /** A tool was invoked. Carries `gen_ai.tool.name`. */
  | 'tool_call'
  /** A tool finished. May carry `gen_ai.tool.name` if available. */
  | 'tool_result'
  /** The agent declared task boundary. Carries `agentdeck.boundary_signal`. */
  | 'task_boundary'
  /** Model id resolved or usage snapshot updated. Carries either
   *  `gen_ai.request.model` or `agentdeck.usage.*`. */
  | 'session_meta'
  /** The agent reported a failure for the current turn (provider error,
   *  failover exhaustion, transport give-up). Records the reason in the
   *  trajectory WITHOUT closing the turn or the task — the agent may retry
   *  the same prompt. Carries `agentdeck.error_label` (+ optional
   *  `agentdeck.error_detail`). Without it a failed turn is byte-identical
   *  to a turn whose response event was simply dropped. */
  | 'agent_error'
  /** Generic step — record verbatim into `steps` table without lifecycle
   *  side effects. Carries `agentdeck.raw_event` + `agentdeck.raw_payload`. */
  | 'raw_step';

/** OTel-shape attributes. Keys mirror GenAI semconv where available;
 *  AgentDeck-specific data lives under `agentdeck.*`. All keys are optional —
 *  consumers should defensively check for the ones their kind requires. */
export interface TelemetryAttributes {
  // ─── GenAI semconv (referenced, not pinned) ───
  /** Model id, e.g. "claude-opus-4-7". */
  'gen_ai.request.model'?: string;
  /** Tool name for tool_call / tool_result. */
  'gen_ai.tool.name'?: string;
  /** Provider/system, e.g. "anthropic", "openai". */
  'gen_ai.system'?: string;

  // ─── AgentDeck namespace ───
  'agentdeck.agent_type'?: AgentType;
  'agentdeck.cwd'?: string;
  /** User prompt text for turn_start. */
  'agentdeck.prompt_text'?: string;
  /** Assistant response text for turn_response. */
  'agentdeck.response_text'?: string;
  /** Task boundary discriminator. */
  'agentdeck.boundary_signal'?: 'todo_complete' | 'clear' | 'session_end' | 'manual' | 'idle_gap';
  /** Original event name for raw_step. */
  'agentdeck.raw_event'?: string;
  /** Original event payload for raw_step (JSON-serializable). */
  'agentdeck.raw_payload'?: Record<string, unknown>;
  /** Tool name as reported by the source (Claude hooks use `tool_name`). */
  'agentdeck.tool_name'?: string;
  /** One-line failure label for agent_error. Doubles as the timeline row's
   *  `raw`, so the projected row and the adapter's own row are byte-equal
   *  and the store's exact-dedup collapses them instead of rendering twice. */
  'agentdeck.error_label'?: string;
  /** Optional multi-line context for agent_error (duration, tools, ids). */
  'agentdeck.error_detail'?: string;

  // ─── Usage (session_meta when usage updated) ───
  'agentdeck.usage.input_tokens'?: number;
  'agentdeck.usage.output_tokens'?: number;
  'agentdeck.usage.cost_usd'?: number;
  /** Which signal closed the turn, for `turn_end`. A `TurnEndSource` value. */
  'agentdeck.turn_end_source'?: string;

  /** Open extension. Adapters may attach extra string-keyed scalars. */
  [k: string]: string | number | boolean | Record<string, unknown> | undefined;
}

/** A single ingestion event. `traceId` ≈ run id (one trace per session/run);
 *  `spanId` is a unique id per emitted event; `parentSpanId` optionally points
 *  to the active turn. The collector currently uses the `kind`/attributes
 *  directly; the trace/span ids are present for future OTLP export. */
export interface TelemetrySpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  /** Human-readable span name, e.g. "agentdeck.turn", "agentdeck.tool.call". */
  name: string;
  kind: TelemetrySpanKind;
  /** Wall-clock millis when the event happened. Adapters use Date.now() if
   *  the source doesn't provide a timestamp. */
  ts: number;
  attributes: TelemetryAttributes;
}

// ─── Adapter helper ──────────────────────────────────────────────────────────

/** Source kind passed to adapters. Mostly informational — used by the collector
 *  for debug logs and by tests for fixture filtering. */
export type TelemetrySource =
  | 'claude-hook'
  | 'claude-pty'
  | 'timeline'
  | 'codex-pty'
  | 'codex-otlp';

/** Opaque context passed to adapters. Holds the session-stable identifiers an
 *  adapter would otherwise have to thread through every call. */
export interface AdapterContext {
  sessionId: string;
  agentType: AgentType;
  /** trace id for this session/run. Adapters should reuse this for every span
   *  they emit during the session — the collector dispatches by sessionId so
   *  trace_id is mostly informational, but keeping it stable lets future OTLP
   *  exports tie spans together. */
  traceId: string;
  cwd?: string;
  /** Optional: current active turn id, populated by the collector after
   *  `turn_start` is processed. Adapters can read but should not write. */
  activeTurnId?: string;
}

// ─── Naming helpers ──────────────────────────────────────────────────────────

/** Canonical span name for a kind. Used by adapters so all spans for the same
 *  kind share a name — makes log filtering and OTLP queries predictable. */
export function spanNameForKind(kind: TelemetrySpanKind): string {
  switch (kind) {
    case 'turn_start':    return 'agentdeck.turn.start';
    case 'turn_response': return 'agentdeck.turn.response';
    case 'turn_end':      return 'agentdeck.turn.end';
    case 'tool_call':     return 'agentdeck.tool.call';
    case 'tool_result':   return 'agentdeck.tool.result';
    case 'task_boundary': return 'agentdeck.task.boundary';
    case 'session_meta':  return 'agentdeck.session.meta';
    case 'agent_error':   return 'agentdeck.agent.error';
    case 'raw_step':      return 'agentdeck.step.raw';
  }
}
