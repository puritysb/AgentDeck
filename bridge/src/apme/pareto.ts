/**
 * Pareto frontier over (quality, cost) for model orchestration.
 *
 * A model is on the frontier if no other model dominates it — i.e. no other
 * model is BOTH higher quality AND lower (or equal) cost per sample. Dominated
 * models are strictly worse on both axes and should never be recommended; the
 * frontier is the real menu of quality/cost tradeoffs.
 *
 * "Same quality, 40% cheaper" decisions fall straight out of this: walk the
 * frontier from cheapest to best and pick the knee that fits the budget.
 *
 * Pure + synchronous + unit-testable. Input is the sample-granularity
 * scorecard; output partitions candidates into frontier vs dominated.
 */

import { APME_COMPARISON_MIN_SAMPLES, isApmeComparisonEligible, type ApmeSampleScorecardRow } from '@agentdeck/shared';

export interface ParetoPoint {
  agentType: string;
  modelId: string;
  provider: string | null;
  taskCategory: string | null;
  /** Quality axis (avg composite, [0,1]). Higher is better. */
  quality: number;
  /** Cost axis: average USD per sample. Lower is better. */
  costPerSample: number | null;
  avgLatencyMs: number | null;
  samples: number;
}

export interface ParetoResult {
  frontier: ParetoPoint[];
  dominated: ParetoPoint[];
}

function toPoint(r: ApmeSampleScorecardRow): ParetoPoint {
  return {
    agentType: r.agentType,
    modelId: r.modelId,
    provider: r.provider,
    taskCategory: r.taskCategory,
    quality: r.avgQuality ?? 0,
    costPerSample: r.costKnown && r.totalCost != null && r.samples > 0
      ? r.totalCost / r.samples
      : null,
    avgLatencyMs: r.avgLatencyMs,
    samples: r.samples,
  };
}

/** True when `b` dominates `a`: at least as good on both axes and strictly
 *  better on at least one (higher quality, lower cost). */
function dominates(b: ParetoPoint, a: ParetoPoint): boolean {
  if (b.taskCategory !== a.taskCategory) return false;
  // An unknown price cannot establish a cost advantage in either direction.
  if (b.costPerSample == null || a.costPerSample == null) return false;
  const bCost = b.costPerSample;
  const aCost = a.costPerSample;
  const betterOrEqual = b.quality >= a.quality && bCost <= aCost;
  const strictlyBetter = b.quality > a.quality || bCost < aCost;
  return betterOrEqual && strictlyBetter;
}

/**
 * Partition scorecard rows into the Pareto frontier and the dominated set.
 * @param rows         sample scorecard rows (optionally pre-filtered by category)
 * @param minSamples   ignore models with too little data to trust
 */
export function computePareto(
  rows: ApmeSampleScorecardRow[],
  minSamples = APME_COMPARISON_MIN_SAMPLES,
): ParetoResult {
  const points = rows
    .filter((r) => r.samples >= minSamples && isApmeComparisonEligible(r.modelId, r.taskCategory, r.samples)
      && r.avgQuality != null && Number.isFinite(r.avgQuality) && r.avgQuality > 0 && r.avgQuality <= 1)
    .map(toPoint);

  const frontier: ParetoPoint[] = [];
  const dominated: ParetoPoint[] = [];
  for (const a of points) {
    if (points.some((b) => b !== a && dominates(b, a))) dominated.push(a);
    else frontier.push(a);
  }
  // Frontier sorted cheapest → most expensive (the natural tradeoff curve).
  frontier.sort((x, y) => {
    const xc = x.costPerSample ?? Infinity;
    const yc = y.costPerSample ?? Infinity;
    if (xc !== yc) return xc < yc ? -1 : 1;
    return y.quality - x.quality;
  });
  return { frontier, dominated };
}

/** Convenience: filter scorecard to a category before computing the frontier. */
export function paretoForCategory(
  rows: ApmeSampleScorecardRow[],
  category: string | null | undefined,
  minSamples = APME_COMPARISON_MIN_SAMPLES,
): ParetoResult {
  const scoped = category != null ? rows.filter((r) => r.taskCategory === category) : rows;
  return computePareto(scoped, minSamples);
}
