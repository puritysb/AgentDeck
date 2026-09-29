/**
 * APME task classifier — LLM-assist SSOT.
 *
 * `classify(signals)` (bridge/src/apme/classifier.ts, ApmeClassifier.swift)
 * is a pure rule table and needs no sharing here. What DOES need a single
 * source is the fallback path when the rules give `unknown`: the prompt
 * text, the label vocabulary, the output-token cap, the per-call timeout,
 * and the backend PREFERENCE ORDER. `task_category` selects the judge
 * rubric downstream, so a category that differs between the two daemons for
 * the same task is a score difference, not a cosmetic one — and before this
 * file existed the two daemons disagreed on all four of those axes: Node's
 * `classifyWithLlm` called MLX only, hardcoded `http://127.0.0.1:8800`,
 * ~20 max_tokens, 15s timeout; Swift's routed through `callConfiguredJudge`,
 * i.e. WHATEVER judge backend the user configured — including the paid
 * `api`/`openai` leg — with the judge's own 800 max_tokens / 60s and a
 * different system prompt. A user who set `judge.backend: "api"` was
 * billed per classification on Swift only, for a call that decides nothing
 * more than which of ten labels a task gets.
 *
 * Measured 2026-09-10 on the maintainer's real apme.sqlite (40 real task
 * prompts, spread across every rule-assigned category, `scripts/
 * measure-apme-classifier-backends.mjs`, numbers in docs/apme.md), and the
 * measurement is recorded as INCONCLUSIVE about ranking. Under the
 * classifier's own 15s budget, on-device Foundation Models completed 16/40
 * calls (agreed with the rule-assigned label on 5/15, 1 out-of-vocabulary
 * answer) and the local MLX server completed 7/40 (agreed 1/7, 0 invalid) —
 * but the MLX server happened to have a 27B model loaded, so the 15s budget
 * measured that server's load that afternoon, not the backend's aptitude;
 * the samples that survived (n=15 vs n=7) are too small to rank on; and
 * agreement with the RULES is not accuracy, since the rules are the thing an
 * LLM reading the prompt is meant to improve on. So the order below is NOT a
 * claim that one backend classifies better. It is the order that changes the
 * fewest existing results while still admitting Apple Intelligence: `mlx`
 * first because it was already Node's only LLM leg (Node runs most
 * classifications) and is the leg the repo's prompts are calibrated against;
 * `foundationModels` second so a Mac with no MLX server — the common case,
 * most Macs have Apple Intelligence — still gets an LLM answer instead of
 * falling to rules; `rules` last. Re-measure before reordering: a normally
 * loaded MLX model, a budget both legs can meet, and owner-labelled ground
 * truth rather than rule agreement.
 */

// ─── Taxonomy ────────────────────────────────────────────────────────────────
//
// Mirrors `TaskCategory` in bridge/src/apme/classifier.ts and
// `ApmeClassifier.TaskCategory` (Swift, hand-mirrored — pre-existing, not
// converted by this file). This list is the one both classifier prompts
// advertise and the one label validation checks a raw model answer against.

export const APME_CLASSIFIER_LABELS = [
  'planning', 'research', 'coding', 'debugging', 'refactoring',
  'review', 'ops', 'conversation', 'multi_agent', 'unknown',
] as const;

export type ApmeClassifierLabel = typeof APME_CLASSIFIER_LABELS[number];

// ─── LLM-assist backend order ───────────────────────────────────────────────

/** Backends the LLM-assist classifier may call, in try-order. `mlx` leads
 *  and `foundationModels` follows (see the measurement note above); `rules` is not a network call — it
 *  means "give up and return the rule-based `unknown`", and is always the
 *  last resort so a fully offline daemon still classifies. `api`/`openai`
 *  are never members: classification runs on every closed task with
 *  `unknown` rules, so routing it through a paid backend would bill the
 *  user for a call the eval pipeline makes silently, on every session,
 *  whatever judge backend they picked for actual eval scoring. */
export const APME_CLASSIFIER_BACKEND_ORDER = ['mlx', 'foundationModels', 'rules'] as const;

export type ApmeClassifierBackend = typeof APME_CLASSIFIER_BACKEND_ORDER[number];

/** Output cap for a classification call. The answer is one word from a
 *  ten-item vocabulary; this is a latency/runaway-generation bound, not a
 *  cost control (both eligible backends are local/free). Deliberately far
 *  below the eval judge's 800-token cap — a different call with a different
 *  purpose sharing that budget is exactly how Swift's classifier inherited
 *  the judge's cost and latency profile in the first place. */
export const APME_CLASSIFIER_MAX_TOKENS = 20;

/** Per-call timeout. Classification runs synchronously in the task-close
 *  path on every `unknown`-ruled task, so it must fail fast into the rule
 *  fallback rather than stall task closure waiting on a busy local server. */
export const APME_CLASSIFIER_TIMEOUT_MS = 15_000;

export const APME_CLASSIFIER_SYSTEM_PROMPT = `You are a task classifier for coding agent sessions.
Given the user's prompt and tool usage summary, classify this task into exactly ONE category.

Categories:
- planning: architecture design, plan mode, thinking about approach
- research: searching code, reading docs, web search, investigating
- coding: writing/editing code, creating files, implementing features
- debugging: fixing bugs, running tests, investigating failures
- refactoring: restructuring existing code without changing behavior
- review: reading code for understanding, code review
- ops: git operations, deployments, config changes, CI/CD
- conversation: quick question, chat, no tools used
- multi_agent: delegating to sub-agents

Respond with ONLY the category name, nothing else.`;

export interface ApmeClassifierSignalSummary {
  taskPrompt: string;
  toolSummary: string;
  totalToolCalls: number;
  filesModified: number;
  filesCreated: number;
  sessionDurationSec: number;
  turnCount: number;
}

/** The exact user-message shape both daemons send. `taskPrompt` is clipped
 *  to 500 chars on the caller's side (matches the existing behavior) — kept
 *  out of this function so callers can clip before or after building the
 *  tool summary without this function silently re-clipping a value a
 *  caller already prepared. */
export function buildClassifierUserMessage(input: ApmeClassifierSignalSummary): string {
  return `Prompt: "${input.taskPrompt}"
Tools used: ${input.toolSummary || 'none'} (${input.totalToolCalls} total)
Files modified: ${input.filesModified}, created: ${input.filesCreated}
Duration: ${input.sessionDurationSec}s, turns: ${input.turnCount}`;
}

/** Normalize a raw model response into one of `APME_CLASSIFIER_LABELS`, or
 *  null when the response names no known category — callers must fall back
 *  to the rule-based result on null, never guess. Exact match first
 *  (the instructed shape), then substring (models routinely wrap the
 *  answer in prose despite being told not to). */
export function normalizeClassifierLabel(raw: string): ApmeClassifierLabel | null {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z_]/g, '');
  if ((APME_CLASSIFIER_LABELS as readonly string[]).includes(cleaned)) {
    return cleaned as ApmeClassifierLabel;
  }
  const match = APME_CLASSIFIER_LABELS.find((c) => cleaned.includes(c));
  return match ?? null;
}
