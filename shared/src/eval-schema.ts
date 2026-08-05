/**
 * AgentDeck eval v1 — canonical schema for APME (Agent Performance Monitoring & Evaluation).
 *
 * Source-of-truth for evaluation data emitted by AgentDeck. Versioned so external
 * consumers (dashboards, exporters, future tooling) have a stable contract.
 *
 * Versioning rule (also in docs/apme.md):
 *   - Adding a new optional field, axis, or category: stays v1 (additive).
 *   - Renaming, removing, or changing the meaning of a field: requires v2.
 *   - Bridge tags every APME HTTP response body with `schema: EVAL_SCHEMA_VERSION`.
 *
 * Authoritative storage layout: `bridge/src/apme/store.ts`. These types match the
 * SQLite schema's logical fields (camelCase) — column-level naming lives in the DAO.
 */

import type { AgentType } from './adapter.js';

/** Wire-format version. Bump on any breaking change to the types in this file. */
export const EVAL_SCHEMA_VERSION = 'agentdeck-eval/v1' as const;
export type EvalSchemaVersion = typeof EVAL_SCHEMA_VERSION;

// ─── Run / Step / Turn / Task / Eval / Rubric / Vibe rows ─────────────────────

export interface ApmeRunRow {
  id: string;
  sessionId: string;
  agentType: AgentType;
  modelId?: string | null;
  projectName?: string | null;
  projectPath?: string | null;
  taskPrompt?: string | null;
  startedAt: number;
  endedAt?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  exitCode?: number | null;
  gitBefore?: string | null;
  gitAfter?: string | null;
  /** The run this one continues after a `/clear` context reset. `/clear` splits
   *  a session into a fresh run so each gets its own evaluation unit; this edge
   *  keeps the conversation reconstructible across the split instead of leaving
   *  N disconnected runs behind one session id. Null for a genuine session start. */
  parentRunId?: string | null;
  /** JSON string. Per-run hardware sample (cpu/memory/load). */
  hwProfile?: string | null;
  /** JSON string. Output of the rule-based classifier — tool counts, file scopes, etc. */
  taskSignals?: string | null;
  taskCategory?: string | null;
  /** 'auto' | 'user' | 'llm' | 'rule'. */
  taskCategorySource?: string | null;
  /** committed | abandoned | iterated | ab_winner | ab_loser | interrupted | exploratory. */
  outcome?: string | null;
  /** high | medium | low. */
  outcomeConfidence?: string | null;
  /** JSON string. Efficiency metrics (response_kind, tool churn, etc.). */
  efficiencyJson?: string | null;
  /** Weighted aggregate of outcome / judge / efficiency / vibe. 0–1 scale. */
  compositeScore?: number | null;
}

export interface ApmeStepRow {
  id?: number;
  runId: string;
  ts: number;
  /** PreToolUse | PostToolUse | Stop | UserPromptSubmit | chat_start | tool_request | … */
  kind: string;
  toolName?: string | null;
  /** JSON string of the original event payload. */
  payload: string;
}

export interface ApmeArtifactRow {
  id?: number;
  runId: string;
  /** before_snapshot | after_snapshot | diff | pty_log | lint_out | test_out | … */
  kind: 'before_snapshot' | 'after_snapshot' | 'diff' | 'pty_log' | 'lint_out' | 'test_out' | string;
  path: string;
  sha256?: string | null;
  bytes?: number | null;
}

export type ApmeEvalLayer =
  | 'deterministic'
  | 'llm_judge'
  | 'vibe'
  | 'turn_judge'
  | 'task_judge'
  /** Pure, sample-trajectory scorers (no LLM): trajectory quality, tool
   *  efficiency, reliability. Computed over a SessionSample's typed events. */
  | 'trajectory'
  /** User-triggered on-demand risk review (the REVIEW deck button /
   *  review-runner). Same eval store as the automatic layers, but this layer
   *  flags it as manually requested so the dashboard can distinguish a
   *  hand-run review from the automatic pipeline. score = risk weight
   *  (low=1.0, medium=0.5, high=0.0); metric='risk'. */
  | 'manual_review';

