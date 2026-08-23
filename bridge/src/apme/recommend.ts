/**
 * APME Recommendation Engine — Phase 4.
 *
 * Given a task context and the user's available models/subscriptions, return a
 * ranked list of model candidates with expected score, expected cost, and
 * confidence. v1 uses the v_model_scorecard view; v2 (stretch) layers in
 * task-similarity via local embeddings.
 */

import type { AgentType } from '@agentdeck/shared';
import type { ApmeStore } from './store.js';
import { paretoForCategory } from './pareto.js';

export interface RecommendInput {
  taskKind?: string;
  budgetUsd?: number;
  latencyBudgetMs?: number;
  preferLocal?: boolean;
  /** Models the user has access to — comes from settings.json.apme.subscriptions. */
  availableModels?: string[];
}

export interface RecommendCandidate {
  modelId: string;
  agentType: AgentType;
  expectedScore: number;
  expectedCostUsd: number;
  confidence: number;
  rationale: string;
}

/**
 * Order a cost-per-quality key, putting anything with no usable price LAST.
 *
 * `null` has always meant "no cost recorded". **Zero has to join it**, because
 * `runs.cost_usd` is one REAL column with no room to say why it is zero: a
 * provider that ships no price table reports `usage.cost.total = 0` on every
 * message, and so does a model that is genuinely free. Collapsing them at the
 * column is unavoidable; ranking on the collapsed value is not. Sorting zero
 * FIRST made "cheapest per unit of quality" answerable by having no prices at
 * all — `apme recommend --budget 3` would return whichever model is worst
 * instrumented as the best buy. Last is the honest place for both: a claim we
 * cannot support, ordered behind every model whose cost we actually measured.
 */
/** Exported for the ordering gate — the rule is the whole finding. */
export function unpricedLast(costPerQuality: number | null | undefined): number {
  return costPerQuality ? costPerQuality : Infinity;
}

/**
 * Three-way, never subtraction — CLAUDE.md states the rule and this is the
 * first time the comparison has a named home to honour it in.
 *
 * Subtracting is not merely stylistic here: every unpriced key maps to
 * `Infinity`, so `a - b` is `Infinity - Infinity` = **NaN** for any pair of
 * them. A NaN comparator leaves the sort order implementation-defined, so with
 * enough unpriced candidates the top-3 slice is an arbitrary permutation rather
 * than a ranking. Equal keys now compare equal, which is what "we cannot tell
 * these apart" should produce.
 */
export function byCostPerQuality(
  a: number | null | undefined,
  b: number | null | undefined,
): number {
  const av = unpricedLast(a);
  const bv = unpricedLast(b);
  if (av === bv) return 0;
  return av < bv ? -1 : 1;
}

export class ApmeRecommender {
  constructor(private readonly store: ApmeStore) {}

  recommend(input: RecommendInput): RecommendCandidate[] {
    if (!this.store.enabled) return [];

    // Work at sample granularity (the canonical eval unit) and restrict to the
    // Pareto frontier — dominated models (strictly worse on quality AND cost)
    // are never worth recommending. This is the model-orchestration payoff:
    // the menu is the quality/cost tradeoff curve, not a flat ranking.
    const scorecard = this.store.sampleScorecard();
    let { frontier } = paretoForCategory(scorecard, input.taskKind);

    // Fall back to the whole frontier if the category has too little data.
    if (frontier.length === 0) frontier = paretoForCategory(scorecard, undefined).frontier;

    // Fall back to the run-level scorecard when no sample-granularity data has
    // accumulated yet (legacy runs, or before the first task judge resolves).
    if (frontier.length === 0) return this.recommendFromRuns(input);

    let candidates = frontier;
    if (input.availableModels) {
      candidates = candidates.filter((p) => input.availableModels!.includes(p.modelId));
    }
    if (input.budgetUsd !== undefined) {
      candidates = candidates.filter((p) => p.costPerSample <= input.budgetUsd!);
    }
    if (input.latencyBudgetMs !== undefined) {
      candidates = candidates.filter((p) => p.avgLatencyMs == null || p.avgLatencyMs <= input.latencyBudgetMs!);
    }

    candidates = [...candidates].sort((a, b) => {
      // Budget-conscious or local-preferring → cheapest first; else best quality.
      if (input.preferLocal || (input.budgetUsd !== undefined && input.budgetUsd < 5)) {
        return a.costPerSample - b.costPerSample || b.quality - a.quality;
      }
      return b.quality - a.quality || a.costPerSample - b.costPerSample;
    });

    return candidates.slice(0, 3).map((p) => ({
      modelId: p.modelId,
      agentType: p.agentType as AgentType,
      expectedScore: p.quality,
      expectedCostUsd: p.costPerSample,
      confidence: Math.min(1, p.samples / 20),
      rationale: `${p.samples} samples, avg ${(p.quality * 100).toFixed(0)}%, $${p.costPerSample.toFixed(4)}/sample${
        p.avgLatencyMs != null ? `, ${Math.round(p.avgLatencyMs)}ms` : ''
      } — on the cost/quality frontier`,
    }));
  }

  /** Legacy run-level recommendation (v_model_scorecard). Used when no
   *  sample-granularity composite scores exist yet. */
  private recommendFromRuns(input: RecommendInput): RecommendCandidate[] {
    const rows = this.store.scorecard();
    const filtered = input.availableModels
      ? rows.filter((r) => input.availableModels!.includes(r.modelId))
      : rows;
    return filtered
      .filter((r) => r.runs >= 3 && (r.avgOverall ?? 0) > 0)
      .sort((a, b) => {
        if (input.budgetUsd !== undefined && input.budgetUsd < 5) {
          return byCostPerQuality(a.costPerQuality, b.costPerQuality);
        }
        return (b.avgOverall ?? 0) - (a.avgOverall ?? 0);
      })
      .slice(0, 3)
      .map((r) => ({
        modelId: r.modelId,
        agentType: r.agentType as AgentType,
        expectedScore: r.avgOverall ?? 0,
        expectedCostUsd: (r.totalCost ?? 0) / Math.max(r.runs, 1),
        confidence: Math.min(1, r.runs / 20),
        rationale: `${r.runs} runs, avg ${((r.avgOverall ?? 0) * 100).toFixed(0)}%${
          r.avgTestsPass != null ? `, tests ${((r.avgTestsPass) * 100).toFixed(0)}%` : ''
        }`,
      }));
  }
}
