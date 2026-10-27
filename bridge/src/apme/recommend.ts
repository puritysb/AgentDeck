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
  provider: string | null;
  expectedScore: number;
  expectedCostUsd: number | null;
  /** Legacy sample-support heuristic, not a probability of correctness. */
  confidence: number;
  samples: number;
  taskCategory: string | null;
  rationale: string;
}

/**
 * Order a cost-per-quality key, putting anything with no usable price LAST.
 *
 * `null` means the price source is unknown and sorts last. Zero is now a valid
 * known-free value: `cost_known` carries the provenance that the old REAL-only
 * schema lacked, so local models no longer have to be penalized to keep an
 * unpriced remote model from masquerading as free.
 */
/** Exported for the ordering gate — the rule is the whole finding. */
export function unpricedLast(costPerQuality: number | null | undefined): number {
  return costPerQuality == null ? Infinity : costPerQuality;
}

/**
 * Three-way, never subtraction — AGENTS.md states the rule and this is the
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

    // Filter constraints BEFORE dominance: an unavailable/too-slow model
    // cannot remove a usable alternative. Never silently switch categories or
    // fall back to legacy run scores when task evidence is insufficient.
    const scorecard = this.store.sampleScorecard().filter((r) => {
      if (input.availableModels && !input.availableModels.includes(r.modelId)) return false;
      const cost = r.costKnown && r.totalCost != null && r.samples > 0 ? r.totalCost / r.samples : null;
      if (input.budgetUsd !== undefined && (cost == null || cost > input.budgetUsd)) return false;
      if (input.latencyBudgetMs !== undefined
        && (r.avgLatencyMs == null || r.avgLatencyMs <= 0 || r.avgLatencyMs > input.latencyBudgetMs)) return false;
      return true;
    });
    let { frontier: candidates } = paretoForCategory(scorecard, input.taskKind);

    candidates = [...candidates].sort((a, b) => {
      // Budget-conscious or local-preferring → cheapest first; else best quality.
      if (input.preferLocal || (input.budgetUsd !== undefined && input.budgetUsd < 5)) {
        return byCostPerQuality(a.costPerSample, b.costPerSample) || b.quality - a.quality;
      }
      return b.quality - a.quality || byCostPerQuality(a.costPerSample, b.costPerSample);
    });

    return candidates.slice(0, 3).map((p) => ({
      modelId: p.modelId,
      agentType: p.agentType as AgentType,
      provider: p.provider,
      expectedScore: p.quality,
      expectedCostUsd: p.costPerSample,
      confidence: Math.min(1, p.samples / 20),
      samples: p.samples,
      taskCategory: p.taskCategory,
      rationale: `${p.samples} samples, avg ${(p.quality * 100).toFixed(0)}%, ${p.costPerSample == null ? 'cost unpriced' : `$${p.costPerSample.toFixed(4)}/sample`}${
        p.avgLatencyMs != null ? `, ${Math.round(p.avgLatencyMs)}ms` : ''
      } — observed AI estimates; not a success probability`,
    }));
  }

}
