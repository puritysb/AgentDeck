// creature-layout.ts — Multi-session creature positioning.
//
// Third mirror of the canonical band layout. The other two:
//   android/app/src/main/kotlin/dev/agentdeck/terrarium/CreatureLayout.kt
//   apple/AgentDeck/Terrarium/CreatureLayout.swift
// Keep the band constants, row rules, and the overlap cap identical across all
// three — a divergence shows up as the same session set drawn in different
// places on the Pixoo depending on which daemon is driving it.
//
// Kotlin/Swift compute in Float and this mirror in double; the sub-1e-7 drift
// that introduces cannot survive the rounding to a 64px device grid.

/** One creature's placement within its agent-type band. */
export interface CreatureSlot {
  /** Center X as a fraction of world width. */
  x: number;
  /** Center Y as a fraction of world height. */
  y: number;
  /** Crowd-driven size multiplier — shrinks as a row fills up. */
  scale: number;
}

/** Coding agents (Claude Code) — left-center band. */
export function layoutOctopuses(count: number): CreatureSlot[] {
  return layoutBand({
    count,
    xMin: 0.20,
    xMax: 0.50,
    frontY: 0.42,
    backY: 0.52,
    singleRowLimit: 4,
    baseScale: 1.0,
    minScale: 0.58,
    creatureWidth: 0.11,
  });
}

/** Codex clouds — float in the upper-center, above the octopuses. */
export function layoutCloudCreatures(count: number): CreatureSlot[] {
  return layoutBand({
    count,
    xMin: 0.30,
    xMax: 0.55,
    frontY: 0.16,
    backY: 0.28,
    singleRowLimit: 3,
    baseScale: 0.98,
    minScale: 0.56,
    creatureWidth: 0.080,
  });
}

/** OpenCode rings — mid-center band. */
export function layoutOpenCodeCreatures(count: number): CreatureSlot[] {
  return layoutBand({
    count,
    xMin: 0.45,
    xMax: 0.68,
    frontY: 0.34,
    backY: 0.46,
    singleRowLimit: 3,
    baseScale: 0.96,
    minScale: 0.56,
    creatureWidth: 0.078,
  });
}

/** Antigravity peak/arc marks — upper-right band. */
export function layoutAntigravityCreatures(count: number): CreatureSlot[] {
  return layoutBand({
    count,
    xMin: 0.58,
    xMax: 0.82,
    frontY: 0.22,
    backY: 0.34,
    singleRowLimit: 3,
    baseScale: 0.96,
    minScale: 0.56,
    creatureWidth: 0.096,
  });
}

/** Kiro ghosts — top-left band, INSIDE the visible tank.
 *
 * Above the octopuses and just left of the Codex clouds (0.30+). The x floor is
 * 0.21 rather than the tank edge because the dashboard's session-list HUD is
 * drawn over roughly the left 0.19 of the tank — a band starting at 0.08 put
 * the ghosts behind that panel, where they were measured to be invisible. The
 * right side is likewise unavailable: the upstream HUD covers it, and what it
 * does not cover belongs to the Antigravity hover strip and the crayfish
 * floor. */
export function layoutKiroCreatures(count: number): CreatureSlot[] {
  return layoutBand({
    count,
    xMin: 0.21,
    xMax: 0.32,
    frontY: 0.10,
    backY: 0.20,
    singleRowLimit: 3,
    baseScale: 0.96,
    minScale: 0.56,
    creatureWidth: 0.086,
  });
}

/**
 * Hard floor for the crowd-driven shrink. Below the per-band `minScale` so
 * tightly packed bands can still shrink enough to honor the overlap cap before
 * we give up and accept brief overlap.
 */
const CROWDED_MIN_SCALE = 0.40;

/**
 * Max fraction of a creature's width that two neighbors may overlap. 0.5 →
 * centers stay at least half a body-width apart (≤50% overlap).
 */
const MAX_OVERLAP_FRACTION = 0.5;

interface BandSpec {
  count: number;
  xMin: number;
  xMax: number;
  frontY: number;
  backY: number;
  singleRowLimit: number;
  baseScale: number;
  minScale: number;
  creatureWidth: number;
}

