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
  /** Normalized endpoint provider. */
  provider?: string | null;
  projectName?: string | null;
  projectPath?: string | null;
  taskPrompt?: string | null;
  startedAt: number;
  endedAt?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  /** True only when every recorded model call has a known price source. */
  costKnown?: boolean | null;
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
  /** Normalized endpoint provider. `null` means no attributable provider. */
  provider?: string | null;
  /** JSON string of SampleModelConfig (provider, subagents, mcpServers). */
  modelConfig?: string | null;
  /** Aggregated from the sample's ModelEvents. */
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: number | null;
  /** False distinguishes an unpriced model from a genuinely free local one. */
  costKnown?: boolean | null;
  latencyMs?: number | null;
}

/** Per-(agent, model, category) scorecard row at sample granularity — the
 *  recommender's real unit. Backed by `v_sample_scorecard`. */
export interface ApmeSampleScorecardRow {
  agentType: string;
  modelId: string;
  provider: string | null;
  taskCategory: string | null;
  samples: number;
  avgQuality: number | null;
  totalCost: number | null;
  costKnown: boolean;
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
  provider: string | null;
  runs: number;
  avgOverall: number | null;
  avgTestsPass: number | null;
  totalCost: number | null;
  costKnown: boolean;
  costPerQuality: number | null;
}