export interface ApmeEvalRowDb {
  id?: number;
  runId: string;
  layer: ApmeEvalLayer;
  /** Axis name. Rubric-specific (e.g. 'task_completion', 'accuracy', 'overall'). */
  metric: string;
  score: number;
  /** Raw judge JSON (reasoning, done, missed, summary). */
  raw?: string | null;
  rubricVer?: number | null;
  judgeModel?: string | null;
  createdAt: number;
}

/** A `task` groups consecutive turns within a run. Boundaries are detected
 *  automatically from agent events:
 *   - `todo_complete`  — TodoWrite PostToolUse where every todo.status === 'completed'
 *   - `clear`          — UserPromptSubmit `/clear` (also splits the run)
 *   - `session_end`    — closeRun finalization
 *   - `manual`         — reserved for a future explicit task-end marker
 *
 *  A task-level judge reads all turns belonging to the task and writes a
 *  one-line `summary` + `compositeScore`. Individual axis scores land in
 *  `evals` rows with `layer='task_judge'` and `taskId` set.
 */
export type TaskBoundarySignal =
  | 'todo_complete'
  | 'clear'
  | 'session_end'
  | 'manual'
  | 'idle_gap'      // OpenClaw chat-style: closed by 90 s of silence after final
  | 'open'
  | string;

export interface ApmeTaskRow {
  id: string;
  runId: string;
  taskIndex: number;
  boundarySignal: TaskBoundarySignal;
  startedAt: number;
  endedAt?: number | null;
  firstTurnIndex?: number | null;
  lastTurnIndex?: number | null;
  summary?: string | null;
  outcome?: string | null;
  compositeScore?: number | null;
  taskCategory?: string | null;
  /** Raw judge JSON (done/missed/reasoning) for the task rollup. */
  notesJson?: string | null;
  // ── Sample header: agent identity + cost (req #2 / #7) ──
  /** Real model id for this sample (the task IS the SessionSample header). */
  modelId?: string | null;
  /** JSON string of SampleModelConfig (provider, subagents, mcpServers). */
  modelConfig?: string | null;
  /** Aggregated from the sample's ModelEvents. */
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  latencyMs?: number | null;
}

/** Per-(agent, model, category) scorecard row at sample granularity — the
 *  recommender's real unit. Backed by `v_sample_scorecard`. */
export interface ApmeSampleScorecardRow {
  agentType: string;
  modelId: string;
  taskCategory: string | null;
  samples: number;
  avgQuality: number | null;
  totalCost: number | null;
  avgLatencyMs: number | null;
  costPerQuality: number | null;
}

export interface ApmeRubricRow {
  version: number;
  /** 'general' | 'conversation' | 'planning' | 'research' | 'debugging' | 'refactoring'
   *  | 'review' | 'ops' | 'task_rollup' | … */
  purpose: string;
  prompt: string;
  /** JSON string mapping axis → weight. */
  weights: string;
  createdAt: number;
  parentVer?: number | null;
  notes?: string | null;
}

export interface ApmeVibeRow {
  id?: number;
  runId: string;
  verdict: 'approve' | 'reject' | 'neutral';
  note?: string | null;
  ts: number;
}

export interface ApmeScorecardRow {
  agentType: string;
  modelId: string;
  runs: number;
  avgOverall: number | null;
  avgTestsPass: number | null;
  totalCost: number | null;
  costPerQuality: number | null;
}

export interface ApmeCategoryScorecardRow {
  taskCategory: string;
  modelId: string;
  runs: number;
  avgOverall: number | null;
  avgTestsPass: number | null;
  totalCost: number | null;
}

// ─── Judge output (parsed JSON shape) ─────────────────────────────────────────

/** Parsed shape of a judge LLM's JSON response. Rubric-specific axes land in
 *  `scores` (e.g. `task_completion`, `accuracy`, `overall`). `summary` is
 *  populated only by the `task_rollup` rubric. */
