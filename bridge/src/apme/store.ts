/**
 * APME SQLite store — wraps better-sqlite3 with a tiny DAO.
 *
 * better-sqlite3 is an optional native dep; if it fails to load (e.g. CI without
 * build tooling), we fall back to a no-op store so the bridge still boots.
 * Callers should check `store.enabled` before assuming persistence.
 */

import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';
import { debug } from '../logger.js';

// better-sqlite3 is an optional native dep. Resolving via createRequire from
// this file's URL lets Node walk `bridge/node_modules/*` via the pnpm
// workspace symlinks, regardless of the process CWD (vitest runs from the
// repo root, where the symlink doesn't exist).
const require = createRequire(import.meta.url);
import type {
  ApmeRunRow,
  ApmeStepRow,
  ApmeArtifactRow,
  ApmeEvalRowDb,
  ApmeRubricRow,
  ApmeVibeRow,
  ApmeScorecardRow,
  ApmeTaskRow,
  ApmeTaskListRow,
  ApmeStopDeliveryRow,
} from './types.js';
import type {
  ApmeSampleEventRow,
  ApmeSampleScorecardRow,
  ApmeTaskView,
  SessionSample,
  SampleModelConfig,
  TrajectoryEvent,
} from '@agentdeck/shared';
import { TASK_ATTENTION_WINDOW_MS, TASK_ATTENTION_RED_SCORE } from '@agentdeck/shared';

// ─── Schema ────────────────────────────────────────────────────────────────────

const SCORECARD_DDL = `
-- Pre-aggregate metrics at the level they actually describe. New rows prefer
-- turn attribution; runs with no turn identity remain available as a legacy
-- fallback instead of being silently dropped after the schema migration.
CREATE VIEW IF NOT EXISTS v_run_metrics AS
SELECT
  run_id,
  MAX(CASE WHEN metric='overall' AND layer='llm_judge' THEN score END) AS overall,
  MAX(CASE WHEN metric='tests_pass' AND layer='deterministic' THEN score END) AS tests_pass
FROM evals
GROUP BY run_id;

CREATE VIEW IF NOT EXISTS v_model_scorecard AS
WITH turn_eval AS (
  SELECT
    turn_id,
    MAX(CASE WHEN metric='overall' THEN score END) AS overall,
    MAX(CASE WHEN metric='tests_pass' THEN score END) AS tests_pass
  FROM evals
  WHERE turn_id IS NOT NULL
  GROUP BY turn_id
), turn_cost AS (
  SELECT
    turn_id,
    CASE WHEN MIN(COALESCE(cost_known, 0))=1 THEN SUM(cost_usd) ELSE NULL END AS cost_usd,
    MIN(COALESCE(cost_known, 0)) AS cost_known
  FROM sample_events
  WHERE turn_id IS NOT NULL AND kind='model'
  GROUP BY turn_id
), attributed_units AS (
  SELECT
    r.agent_type AS agent_type,
    t.run_id AS run_id,
    t.id AS turn_id,
    t.model_id AS model_id,
    COALESCE(t.provider, r.provider) AS provider,
    COALESCE(
      t.composite_score,
      e.overall
    ) AS overall,
    e.tests_pass AS tests_pass,
    c.cost_usd AS cost_usd,
    COALESCE(c.cost_known, 0) AS cost_known
  FROM turns t
  JOIN runs r ON r.id=t.run_id
  LEFT JOIN turn_eval e ON e.turn_id=t.id
  LEFT JOIN turn_cost c ON c.turn_id=t.id
  WHERE t.model_id IS NOT NULL AND t.model_id != ''
), legacy_units AS (
  SELECT
    r.agent_type AS agent_type,
    r.id AS run_id,
    NULL AS turn_id,
    COALESCE(r.model_id, 'unknown') AS model_id,
    r.provider AS provider,
    m.overall AS overall,
    m.tests_pass AS tests_pass,
    CASE WHEN r.cost_known=1 THEN r.cost_usd ELSE NULL END AS cost_usd,
    COALESCE(r.cost_known, 0) AS cost_known
  FROM runs r
  LEFT JOIN v_run_metrics m ON m.run_id=r.id
  WHERE NOT EXISTS (
    SELECT 1 FROM turns t
    WHERE t.run_id=r.id AND t.model_id IS NOT NULL AND t.model_id != ''
  )
), units AS (
  SELECT * FROM attributed_units
  UNION ALL
  SELECT * FROM legacy_units
)
SELECT
  agent_type,
  model_id,
  provider,
  COUNT(DISTINCT run_id) AS runs,
  AVG(overall) AS avg_overall,
  AVG(tests_pass) AS avg_tests_pass,
  CASE WHEN MIN(cost_known)=1 THEN SUM(cost_usd) ELSE NULL END AS total_cost,
  MIN(cost_known) AS cost_known,
  CASE WHEN MIN(cost_known)=1 AND AVG(overall)>0 THEN SUM(cost_usd)/AVG(overall) ELSE NULL END AS cost_per_quality
FROM units
GROUP BY agent_type, model_id, provider;

CREATE VIEW IF NOT EXISTS v_category_scorecard AS
WITH task_metrics AS (
  SELECT
    task_id,
    MAX(CASE WHEN metric='tests_pass' AND layer='deterministic' THEN score END) AS tests_pass
  FROM evals
  WHERE task_id IS NOT NULL
  GROUP BY task_id
)
SELECT
  t.task_category AS task_category,
  COALESCE(t.model_id, r.model_id, 'unknown') AS model_id,
  COALESCE(t.provider, r.provider) AS provider,
  COUNT(DISTINCT t.run_id) AS runs,
  AVG(t.composite_score) AS avg_overall,
  AVG(m.tests_pass) AS avg_tests_pass,
  CASE WHEN MIN(COALESCE(t.cost_known, 0))=1 THEN SUM(t.cost_usd) ELSE NULL END AS total_cost,
  MIN(COALESCE(t.cost_known, 0)) AS cost_known
FROM tasks t
JOIN runs r ON r.id=t.run_id
LEFT JOIN task_metrics m ON m.task_id=t.id
WHERE t.task_category IS NOT NULL AND t.task_category != 'unknown'
GROUP BY t.task_category, COALESCE(t.model_id, r.model_id, 'unknown'), COALESCE(t.provider, r.provider);

-- Sample-granularity scorecard: quality vs cost per (agent, provider, model,
-- category). A task that used more than one model is stored as 'mixed' rather
-- than attributed to whichever assistant message happened to arrive last.
CREATE VIEW IF NOT EXISTS v_sample_scorecard AS
SELECT
  r.agent_type AS agent_type,
  COALESCE(t.model_id, r.model_id, 'unknown') AS model_id,
  COALESCE(t.provider, r.provider) AS provider,
  t.task_category AS task_category,
  COUNT(*) AS samples,
  AVG(t.composite_score) AS avg_quality,
  CASE WHEN MIN(COALESCE(t.cost_known, 0))=1 THEN SUM(t.cost_usd) ELSE NULL END AS total_cost,
  MIN(COALESCE(t.cost_known, 0)) AS cost_known,
  AVG(t.latency_ms) AS avg_latency_ms,
  CASE WHEN MIN(COALESCE(t.cost_known, 0))=1 AND AVG(t.composite_score)>0
       THEN SUM(t.cost_usd)/AVG(t.composite_score) ELSE NULL END AS cost_per_quality
FROM tasks t
JOIN runs r ON r.id=t.run_id
WHERE t.ended_at IS NOT NULL AND t.composite_score IS NOT NULL
GROUP BY r.agent_type, COALESCE(t.model_id, r.model_id, 'unknown'), COALESCE(t.provider, r.provider), t.task_category;
`;

const DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  agent_type    TEXT NOT NULL,
  model_id      TEXT,
  provider      TEXT,
  project_name  TEXT,
  project_path  TEXT,
  task_prompt   TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  cost_known    INTEGER NOT NULL DEFAULT 0,
  exit_code     INTEGER,
  git_before    TEXT,
  git_after     TEXT,
  hw_profile    TEXT,
  task_signals  TEXT,
  task_category TEXT,
  task_category_source TEXT DEFAULT 'auto',
  outcome       TEXT,
  outcome_confidence TEXT,
  efficiency_json TEXT,
  composite_score REAL
);

CREATE TABLE IF NOT EXISTS steps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts         INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  tool_name  TEXT,
  payload    TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id     TEXT,
  turn_index  INTEGER NOT NULL,
  model_id    TEXT,
  provider    TEXT,
  prompt      TEXT,
  response    TEXT,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  tool_calls  INTEGER DEFAULT 0,
  files_modified INTEGER DEFAULT 0,
  files_created INTEGER DEFAULT 0,
  git_before  TEXT,
  git_after   TEXT,
  task_category TEXT,
  outcome     TEXT,
  composite_score REAL,
  efficiency_json TEXT,
  -- How this turn's end was learned. The Stop hook is the sole authority that
  -- closes a Claude turn and its delivery is NOT guaranteed, so the closing
  -- signal is recorded per turn: 'stop' (real hook), 'synthetic_stop'
  -- (watchdog recovered it from the transcript), 'next_prompt' (no Stop ever
  -- arrived — an unrecovered loss), 'session_end' / 'run_close' / 'clear'.
  -- NULL while the turn is open. This column is the Stop-delivery instrument:
  -- synthetic_stop/(stop+synthetic_stop+next_prompt) is the observed loss rate
  -- and 'next_prompt' alone is the share the watchdog failed to recover.
  end_source  TEXT
);

CREATE INDEX IF NOT EXISTS idx_turns_run ON turns(run_id);
CREATE INDEX IF NOT EXISTS idx_turns_task ON turns(task_id);

CREATE TABLE IF NOT EXISTS tasks (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_index       INTEGER NOT NULL,
  boundary_signal  TEXT NOT NULL,
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  first_turn_index INTEGER,
  last_turn_index  INTEGER,
  summary          TEXT,
  outcome          TEXT,
  composite_score  REAL,
  task_category    TEXT,
  notes_json       TEXT,
  model_id         TEXT,
  provider         TEXT,
  model_config     TEXT,
  input_tokens     INTEGER,
  output_tokens    INTEGER,
  cost_usd         REAL,
  cost_known       INTEGER NOT NULL DEFAULT 0,
  latency_ms       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);

-- Typed trajectory events — the SessionSample.events projection. The single
-- source of truth that BOTH the timeline and APME eval derive from. Storage-
-- time dedup via the UNIQUE index + INSERT OR IGNORE (no race-sensitive window).
CREATE TABLE IF NOT EXISTS sample_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  turn_index    INTEGER,
  seq           INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  kind          TEXT NOT NULL,
  model         TEXT,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  cost_known    INTEGER NOT NULL DEFAULT 0,
  latency_ms    INTEGER,
  tool_name     TEXT,
  tool_status   TEXT,
  tool_error    TEXT,
  payload       TEXT,
  dedup_key     TEXT
);

