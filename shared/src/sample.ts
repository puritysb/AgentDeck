/**
 * AgentDeck SessionSample — the canonical, evaluable unit of agent work.
 *
 * Inspired by Inspect AI's `EvalLog → Sample → Event → Scorer` model. A
 * `SessionSample` is a bounded slice of an agent session (one "task") carrying
 * a typed trajectory of message/tool/model/state events. It is the SINGLE
 * source of truth: both the device-facing TIMELINE and the APME evaluation are
 * projections of this object, rather than two parallel event emitters.
 *
 * Storage: the `tasks` row IS the sample header (id/run_id/index/boundary/…);
 * the typed trajectory lives in the `sample_events` table. See
 * `bridge/src/apme/store.ts`. Logical field names here are camelCase; the DAO
 * maps to snake_case columns.
 *
 * Satisfies the HuggingFace "universal agent eval" requirements:
 *   #2 agent identity  → SampleModelConfig (model, subagents, mcpServers)
 *   #5 trajectory      → TrajectoryEvent[]  (typed, ordered)
 *   #6 tool-use        → ToolEvent
 *   #7 cost tracking   → SampleCost + per-ModelEvent cost/latency
 */

import type { AgentType } from './adapter.js';
import type { ResponseKind, TaskBoundarySignal } from './eval-schema.js';

// ─── Agent identity (req #2) ──────────────────────────────────────────────────

export interface SampleModelConfig {
  /** Real model id, e.g. "claude-opus-4-8", "gpt-5-codex", "mlx:qwen3-30b". */
  modelId: string;
  /** "anthropic" | "openai" | "mlx" | "openclaw" | "local" | … */
  provider?: string | null;
  /** Sub-agent names spawned during the sample (Task tool, delegations). */
  subagents?: string[];
  /** MCP server names the agent had access to. */
  mcpServers?: string[];
}

// ─── Cost aggregate (req #7) ──────────────────────────────────────────────────

export interface SampleCost {
  inputTokens: number;
  outputTokens: number;
  /** Sum over the sample's ModelEvents (priced at ingestion). 0 for local. */
  costUsd: number;
  /** Sum of per-model-call latencies (ms). */
  latencyMs: number;
}

// ─── Typed trajectory events (req #5) — mirror Inspect's event union ───────────

export type TrajectoryEventKind =
  | 'user_message'
  | 'assistant_message'
  | 'model'
  | 'tool'
  | 'state'
  | 'info';

export type ToolStatus = 'pending' | 'success' | 'error';

interface TrajectoryEventBase {
  ts: number;
  /** Index of the turn this event belongs to within the run. */
  turnIndex: number;
}

/** A user prompt / message. */
export interface UserMessageEvent extends TrajectoryEventBase {
  kind: 'user_message';
  text: string;
}

/** An assistant response body. `responseKind` lets scorers skip silence. */
export interface AssistantMessageEvent extends TrajectoryEventBase {
  kind: 'assistant_message';
  text: string;
  responseKind: ResponseKind;
}

/** A model invocation with usage + cost. The atom of cost tracking. */
export interface ModelEvent extends TrajectoryEventBase {
  kind: 'model';
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Priced at ingestion via shared/src/pricing.ts. 0 for local models. */
  costUsd: number;
  latencyMs: number;
}

/** A single tool call. The PreToolUse/PostToolUse pair collapses into one row. */
export interface ToolEvent extends TrajectoryEventBase {
  kind: 'tool';
  name: string;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  status?: ToolStatus;
}

/** An agent-state machine transition (idle → processing → awaiting …). */
export interface StateTransitionEvent extends TrajectoryEventBase {
  kind: 'state';
  from?: string | null;
  to: string;
}

/** Free-form annotation: memory recall, errors, boundary markers. */
export interface InfoEvent extends TrajectoryEventBase {
  kind: 'info';
  label: string;
  detail?: string | null;
}

export type TrajectoryEvent =
  | UserMessageEvent
  | AssistantMessageEvent
  | ModelEvent
  | ToolEvent
  | StateTransitionEvent
  | InfoEvent;

// ─── Scores (filled by the Scorer registry) ───────────────────────────────────

export interface SampleScore {
  /** Scorer name, e.g. "deterministic", "judge", "outcome", "trajectory". */
  scorer: string;
  /** Axis within the scorer, e.g. "tests_pass", "overall", "tool_efficiency". */
  metric: string;
  /** [0,1]. */
  score: number;
  reasoning?: string | null;
}

// ─── The canonical sample ─────────────────────────────────────────────────────

export interface SessionSample {
  /** Equals tasks.id — the task row is the sample header. */
  id: string;
  runId: string;
  sessionId: string;
  agentType: AgentType;
  /** task_index within the run. */
  index: number;
  boundarySignal: TaskBoundarySignal;
  startedAt: number;
  endedAt?: number | null;
  /** req #2 — agent identity. */
  model: SampleModelConfig;
  projectName?: string | null;
  projectPath?: string | null;
  /** req #5 — the ordered typed trajectory. */
  events: TrajectoryEvent[];
  /** req #7 — aggregated cost, projected from ModelEvents. */
  cost: SampleCost;
  /** Scorer outputs (present once evaluated). */
  scores?: SampleScore[];
  summary?: string | null;
  outcome?: string | null;
  compositeScore?: number | null;
  taskCategory?: string | null;
}

// ─── DB row for the sample_events table ───────────────────────────────────────

/** One typed trajectory event as stored. Logical (camelCase) mirror of the
 *  `sample_events` columns. `payload` is JSON: message text, tool input/output,
 *  state from/to, or info detail depending on `kind`. */
export interface ApmeSampleEventRow {
  id?: number;
  taskId: string;
  runId: string;
  turnIndex?: number | null;
  /** The turn this event belongs to, as an id rather than the run-scoped
   *  `turnIndex`. Both are kept: `turnIndex` is the ordering key the collector
   *  and dedup path work in, `turnId` is the edge a graph projection (or any
   *  join that starts from a turn) can follow directly. */
  turnId?: string | null;
  /** Monotonic order within the task. */
  seq: number;
  ts: number;
  kind: TrajectoryEventKind;
  // model columns (kind='model')
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
  // tool columns (kind='tool')
  toolName?: string | null;
  toolStatus?: ToolStatus | string | null;
  toolError?: string | null;
  /** JSON payload (message text / tool input+output / info detail / state). */
  payload?: string | null;
  /** Storage-time dedup key: sha1(kind | turnIndex | semanticCore). UNIQUE per task. */
  dedupKey?: string | null;
}
