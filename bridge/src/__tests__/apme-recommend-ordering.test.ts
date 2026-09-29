import { describe, it, expect } from 'vitest';
import { unpricedLast, byCostPerQuality } from '../apme/recommend.js';

describe('cost-per-quality ordering', () => {
  // `cost_known` now distinguishes a known-free local zero from an unpriced
  // remote zero. Unknown values reach this comparator as null; numeric zero is
  // therefore a real, rankable cost.
  it('ranks unknown cost behind known-free and paid candidates', () => {
    const keys = [null, 0, 12.5, undefined, 0.4];
    const sorted = [...keys].sort((a, b) => unpricedLast(a) - unpricedLast(b));
    expect(sorted.slice(0, 3)).toEqual([0, 0.4, 12.5]);
    expect(sorted.slice(3).every((k) => k == null)).toBe(true);
  });

  it('lets a known-free zero beat a real price', () => {
    expect(unpricedLast(0)).toBeLessThan(unpricedLast(999));
  });

  it('compares three-way so two unpriced keys never produce NaN', () => {
    // Every unpriced key maps to Infinity, so subtraction gives
    // `Infinity - Infinity` = NaN. A NaN comparator makes the sort order
    // implementation-defined — with enough unpriced candidates the top-3 is an
    // arbitrary permutation rather than a ranking. AGENTS.md: comparators are
    // three-way, never subtraction.
    expect(byCostPerQuality(null, undefined)).toBe(0);
    expect(Number.isNaN(unpricedLast(null) - unpricedLast(undefined))).toBe(true);
    expect(byCostPerQuality(0.4, 12.5)).toBeLessThan(0);
    expect(byCostPerQuality(12.5, 0.4)).toBeGreaterThan(0);
    expect(byCostPerQuality(0, 0.4)).toBeLessThan(0);
    expect(byCostPerQuality(null, 0)).toBeGreaterThan(0);
  });
});