export interface ApmeCategoryScorecardRow {
  taskCategory: string;
  modelId: string;
  provider: string | null;
  runs: number;
  avgOverall: number | null;
  avgTestsPass: number | null;
  totalCost: number | null;
  costKnown: boolean;
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

/** How a turn's end was learned, stored in `turns.end_source`.
 *
 *  A Claude turn is closed by exactly one authority — the Stop hook — whose
 *  delivery is fire-and-forget and therefore lossy. Recording WHICH signal
 *  closed each turn turns that loss from an anecdote into a rate:
 *
 *   - `stop`            the real Stop hook arrived. The healthy case.
 *   - `synthetic_stop`  the Stop was lost and the missed-Stop watchdog
 *                       recovered it from the transcript tail. Counting these
 *                       IS the Stop-hook loss measurement.
 *   - `next_prompt`     no Stop ever arrived and no watchdog recovered it —
 *                       the turn stayed open until the following prompt
 *                       displaced it. An unrecovered loss.
 *   - `interrupted`     the user pressed ESC. Claude Code emits NO hook for a
 *                       cancel — not PostToolUse, not Stop, not
 *                       UserPromptSubmit — so no Stop was ever due and this is
 *                       NOT a lost hook. It is its own bucket precisely so it
 *                       stops being counted as one; the transcript's interrupt
 *                       marker is the only evidence it happened.
 *   - `aborted`         the CLIENT ended the turn: usage limit reached, auth
 *                       expired (`Please run /login`), credit limit, an API
 *                       429/529. Claude Code writes one assistant record with
 *                       `stop_reason: "stop_sequence"` and fires no Stop hook,
 *                       so — like a cancel — no Stop was ever due. Measured,
 *                       not assumed: across 211 local transcripts (61k
 *                       assistant records) every one of the 37 `stop_sequence`
 *                       records was such an abort message, none was followed by
 *                       a `stop_hook_summary`, and none was followed by more
 *                       assistant work in the same turn.
 *   - `superseded`      a second prompt landed before this one's turn ever ran
 *                       (queued messages and `<task-notification>` injections
 *                       arrive in pairs ~130 ms apart), so one model turn served
 *                       both and only the LAST of them is owed a Stop. The
 *                       displaced row is an artifact of counting turns per
 *                       `UserPromptSubmit`; the evidence is that the transcript
 *                       holds no assistant record at all since the turn opened.
 *   - `session_end`     the session ended while the turn was open (an
 *                       abandoned turn).
 *   - `run_close`       the abandoned-run reaper closed the run out from under
 *                       a turn that was still open. Measured 2026-09-03 over
 *                       5.5 days: 45 of the 52 such turns had a daemon restart
 *                       between their start and the session's next turn, i.e.
 *                       the Stop was not lost by the agent — the process that
 *                       would have received it was gone. Reported in its own
 *                       column so it cannot pass for a session end.
 *   - `clear`           `/clear` split the run mid-turn.
 *
 *  NULL means either "still open" (`ended_at IS NULL`) or, on a row written
 *  before the column existed, "unknown" — never assume a bucket for those. */
export type TurnEndSource =
  | 'stop'
  | 'synthetic_stop'
  | 'next_prompt'
  | 'interrupted'
  | 'aborted'
  | 'superseded'
  | 'session_end'
  | 'run_close'
  | 'clear';

/** Per-agent Stop-delivery rollup over a time window (`ApmeStore.stopDelivery`). */
export interface ApmeStopDeliveryRow {
  agentType: string;
  /** Turns STARTED in the window — open ones included, on purpose. */
  total: number;
  stop: number;
  syntheticStop: number;
  nextPrompt: number;
  /** User cancels. Reported beside the loss buckets, never inside them. */
  interrupted: number;
  /** Client-side aborts (usage limit, auth, API error). Like a cancel, no Stop
   *  was owed — reported beside the loss buckets, never inside them. */
  aborted: number;
  /** Prompts folded into the following turn before they ran. No Stop owed. */
  superseded: number;
  /** `session_end` + `clear`: the turn was open when the user ended or reset
   *  the session. No longer includes `run_close`, which is a different fact. */
  sessionEnd: number;
  /** `run_close`: the reaper closed the run under a still-open turn — the
   *  collector that would have received the Stop no longer existed (a daemon
   *  restart, overwhelmingly). Folding this into `sessionEnd` is what made a
   *  measured 29% codex loss report as 11%. Not in the loss ratio either: the
   *  hook may well have fired into a dead port, which is not the agent's
   *  fault, and the honest number for it is this column. */
  runClose: number;
  /** Still open at query time. */
  open: number;
  /** Closed, but written before `end_source` existed — signal unknown. */
  preInstrument: number;
}

/** Per-day judge outcome rollup over a time window (`ApmeStore.judgeHealth`).
 *
 *  The forward-looking counterpart of `ApmeStopDeliveryRow`: that one asks how
 *  turns got closed, this one asks whether the closed work got a verdict. Days
 *  are the local date the tasks CLOSED, not the date they were judged — the
 *  question is "did this day's work get evaluated", and a task judged three
 *  days late still belongs to the day it happened. */
export interface ApmeJudgeHealthRow {
  /** Local date the tasks closed, YYYY-MM-DD. */
  day: string;
  closed: number;
  judged: number;
  /** Refused by task-gradeability — no reply, aborted-only, trivial. NOT a
   *  failure: a verdict about the agent's work needs the agent's work. */
  declined: number;
  /** Unjudged and still inside the drain's lookback. The judge may yet reach
   *  these, so they are pending rather than lost. */
  waiting: number;
  /** Unjudged and OUTSIDE the drain's lookback. The drain can no longer offer
   *  these to the judge, so they never will be. Its own column because the
   *  alternative is what happened before it existed: 226 gradeable tasks aged
   *  out silently while the total just looked like "some old backlog". */
  agedOut: number;
}

/** The share of a day's gradeable work that actually has a verdict.
 *
 *  Defined once, here, for the same reason `stopDeliveryLoss` is: the choice of
 *  denominator IS the instrument. Declined tasks are excluded because refusing
 *  to grade an empty task is the judge working correctly, not a miss; waiting
 *  and aged-out rows stay in, because both are work that should have been
 *  graded and is not. */
export function judgeCoverage(row: ApmeJudgeHealthRow): { adjudicable: number; ratio: number | null } {
  const adjudicable = row.judged + row.waiting + row.agedOut;
  return { adjudicable, ratio: adjudicable > 0 ? row.judged / adjudicable : null };
}

/** The Stop-delivery rate a row actually supports.
 *
 *  Defined once, here, because "which buckets are evidence of a lost hook" is
 *  the whole instrument and a second consumer restating it would quietly
 *  measure something else. Only turns whose Stop can be adjudicated are in the
 *  denominator: a real Stop, a recovered one, or a turn the next prompt
 *  displaced while it was genuinely running. Cancels, client aborts, superseded
 *  prompts, session ends, still-open turns and pre-column rows are not evidence
 *  either way — a turn for which Claude Code never owed a Stop cannot report a
 *  dropped one. */
export function stopDeliveryLoss(row: ApmeStopDeliveryRow): { adjudicated: number; lost: number; ratio: number | null } {
  const adjudicated = row.stop + row.syntheticStop + row.nextPrompt;
  const lost = row.syntheticStop + row.nextPrompt;
  return { adjudicated, lost, ratio: adjudicated > 0 ? lost / adjudicated : null };
}

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
  /** The task's own first turn prompt with NO run-prompt fallback — the only
   *  legitimate input to title derivation (a fallback would name task 2+ of a
   *  split run after task 0's intent). */
  ownFirstPrompt: string | null;
  turnCount: number;
  /** Turns whose assistant reply was archived. `turnCount - answeredTurns > 0`
   *  marks a unit the judge can only partly see. */
  answeredTurns: number;
  eventCount: number;
  toolCount: number;
  /** Sum of files modified + created across the task's turns. */
  filesTouched: number;
  evalCount: number;
  overallScore: number | null;
  /** True when the row matches the Work board's attention bucket (orphaned
   *  boundary, unarchived reply on a closed task, or a red-band score). The
   *  flag is computed by the same SQL expression that filters the Attention
   *  tab, so a striped row and the tab's membership can never disagree. */
  attention: boolean;
}