export interface ParsedJudge {
  scores: Record<string, number>;
  reasoning: string;
  /** Items the agent completed (for human verification of judge reasoning). */
  done?: string[];
  /** Items the agent missed. */
  missed?: string[];
  /** One-sentence task summary, ≤ 140 chars (task_rollup rubric only). */
  summary?: string;
}

/** Response classification stored in `turns.efficiency_json.response_kind`. Drives
 *  which turns make it to the LLM judge — `tool_only` / `empty` are silence to
 *  the judge and produce noise scores. */
export type ResponseKind = 'text' | 'tool_only' | 'empty';

// ─── HTTP API response envelopes ──────────────────────────────────────────────

/** Common envelope for every APME GET response. External consumers should check
 *  `schema` and refuse to deserialize unknown major versions. */
export interface ApmeApiEnvelope {
  schema: EvalSchemaVersion;
}

export interface ApmeRunEvalSummary {
  layer: string;
  metric: string;
  score: number;
  rubricVer: number | null;
  judgeModel: string | null;
  createdAt: number;
}

export interface ApmeRunWithEvalsSummary extends ApmeRunRow {
  evals: ApmeRunEvalSummary[];
  overallScore: number | null;
  vibe: { verdict: ApmeVibeRow['verdict'] } | null;
}

export interface ApmeRunsResponse extends ApmeApiEnvelope {
  runs: ApmeRunWithEvalsSummary[];
}

/** A task unit carrying enough run context to be read on its own.
 *
 *  Tasks are the canonical evaluation unit, but a bare `ApmeTaskRow` names no
 *  agent, model, project or prompt — which is why the only way to reach one used
 *  to be drilling into its run. This is the shape the task browse surface lists. */
export interface ApmeTaskListRow extends ApmeTaskRow {
  sessionId: string;
  agentType: AgentType;
  /** Task-level model when the sample recorded one, else the run's. */
  modelId: string | null;
  projectName: string | null;
  /** Run's working directory — the root a file path is made relative to. */
  projectPath: string | null;
  parentRunId: string | null;
  /** The task's own first prompt; falls back to the run prompt when the task
   *  predates per-turn prompt capture. */
  firstPrompt: string | null;
  turnCount: number;
  /** Turns whose assistant reply was archived. `turnCount - answeredTurns > 0`
   *  marks a unit the judge can only partly see. */
  answeredTurns: number;
  eventCount: number;
  toolCount: number;
  evalCount: number;
  overallScore: number | null;
}

export interface ApmeTaskListResponse extends ApmeApiEnvelope {
  total: number;
  limit: number;
  offset: number;
  tasks: ApmeTaskListRow[];
  facets: { agents: string[]; projects: string[]; categories: string[]; outcomes: string[] };
}

export interface ApmeRunDetailResponse extends ApmeApiEnvelope {
  run: ApmeRunRow;
  evals: ApmeEvalRowDb[];
  steps: ApmeStepRow[];
  /** Raw turn rows (snake_case from SQLite) plus per-turn evals. */
  turns: Array<Record<string, unknown> & { turnEvals: ApmeEvalRowDb[] }>;
  vibe: ApmeVibeRow | null;
  overallScore: number | null;
}

export interface ApmeScorecardResponse extends ApmeApiEnvelope {
  scorecards: ApmeScorecardRow[];
}

export interface ApmeCategoriesResponse extends ApmeApiEnvelope {
  categories: ApmeCategoryScorecardRow[];
}

export interface ApmeRubricResponse extends ApmeApiEnvelope {
  rubric: ApmeRubricRow;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Wrap any payload with the schema version envelope. Used by the bridge's
 *  HTTP routes so callers don't have to remember the constant. */
export function withSchemaEnvelope<T extends Record<string, unknown>>(
  body: T,
): T & ApmeApiEnvelope {
  return { schema: EVAL_SCHEMA_VERSION, ...body };
}
