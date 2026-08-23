import { describe, it, expect } from 'vitest';
import { unpricedLast, byCostPerQuality } from '../apme/recommend.js';

describe('cost-per-quality ordering', () => {
  // `runs.cost_usd` is one REAL column with no room to say WHY it is zero. A
  // provider that ships no price table reports `usage.cost.total = 0` on every
  // message; so does a genuinely free model. Once per-message cost started
  // being recorded, an all-zero group's `cost_per_quality` went from NULL
  // (sorted last, never recommended) to 0 (sorted FIRST), so
  // `apme recommend --budget 3` could return whichever model is worst
  // instrumented as the best buy.
  it('ranks an unpriced group behind every priced one', () => {
    const keys = [null, 0, 12.5, undefined, 0.4];
    const sorted = [...keys].sort((a, b) => unpricedLast(a) - unpricedLast(b));
    expect(sorted.slice(0, 2)).toEqual([0.4, 12.5]);
    // Both "no cost recorded" and "cost recorded as zero" land behind.
    expect(sorted.slice(2).every((k) => k === null || k === 0 || k === undefined)).toBe(true);
  });

  it('does not let a zero beat a real price', () => {
    expect(unpricedLast(0)).toBeGreaterThan(unpricedLast(999));
  });

  it('compares three-way so two unpriced keys never produce NaN', () => {
    // Every unpriced key maps to Infinity, so subtraction gives
    // `Infinity - Infinity` = NaN. A NaN comparator makes the sort order
    // implementation-defined — with enough unpriced candidates the top-3 is an
    // arbitrary permutation rather than a ranking. CLAUDE.md: comparators are
    // three-way, never subtraction.
    expect(byCostPerQuality(null, 0)).toBe(0);
    expect(Number.isNaN(unpricedLast(null) - unpricedLast(0))).toBe(true);
    expect(byCostPerQuality(0.4, 12.5)).toBeLessThan(0);
    expect(byCostPerQuality(12.5, 0.4)).toBeGreaterThan(0);
    expect(byCostPerQuality(0, 0.4)).toBeGreaterThan(0);
  });
});
