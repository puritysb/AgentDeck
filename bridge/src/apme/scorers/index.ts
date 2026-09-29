/**
 * Scorer registry — Inspect-style pluggable scorers over a SessionSample.
 *
 * A `Scorer` reads the canonical typed trajectory (not raw turns) and emits
 * axis scores in [0,1]. This is where the typed-trajectory rebuild pays off:
 * scorers that were impossible with the old "tool_calls: count" model — tool
 * churn, error rates, retry detection — are now pure functions of the sample.
 *
 * The existing deterministic (lint/build/test) and LLM-judge layers remain in
 * runner.ts; these scorers ADD trajectory-based signal alongside them. All
 * scorers here are pure + synchronous + unit-testable (no LLM, no I/O).
 */

import type { SessionSample, ToolEvent, ApmeEvalLayer } from '@agentdeck/shared';

export interface ScorerResult {
  /** Axis name stored in evals.metric. */
  metric: string;
  /** [0,1]. */
  score: number;
  reasoning?: string;
}

export interface Scorer {
  name: string;
  /** Eval layer the results are stored under. */
  layer: ApmeEvalLayer;
  appliesTo(sample: SessionSample): boolean;
  score(sample: SessionSample): ScorerResult[];
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, Math.round(n * 100) / 100));

function toolEvents(sample: SessionSample): ToolEvent[] {
  return sample.events.filter((e): e is ToolEvent => e.kind === 'tool');
}

function toolKey(t: ToolEvent): string {
  let input = '';
  try { input = t.input == null ? '' : JSON.stringify(t.input); } catch { input = ''; }
  return `${t.name}|${input}`;
}

/**
 * Trajectory quality — penalizes churn: consecutive identical tool calls
 * (same name+input) signal the agent spinning, and tool errors signal
 * wasted steps. High score = a clean, non-repetitive trajectory.
 */
export const TrajectoryQualityScorer: Scorer = {
  name: 'trajectory_quality',
  layer: 'trajectory',
  appliesTo: (s) => toolEvents(s).length >= 2,
  score: (s) => {
    const tools = toolEvents(s);
    let dupes = 0;
    for (let i = 1; i < tools.length; i++) {
      // A pruned tool call (#302) has no retained `input`, so two pruned
      // calls to the same tool name would otherwise key-match and count as
      // a detected repeat — a wrong verdict about churn built from absence,
      // not evidence. Only two calls that both still carry their real input
      // can be compared.
      if (tools[i].pruned || tools[i - 1].pruned) continue;
      if (toolKey(tools[i]) === toolKey(tools[i - 1])) dupes++;
    }
    const errors = tools.filter((t) => t.status === 'error').length;
    const redundancy = dupes / tools.length;
    const errorRate = errors / tools.length;
    const score = clamp01(1 - 0.7 * redundancy - 0.5 * errorRate);
    return [{
      metric: 'trajectory_quality',
      score,
      reasoning: `${tools.length} tool calls, ${dupes} consecutive repeats, ${errors} errors`,
    }];
  },
};

/**
 * Tool efficiency — fraction of tool calls that completed without error,
 * lightly penalized when tool count balloons relative to assistant turns
 * (many tools per turn of visible progress = thrashing).
 */
export const ToolEfficiencyScorer: Scorer = {
  name: 'tool_efficiency',
  layer: 'trajectory',
  appliesTo: (s) => toolEvents(s).length >= 1,
  score: (s) => {
    const tools = toolEvents(s);
    const resolved = tools.filter((t) => t.status === 'success' || t.status === 'error');
    const ok = tools.filter((t) => t.status === 'success').length;
    const successRate = resolved.length > 0 ? ok / resolved.length : 1;
    const assistantTurns = Math.max(1, s.events.filter((e) => e.kind === 'assistant_message').length);
    const toolsPerTurn = tools.length / assistantTurns;
    // Soft penalty once tools-per-turn exceeds ~8 (sigmoid-ish).
    const densityPenalty = toolsPerTurn > 8 ? Math.min(0.3, (toolsPerTurn - 8) * 0.03) : 0;
    const score = clamp01(successRate - densityPenalty);
    return [{
      metric: 'tool_efficiency',
      score,
      reasoning: `${ok}/${resolved.length || tools.length} tools succeeded, ${toolsPerTurn.toFixed(1)} tools/turn`,
    }];
  },
};

/** All registered sample scorers. */
export const SAMPLE_SCORERS: Scorer[] = [TrajectoryQualityScorer, ToolEfficiencyScorer];

/** Run every applicable scorer and flatten the results. Pure — caller persists. */
export function runSampleScorers(sample: SessionSample, scorers: Scorer[] = SAMPLE_SCORERS): Array<ScorerResult & { layer: ApmeEvalLayer; scorer: string }> {
  const out: Array<ScorerResult & { layer: ApmeEvalLayer; scorer: string }> = [];
  for (const scorer of scorers) {
    if (!scorer.appliesTo(sample)) continue;
    try {
      for (const r of scorer.score(sample)) out.push({ ...r, layer: scorer.layer, scorer: scorer.name });
    } catch { /* a scorer must never break eval */ }
  }
  return out;
}