function layoutBand(spec: BandSpec): CreatureSlot[] {
  const { count, xMin, xMax, frontY, backY, singleRowLimit, baseScale, minScale, creatureWidth } = spec;
  if (count <= 0) return [];

  const rows = count <= singleRowLimit ? 1 : count <= singleRowLimit * 2 ? 2 : 3;

  const scale = Math.max(minScale, baseScale - Math.max(0, count - 1) * 0.055);
  const rowCounts = distribute(count, rows);
  const slots: CreatureSlot[] = [];
  let absoluteIndex = 0;

  for (let row = 0; row < rows; row++) {
    const rowCount = rowCounts[row];
    if (rowCount <= 0) continue;

    const rowT = rows === 1 ? 0 : row / (rows - 1);
    const rowY = frontY + (backY - frontY) * rowT;
    const rowInset = 0.015 + row * 0.02;
    const rowMinX = xMin + rowInset;
    const rowMaxX = xMax - rowInset;
    // Alternating jitter magnitude — constant within a row.
    const spread = Math.max(0.003, Math.min(0.012, (rowMaxX - rowMinX) / Math.max(rowCount * 5, 1)));

    // Overlap cap: keep neighbor center-spacing ≥ MAX_OVERLAP_FRACTION of the
    // on-screen body width so creatures never overlap by more than ~half. When
    // the band is too tight to honor that at the count-based scale, shrink every
    // creature in the row by the same ratio (down to CROWDED_MIN_SCALE) instead
    // of letting them pile up.
    let rowScale = Math.max(minScale, scale - row * 0.04);
    if (rowCount >= 2) {
      // Worst-case gap after the alternating jitter squeezes a pair.
      const spacing = (rowMaxX - rowMinX) / (rowCount - 1) - 2 * spread;
      const overlapCapScale = Math.max(0, spacing) / (MAX_OVERLAP_FRACTION * creatureWidth);
      rowScale = Math.max(CROWDED_MIN_SCALE, Math.min(rowScale, overlapCapScale));
    }

    for (let col = 0; col < rowCount; col++) {
      const t = rowCount === 1 ? 0.5 : col / (rowCount - 1);
      const baseX = rowMinX + (rowMaxX - rowMinX) * t;
      const phase = (absoluteIndex + row) % 2 === 0 ? -1 : 1;
      const x = Math.min(xMax, Math.max(xMin, baseX + spread * phase));
      const yJitter = ((absoluteIndex % 3) - 1) * 0.008;
      slots.push({ x, y: rowY + yJitter, scale: rowScale });
      absoluteIndex += 1;
    }
  }

  return slots;
}

function distribute(count: number, rows: number): number[] {
  if (rows <= 0) return [];
  const result = new Array<number>(rows).fill(Math.floor(count / rows));
  for (let index = 0; index < count % rows; index++) result[index] += 1;
  return result;
}

/**
 * Spreads floor-resting creatures apart (DESIGN.md §6.4, `TERRARIUM_RULES.floorSpacing`).
 *
 * `items` are centre X and body width as world fractions. Neighbours end at
 * least `minGapRatio × (wA + wB) / 2` apart, inside `[minX, maxX]`, moving each
 * creature as little as a two-sweep pass can: push right, then pull back from
 * the right edge, then clamp to the left edge. When the band cannot hold them
 * all, they are spaced evenly across it instead. Returns X in input order.
 *
 * Mirrored by hand in CreatureLayout.swift / CreatureLayout.kt and pinned by
 * `shared/floor-spacing-vectors.json`, which all three suites replay.
 */
export function spreadFloorResidents(
  items: ReadonlyArray<{ x: number; width: number }>,
  minX: number,
  maxX: number,
  minGapRatio: number,
): number[] {
  const order = items.map((_, i) => i).sort((a, b) => items[a].x - items[b].x || a - b);
  const need = (a: number, b: number) => minGapRatio * (items[a].width + items[b].width) / 2;
  const xs = order.map((i) => items[i].x);
  const n = xs.length;
  if (n === 0) return [];
  let required = 0;
  for (let k = 1; k < n; k++) required += need(order[k - 1], order[k]);
  if (required > maxX - minX) {
    // Not enough room: spread evenly, proportional to each pair's need.
    const scale = n > 1 ? (maxX - minX) / required : 0;
    xs[0] = n > 1 ? minX : (minX + maxX) / 2;
    for (let k = 1; k < n; k++) xs[k] = xs[k - 1] + need(order[k - 1], order[k]) * scale;
  } else {
    xs[0] = Math.max(minX, xs[0]);
    for (let k = 1; k < n; k++) xs[k] = Math.max(xs[k], xs[k - 1] + need(order[k - 1], order[k]));
    xs[n - 1] = Math.min(maxX, xs[n - 1]);
    for (let k = n - 2; k >= 0; k--) xs[k] = Math.min(xs[k], xs[k + 1] - need(order[k], order[k + 1]));
    xs[0] = Math.max(minX, xs[0]);
    for (let k = 1; k < n; k++) xs[k] = Math.max(xs[k], xs[k - 1] + need(order[k - 1], order[k]));
  }
  const out = new Array<number>(n);
  order.forEach((i, k) => { out[i] = xs[k]; });
  return out;
}