/** Generic idle-gap boundary, in ms: a session whose last turn CLOSED this
 *  long ago with no new prompt closes its active task with
 *  `boundary_signal='idle_gap'`. Shared because BOTH daemons enforce it
 *  (Node `ApmeCollector.armIdleGapTimer`, Swift `ApmeCollector.idleGapSec` —
 *  the Swift value is this constant in seconds; change the two together).
 *
 *  Why 15 minutes (measured 2026-08-28 on the real store): 96% of claude-code
 *  inter-turn gaps (87% codex) are under 15 min, and nearly everything above
 *  is also past the 30-minute orphan reaper — already split today, just
 *  mislabeled `orphaned` and judged hours late (codex tasks averaged 2.4 h
 *  open; 10% ever judged). */
export const AGENT_IDLE_GAP_MS = 900_000;

/** Attention is triage, so it is bounded by recency: measured on the real
 *  store (2026-08-28), an unwindowed bucket held 1,412 of 1,519 tasks — the
 *  entire pre-idle-gap orphan history — which is an archive, not a to-do
 *  list. Both daemons build the same attention SQL from this window (Swift's
 *  `ApmeStore.taskAttentionWindowMs` literal is grep-pinned to this value by
 *  apme-display-rules-sync.test.ts; change the two together). */
export const TASK_ATTENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The judged-score red band that pulls a recent task into the attention
 *  bucket (`overall < this`). Same cross-daemon contract and grep gate as
 *  the window above (Swift: `ApmeStore.taskAttentionRedScore`). */
export const TASK_ATTENTION_RED_SCORE = 0.4;

/** Work-board lifecycle buckets. `attention` is a cross-cutting triage bucket;
 *  the other four partition a task's lifecycle. One SQL definition per bucket
 *  lives in the store (`TASK_VIEW_SQL`) — filter, row flag and tab badge all
 *  read it. */
export type ApmeTaskView = 'attention' | 'inprogress' | 'judged' | 'reported' | 'orphaned';

/** A task list row enriched at the HTTP layer with the display projections the
 *  Work board renders — the intent-derived title (`deriveTaskTitle`) and the
 *  folded action line (`foldActionCounts`). Kept out of `ApmeTaskListRow` so
 *  the store returns raw facts and the projections stay in their SSOTs. */
export interface ApmeWorkBoardRow extends ApmeTaskListRow {
  /** Intent title from the task's first prompt, or null (render `Task N`). */
  title: string | null;
  /** `Edit×9 Read×24 · 2 files`, or null when there is nothing to fold. */
  actionFold: string | null;
  /** Subagent dispatches / agent-to-agent messages this task made
   *  (`agentCoordinationSummary`), or null for a plain single-agent task. */
  coordination: { dispatches: number; messages: number } | null;
}

export interface ApmeTaskListResponse extends ApmeApiEnvelope {
  total: number;
  limit: number;
  offset: number;
  tasks: ApmeWorkBoardRow[];
  facets: { agents: string[]; projects: string[]; categories: string[]; outcomes: string[] };
  /** Tab badges for the Work board — same bucket definitions as `view`. */
  viewCounts: Record<'all' | ApmeTaskView, number>;
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
