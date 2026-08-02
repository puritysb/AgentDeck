/**
 * APME Outcome Detector + Efficiency Calculator + Composite Scorer.
 *
 * Determines what the user DID with the agent's output (committed, abandoned,
 * iterated, A/B tested) rather than relying on noisy explicit feedback.
 * Computes efficiency metrics from run metadata. Calculates a weighted
 * composite score from outcome + judge + efficiency + vibe.
 */

import { execSync } from 'child_process';
import { debug } from '../logger.js';
import type { ApmeStore } from './store.js';
import type { ApmeRunRow } from './types.js';

// ─── Outcome types ───────────────────────────────────────────────────────────

export type Outcome =
  | 'committed'     // git changed after session → strongest positive
  | 'abandoned'     // no commit + new session on same project soon
  | 'iterated'      // follow-up session on same topic
  | 'ab_winner'     // parallel sessions, this one's changes survived
  | 'ab_loser'      // parallel sessions, this one's changes discarded
  | 'interrupted'   // very short session, likely Ctrl+C
  | 'exploratory'   // short, few tools, no changes → neutral
  | 'pending';      // not enough time elapsed to judge

export type Confidence = 'high' | 'medium' | 'low';

export interface OutcomeResult {
  outcome: Outcome;
  confidence: Confidence;
  reason: string;
}

// ─── Efficiency metrics ──────────────────────────────────────────────────────

export interface EfficiencyMetrics {
  tokensPerChange: number | null;   // (in+out) / diff lines
  costPerChange: number | null;     // cost_usd / diff lines
  timeToCompleteSec: number | null;
  toolEfficiency: number | null;    // diff lines / tool calls
  diffLines: number | null;
}

// ─── Composite score breakdown ───────────────────────────────────────────────

export interface CompositeBreakdown {
  outcomeScore: number;
  outcomeWeight: number;
  judgeScore: number | null;
  judgeWeight: number;
  efficiencyScore: number | null;
  efficiencyWeight: number;
  vibeScore: number | null;
  vibeWeight: number;
  composite: number;
}

// ─── Outcome detection ───────────────────────────────────────────────────────

const OUTCOME_SCORES: Record<Outcome, number> = {
  committed: 1.0,
  ab_winner: 1.0,
  iterated: 0.6,
  exploratory: 0.5,
  pending: 0.5,
  interrupted: 0.3,
  abandoned: 0.2,
  ab_loser: 0.1,
};

// Categories where success is measured by response quality, not git commits.
const NON_CODE_CATEGORIES = new Set(['conversation', 'planning', 'research', 'review']);