CREATE INDEX IF NOT EXISTS idx_sevents_task ON sample_events(task_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sevents_dedup ON sample_events(task_id, dedup_key);

CREATE TABLE IF NOT EXISTS artifacts (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id    TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind      TEXT NOT NULL,
  path      TEXT NOT NULL,
  sha256    TEXT,
  bytes     INTEGER
);

CREATE TABLE IF NOT EXISTS evals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  turn_id     TEXT REFERENCES turns(id) ON DELETE CASCADE,
  task_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  layer       TEXT NOT NULL,
  metric      TEXT NOT NULL,
  score       REAL,
  raw         TEXT,
  rubric_ver  INTEGER,
  judge_model TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rubrics (
  version     INTEGER PRIMARY KEY,
  purpose     TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  weights     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  parent_ver  INTEGER,
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS vibe_feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  verdict    TEXT NOT NULL,
  note       TEXT,
  ts         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_model ON runs(model_id);
CREATE INDEX IF NOT EXISTS idx_runs_agent ON runs(agent_type);
CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
CREATE INDEX IF NOT EXISTS idx_evals_run ON evals(run_id);
CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id);

${SCORECARD_DDL}
`;

// ─── Default rubric v1 (seeded on first boot) ──────────────────────────────────

const DEFAULT_RUBRIC_V1 = {
  version: 1,
  purpose: 'general',
  prompt: `You are a senior engineer evaluating whether an AI coding agent completed the user's task.

Given the task prompt and the git diff produced, evaluate the agent's contribution.
Score each axis as a float in [0,1] where 0=failed and 1=excellent.

Axes:
- task_completion: Did the agent actually do what the user asked? A perfect score means the task prompt's request was fully addressed in the diff. A zero means nothing relevant was done.
- code_quality: Is the code correct, safe, and maintainable? Check for bugs, missing error handling, security issues, and dead code.
- efficiency: Did the agent make minimal, focused changes? Penalize unrelated modifications, unnecessary refactoring, or verbose solutions to simple problems.
- overall: Your holistic judgment. Weight task_completion most heavily — a session that completes the task with decent quality is better than a perfect-style session that misses the point.

Important: Explain your reasoning with specific references to what was done and what was missed. List concrete items with checkmarks (done) and crosses (missed). This reasoning will be shown to the user for verification.
"missed" lists only parts of the user's request that were not done — style nits and improvement ideas belong in "reasoning", and an empty missed array is the correct output for a fully completed request.

Return strict JSON: {"task_completion":N,"code_quality":N,"efficiency":N,"overall":N,"reasoning":"...", "done":["item1","item2"], "missed":["item1"]}.`,
  weights: JSON.stringify({ task_completion: 0.5, code_quality: 0.3, efficiency: 0.2 }),
  notes: 'seeded default',
};

/** The pre-2026-08-22 general prompt, kept verbatim so seeding can recognize
 *  an untouched v1 and upgrade it in place. Judges routinely filed style nits
 *  under `missed`, which the scorecard renders as "work the agent skipped" —
 *  a completed task then reads as incomplete (found by model-eval J02). Only
 *  a byte-identical legacy prompt is upgraded: any user edit means the rubric
 *  is theirs, not ours. */
export const DEFAULT_RUBRIC_PROMPT_LEGACY = `You are a senior engineer evaluating whether an AI coding agent completed the user's task.

Given the task prompt and the git diff produced, evaluate the agent's contribution.
Score each axis as a float in [0,1] where 0=failed and 1=excellent.

Axes:
- task_completion: Did the agent actually do what the user asked? A perfect score means the task prompt's request was fully addressed in the diff. A zero means nothing relevant was done.
- code_quality: Is the code correct, safe, and maintainable? Check for bugs, missing error handling, security issues, and dead code.
- efficiency: Did the agent make minimal, focused changes? Penalize unrelated modifications, unnecessary refactoring, or verbose solutions to simple problems.
- overall: Your holistic judgment. Weight task_completion most heavily — a session that completes the task with decent quality is better than a perfect-style session that misses the point.

Important: Explain your reasoning with specific references to what was done and what was missed. List concrete items with checkmarks (done) and crosses (missed). This reasoning will be shown to the user for verification.

Return strict JSON: {"task_completion":N,"code_quality":N,"efficiency":N,"overall":N,"reasoning":"...", "done":["item1","item2"], "missed":["item1"]}.`;

// ─── Category-specific rubrics ──────────────────────────────────────────────
// Each category has evaluation axes suited to its domain.
// The judge selects the rubric matching the run's taskCategory.
// Falls back to 'general' if no category-specific rubric exists.

const CATEGORY_RUBRICS: Record<string, { purpose: string; prompt: string; weights: string; notes: string }> = {
  conversation: {
    purpose: 'conversation',
    prompt: `You are evaluating an AI assistant's response to a conversational query or question.
The user asked a question and the agent responded. Evaluate the quality of the response.

Score each axis as a float in [0,1] where 0=failed and 1=excellent.

Axes:
- accuracy: Is the answer factually correct? For math/logic questions, is the result right?
- helpfulness: Does the response address what the user actually wanted? Is it complete?
- conciseness: Is the response appropriately sized? Not too verbose, not too terse.
- overall: Holistic judgment. An accurate, helpful response scores high even if brief.

Return strict JSON: {"accuracy":N,"helpfulness":N,"conciseness":N,"overall":N,"reasoning":"...", "done":["item1"], "missed":["item1"]}.`,
    weights: JSON.stringify({ accuracy: 0.5, helpfulness: 0.3, conciseness: 0.2 }),
    notes: 'conversation/Q&A evaluation',
  },
  planning: {
    purpose: 'planning',
    prompt: `You are evaluating an AI agent's planning session. The user asked the agent to plan an approach for a task.

Score each axis as a float in [0,1] where 0=failed and 1=excellent.

Axes:
- completeness: Does the plan cover all aspects of the request? Are edge cases considered?
- feasibility: Is the plan technically sound and implementable? Are the proposed steps realistic?
- clarity: Is the plan well-structured, easy to follow, with clear priorities?
- overall: Holistic judgment. A thorough, actionable plan scores high.

Return strict JSON: {"completeness":N,"feasibility":N,"clarity":N,"overall":N,"reasoning":"...", "done":["item1"], "missed":["item1"]}.`,
    weights: JSON.stringify({ completeness: 0.4, feasibility: 0.35, clarity: 0.25 }),
    notes: 'planning/architecture evaluation',
  },
  research: {
    purpose: 'research',
    prompt: `You are evaluating an AI agent's research session. The user asked the agent to investigate, search, or gather information.

Score each axis as a float in [0,1] where 0=failed and 1=excellent.

Axes:
- thoroughness: Did the agent search broadly enough? Were relevant files, docs, or sources explored?
- relevance: Is the information found actually relevant to the user's question?
- synthesis: Did the agent synthesize findings into a clear answer or summary?
- overall: Holistic judgment. Research that finds the right answer efficiently scores high.

Return strict JSON: {"thoroughness":N,"relevance":N,"synthesis":N,"overall":N,"reasoning":"...", "done":["item1"], "missed":["item1"]}.`,
    weights: JSON.stringify({ thoroughness: 0.3, relevance: 0.4, synthesis: 0.3 }),
    notes: 'research/investigation evaluation',
  },
  debugging: {
    purpose: 'debugging',
    prompt: `You are evaluating an AI agent's debugging session. The user reported a bug and the agent investigated and attempted to fix it.

Given the task prompt and the git diff produced, evaluate the debugging effort.
Score each axis as a float in [0,1] where 0=failed and 1=excellent.

Axes:
- diagnosis: Did the agent correctly identify the root cause? Not just symptoms but the actual bug?
- fix_quality: Is the fix correct, minimal, and safe? Does it avoid introducing new bugs?
- verification: Did the agent verify the fix (run tests, check edge cases)?
- overall: Holistic judgment. A correct diagnosis + clean fix scores high.

Return strict JSON: {"diagnosis":N,"fix_quality":N,"verification":N,"overall":N,"reasoning":"...", "done":["item1"], "missed":["item1"]}.`,
    weights: JSON.stringify({ diagnosis: 0.35, fix_quality: 0.4, verification: 0.25 }),
    notes: 'debugging evaluation',
  },
  refactoring: {
    purpose: 'refactoring',
    prompt: `You are evaluating an AI agent's refactoring session. The user asked the agent to restructure or improve existing code.

Given the task prompt and the git diff produced, evaluate the refactoring.
Score each axis as a float in [0,1] where 0=failed and 1=excellent.

Axes:
- safety: Does the refactoring preserve existing behavior? No regressions introduced?
- improvement: Is the resulting code genuinely better? Cleaner, more maintainable, less duplication?
- scope: Was the refactoring appropriately scoped? Not too aggressive, not too timid?
- overall: Holistic judgment. Safe refactoring that clearly improves the code scores high.

Return strict JSON: {"safety":N,"improvement":N,"scope":N,"overall":N,"reasoning":"...", "done":["item1"], "missed":["item1"]}.`,
    weights: JSON.stringify({ safety: 0.4, improvement: 0.35, scope: 0.25 }),
    notes: 'refactoring evaluation',
  },
  review: {
    purpose: 'review',
    prompt: `You are evaluating an AI agent's code review session. The user asked the agent to review code for issues.

Score each axis as a float in [0,1] where 0=failed and 1=excellent.

Axes:
- coverage: Did the review examine all relevant areas? Were critical paths checked?
- insight: Did the review catch real issues (not just style nits)? Were suggestions actionable?
- accuracy: Are the identified issues real problems? Low false positive rate?
- overall: Holistic judgment. A review that catches important bugs/issues scores high.

Return strict JSON: {"coverage":N,"insight":N,"accuracy":N,"overall":N,"reasoning":"...", "done":["item1"], "missed":["item1"]}.`,
    weights: JSON.stringify({ coverage: 0.3, insight: 0.4, accuracy: 0.3 }),
    notes: 'code review evaluation',
  },
  ops: {
    purpose: 'ops',
    prompt: `You are evaluating an AI agent's ops/DevOps session. The user asked the agent to perform operational tasks (git, CI/CD, deployment, configuration).

Score each axis as a float in [0,1] where 0=failed and 1=excellent.

Axes:
- correctness: Did the operations complete successfully? Were commands appropriate?
- safety: Were destructive operations handled carefully? Were backups/confirmations used?
- completeness: Were all requested steps performed? Nothing left half-done?
- overall: Holistic judgment. Correct, safe ops that complete the task score high.

Return strict JSON: {"correctness":N,"safety":N,"completeness":N,"overall":N,"reasoning":"...", "done":["item1"], "missed":["item1"]}.`,
    weights: JSON.stringify({ correctness: 0.4, safety: 0.35, completeness: 0.25 }),
    notes: 'ops/DevOps evaluation',
  },
  task_rollup: {
    purpose: 'task_rollup',
    prompt: `You are evaluating a multi-turn AI agent task that has just ended.
The boundary signal that closed the task tells you HOW it ended:
  - todo_complete : the agent itself marked every TodoWrite item as completed (self-declared done)
  - clear         : the user typed /clear to reset context (often: user gave up or moved on)
  - session_end   : the agent process exited (could be done, could be interrupted)
  - manual        : a human marked the boundary explicitly

You receive: the task's category (coding/planning/research/…), the number of turns,
the boundary signal, and the full Turn 0..N transcript (user prompt → agent response).

Your job is a one-sentence rollup PLUS axis scores in [0,1].

Identify FIRST: what was the user actually trying to accomplish? Read Turn 0's prompt and any
later prompts that pivot or refine. The task's success is measured against THAT goal — not
against how busy the turns look.

Axes (each in [0,1], 0=failed, 1=excellent):
- completion: Did the agent actually deliver against the user's identified goal? High = goal
  reached with evidence in the final turns. Low = goal half-done, abandoned, or only declared
  done (e.g. "I've completed all the items" with nothing visible). For boundary=clear, completion
  is usually low — the user reset before satisfaction.
- coherence: Did the turns build on each other toward the goal? Penalize incoherent jumps,
  redundant re-planning, lost context, or the agent forgetting earlier decisions.
- efficiency: Were the turns appropriately scoped? Penalize repeated tool calls with the same
  inputs, long discovery loops the agent could have shortcut, or churn. Reward focused progress.
- overall: Holistic judgment. Weight completion most heavily — an efficient coherent task
  that never finishes is worse than a slightly messier task that delivered.

Summary guidance: one sentence, ≤ 280 characters, past tense, describing what the task ACCOMPLISHED
(not what the agent attempted). Start with a verb: "Added", "Fixed", "Investigated", "Refactored",
"Failed to". Be specific about the artefact when possible. No hedging, no "the agent…" preamble.

reasoning: 1-3 sentences explaining the key evidence behind the overall score. Cite turn numbers.
done: list the concrete deliverables visible in the turns (≤5 short items).
missed: list what the user asked for but the agent did NOT deliver (≤5 items, empty array if none).

Return strict JSON exactly, no prose before or after:
{"summary":"<one sentence>","completion":N,"coherence":N,"efficiency":N,"overall":N,"reasoning":"...","done":["…"],"missed":["…"]}

Examples of well-calibrated overall scores:
  0.9 — User asked to add a feature; final turns show the feature implemented + test passing.
  0.6 — User asked for a feature; agent built most of it but left a TODO they self-declared "done".
  0.3 — User asked a question; agent rambled across 5 turns without ever answering.
  0.1 — User asked to fix a bug; agent introduced two more bugs and called /clear.`,
    weights: JSON.stringify({ completion: 0.5, coherence: 0.25, efficiency: 0.25 }),
    notes: 'task-unit rollup (TodoWrite all-completed / /clear / session_end)',
  },
};

// ─── Store ─────────────────────────────────────────────────────────────────────

type BetterSqliteDb = {
  prepare: (sql: string) => {
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
  exec: (sql: string) => void;
  close: () => void;
  pragma: (s: string) => unknown;
  /** better-sqlite3 wraps `fn` in BEGIN/COMMIT and rolls back if it throws. */
  transaction: <T>(fn: () => T) => () => T;
};

/** The latest overall judge score for a task, else its composite. Inlined into
 *  several `TASK_VIEW_SQL` buckets so "judged" means one thing everywhere. */
const TASK_SCORE_SQL =
  `COALESCE((SELECT e.score FROM evals e WHERE e.task_id = t.id AND e.metric = 'overall'
             ORDER BY e.created_at DESC LIMIT 1), t.composite_score)`;

/** The recency window and red-score band live in shared/src/eval-schema.ts
 *  (TASK_ATTENTION_WINDOW_MS / TASK_ATTENTION_RED_SCORE): both daemons build
 *  the same attention SQL, so the numbers are cross-daemon contracts, not
 *  store-local tuning knobs. Re-exported for existing importers. */
export { TASK_ATTENTION_WINDOW_MS } from '@agentdeck/shared';

/** The attention bucket, anchored at a caller-supplied cutoff (epoch ms) so
 *  the filter, the row flag and the badge are computed against the SAME
 *  instant within one request. Needs eyes = recent AND (reaper-closed, a
 *  closed task with an unarchived reply the judge can only partly see, or a
 *  judged score below the dashboard's red band). `cutoffMs` is always a
 *  number we computed — never user input — so inlining it is safe. */
function taskAttentionSql(cutoffMs: number): string {
  // IFNULL is load-bearing: a NULL score makes `score < 0.4` NULL, NULL OR
  // false is NULL, and SQLite sorts NULL LAST under DESC — so without it,
  // recent unjudged rows sank BELOW week-old rows (which get a determinate 0
  // from the cutoff test) on the attention-first ordering.
  return `IFNULL((t.started_at >= ${Math.floor(cutoffMs)}
      AND (t.boundary_signal = 'orphaned'
        OR (t.ended_at IS NOT NULL AND EXISTS (
              SELECT 1 FROM turns tu WHERE tu.task_id = t.id AND tu.response IS NULL))
        OR ${TASK_SCORE_SQL} < ${TASK_ATTENTION_RED_SCORE})), 0)`;
}

/** The NARROWING filters `listTaskPage` and `taskViewCounts` share — one
 *  builder so a filtered board's badges and its rows read the same WHERE. */
function buildTaskFilterWhere(opts: {
  agentType?: string; sessionId?: string; projectName?: string; category?: string; outcome?: string; q?: string;
}): { where: string[]; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  // `_empty` runs are bookkeeping shells, never work the user did.
  where.push("COALESCE(r.task_category, '') != '_empty'");
  if (opts.agentType) { where.push('r.agent_type = ?'); args.push(opts.agentType); }
  if (opts.sessionId) { where.push('r.session_id = ?'); args.push(opts.sessionId); }
  if (opts.projectName) { where.push('r.project_name = ?'); args.push(opts.projectName); }
  if (opts.category) { where.push('COALESCE(t.task_category, r.task_category) = ?'); args.push(opts.category); }
  if (opts.outcome) { where.push('t.outcome = ?'); args.push(opts.outcome); }
  if (opts.q) {
    where.push('(t.summary LIKE ? OR r.task_prompt LIKE ?)');
    const like = `%${opts.q}%`; args.push(like, like);
  }
  return { where, args };
}

/** ONE SQL definition per Work-board lifecycle bucket — the filter, the row's
 *  `attention` flag and the tab badges all read these same expressions, so a
 *  badge count can never disagree with the rows its tab lists.
 *
 *  attention  — see `taskAttentionSql` (recency-windowed, hence a function).
 *  inprogress — still accumulating turns.
 *  judged     — carries an overall judge score or a composite.
 *  reported   — closed but never scored (no judge configured / skipped).
 *  orphaned   — reaper-closed; the un-windowed ledger of segmentation debt. */
const TASK_VIEW_SQL: Record<Exclude<ApmeTaskView, 'attention'>, string> = {
  inprogress: 't.ended_at IS NULL',
  judged: `${TASK_SCORE_SQL} IS NOT NULL`,
  reported: `(t.ended_at IS NOT NULL AND ${TASK_SCORE_SQL} IS NULL)`,
  orphaned: `t.boundary_signal = 'orphaned'`,
};

export class ApmeStore {
  private db: BetterSqliteDb | null = null;
  public enabled = false;
  public readonly dbPath: string;
  /** Populated when init() returns false. Surfaced in daemon startup logs so
   *  silent APME outages (the failure mode that left ~/.agentdeck/apme.sqlite
   *  stale for 11 days in 2026-04 user data) become diagnosable. */
  public lastInitError: string | null = null;

  constructor(dbPath?: string) {
    const dataDir = process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
    this.dbPath = dbPath ?? join(dataDir, 'apme.sqlite');
  }

  /** Attempt to open the DB. Returns false on failure; check `lastInitError`
   *  for the reason. The two common failure modes are:
   *    1. better-sqlite3 native binding missing (CI / setups without build tools)
   *    2. DB file unreadable / DDL fails (disk full, permissions, WAL lock from a
   *       crashed prior process). */
  async init(): Promise<boolean> {
    try {
      let Ctor: (new (path: string) => BetterSqliteDb) | null = null;
      try {
        Ctor = require('better-sqlite3') as new (path: string) => BetterSqliteDb;
      } catch (err) {
        this.lastInitError =
          `better-sqlite3 native binding unavailable (${String(err).slice(0, 200)})`;
        debug('APME', this.lastInitError);
        return false;
      }
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      this.db = new Ctor(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.exec(DDL);
      this.migrateSchema();
      this.seedDefaultRubric();
      this.enabled = true;
      this.lastInitError = null;
      debug('APME', `store ready at ${this.dbPath}`);
      return true;
    } catch (err) {
      this.lastInitError = `store init failed at ${this.dbPath}: ${String(err).slice(0, 300)}`;
      debug('APME', this.lastInitError);
      return false;
    }
  }

  close(): void {
    try { this.db?.close(); } catch { /* ignore */ }
    this.db = null;
    this.enabled = false;
  }

  /** Add columns that may be missing from databases created before this version. */
  private migrateSchema(): void {
    if (!this.db) return;
    const cols = (this.db.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>).map(c => c.name);
    const migrations: Array<[string, string]> = [
      ['provider', 'ALTER TABLE runs ADD COLUMN provider TEXT'],
      ['cost_known', 'ALTER TABLE runs ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 0'],
      ['task_signals', 'ALTER TABLE runs ADD COLUMN task_signals TEXT'],
      ['task_category', 'ALTER TABLE runs ADD COLUMN task_category TEXT'],
      ['task_category_source', "ALTER TABLE runs ADD COLUMN task_category_source TEXT DEFAULT 'auto'"],
      ['turn_id', 'ALTER TABLE evals ADD COLUMN turn_id TEXT REFERENCES turns(id) ON DELETE CASCADE'],
      ['turn_response', 'ALTER TABLE turns ADD COLUMN response TEXT'],
      ['outcome', 'ALTER TABLE runs ADD COLUMN outcome TEXT'],
      ['outcome_confidence', 'ALTER TABLE runs ADD COLUMN outcome_confidence TEXT'],
      ['efficiency_json', 'ALTER TABLE runs ADD COLUMN efficiency_json TEXT'],
      ['composite_score', 'ALTER TABLE runs ADD COLUMN composite_score REAL'],
    ];
    for (const [col, sql] of migrations) {
      if (!cols.includes(col)) {
        try { this.db.exec(sql); } catch { /* column may already exist from partial migration */ }
      }
    }
    // Tasks table — created via CREATE TABLE IF NOT EXISTS above, but older
    // DBs need ALTER for turns.task_id and evals.task_id.
    const turnCols = (this.db.prepare("PRAGMA table_info(turns)").all() as Array<{ name: string }>).map(c => c.name);
    if (!turnCols.includes('task_id')) {
      try { this.db.exec('ALTER TABLE turns ADD COLUMN task_id TEXT'); } catch { /* ignore */ }
      try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_turns_task ON turns(task_id)'); } catch { /* ignore */ }
    }
    // Stop-delivery attribution. Deliberately NOT backfilled: rows written
    // before this column existed cannot be told apart (every one of them was
    // closed by the next prompt regardless of whether a Stop arrived), and a
    // guessed backfill would poison the very rate this column exists to
    // measure. `end_source IS NULL AND ended_at IS NOT NULL` reads as
    // "pre-instrument", which is what it is.
    if (!turnCols.includes('end_source')) {
      try { this.db.exec('ALTER TABLE turns ADD COLUMN end_source TEXT'); } catch { /* ignore */ }
    }
    if (!turnCols.includes('model_id')) {
      try { this.db.exec('ALTER TABLE turns ADD COLUMN model_id TEXT'); } catch { /* ignore */ }
    }
    if (!turnCols.includes('provider')) {
      try { this.db.exec('ALTER TABLE turns ADD COLUMN provider TEXT'); } catch { /* ignore */ }
    }
    const evalCols = (this.db.prepare("PRAGMA table_info(evals)").all() as Array<{ name: string }>).map(c => c.name);
    if (!evalCols.includes('task_id')) {
      try { this.db.exec('ALTER TABLE evals ADD COLUMN task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE'); }
      catch { /* ignore */ }
    }
    // Tasks sample-header columns (model identity + cost) — added for the
    // SessionSample rebuild. Older DBs get them via ALTER.
    const taskCols = (this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>).map(c => c.name);
    for (const [col, sql] of [
      ['model_id', 'ALTER TABLE tasks ADD COLUMN model_id TEXT'],
      ['provider', 'ALTER TABLE tasks ADD COLUMN provider TEXT'],
      ['model_config', 'ALTER TABLE tasks ADD COLUMN model_config TEXT'],
      ['input_tokens', 'ALTER TABLE tasks ADD COLUMN input_tokens INTEGER'],
      ['output_tokens', 'ALTER TABLE tasks ADD COLUMN output_tokens INTEGER'],
      ['cost_usd', 'ALTER TABLE tasks ADD COLUMN cost_usd REAL'],
      ['cost_known', 'ALTER TABLE tasks ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 0'],
      ['latency_ms', 'ALTER TABLE tasks ADD COLUMN latency_ms INTEGER'],
    ] as Array<[string, string]>) {
      if (!taskCols.includes(col)) {
        try { this.db.exec(sql); } catch { /* ignore */ }
      }
    }
    // ── Graph-integrity columns ──
    // The row model is a clean hierarchy (run → task → turn → event) EXCEPT for
    // two severed edges, both of which a graph projection would have to guess at:
    //
    //  1. sample_events pointed at a turn by `turn_index`, an integer that is
    //     only unique within a run — so the trajectory could not be walked back
    //     to its turn without a compound join, and a task spanning turns had no
    //     first-class event→turn edge at all.
    //  2. `/clear` splits a session into a fresh run (`splitRun`) with no
    //     pointer to the run it continues, so one conversation shows up as N
    //     disconnected components. One live session here had 127 such runs.
    const sevCols = (this.db.prepare("PRAGMA table_info(sample_events)").all() as Array<{ name: string }>).map(c => c.name);
    if (!sevCols.includes('cost_known')) {
      try { this.db.exec('ALTER TABLE sample_events ADD COLUMN cost_known INTEGER NOT NULL DEFAULT 0'); } catch { /* ignore */ }
    }
    if (!sevCols.includes('turn_id')) {
      try { this.db.exec('ALTER TABLE sample_events ADD COLUMN turn_id TEXT'); } catch { /* ignore */ }
      try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_sevents_turn ON sample_events(turn_id)'); } catch { /* ignore */ }
      // Backfill from the compound key the column replaces. One-shot: the
      // column only appears once, so this never re-scans on later boots.
      try {
        this.db.exec(
          `UPDATE sample_events SET turn_id = (
             SELECT t.id FROM turns t
             WHERE t.run_id = sample_events.run_id AND t.turn_index = sample_events.turn_index
           ) WHERE turn_id IS NULL AND turn_index IS NOT NULL`,
        );
      } catch { /* best-effort backfill */ }
    }
    if (!cols.includes('parent_run_id')) {
      try { this.db.exec('ALTER TABLE runs ADD COLUMN parent_run_id TEXT'); } catch { /* ignore */ }
      try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id)'); } catch { /* ignore */ }
    }

    // A positive historical value proves that a price existed. Historical
    // zeroes remain unknown because they could be either a free local model or
    // the old UNKNOWN_PRICE fallback — the ambiguity this column removes.
    try { this.db.exec('UPDATE runs SET cost_known=1 WHERE cost_usd > 0'); } catch { /* ignore */ }
    try { this.db.exec('UPDATE tasks SET cost_known=1 WHERE cost_usd > 0'); } catch { /* ignore */ }
    try { this.db.exec('UPDATE sample_events SET cost_known=1 WHERE cost_usd > 0'); } catch { /* ignore */ }

    // ── Covering indexes for the per-run/per-task rollups ──
    // better-sqlite3 is synchronous on a single connection, so ANY slow query
    // here stalls the daemon's whole HTTP path — this is a latency budget, not
    // a nice-to-have. `MAX(ts)` over a run's steps was reading full rows to
    // reach one integer, and `steps.payload` holds entire hook bodies, so the
    // abandoned-run sweep was touching hundreds of megabytes and taking 22s.
    // (run_id, ts) answers it from the index alone.
    for (const sql of [
      'CREATE INDEX IF NOT EXISTS idx_steps_run_ts ON steps(run_id, ts)',
      'CREATE INDEX IF NOT EXISTS idx_sevents_run_ts ON sample_events(run_id, ts)',
      'CREATE INDEX IF NOT EXISTS idx_turns_run_started ON turns(run_id, started_at)',
      // evals had an index on run_id only, while the task rollup and the task
      // list both look up by task_id.
      'CREATE INDEX IF NOT EXISTS idx_evals_task ON evals(task_id)',
      'CREATE INDEX IF NOT EXISTS idx_tasks_started ON tasks(started_at)',
    ]) {
      try { this.db.exec(sql); } catch { /* ignore */ }
    }

    // CREATE VIEW IF NOT EXISTS preserves stale executable SQL forever. Rebuild
    // after the ALTERs above so both fresh and upgraded databases group by the
    // turn/provider identity this version actually writes.
    for (const view of ['v_sample_scorecard', 'v_category_scorecard', 'v_model_scorecard', 'v_run_metrics']) {
      try { this.db.exec(`DROP VIEW IF EXISTS ${view}`); } catch { /* ignore */ }
    }
    this.db.exec(SCORECARD_DDL);
  }

  private seedDefaultRubric(): void {
    if (!this.db) return;
    // Seed general rubric if none exists
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM rubrics WHERE purpose = ?').get('general') as { n: number };
    if (row.n > 0) {
      // Upgrade an untouched legacy general prompt to the missed-axis-clarified
      // wording. Byte-identical match only — an edited rubric belongs to the
      // user and is never overwritten; the append keeps full version history.
      const latestGeneral = this.getCurrentRubric('general');
      if (latestGeneral && latestGeneral.prompt === DEFAULT_RUBRIC_PROMPT_LEGACY) {
        this.appendRubric({
          purpose: 'general',
          prompt: DEFAULT_RUBRIC_V1.prompt,
          weights: DEFAULT_RUBRIC_V1.weights,
          createdAt: Date.now(),
          parentVer: latestGeneral.version,
          notes: 'seeded default (missed-axis clarified)',
        });
      }
      // Seed category rubrics that don't exist yet (idempotent)
      for (const [, rubric] of Object.entries(CATEGORY_RUBRICS)) {
        const exists = this.db.prepare('SELECT COUNT(*) AS n FROM rubrics WHERE purpose = ?').get(rubric.purpose) as { n: number };
        if (exists.n === 0) {
          this.db.prepare(
            `INSERT INTO rubrics (purpose, prompt, weights, created_at, parent_ver, notes) VALUES (?, ?, ?, ?, NULL, ?)`,
          ).run(rubric.purpose, rubric.prompt, rubric.weights, Date.now(), rubric.notes);
        }
      }
      return;
    }
    this.db.prepare(
      `INSERT INTO rubrics (version, purpose, prompt, weights, created_at, parent_ver, notes)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      DEFAULT_RUBRIC_V1.version,
      DEFAULT_RUBRIC_V1.purpose,
      DEFAULT_RUBRIC_V1.prompt,
      DEFAULT_RUBRIC_V1.weights,
      Date.now(),
      DEFAULT_RUBRIC_V1.notes,
    );
    // Seed category-specific rubrics (version auto-assigned by SQLite rowid)
    for (const [, rubric] of Object.entries(CATEGORY_RUBRICS)) {
      this.db.prepare(
        `INSERT INTO rubrics (purpose, prompt, weights, created_at, parent_ver, notes) VALUES (?, ?, ?, ?, NULL, ?)`,
      ).run(rubric.purpose, rubric.prompt, rubric.weights, Date.now(), rubric.notes);
    }
  }

  // ─── Runs ────────────────────────────────────────────────────────────────────

  insertRun(row: ApmeRunRow): void {
    if (!this.db) return;
    const costKnown = row.costKnown === true || (row.costUsd != null && row.costUsd > 0);
    this.db.prepare(
      `INSERT INTO runs
        (id, session_id, agent_type, model_id, provider, project_name, project_path, task_prompt,
         started_at, ended_at, input_tokens, output_tokens, cost_usd, cost_known, exit_code,
         git_before, git_after, hw_profile)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      row.sessionId,
      row.agentType,
      row.modelId ?? null,
      row.provider ?? null,
      row.projectName ?? null,
      row.projectPath ?? null,
      row.taskPrompt ?? null,
      row.startedAt,
      row.endedAt ?? null,
      row.inputTokens ?? null,
      row.outputTokens ?? null,
      row.costUsd ?? null,
      costKnown ? 1 : 0,
      row.exitCode ?? null,
      row.gitBefore ?? null,
      row.gitAfter ?? null,
      row.hwProfile ?? null,
    );
  }

  updateRun(id: string, patch: Partial<ApmeRunRow>): void {
    if (!this.db) return;
    const fields: string[] = [];
    const values: unknown[] = [];
    const map: Record<string, string> = {
      modelId: 'model_id',
      provider: 'provider',
      projectName: 'project_name',
      projectPath: 'project_path',
      taskPrompt: 'task_prompt',
      endedAt: 'ended_at',
      inputTokens: 'input_tokens',
      outputTokens: 'output_tokens',
      costUsd: 'cost_usd',
      costKnown: 'cost_known',
      exitCode: 'exit_code',
      gitBefore: 'git_before',
      gitAfter: 'git_after',
      parentRunId: 'parent_run_id',
      hwProfile: 'hw_profile',
      taskSignals: 'task_signals',
      taskCategory: 'task_category',
      taskCategorySource: 'task_category_source',
      outcome: 'outcome',
      outcomeConfidence: 'outcome_confidence',
      efficiencyJson: 'efficiency_json',
      compositeScore: 'composite_score',
    };
    for (const [k, v] of Object.entries(patch)) {
      const col = map[k];
      if (!col || v === undefined) continue;
      fields.push(`${col} = ?`);
      values.push(k === 'costKnown' ? (v ? 1 : 0) : v);
    }
    if (patch.costUsd != null && patch.costUsd > 0 && patch.costKnown === undefined) {
      fields.push('cost_known = ?'); values.push(1);
    }
    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE runs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  /** Delete a run and all its related data (steps, turns, evals, artifacts, vibe). */
  deleteRun(id: string): void {
    if (!this.db) return;
    // CASCADE should handle children, but be explicit for safety.
    this.db.prepare('DELETE FROM steps WHERE run_id = ?').run(id);
    this.db.prepare('DELETE FROM turns WHERE run_id = ?').run(id);
    this.db.prepare('DELETE FROM evals WHERE run_id = ?').run(id);
    this.db.prepare('DELETE FROM artifacts WHERE run_id = ?').run(id);
    this.db.prepare('DELETE FROM vibe_feedback WHERE run_id = ?').run(id);
    this.db.prepare('DELETE FROM runs WHERE id = ?').run(id);
  }

  getRun(id: string): ApmeRunRow | null {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToRun(row) : null;
  }

  listRuns(opts: { limit?: number; agentType?: string; modelId?: string } = {}): ApmeRunRow[] {
    if (!this.db) return [];
    const wh: string[] = [];
    const args: unknown[] = [];
    if (opts.agentType) { wh.push('agent_type = ?'); args.push(opts.agentType); }
    if (opts.modelId) { wh.push('model_id = ?'); args.push(opts.modelId); }
    const where = wh.length ? `WHERE ${wh.join(' AND ')}` : '';
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const rows = this.db.prepare(
      `SELECT * FROM runs ${where} ORDER BY started_at DESC LIMIT ${limit}`,
    ).all(...args) as Record<string, unknown>[];
    return rows.map(rowToRun);
  }

  // ─── Turns ──────────────────────────────────────────────────────────────────

  insertTurn(turn: { id: string; runId: string; taskId?: string | null; turnIndex: number; prompt?: string; startedAt: number; gitBefore?: string }): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO turns (id, run_id, task_id, turn_index, prompt, started_at, git_before) VALUES (?,?,?,?,?,?,?)`,
    ).run(turn.id, turn.runId, turn.taskId ?? null, turn.turnIndex, turn.prompt ?? null, turn.startedAt, turn.gitBefore ?? null);
  }

  updateTurn(id: string, fields: Record<string, unknown>): void {
    if (!this.db) return;
    const map: Record<string, string> = {
      endedAt: 'ended_at', toolCalls: 'tool_calls', filesModified: 'files_modified',
      filesCreated: 'files_created', gitAfter: 'git_after', taskCategory: 'task_category',
      outcome: 'outcome', compositeScore: 'composite_score', efficiencyJson: 'efficiency_json',
      prompt: 'prompt', response: 'response', taskId: 'task_id',
      endSource: 'end_source',
      modelId: 'model_id', provider: 'provider',
    };
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = map[k]; if (!col || v === undefined) continue;
      sets.push(`${col} = ?`); vals.push(v);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE turns SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /** The newest closed turn of any run that `sessionId` ever owned, provided
   *  it closed at or after `endedSinceMs`. The collector's fallback for a
   *  reply that arrives after the run's in-memory edges are gone. */
  latestClosedTurnIdForSession(sessionId: string, endedSinceMs: number): string | null {
    if (!this.db) return null;
    const row = this.db.prepare(
      `SELECT t.id AS id FROM turns t JOIN runs r ON r.id = t.run_id
       WHERE r.session_id = ? AND t.ended_at IS NOT NULL AND t.ended_at >= ?
       ORDER BY t.ended_at DESC LIMIT 1`,
    ).get(sessionId, endedSinceMs) as { id: string } | undefined;
    return row?.id ?? null;
  }

  getTurn(id: string): Record<string, unknown> | null {
    if (!this.db) return null;
    return (this.db.prepare('SELECT * FROM turns WHERE id = ?').get(id) as Record<string, unknown>) ?? null;
  }

  listTurns(runId: string): Array<Record<string, unknown>> {
    if (!this.db) return [];
    return this.db.prepare('SELECT * FROM turns WHERE run_id = ? ORDER BY turn_index ASC').all(runId) as Array<Record<string, unknown>>;
  }

  /** Stop-hook delivery rate, per agent, over turns STARTED since `sinceMs`.
   *
   *  The window keys on `started_at` rather than `ended_at` so a turn that is
   *  still open counts in the same denominator as its siblings — an open turn
   *  is a Stop that has not arrived (yet), and dropping it from the sample
   *  would hide exactly the failure being measured.
   *
   *  `preInstrument` is rows written before the `end_source` column existed;
   *  they are reported separately instead of being folded into any bucket,
   *  because their closing signal is genuinely unknown (see the migration).
   *
   *  `interrupted`, `aborted` and `superseded` are their own columns rather
   *  than part of any loss bucket: each is a turn for which Claude Code owes no
   *  Stop at all, so counting them as dropped hooks would report the user's own
   *  ESC key, their exhausted usage window, and an artifact of counting turns
   *  per prompt as infrastructure loss. `stopDeliveryLoss` in
   *  `@agentdeck/shared` owns which buckets the ratio may read.
   */
  stopDelivery(opts: { sinceMs: number; agentType?: string } = { sinceMs: 0 }): ApmeStopDeliveryRow[] {
    if (!this.db) return [];
    const params: unknown[] = [opts.sinceMs];
    let where = 't.started_at >= ?';
    if (opts.agentType) { where += ' AND r.agent_type = ?'; params.push(opts.agentType); }
    const rows = this.db.prepare(
      `SELECT r.agent_type AS agentType,
              COUNT(*) AS total,
              SUM(t.end_source = 'stop') AS stop,
              SUM(t.end_source = 'synthetic_stop') AS syntheticStop,
              SUM(t.end_source = 'next_prompt') AS nextPrompt,
              SUM(t.end_source = 'interrupted') AS interrupted,
              SUM(t.end_source = 'aborted') AS aborted,
              SUM(t.end_source = 'superseded') AS superseded,
              SUM(t.end_source IN ('session_end','clear')) AS sessionEnd,
              SUM(t.end_source = 'run_close') AS runClose,
              SUM(t.ended_at IS NULL) AS open,
              SUM(t.ended_at IS NOT NULL AND t.end_source IS NULL) AS preInstrument
         FROM turns t JOIN runs r ON r.id = t.run_id
        WHERE ${where}
        GROUP BY r.agent_type
        ORDER BY r.agent_type`,
    ).all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      agentType: String(r.agentType ?? 'unknown'),
      total: Number(r.total ?? 0),
      stop: Number(r.stop ?? 0),
      syntheticStop: Number(r.syntheticStop ?? 0),
      nextPrompt: Number(r.nextPrompt ?? 0),
      interrupted: Number(r.interrupted ?? 0),
      aborted: Number(r.aborted ?? 0),
      superseded: Number(r.superseded ?? 0),
      sessionEnd: Number(r.sessionEnd ?? 0),
      runClose: Number(r.runClose ?? 0),
      open: Number(r.open ?? 0),
      preInstrument: Number(r.preInstrument ?? 0),
    }));
  }

  // ─── Tasks ──────────────────────────────────────────────────────────────────

  insertTask(row: ApmeTaskRow): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO tasks (id, run_id, task_index, boundary_signal, started_at, first_turn_index)
       VALUES (?,?,?,?,?,?)`,
    ).run(
      row.id, row.runId, row.taskIndex, row.boundarySignal, row.startedAt,
      row.firstTurnIndex ?? null,
    );
  }

  updateTask(id: string, patch: Partial<ApmeTaskRow>): void {
    if (!this.db) return;
    const map: Record<string, string> = {
      endedAt: 'ended_at',
      firstTurnIndex: 'first_turn_index',
      lastTurnIndex: 'last_turn_index',
      summary: 'summary',
      outcome: 'outcome',
      compositeScore: 'composite_score',
      taskCategory: 'task_category',
      notesJson: 'notes_json',
      boundarySignal: 'boundary_signal',
      modelId: 'model_id',
      provider: 'provider',
      modelConfig: 'model_config',
      inputTokens: 'input_tokens',
      outputTokens: 'output_tokens',
      costUsd: 'cost_usd',
      costKnown: 'cost_known',
      latencyMs: 'latency_ms',
    };
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = map[k];
      if (!col || v === undefined) continue;
      sets.push(`${col} = ?`);
      vals.push(k === 'costKnown' ? (v ? 1 : 0) : v);
    }
    if (patch.costUsd != null && patch.costUsd > 0 && patch.costKnown === undefined) {
      sets.push('cost_known = ?'); vals.push(1);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  getTask(id: string): ApmeTaskRow | null {
    if (!this.db) return null;
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? rowToTask(row) : null;
  }

  listTasksForRun(runId: string): ApmeTaskRow[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT * FROM tasks WHERE run_id = ? ORDER BY task_index ASC',
    ).all(runId) as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  }

  /** All tasks across runs, newest first. Used by `agentdeck apme export --by task`
   *  to dump a flat dataset of meaningful task units (one row per closed task). */
  listAllTasks(opts: { limit?: number; closedOnly?: boolean } = {}): ApmeTaskRow[] {
    if (!this.db) return [];
    const limit = opts.limit ?? 100;
    const sql = opts.closedOnly
      ? `SELECT * FROM tasks WHERE ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ?`
      : `SELECT * FROM tasks ORDER BY started_at DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(limit) as Array<Record<string, unknown>>;
    return rows.map(rowToTask);
  }

  /** One page of task units with the run context needed to read them without a
   *  second query — the browse surface for "every work unit we have processed".
   *
   *  `listAllTasks` returns bare task rows, which is why the dashboard could
   *  only reach a task by drilling into its run: the row alone carries no agent,
   *  model, project or prompt. Tasks are the canonical evaluation unit, so they
   *  need a first-class list of their own.
   *
   *  `total` is the unpaged count for the same filters, so a caller can page
   *  without guessing when it has reached the end. */
  listTaskPage(opts: {
    limit?: number;
    offset?: number;
    agentType?: string;
    sessionId?: string;
    projectName?: string;
    category?: string;
    outcome?: string;
    /** 'closed' — boundary hit; 'open' — still accumulating; default both. */
    state?: 'closed' | 'open';
    /** Work-board lifecycle bucket — see `TASK_VIEW_SQL` for the one
     *  definition each bucket has. */
    view?: ApmeTaskView;
    /** Row ordering. Default is pure recency — the pre-existing contract that
     *  buildApmeGraph ("most recent task units"), the activity snapshot and
     *  the Tasks tab all assume. `'attention'` (Work board only) floats the
     *  attention bucket first, then recency. */
    order?: 'recency' | 'attention';
    /** Substring match over the task summary and its run's first prompt. */
    q?: string;
  } = {}): { total: number; tasks: ApmeTaskListRow[] } {
    if (!this.db) return { total: 0, tasks: [] };
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
    const offset = Math.max(opts.offset ?? 0, 0);
    const { where, args } = buildTaskFilterWhere(opts);
    const attentionSql = taskAttentionSql(Date.now() - TASK_ATTENTION_WINDOW_MS);
    if (opts.view) where.push(opts.view === 'attention' ? attentionSql : TASK_VIEW_SQL[opts.view]);
    if (opts.state === 'closed') where.push('t.ended_at IS NOT NULL');
    if (opts.state === 'open') where.push('t.ended_at IS NULL');
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const orderSql = opts.order === 'attention'
      ? 'ORDER BY attention DESC, t.started_at DESC'
      : 'ORDER BY t.started_at DESC';
    const total = (this.db.prepare(
      `SELECT COUNT(*) AS n FROM tasks t JOIN runs r ON r.id = t.run_id ${whereSql}`,
    ).get(...args) as { n: number }).n;
    const rows = this.db.prepare(
      `SELECT t.*,
              r.session_id, r.agent_type, r.model_id AS run_model_id, r.project_name,
              r.project_path, r.task_prompt AS run_prompt, r.parent_run_id,
              (SELECT COUNT(*) FROM turns tu WHERE tu.task_id = t.id) AS turn_count,
              (SELECT COUNT(*) FROM turns tu WHERE tu.task_id = t.id AND tu.response IS NOT NULL) AS answered_turns,
              (SELECT COUNT(*) FROM sample_events se WHERE se.task_id = t.id) AS event_count,
              (SELECT COUNT(*) FROM sample_events se WHERE se.task_id = t.id AND se.kind = 'tool') AS tool_count,
              (SELECT COALESCE(SUM(COALESCE(tu.files_modified, 0) + COALESCE(tu.files_created, 0)), 0)
                 FROM turns tu WHERE tu.task_id = t.id) AS files_touched,
              (SELECT tu.prompt FROM turns tu WHERE tu.task_id = t.id ORDER BY tu.turn_index ASC LIMIT 1) AS first_prompt,
              (SELECT e.score FROM evals e WHERE e.task_id = t.id AND e.metric = 'overall' ORDER BY e.created_at DESC LIMIT 1) AS overall_score,
              (SELECT COUNT(*) FROM evals e WHERE e.task_id = t.id) AS eval_count,
              (${attentionSql}) AS attention
       FROM tasks t JOIN runs r ON r.id = t.run_id
       ${whereSql}
       ${orderSql}
       LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset) as Array<Record<string, unknown>>;
    return { total, tasks: rows.map(rowToTaskListRow) };
  }

  /** 10 s TTL cache for `taskViewCounts`, keyed by the filter tuple. The Work
   *  board polls every 15 s and refetches on every interaction; the badges
   *  are a full-table aggregate with correlated eval subqueries, so paying it
   *  at most once per TTL bounds the cost of leaving the dashboard open. */
  private viewCountsCache = new Map<string, { at: number; value: Record<'all' | ApmeTaskView, number> }>();

  /** Per-lifecycle-bucket totals for the Work board's tab badges. Takes the
   *  same NARROWING filters as `listTaskPage` (agent/project/category/
   *  outcome/q) so a filtered board's badges count what its tabs would list.
   *  Buckets and filters read the same SQL definitions; the TTL means a badge
   *  may lag its rows by up to 10 s after a task moves buckets — a bounded
   *  staleness, not a different definition. */
  taskViewCounts(filters: {
    agentType?: string; sessionId?: string; projectName?: string; category?: string; outcome?: string; q?: string;
  } = {}): Record<'all' | ApmeTaskView, number> {
    const empty = { all: 0, attention: 0, inprogress: 0, judged: 0, reported: 0, orphaned: 0 } as const;
    if (!this.db) return { ...empty };
    const key = JSON.stringify([filters.agentType, filters.sessionId, filters.projectName, filters.category, filters.outcome, filters.q]);
    const cached = this.viewCountsCache.get(key);
    if (cached && Date.now() - cached.at < 10_000) return cached.value;
    const attentionSql = taskAttentionSql(Date.now() - TASK_ATTENTION_WINDOW_MS);
    const { where, args } = buildTaskFilterWhere(filters);
    const row = this.db.prepare(
      `SELECT COUNT(*) AS all_n,
              SUM(CASE WHEN ${attentionSql} THEN 1 ELSE 0 END) AS attention_n,
              SUM(CASE WHEN ${TASK_VIEW_SQL.inprogress} THEN 1 ELSE 0 END) AS inprogress_n,
              SUM(CASE WHEN ${TASK_VIEW_SQL.judged} THEN 1 ELSE 0 END) AS judged_n,
              SUM(CASE WHEN ${TASK_VIEW_SQL.reported} THEN 1 ELSE 0 END) AS reported_n,
              SUM(CASE WHEN ${TASK_VIEW_SQL.orphaned} THEN 1 ELSE 0 END) AS orphaned_n
       FROM tasks t JOIN runs r ON r.id = t.run_id
       WHERE ${where.join(' AND ')}`,
    ).get(...args) as Record<string, number | null>;
    const value = {
      all: row.all_n ?? 0,
      attention: row.attention_n ?? 0,
      inprogress: row.inprogress_n ?? 0,
      judged: row.judged_n ?? 0,
      reported: row.reported_n ?? 0,
      orphaned: row.orphaned_n ?? 0,
    };
    if (this.viewCountsCache.size > 20) this.viewCountsCache.clear();
    this.viewCountsCache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Per-tool call counts for a page of tasks, in one grouped query. Feeds the
   *  shared `foldActionCounts` projection — the store returns raw counts, the
   *  HTTP layer folds. */
  toolCountsForTasks(taskIds: readonly string[]): Map<string, Array<{ name: string; count: number }>> {
    const out = new Map<string, Array<{ name: string; count: number }>>();
    if (!this.db || taskIds.length === 0) return out;
    const placeholders = taskIds.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT task_id, tool_name, COUNT(*) AS n FROM sample_events
       WHERE kind = 'tool' AND tool_name IS NOT NULL AND task_id IN (${placeholders})
       GROUP BY task_id, tool_name`,
    ).all(...taskIds) as Array<{ task_id: string; tool_name: string; n: number }>;
    for (const r of rows) {
      const list = out.get(r.task_id) ?? [];
      list.push({ name: r.tool_name, count: r.n });
      out.set(r.task_id, list);
    }
    return out;
  }

  /** Distinct values behind the task list's filters, so the UI offers what the
   *  data actually contains rather than a hardcoded menu. */
  taskFacets(): { agents: string[]; projects: string[]; categories: string[]; outcomes: string[] } {
    if (!this.db) return { agents: [], projects: [], categories: [], outcomes: [] };
    const col = (sql: string): string[] =>
      (this.db!.prepare(sql).all() as Array<{ v: string | null }>)
        .map((r) => r.v).filter((v): v is string => typeof v === 'string' && v.length > 0);
    return {
      agents: col('SELECT DISTINCT agent_type AS v FROM runs ORDER BY v'),
      projects: col('SELECT DISTINCT project_name AS v FROM runs ORDER BY v'),
      categories: col("SELECT DISTINCT COALESCE(task_category,'') AS v FROM tasks WHERE v != '' ORDER BY v"),
      outcomes: col("SELECT DISTINCT COALESCE(outcome,'') AS v FROM tasks WHERE v != '' ORDER BY v"),
    };
  }

  listTurnsForTask(taskId: string): Array<Record<string, unknown>> {
    if (!this.db) return [];
    return this.db.prepare(
      'SELECT * FROM turns WHERE task_id = ? ORDER BY turn_index ASC',
    ).all(taskId) as Array<Record<string, unknown>>;
  }

  /** Ended tasks (boundary hit) that haven't been judged yet — the judge
   *  backlog. The daemon's eval tick drains this a few per sweep; before it
   *  did (2026-09-03) nothing called it, so a task whose one judge call was
   *  lost — daemon restarted mid-eval, judge offline, backend probe not yet
   *  ready — stayed unjudged for good: 1,060 closed tasks sat in `reported`.
   *  `sinceMs` bounds how far back the drain reaches. */
  listTasksNeedingSummary(limit: number = 20, sinceMs: number = 0): Array<{ id: string; runId: string; taskCategory: string | null }> {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT t.id, t.run_id, t.task_category FROM tasks t
       WHERE t.ended_at IS NOT NULL
         AND t.ended_at >= ?
         AND t.summary IS NULL
         -- A task the judge already declined (task-gradeability.ts) is not a
         -- backlog; re-offering it every sweep re-declines it forever.
         AND (t.notes_json IS NULL OR t.notes_json NOT LIKE '%"notGradeable"%')
       ORDER BY t.ended_at DESC
       LIMIT ?`,
    ).all(sinceMs, limit) as Array<{ id: string; run_id: string; task_category: string | null }>;
    return rows.map((r) => ({ id: r.id, runId: r.run_id, taskCategory: r.task_category }));
  }

  insertEvalForTask(row: ApmeEvalRowDb & { taskId: string }): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO evals (run_id, task_id, layer, metric, score, raw, rubric_ver, judge_model, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(row.runId, row.taskId, row.layer, row.metric, row.score,
      row.raw ?? null, row.rubricVer ?? null, row.judgeModel ?? null, row.createdAt);
  }

  listEvalsForTask(taskId: string): ApmeEvalRowDb[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT * FROM evals WHERE task_id = ? ORDER BY created_at ASC',
    ).all(taskId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      layer: r.layer as ApmeEvalRowDb['layer'],
      metric: r.metric as string,
      score: r.score as number,
      raw: (r.raw as string | null) ?? null,
      rubricVer: (r.rubric_ver as number | null) ?? null,
      judgeModel: (r.judge_model as string | null) ?? null,
      createdAt: r.created_at as number,
    }));
  }

  listEvalsForTurn(turnId: string): ApmeEvalRowDb[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT * FROM evals WHERE turn_id = ? ORDER BY created_at ASC',
    ).all(turnId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      layer: r.layer as ApmeEvalRowDb['layer'],
      metric: r.metric as string,
      score: r.score as number,
      raw: (r.raw as string | null) ?? null,
      rubricVer: (r.rubric_ver as number | null) ?? null,
      judgeModel: (r.judge_model as string | null) ?? null,
      createdAt: r.created_at as number,
    }));
  }

  insertEvalForTurn(row: ApmeEvalRowDb & { turnId: string }): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO evals (run_id, turn_id, layer, metric, score, raw, rubric_ver, judge_model, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(row.runId, row.turnId, row.layer, row.metric, row.score,
      row.raw ?? null, row.rubricVer ?? null, row.judgeModel ?? null, row.createdAt);
  }

  // ─── Steps / Artifacts ───────────────────────────────────────────────────────

  insertStep(row: ApmeStepRow): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO steps (run_id, ts, kind, tool_name, payload) VALUES (?, ?, ?, ?, ?)`,
    ).run(row.runId, row.ts, row.kind, row.toolName ?? null, row.payload);
  }

  listSteps(runId: string): ApmeStepRow[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT * FROM steps WHERE run_id = ? ORDER BY ts ASC',
    ).all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      ts: r.ts as number,
      kind: r.kind as string,
      toolName: (r.tool_name as string | null) ?? null,
      payload: (r.payload as string | null) ?? '{}',
    }));
  }

  insertArtifact(row: ApmeArtifactRow): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO artifacts (run_id, kind, path, sha256, bytes) VALUES (?, ?, ?, ?, ?)`,
    ).run(row.runId, row.kind, row.path, row.sha256 ?? null, row.bytes ?? null);
  }

  // ─── Evals ───────────────────────────────────────────────────────────────────

  insertEval(row: ApmeEvalRowDb): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO evals
        (run_id, layer, metric, score, raw, rubric_ver, judge_model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.runId, row.layer, row.metric, row.score,
      row.raw ?? null, row.rubricVer ?? null, row.judgeModel ?? null, row.createdAt,
    );
  }

  listEvalsForRun(runId: string): ApmeEvalRowDb[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT * FROM evals WHERE run_id = ? ORDER BY created_at ASC',
    ).all(runId) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as number,
      runId: r.run_id as string,
      layer: r.layer as ApmeEvalRowDb['layer'],
      metric: r.metric as string,
      score: r.score as number,
      raw: (r.raw as string | null) ?? null,
      rubricVer: (r.rubric_ver as number | null) ?? null,
      judgeModel: (r.judge_model as string | null) ?? null,
      createdAt: r.created_at as number,
    }));
  }

  // ─── Rubrics ─────────────────────────────────────────────────────────────────

  getCurrentRubric(purpose: string = 'general'): ApmeRubricRow | null {
    if (!this.db) return null;
    const row = this.db.prepare(
      `SELECT * FROM rubrics WHERE purpose = ? ORDER BY version DESC LIMIT 1`,
    ).get(purpose) as Record<string, unknown> | undefined;
    return row ? rowToRubric(row) : null;
  }

  appendRubric(row: Omit<ApmeRubricRow, 'version'>): number {
    if (!this.db) return 0;
    const next = (this.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS v FROM rubrics').get() as { v: number }).v;
    this.db.prepare(
      `INSERT INTO rubrics (version, purpose, prompt, weights, created_at, parent_ver, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(next, row.purpose, row.prompt, row.weights, row.createdAt, row.parentVer ?? null, row.notes ?? null);
    return next;
  }

  // ─── Vibe ────────────────────────────────────────────────────────────────────

  insertVibe(row: ApmeVibeRow): void {
    if (!this.db) return;
    this.db.prepare(
      `INSERT INTO vibe_feedback (run_id, verdict, note, ts) VALUES (?, ?, ?, ?)`,
    ).run(row.runId, row.verdict, row.note ?? null, row.ts);
  }

  /** Return the most recent vibe verdict for a run, or null if none. */
  latestVibeForRun(runId: string): ApmeVibeRow | null {
    if (!this.db) return null;
    const row = this.db.prepare(
      `SELECT * FROM vibe_feedback WHERE run_id = ? ORDER BY ts DESC LIMIT 1`,
    ).get(runId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: row.id as number,
      runId: row.run_id as string,
      verdict: row.verdict as ApmeVibeRow['verdict'],
      note: (row.note as string | null) ?? null,
      ts: row.ts as number,
    };
  }

  /** Runs that have ended but have zero eval rows — candidates for the daemon eval queue. */
  listUnevaluatedRuns(limit: number = 20): { id: string; projectPath: string | null }[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT r.id, r.project_path FROM runs r
       WHERE r.ended_at IS NOT NULL
         AND (r.task_category IS NULL OR r.task_category != '_empty')
         AND NOT EXISTS (SELECT 1 FROM evals e WHERE e.run_id = r.id)
       ORDER BY r.ended_at DESC
       LIMIT ?`,
    ).all(limit) as Array<{ id: string; project_path: string | null }>;
    return rows.map((r) => ({ id: r.id, projectPath: r.project_path }));
  }

  /** Runs that have ended but have no category — candidates for daemon re-classification. */
  listUnclassifiedRuns(limit: number = 5): { id: string; projectPath: string | null }[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT r.id, r.project_path FROM runs r
       WHERE r.ended_at IS NOT NULL
         AND r.task_category IS NULL
       ORDER BY r.ended_at DESC
       LIMIT ?`,
    ).all(limit) as Array<{ id: string; project_path: string | null }>;
    return rows.map((r) => ({ id: r.id, projectPath: r.project_path }));
  }

  /** Turns with response captured but no outcome yet — backfill candidates. */
  listTurnsNeedingOutcome(limit: number = 20): Array<{ id: string; runId: string }> {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT id, run_id FROM turns
       WHERE response IS NOT NULL AND response != ''
         AND outcome IS NULL
       ORDER BY started_at DESC
       LIMIT ?`,
    ).all(limit) as Array<{ id: string; run_id: string }>;
    return rows.map((r) => ({ id: r.id, runId: r.run_id }));
  }

  /** Abandoned runs: real work that was never closed. The daemon restarted (or
   *  crashed) mid-session, so the in-memory session→run map `closeRun` depends
   *  on is gone and nothing will ever finalize these rows.
   *
   *  Distinct from `listOrphanedRuns`, which by design only matches empty
   *  shells (`task_prompt IS NULL` + no turns) and so steps right over the case
   *  that actually costs data: a run carrying prompts, turns and a whole tool
   *  trajectory stays open forever, its task never closes, and a task that
   *  never closes is never evaluated.
   *
   *  Staleness is measured from the LAST recorded activity, never
   *  `started_at` — a live multi-hour session must not be reaped out from
   *  under the process that owns it (session bridges share this sqlite file
   *  and the daemon cannot see their in-memory state). Callers additionally
   *  skip runs their own collector still holds open.
   *  `lastActivity` is returned so the caller can close the rows AT the last
   *  activity instead of `now`, keeping durations honest. */
  listAbandonedRuns(staleSec: number = 7200, limit: number = 20): Array<{ id: string; projectPath: string | null; lastActivity: number }> {
    if (!this.db) return [];
    const cutoff = Date.now() - staleSec * 1000;
    const rows = this.db.prepare(
      `SELECT id, project_path, last_activity FROM (
         SELECT r.id AS id, r.project_path AS project_path,
           MAX(
             r.started_at,
             COALESCE((SELECT MAX(MAX(t.started_at, COALESCE(t.ended_at, 0))) FROM turns t WHERE t.run_id = r.id), 0),
             COALESCE((SELECT MAX(s.ts) FROM steps s WHERE s.run_id = r.id), 0),
             COALESCE((SELECT MAX(se.ts) FROM sample_events se WHERE se.run_id = r.id), 0)
           ) AS last_activity
         FROM runs r
         WHERE r.ended_at IS NULL
           -- Sound pre-filter, not an approximation: last_activity is a MAX that
           -- includes started_at, so last_activity < cutoff implies
           -- started_at < cutoff. Checking it first lets idx_runs_started skip
           -- every recent run before the correlated MAXes are evaluated.
           AND r.started_at < ?
           AND EXISTS (SELECT 1 FROM turns t WHERE t.run_id = r.id)
       )
       WHERE last_activity < ?
       ORDER BY last_activity ASC
       LIMIT ?`,
    ).all(cutoff, cutoff, limit) as Array<{ id: string; project_path: string | null; last_activity: number }>;
    return rows.map((r) => ({ id: r.id, projectPath: r.project_path, lastActivity: r.last_activity }));
  }

  /** Finalize an abandoned run: close its dangling turns, close its open
   *  tasks, then close the run itself — all stamped at `endedAt` (the run's
   *  last activity), not `now`, so a run abandoned last night doesn't report a
   *  12-hour turn.
   *
   *  The task's boundary says what the reaper actually found, not merely that
   *  it was the reaper who found it. A task whose every turn had closed is a
   *  task that went quiet after a clean finish — the definition of the
   *  `idle_gap` boundary (`AGENT_IDLE_GAP_MS`), reached late because the
   *  in-memory timer that would have fired did not survive the process. Only a
   *  task still holding an OPEN turn is `orphaned`: the work was cut off
   *  mid-turn with nothing left to tell how it ended. Stamping both
   *  `orphaned` put 79% of a week's tasks in the "reaper" chip and hid that
   *  the segmentation itself had been right. Tasks are classified BEFORE the
   *  dangling turns are closed, since closing them is what would erase the
   *  distinction.
   *
   *  Tasks are backfilled with their real first/last turn index when the
   *  in-memory close never ran, since the task rollup reads those columns.
   *  Returns the closed tasks — with the boundary each was given — so the
   *  caller can enqueue task-level evals, the whole point of closing them. */
  reapAbandonedRun(runId: string, endedAt: number): Array<{ id: string; category: string | null; boundarySignal: 'idle_gap' | 'orphaned' }> {
    if (!this.db) return [];
    const bounds = this.db.prepare(
      'SELECT MIN(turn_index) AS lo, MAX(turn_index) AS hi FROM turns WHERE run_id = ?',
    ).get(runId) as { lo: number | null; hi: number | null } | undefined;
    const tasks = this.db.prepare(
      `SELECT k.id, k.task_category,
              EXISTS (SELECT 1 FROM turns t WHERE t.task_id = k.id AND t.ended_at IS NULL) AS has_open_turn
         FROM tasks k WHERE k.run_id = ? AND k.ended_at IS NULL`,
    ).all(runId) as Array<{ id: string; task_category: string | null; has_open_turn: number }>;
    const tx = this.db.transaction(() => {
      // Tasks first: the open-turn test below is destroyed by the turn UPDATE.
      this.db!.prepare(
        `UPDATE tasks SET ended_at = ?,
           boundary_signal = CASE
             WHEN EXISTS (SELECT 1 FROM turns t WHERE t.task_id = tasks.id AND t.ended_at IS NULL)
               THEN 'orphaned' ELSE 'idle_gap' END,
           first_turn_index = COALESCE(first_turn_index, ?),
           last_turn_index  = COALESCE(last_turn_index, ?),
           -- The in-memory close resolves a category at close time; a reaped
           -- task never had one, and the judge then fell back to the generic
           -- rubric (66 of 135 uncategorised tasks in a week sat on runs
           -- already classified 'ops'). Inherit the run's.
           task_category = COALESCE(task_category,
             (SELECT r.task_category FROM runs r WHERE r.id = tasks.run_id AND r.task_category <> 'unknown'))
         WHERE run_id = ? AND ended_at IS NULL`,
      ).run(endedAt, bounds?.lo ?? null, bounds?.hi ?? null, runId);
      this.db!.prepare(
        `UPDATE turns SET ended_at = ?, end_source = 'run_close'
          WHERE run_id = ? AND ended_at IS NULL`,
      ).run(endedAt, runId);
      this.db!.prepare('UPDATE runs SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(endedAt, runId);
    });
    try { tx(); } catch (err) {
      debug('APME', `reapAbandonedRun ${runId.slice(0, 8)} failed: ${String(err)}`);
      return [];
    }
    return tasks.map((t) => ({
      id: t.id,
      category: t.task_category ?? this.getTask(t.id)?.taskCategory ?? null,
      boundarySignal: t.has_open_turn ? 'orphaned' : 'idle_gap',
    }));
  }

  /** Closed tasks that carry a verdict, newest first — the candidates for
   *  `retractTaskVerdict` when what they were scored on turns out not to
   *  have been the agent's work. `sinceMs` bounds the sweep. */
  listJudgedTasks(sinceMs: number, limit: number = 2000): Array<{ id: string }> {
    if (!this.db) return [];
    return this.db.prepare(
      `SELECT id FROM tasks
        WHERE ended_at IS NOT NULL AND ended_at >= ?
          AND (composite_score IS NOT NULL OR summary IS NOT NULL)
          AND (notes_json IS NULL OR notes_json NOT LIKE '%"notGradeable"%')
        ORDER BY ended_at DESC LIMIT ?`,
    ).all(sinceMs, limit) as Array<{ id: string }>;
  }

  /** Closed tasks the judge declined (`notGradeable` stamped), newest first. */
  listDeclinedTasks(sinceMs: number, limit: number = 2000): Array<{ id: string }> {
    if (!this.db) return [];
    return this.db.prepare(
      `SELECT id FROM tasks
        WHERE ended_at IS NOT NULL AND ended_at >= ?
          AND notes_json LIKE '%"notGradeable"%'
        ORDER BY ended_at DESC LIMIT ?`,
    ).all(sinceMs, limit) as Array<{ id: string }>;
  }

  /** Clear a declined task's stamp so the backlog drain offers it again. */
  readmitTask(taskId: string): void {
    if (!this.db) return;
    this.db.prepare(`UPDATE tasks SET notes_json = NULL WHERE id = ? AND notes_json LIKE '%"notGradeable"%'`).run(taskId);
  }

  /** Withdraw a task's verdict: its judge and scorer rows are deleted and the
   *  summary / score / outcome cleared, and the row is stamped with why it
   *  cannot be graded. A verdict reached against silence — or against a
   *  usage-limit notice standing in for the reply — is not a measurement of
   *  the agent, and leaving it in place keeps it ranking real work on the
   *  scorecard and floating to the top of the attention sort. A manually set
   *  outcome (`agentdeck task cancel`) is the user's statement and is kept. */
  retractTaskVerdict(taskId: string, reason: string): void {
    if (!this.db) return;
    const tx = this.db.transaction(() => {
      this.db!.prepare(`DELETE FROM evals WHERE task_id = ? AND layer IN ('task_judge', 'trajectory')`).run(taskId);
      this.db!.prepare(
        `UPDATE tasks SET summary = NULL, composite_score = NULL,
           outcome = CASE WHEN outcome = 'abandoned' THEN outcome ELSE NULL END,
           notes_json = ?
         WHERE id = ?`,
      ).run(JSON.stringify({ notGradeable: reason, retractedAt: Date.now() }), taskId);
    });
    tx();
  }

  /** One-time, idempotent re-stamp of tasks the OLD reaper closed as
   *  `orphaned` although every one of their turns had closed normally —
   *  the `idle_gap` boundary reached late, which is what the reaper now
   *  writes. Only rows with EVIDENCE move: every turn carries a known
   *  `end_source`, none is `run_close` (the old reaper's mark on a turn it
   *  cut open) and none is still open. Rows from before `end_source`
   *  existed are left as they are — their closing signal is unknown, and a
   *  guess would corrupt the chip that exists to show how much to trust the
   *  segmentation. Measured 2026-09-03: 165 of 1,026 orphaned tasks qualify,
   *  861 predate the column. Returns the number of rows changed. */
  reclassifyReapedTasks(): number {
    if (!this.db) return 0;
    try {
      const info = this.db.prepare(
        `UPDATE tasks SET boundary_signal = 'idle_gap'
          WHERE boundary_signal = 'orphaned'
            AND ended_at IS NOT NULL
            AND EXISTS (SELECT 1 FROM turns u WHERE u.task_id = tasks.id)
            AND NOT EXISTS (SELECT 1 FROM turns u WHERE u.task_id = tasks.id
                              AND (u.ended_at IS NULL OR u.end_source IS NULL OR u.end_source = 'run_close'))`,
      ).run();
      return Number(info.changes ?? 0);
    } catch (err) {
      debug('APME', `reclassifyReapedTasks failed: ${String(err)}`);
      return 0;
    }
  }

  /** Runs still open in the store, oldest first — what a freshly started
   *  daemon must re-adopt before it handles a single hook. Only the run's
   *  identity comes from here; the collector reads the turns and tasks back
   *  through the existing per-run helpers. */
  listOpenRuns(limit: number = 500): ApmeRunRow[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT * FROM runs WHERE ended_at IS NULL ORDER BY started_at ASC LIMIT ?',
    ).all(limit) as Array<Record<string, unknown>>;
    return rows.map(rowToRun);
  }

  /** Tool-call counters for one turn, recovered from the trajectory it wrote.
   *  The collector keeps these in memory and flushes them only when the turn
   *  closes, so a turn open across a restart would otherwise close with
   *  `tool_calls = 0` whatever it did — every reaped codex turn in the measured
   *  week read exactly that. `Edit`/`Write` are the two names the live counter
   *  singles out (`filesModified` / `filesCreated`). */
  countToolEventsForTurn(taskId: string, turnIndex: number): { toolCalls: number; filesModified: number; filesCreated: number } {
    if (!this.db) return { toolCalls: 0, filesModified: 0, filesCreated: 0 };
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(tool_name = 'Edit'), 0) AS edits,
              COALESCE(SUM(tool_name = 'Write'), 0) AS writes
         FROM sample_events WHERE task_id = ? AND turn_index = ? AND kind = 'tool'`,
    ).get(taskId, turnIndex) as { n: number; edits: number; writes: number } | undefined;
    return { toolCalls: Number(row?.n ?? 0), filesModified: Number(row?.edits ?? 0), filesCreated: Number(row?.writes ?? 0) };
  }

  /** Orphaned runs: started long ago, never closed, no turns.
   *  Typically from session bridges that crashed without cleanup. */
  listOrphanedRuns(staleSec: number = 1800): string[] {
    if (!this.db) return [];
    const cutoff = Date.now() - staleSec * 1000;
    const rows = this.db.prepare(
      `SELECT r.id FROM runs r
       WHERE r.ended_at IS NULL
         AND r.started_at < ?
         AND r.task_prompt IS NULL
         AND NOT EXISTS (SELECT 1 FROM turns t WHERE t.run_id = r.id)
       LIMIT 20`,
    ).all(cutoff) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  // ─── Sample events (typed trajectory) ────────────────────────────────────────

  /** Append one typed trajectory event. INSERT OR IGNORE on the UNIQUE
   *  (task_id, dedup_key) index makes storage-time dedup atomic — duplicates
   *  never persist. Returns true if a row was actually inserted. */
  insertSampleEvent(row: ApmeSampleEventRow): boolean {
    if (!this.db) return false;
    // A positive monetary amount is self-proving provenance even for legacy
    // callers that predate costKnown. Zero remains ambiguous and must only be
    // marked known by a pricing table / known-local producer.
    const costKnown = row.costKnown === true || (row.costUsd != null && row.costUsd > 0);
    const res = this.db.prepare(
      `INSERT OR IGNORE INTO sample_events
        (task_id, run_id, turn_index, turn_id, seq, ts, kind, model, input_tokens, output_tokens,
         cost_usd, cost_known, latency_ms, tool_name, tool_status, tool_error, payload, dedup_key)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      row.taskId, row.runId, row.turnIndex ?? null, row.turnId ?? null, row.seq, row.ts, row.kind,
      row.model ?? null, row.inputTokens ?? null, row.outputTokens ?? null,
      row.costUsd ?? null, costKnown ? 1 : 0, row.latencyMs ?? null,
      row.toolName ?? null, row.toolStatus ?? null, row.toolError ?? null,
      row.payload ?? null, row.dedupKey ?? null,
    );
    return res.changes > 0;
  }

  /** Update a previously-inserted event (e.g. a tool pending→resolved) by id. */
  updateSampleEvent(id: number, fields: Partial<ApmeSampleEventRow>): void {
    if (!this.db) return;
    const map: Record<string, string> = {
      toolStatus: 'tool_status', toolError: 'tool_error', payload: 'payload',
      costUsd: 'cost_usd', costKnown: 'cost_known', latencyMs: 'latency_ms', model: 'model',
      inputTokens: 'input_tokens', outputTokens: 'output_tokens', ts: 'ts',
    };
    const sets: string[] = []; const vals: unknown[] = [];
    for (const [k, v] of Object.entries(fields)) {
      const col = map[k]; if (!col || v === undefined) continue;
      sets.push(`${col} = ?`); vals.push(k === 'costKnown' ? (v ? 1 : 0) : v);
    }
    if (fields.costUsd != null && fields.costUsd > 0 && fields.costKnown === undefined) {
      sets.push('cost_known = ?'); vals.push(1);
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.prepare(`UPDATE sample_events SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /** Find a tool event still pending for (task, turn, toolName), to resolve it. */
  findPendingToolEvent(taskId: string, turnIndex: number, toolName: string): ApmeSampleEventRow | null {
    if (!this.db) return null;
    const row = this.db.prepare(
      `SELECT * FROM sample_events
       WHERE task_id = ? AND turn_index = ? AND kind = 'tool' AND tool_name = ?
         AND (tool_status IS NULL OR tool_status = 'pending')
       ORDER BY seq DESC LIMIT 1`,
    ).get(taskId, turnIndex, toolName) as Record<string, unknown> | undefined;
    return row ? rowToSampleEvent(row) : null;
  }

  /** One assistant-message slot per turn. Response producers overlap, so text
   *  hashes cannot be the identity: a truncated projection and the full final
   *  are two payload versions of the same logical event. */
  findAssistantMessageEvent(taskId: string, turnId: string): ApmeSampleEventRow | null {
    if (!this.db) return null;
    const row = this.db.prepare(
      `SELECT * FROM sample_events
       WHERE task_id = ? AND turn_id = ? AND kind = 'assistant_message'
       ORDER BY seq ASC LIMIT 1`,
    ).get(taskId, turnId) as Record<string, unknown> | undefined;
    return row ? rowToSampleEvent(row) : null;
  }

  listSampleEventRows(taskId: string): ApmeSampleEventRow[] {
    if (!this.db) return [];
    const rows = this.db.prepare(
      'SELECT * FROM sample_events WHERE task_id = ? ORDER BY seq ASC',
    ).all(taskId) as Record<string, unknown>[];
    return rows.map(rowToSampleEvent);
  }

  listSampleEvents(taskId: string): TrajectoryEvent[] {
    return this.listSampleEventRows(taskId).map(sampleEventRowToTrajectory).filter((e): e is TrajectoryEvent => e !== null);
  }

  /** Next monotonic seq within a task. */
  nextSampleSeq(taskId: string): number {
    if (!this.db) return 0;
    const row = this.db.prepare('SELECT COALESCE(MAX(seq),-1)+1 AS s FROM sample_events WHERE task_id = ?').get(taskId) as { s: number };
    return row.s;
  }

  /** Assemble the full SessionSample (header + cost + typed trajectory). */
  getSample(taskId: string): SessionSample | null {
    if (!this.db) return null;
    const task = this.getTask(taskId);
    if (!task) return null;
    const run = this.getRun(task.runId);
    const events = this.listSampleEvents(taskId);
    let modelConfig: SampleModelConfig | null = null;
    if (task.modelConfig) { try { modelConfig = JSON.parse(task.modelConfig) as SampleModelConfig; } catch { /* ignore */ } }
    const modelId = task.modelId ?? run?.modelId ?? modelConfig?.modelId ?? 'unknown';
    return {
      id: task.id,
      runId: task.runId,
      sessionId: run?.sessionId ?? '',
      agentType: (run?.agentType ?? 'claude-code') as SessionSample['agentType'],
      index: task.taskIndex,
      boundarySignal: task.boundarySignal,
      startedAt: task.startedAt,
      endedAt: task.endedAt ?? null,
      model: modelConfig ?? { modelId },
      projectName: run?.projectName ?? null,
      projectPath: run?.projectPath ?? null,
      events,
      cost: {
        inputTokens: task.inputTokens ?? 0,
        outputTokens: task.outputTokens ?? 0,
        costUsd: task.costUsd ?? 0,
        costKnown: task.costKnown ?? false,
        latencyMs: task.latencyMs ?? 0,
      },
      summary: task.summary ?? null,
      outcome: task.outcome ?? null,
      compositeScore: task.compositeScore ?? null,
      taskCategory: task.taskCategory ?? null,
    };
  }

  /** Recompute the task's cost aggregate by summing its ModelEvents. */
  recomputeSampleCost(taskId: string): void {
    if (!this.db) return;
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(input_tokens),0) AS it, COALESCE(SUM(output_tokens),0) AS ot,
              CASE WHEN COUNT(*) > 0 AND MIN(COALESCE(cost_known,0))=1
                   THEN SUM(cost_usd) ELSE NULL END AS cu,
              CASE WHEN COUNT(*) > 0 AND MIN(COALESCE(cost_known,0))=1
                   THEN 1 ELSE 0 END AS ck,
              COALESCE(SUM(latency_ms),0) AS lm
       FROM sample_events WHERE task_id = ? AND kind = 'model'`,
    ).get(taskId) as { it: number; ot: number; cu: number | null; ck: number; lm: number };
    this.updateTask(taskId, {
      inputTokens: row.it, outputTokens: row.ot, costUsd: row.cu,
      costKnown: row.ck === 1, latencyMs: row.lm,
    });
  }

  sampleScorecard(): ApmeSampleScorecardRow[] {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT * FROM v_sample_scorecard').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      agentType: r.agent_type as string,
      modelId: r.model_id as string,
      provider: (r.provider as string | null) ?? null,
      taskCategory: (r.task_category as string | null) ?? null,
      samples: r.samples as number,
      avgQuality: (r.avg_quality as number | null) ?? null,
      totalCost: (r.total_cost as number | null) ?? null,
      costKnown: r.cost_known === 1,
      avgLatencyMs: (r.avg_latency_ms as number | null) ?? null,
      costPerQuality: (r.cost_per_quality as number | null) ?? null,
    }));
  }

  // ─── Scorecard ───────────────────────────────────────────────────────────────

  scorecard(): ApmeScorecardRow[] {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT * FROM v_model_scorecard').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      agentType: r.agent_type as string,
      modelId: r.model_id as string,
      provider: (r.provider as string | null) ?? null,
      runs: r.runs as number,
      avgOverall: (r.avg_overall as number | null) ?? null,
      avgTestsPass: (r.avg_tests_pass as number | null) ?? null,
      totalCost: (r.total_cost as number | null) ?? null,
      costKnown: r.cost_known === 1,
      costPerQuality: (r.cost_per_quality as number | null) ?? null,
    }));
  }

  categoryScorecard(): Array<{ taskCategory: string; modelId: string; provider: string | null; runs: number; avgOverall: number | null; avgTestsPass: number | null; totalCost: number | null; costKnown: boolean }> {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT * FROM v_category_scorecard').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      taskCategory: r.task_category as string,
      modelId: r.model_id as string,
      provider: (r.provider as string | null) ?? null,
      runs: r.runs as number,
      avgOverall: (r.avg_overall as number | null) ?? null,
      avgTestsPass: (r.avg_tests_pass as number | null) ?? null,
      totalCost: (r.total_cost as number | null) ?? null,
      costKnown: r.cost_known === 1,
    }));
  }
}

// ─── Row mappers ───────────────────────────────────────────────────────────────

function rowToRun(r: Record<string, unknown>): ApmeRunRow {
  return {
    id: r.id as string,
    sessionId: r.session_id as string,
    agentType: r.agent_type as ApmeRunRow['agentType'],
    modelId: (r.model_id as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    projectName: (r.project_name as string | null) ?? null,
    projectPath: (r.project_path as string | null) ?? null,
    taskPrompt: (r.task_prompt as string | null) ?? null,
    startedAt: r.started_at as number,
    endedAt: (r.ended_at as number | null) ?? null,
    inputTokens: (r.input_tokens as number | null) ?? null,
    outputTokens: (r.output_tokens as number | null) ?? null,
    costUsd: (r.cost_usd as number | null) ?? null,
    costKnown: r.cost_known === 1,
    exitCode: (r.exit_code as number | null) ?? null,
    gitBefore: (r.git_before as string | null) ?? null,
    gitAfter: (r.git_after as string | null) ?? null,
    parentRunId: (r.parent_run_id as string | null) ?? null,
    hwProfile: (r.hw_profile as string | null) ?? null,
    taskSignals: (r.task_signals as string | null) ?? null,
    taskCategory: (r.task_category as string | null) ?? null,
    taskCategorySource: (r.task_category_source as string | null) ?? null,
    outcome: (r.outcome as string | null) ?? null,
    outcomeConfidence: (r.outcome_confidence as string | null) ?? null,
    efficiencyJson: (r.efficiency_json as string | null) ?? null,
    compositeScore: (r.composite_score as number | null) ?? null,
  };
}

function rowToTask(r: Record<string, unknown>): ApmeTaskRow {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    taskIndex: r.task_index as number,
    boundarySignal: r.boundary_signal as string,
    startedAt: r.started_at as number,
    endedAt: (r.ended_at as number | null) ?? null,
    firstTurnIndex: (r.first_turn_index as number | null) ?? null,
    lastTurnIndex: (r.last_turn_index as number | null) ?? null,
    summary: (r.summary as string | null) ?? null,
    outcome: (r.outcome as string | null) ?? null,
    compositeScore: (r.composite_score as number | null) ?? null,
    taskCategory: (r.task_category as string | null) ?? null,
    notesJson: (r.notes_json as string | null) ?? null,
    modelId: (r.model_id as string | null) ?? null,
    provider: (r.provider as string | null) ?? null,
    modelConfig: (r.model_config as string | null) ?? null,
    inputTokens: (r.input_tokens as number | null) ?? null,
    outputTokens: (r.output_tokens as number | null) ?? null,
    costUsd: (r.cost_usd as number | null) ?? null,
    costKnown: r.cost_known === 1,
    latencyMs: (r.latency_ms as number | null) ?? null,
  };
}

/** Task row + the run context that makes it readable on its own. `modelId`
 *  prefers the task's own sample header and falls back to the run's, since only
 *  newer tasks carry one. */
function rowToTaskListRow(r: Record<string, unknown>): ApmeTaskListRow {
  return {
    ...rowToTask(r),
    sessionId: r.session_id as string,
    agentType: r.agent_type as ApmeTaskListRow['agentType'],
    modelId: (r.model_id as string | null) ?? (r.run_model_id as string | null) ?? null,
    projectName: (r.project_name as string | null) ?? null,
    projectPath: (r.project_path as string | null) ?? null,
    parentRunId: (r.parent_run_id as string | null) ?? null,
    firstPrompt: (r.first_prompt as string | null) ?? (r.run_prompt as string | null) ?? null,
    // The task's OWN first turn prompt, with NO run-prompt fallback: title
    // derivation must never name task 2+ of a split run after task 0's intent.
    ownFirstPrompt: (r.first_prompt as string | null) ?? null,
    turnCount: (r.turn_count as number | null) ?? 0,
    answeredTurns: (r.answered_turns as number | null) ?? 0,
    eventCount: (r.event_count as number | null) ?? 0,
    toolCount: (r.tool_count as number | null) ?? 0,
    filesTouched: (r.files_touched as number | null) ?? 0,
    evalCount: (r.eval_count as number | null) ?? 0,
    overallScore: (r.overall_score as number | null) ?? (r.composite_score as number | null) ?? null,
    attention: r.attention === 1,
  };
}

function rowToSampleEvent(r: Record<string, unknown>): ApmeSampleEventRow {
  return {
    id: r.id as number,
    taskId: r.task_id as string,
    runId: r.run_id as string,
    turnIndex: (r.turn_index as number | null) ?? null,
    turnId: (r.turn_id as string | null) ?? null,
    seq: r.seq as number,
    ts: r.ts as number,
    kind: r.kind as ApmeSampleEventRow['kind'],
    model: (r.model as string | null) ?? null,
    inputTokens: (r.input_tokens as number | null) ?? null,
    outputTokens: (r.output_tokens as number | null) ?? null,
    costUsd: (r.cost_usd as number | null) ?? null,
    costKnown: r.cost_known === 1,
    latencyMs: (r.latency_ms as number | null) ?? null,
    toolName: (r.tool_name as string | null) ?? null,
    toolStatus: (r.tool_status as string | null) ?? null,
    toolError: (r.tool_error as string | null) ?? null,
    payload: (r.payload as string | null) ?? null,
    dedupKey: (r.dedup_key as string | null) ?? null,
  };
}

/** Decode a stored sample_events row back into a typed TrajectoryEvent. */
function sampleEventRowToTrajectory(r: ApmeSampleEventRow): TrajectoryEvent | null {
  const base = { ts: r.ts, turnIndex: r.turnIndex ?? 0 };
  let p: Record<string, unknown> = {};
  if (r.payload) { try { p = JSON.parse(r.payload) as Record<string, unknown>; } catch { /* ignore */ } }
  switch (r.kind) {
    case 'user_message':
      return { ...base, kind: 'user_message', text: (p.text as string) ?? '' };
    case 'assistant_message':
      return { ...base, kind: 'assistant_message', text: (p.text as string) ?? '', responseKind: ((p.responseKind as string) ?? 'text') as 'text' | 'tool_only' | 'empty' };
    case 'model':
      return { ...base, kind: 'model', model: r.model ?? 'unknown', inputTokens: r.inputTokens ?? 0, outputTokens: r.outputTokens ?? 0, costUsd: r.costUsd ?? 0, latencyMs: r.latencyMs ?? 0 };
    case 'tool':
      return { ...base, kind: 'tool', name: r.toolName ?? 'tool', input: p.input, output: p.output, error: r.toolError ?? null, status: (r.toolStatus as 'pending' | 'success' | 'error' | undefined) ?? undefined };
    case 'subagent':
      return {
        ...base,
        kind: 'subagent',
        id: (p.id as string) ?? 'unknown',
        name: (p.name as string) ?? 'Subagent',
        phase: p.phase === 'completed' ? 'completed' : 'started',
        summary: (p.summary as string | null) ?? null,
        durationMs: typeof p.durationMs === 'number' ? p.durationMs : null,
      };
    case 'state':
      return { ...base, kind: 'state', from: (p.from as string | null) ?? null, to: (p.to as string) ?? 'unknown' };
    case 'info':
      return { ...base, kind: 'info', label: (p.label as string) ?? 'info', detail: (p.detail as string | null) ?? null };
    case 'relation':
      return {
        ...base,
        kind: 'relation',
        relation: p.relation === 'spawned' || p.relation === 'messaged' ? p.relation : 'waiting_on',
        direction: p.direction === 'in' ? 'in' : 'out',
        phase: p.phase === 'closed' ? 'closed' : 'open',
        peerSessionId: (p.peerSessionId as string | null) ?? null,
        peerName: (p.peerName as string | null) ?? null,
        evidence: (p.evidence as string) ?? 'unknown',
        detail: (p.detail as string | null) ?? null,
      };
    default:
      return null;
  }
}

function rowToRubric(r: Record<string, unknown>): ApmeRubricRow {
  return {
    version: r.version as number,
    purpose: r.purpose as string,
    prompt: r.prompt as string,
    weights: r.weights as string,
    createdAt: r.created_at as number,
    parentVer: (r.parent_ver as number | null) ?? null,
    notes: (r.notes as string | null) ?? null,
  };
}
