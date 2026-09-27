import { describe, it, expect } from 'vitest';
import {
  layoutOctopuses, layoutCloudCreatures, layoutOpenCodeCreatures, layoutAntigravityCreatures,
  spreadFloorResidents,
  type CreatureSlot,
} from '../creature-layout.js';
import { readFileSync } from 'node:fs';
import { TERRARIUM_RULES } from '../terrarium-rules.js';

/**
 * These lock the band geometry that the Pixoo renderers in BOTH daemons read.
 * The Swift (apple/AgentDeck/Terrarium/CreatureLayout.swift) and Kotlin
 * (android/.../terrarium/CreatureLayout.kt) mirrors must produce the same
 * numbers — if a constant moves here without moving there, the same session set
 * draws in different places depending on which daemon is driving the device.
 */

const BANDS = [
  { name: 'octopus', fn: layoutOctopuses, xMin: 0.20, xMax: 0.50, singleRowLimit: 4 },
  { name: 'cloud', fn: layoutCloudCreatures, xMin: 0.30, xMax: 0.55, singleRowLimit: 3 },
  { name: 'opencode', fn: layoutOpenCodeCreatures, xMin: 0.45, xMax: 0.68, singleRowLimit: 3 },
  { name: 'antigravity', fn: layoutAntigravityCreatures, xMin: 0.58, xMax: 0.82, singleRowLimit: 3 },
] as const;

describe('creature-layout bands', () => {
  it('returns nothing for a count of zero or less', () => {
    for (const { fn } of BANDS) {
      expect(fn(0)).toEqual([]);
      expect(fn(-1)).toEqual([]);
    }
  });

  it.each(BANDS)('$name keeps every slot inside its X band', ({ fn, xMin, xMax }) => {
    for (let count = 1; count <= 12; count++) {
      for (const slot of fn(count)) {
        expect(slot.x).toBeGreaterThanOrEqual(xMin);
        expect(slot.x).toBeLessThanOrEqual(xMax);
      }
    }
  });

  it.each(BANDS)('$name emits exactly `count` slots', ({ fn }) => {
    for (let count = 1; count <= 12; count++) {
      expect(fn(count)).toHaveLength(count);
    }
  });

  it.each(BANDS)('$name stays on one row up to its limit, then wraps', ({ fn, singleRowLimit }) => {
    const rowsOf = (slots: CreatureSlot[]) => new Set(slots.map(s => Math.round(s.y * 1000))).size;
    // Within the limit every slot shares one row Y (modulo the ±0.008 jitter,
    // which is why we compare against the un-jittered row count instead of Y).
    const single = fn(singleRowLimit);
    const singleRowYs = new Set(single.map((s, i) => Math.round((s.y - ((i % 3) - 1) * 0.008) * 1000)));
    expect(singleRowYs.size).toBe(1);

    // One past the limit must introduce a second row.
    expect(rowsOf(fn(singleRowLimit + 1))).toBeGreaterThan(1);
  });

  it('anchors each band at a distinct X center, so types read as clusters', () => {
    // The bands deliberately OVERLAP in X (octopus 0.20–0.50 vs cloud
    // 0.30–0.55) — separation is carried by the per-type Y stratification in the
    // renderers, not by disjoint X ranges. What must hold is that the bands do
    // not collapse onto a common center: a lone creature of each type lands in
    // its own part of the tank, left-to-right in a stable order.
    const centers = BANDS.map(({ fn }) => fn(1)[0].x);
    const sorted = [...centers].sort((a, b) => a - b);
    expect(centers).toEqual(sorted); // octopus < cloud < opencode < antigravity
    for (let i = 1; i < centers.length; i++) {
      expect(centers[i] - centers[i - 1]).toBeGreaterThan(0.05);
    }
  });
});

describe('crowd shrink', () => {
  it('never grows the scale as a band fills up', () => {
    for (const { fn } of BANDS) {
      let previous = Number.POSITIVE_INFINITY;
      for (let count = 1; count <= 12; count++) {
        const maxScale = Math.max(...fn(count).map(s => s.scale));
        expect(maxScale).toBeLessThanOrEqual(previous + 1e-9);
        previous = maxScale;
      }
    }
  });

  it('honors the 0.40 hard floor even when a band is packed', () => {
    for (const { fn } of BANDS) {
      for (const slot of fn(24)) {
        expect(slot.scale).toBeGreaterThanOrEqual(0.40);
      }
    }
  });

  it('shrinks a crowded row enough to cap neighbor overlap at ~half a body', () => {
    // Cloud band is the tightest (0.30–0.55 across 3 per row).
    const slots = layoutCloudCreatures(3);
    const creatureWidth = 0.080;
    const xs = slots.map(s => s.x).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) {
      const spacing = xs[i] - xs[i - 1];
      // Centers must sit at least half a scaled body-width apart.
      expect(spacing).toBeGreaterThanOrEqual(0.5 * creatureWidth * slots[i].scale - 1e-6);
    }
  });

  it('gives a lone creature the band-native full scale', () => {
    expect(layoutOctopuses(1)[0].scale).toBeCloseTo(1.0, 6);
    expect(layoutCloudCreatures(1)[0].scale).toBeCloseTo(0.98, 6);
    expect(layoutOpenCodeCreatures(1)[0].scale).toBeCloseTo(0.96, 6);
    expect(layoutAntigravityCreatures(1)[0].scale).toBeCloseTo(0.96, 6);
  });

  it('centers a lone creature in its band', () => {
    // t = 0.5 with the row inset applied, then nudged by the alternating jitter.
    const [only] = layoutOctopuses(1);
    expect(only.x).toBeGreaterThan(0.20);
    expect(only.x).toBeLessThan(0.50);
    expect(only.y).toBeCloseTo(0.42 - 0.008, 6); // frontY, minus the index-0 jitter
  });
});

describe('spreadFloorResidents (shared vectors)', () => {
  const file = JSON.parse(readFileSync(new URL('../../floor-spacing-vectors.json', import.meta.url), 'utf8'));
  for (const v of file.vectors as Array<{ name: string; minX: number; maxX: number; minGapRatio: number; items: { x: number; width: number }[]; expected: number[] }>) {
    it(v.name, () => {
      const out = spreadFloorResidents(v.items, v.minX, v.maxX, v.minGapRatio);
      expect(out.length).toBe(v.expected.length);
      out.forEach((x, i) => expect(x).toBeCloseTo(v.expected[i], 4));
    });
  }

  it('keeps floor residents inside the band left of the crayfish clear line', () => {
    const items = layoutOctopuses(6).map((slot) => ({ x: slot.x, width: 0.11 * slot.scale }));
    const out = spreadFloorResidents(items, TERRARIUM_RULES.floorSpacing.minX, TERRARIUM_RULES.crayfish.clearMaxX, TERRARIUM_RULES.floorSpacing.minGapRatio);
    for (const x of out) {
      expect(x).toBeGreaterThanOrEqual(TERRARIUM_RULES.floorSpacing.minX - 1e-9);
      expect(x).toBeLessThanOrEqual(TERRARIUM_RULES.crayfish.clearMaxX + 1e-9);
    }
  });
});