export function detectOutcome(store: ApmeStore, run: ApmeRunRow): OutcomeResult {
  if (!run.endedAt) return { outcome: 'pending', confidence: 'low', reason: 'run still in progress' };

  const durationSec = (run.endedAt - run.startedAt) / 1000;

  // Non-code categories: response completion = success (no git needed)
  if (run.taskCategory && NON_CODE_CATEGORIES.has(run.taskCategory)) {
    const turns = store.listTurns(run.id);
    if (turns.length > 0) {
      return { outcome: 'committed', confidence: 'high', reason: `${run.taskCategory} session completed — ${turns.length} turn(s)` };
    }
    if (durationSec < 10) {
      return { outcome: 'interrupted', confidence: 'medium', reason: `very short ${run.taskCategory} session (${Math.round(durationSec)}s)` };
    }
    return { outcome: 'exploratory', confidence: 'low', reason: `${run.taskCategory} session with no captured turns` };
  }

  // 1. Check git diff — did the session produce a commit?
  const hasCommit = run.gitBefore && run.gitAfter && run.gitBefore !== run.gitAfter;
  if (hasCommit) {
    // Check how quickly the commit happened
    if (durationSec < 120) {
      return { outcome: 'committed', confidence: 'high', reason: `quick commit in ${Math.round(durationSec)}s — git ${run.gitBefore?.slice(0, 7)}→${run.gitAfter?.slice(0, 7)}` };
    }
    return { outcome: 'committed', confidence: 'high', reason: `committed — git ${run.gitBefore?.slice(0, 7)}→${run.gitAfter?.slice(0, 7)}` };
  }

  // Also check live git state if projectPath available (commit may have happened after session)
  if (run.projectPath && run.gitBefore) {
    const currentHead = readGitHead(run.projectPath);
    if (currentHead && currentHead !== run.gitBefore) {
      return { outcome: 'committed', confidence: 'medium', reason: `post-session commit detected — git ${run.gitBefore.slice(0, 7)}→${currentHead.slice(0, 7)}` };
    }
  }

  // 2. Check for A/B testing pattern — similar runs close in time
  const recentRuns = store.listRuns({ limit: 20 });
  const siblings = recentRuns.filter((r) =>
    r.id !== run.id &&
    r.projectName === run.projectName &&
    r.endedAt &&
    Math.abs(r.startedAt - run.startedAt) < 30 * 60 * 1000 && // within 30 min
    r.modelId !== run.modelId // different model → A/B
  );

  if (siblings.length > 0) {
    const anyCommitted = siblings.some((s) => s.gitBefore && s.gitAfter && s.gitBefore !== s.gitAfter);
    if (anyCommitted) {
      return { outcome: 'ab_loser', confidence: 'medium', reason: `A/B test — sibling ${siblings.find((s) => s.gitBefore !== s.gitAfter)?.modelId ?? 'unknown'} was committed instead` };
    }
    // No sibling committed either — both abandoned or still pending
  }

  // 3. Check for iteration — same project, new session soon after
  const followUps = recentRuns.filter((r) =>
    r.id !== run.id &&
    r.projectName === run.projectName &&
    r.startedAt > (run.endedAt ?? 0) &&
    r.startedAt - (run.endedAt ?? 0) < 10 * 60 * 1000 // within 10 min
  );
  if (followUps.length > 0) {
    return { outcome: 'iterated', confidence: 'medium', reason: `follow-up session ${Math.round((followUps[0].startedAt - (run.endedAt ?? 0)) / 1000)}s later` };
  }

  // 4. Very short session → interrupted or exploratory
  const steps = store.listSteps(run.id);
  const toolCalls = steps.filter((s) => s.kind === 'PreToolUse' || s.kind === 'tool_start').length;

  if (durationSec < 30 && toolCalls <= 1) {
    return { outcome: 'interrupted', confidence: 'low', reason: `very short session (${Math.round(durationSec)}s, ${toolCalls} tools)` };
  }
  if (durationSec < 120 && toolCalls <= 3) {
    return { outcome: 'exploratory', confidence: 'low', reason: `short session (${Math.round(durationSec)}s, ${toolCalls} tools) — likely exploration` };
  }

  // 5. Long session with no commit → abandoned
  if (durationSec > 300) {
    return { outcome: 'abandoned', confidence: 'medium', reason: `${Math.round(durationSec / 60)}min session with no commit` };
  }

  return { outcome: 'exploratory', confidence: 'low', reason: `${Math.round(durationSec)}s session, ${toolCalls} tools, no commit` };
}

// ─── Efficiency ──────────────────────────────────────────────────────────────

export function computeEfficiency(run: ApmeRunRow): EfficiencyMetrics {
  const totalTokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
  const durationSec = run.endedAt && run.startedAt ? (run.endedAt - run.startedAt) / 1000 : null;
  const diffLines = countDiffLines(run);

  // Parse task_signals for tool call count
  let toolCalls = 0;
  if (run.taskSignals) {
    try {
      const sig = JSON.parse(run.taskSignals);
      toolCalls = sig.totalToolCalls ?? 0;
    } catch { /* ignore */ }
  }

  return {
    tokensPerChange: diffLines && diffLines > 0 ? Math.round(totalTokens / diffLines) : null,
    costPerChange: diffLines && diffLines > 0 && run.costUsd ? run.costUsd / diffLines : null,
    timeToCompleteSec: durationSec ? Math.round(durationSec) : null,
    toolEfficiency: toolCalls > 0 && diffLines ? Math.round((diffLines / toolCalls) * 10) / 10 : null,
    diffLines,
  };
}

function countDiffLines(run: ApmeRunRow): number | null {
  if (!run.projectPath) return null;
  try {
    const args = run.gitBefore && run.gitAfter && run.gitBefore !== run.gitAfter
      ? `diff --shortstat ${run.gitBefore}..${run.gitAfter}`
      : 'diff --shortstat HEAD';
    const out = execSync(`git ${args}`, {
      cwd: run.projectPath, encoding: 'utf-8', timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    // "3 files changed, 45 insertions(+), 12 deletions(-)"
    const ins = out.match(/(\d+) insertion/);
    const del = out.match(/(\d+) deletion/);
    return (parseInt(ins?.[1] ?? '0', 10)) + (parseInt(del?.[1] ?? '0', 10));
  } catch {
    return null;
  }
}

// ─── Composite scorer ────────────────────────────────────────────────────────

export function computeComposite(
  store: ApmeStore,
  run: ApmeRunRow,
  outcomeResult: OutcomeResult,
  efficiency: EfficiencyMetrics,
): CompositeBreakdown {
  const outcomeScore = OUTCOME_SCORES[outcomeResult.outcome] ?? 0.5;
  const outcomeWeight = 0.4;

  // LLM judge overall
  const evals = store.listEvalsForRun(run.id);
  const judgeOverall = evals.find((e) => e.layer === 'llm_judge' && e.metric === 'overall');
  const judgeScore = judgeOverall?.score ?? null;
  const judgeWeight = 0.3;

  // Efficiency — normalize: lower tokens_per_change is better.
  // Use a sigmoid-like normalization: score = 1 / (1 + tpc/median)
  // Median for coding tasks ~200 tokens/line. Null = 0.5 (neutral).
  const medianTpc = 200;
  let efficiencyScore: number | null = null;
  if (efficiency.tokensPerChange !== null && efficiency.tokensPerChange > 0) {
    efficiencyScore = Math.round((1 / (1 + efficiency.tokensPerChange / medianTpc)) * 100) / 100;
  }
  const efficiencyWeight = 0.2;

  // Vibe — lowest weight due to noise
  const vibe = store.latestVibeForRun(run.id);
  let vibeScore: number | null = null;
  if (vibe) {
    vibeScore = vibe.verdict === 'approve' ? 1.0 : vibe.verdict === 'reject' ? 0.0 : 0.5;
  }
  const vibeWeight = 0.1;

  // Weighted sum (only count axes that have values)
  let sum = outcomeScore * outcomeWeight;
  let totalWeight = outcomeWeight;

  if (judgeScore !== null) {
    sum += judgeScore * judgeWeight;
    totalWeight += judgeWeight;
  }
  if (efficiencyScore !== null) {
    sum += efficiencyScore * efficiencyWeight;
    totalWeight += efficiencyWeight;
  }
  if (vibeScore !== null) {
    sum += vibeScore * vibeWeight;
    totalWeight += vibeWeight;
  }

  const composite = totalWeight > 0 ? Math.round((sum / totalWeight) * 100) / 100 : 0.5;

  return {
    outcomeScore, outcomeWeight,
    judgeScore, judgeWeight,
    efficiencyScore, efficiencyWeight,
    vibeScore, vibeWeight,
    composite,
  };
}

// ─── Full evaluation pass ────────────────────────────────────────────────────

/** Run outcome detection + efficiency + composite scoring on a single run. */
export function evaluateOutcome(store: ApmeStore, runId: string): {
  outcome: OutcomeResult;
  efficiency: EfficiencyMetrics;
  composite: CompositeBreakdown;
} | null {
  const run = store.getRun(runId);
  if (!run || !run.endedAt) return null;

  const outcome = detectOutcome(store, run);
  const efficiency = computeEfficiency(run);
  const composite = computeComposite(store, run, outcome, efficiency);

  // Persist
  store.updateRun(runId, {
    outcome: outcome.outcome,
    outcomeConfidence: outcome.confidence,
    efficiencyJson: JSON.stringify(efficiency),
    compositeScore: composite.composite,
  });

  debug('APME', `outcome ${runId.slice(0, 8)}: ${outcome.outcome}(${outcome.confidence}) composite=${composite.composite}`);
  return { outcome, efficiency, composite };
}

/** Lightweight composite re-computation — called after judge evals are inserted
 *  so the judge contribution is reflected without re-detecting outcome/efficiency. */
export function recomputeComposite(store: ApmeStore, runId: string): void {
  const run = store.getRun(runId);
  if (!run || !run.outcome || !run.efficiencyJson) return;
  try {
    const outcomeResult: OutcomeResult = { outcome: run.outcome as Outcome, confidence: (run.outcomeConfidence ?? 'low') as Confidence, reason: '' };
    const efficiency: EfficiencyMetrics = JSON.parse(run.efficiencyJson);
    const composite = computeComposite(store, run, outcomeResult, efficiency);
    store.updateRun(runId, { compositeScore: composite.composite });
    debug('APME', `recomputeComposite ${runId.slice(0, 8)}: ${composite.composite}`);
  } catch (err) {
    debug('APME', `recomputeComposite failed ${runId.slice(0, 8)}: ${String(err)}`);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function readGitHead(cwd: string): string | null {
  try {
    return execSync('git rev-parse HEAD', {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000, windowsHide: true,
    }).trim() || null;
  } catch {
    return null;
  }
}
