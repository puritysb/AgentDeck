/**
 * Timebox Mini 11×11 "Agent Beacon" renderer.
 *
 * The panel is too small for a miniature terrarium. It gets its own visual
 * language instead: a stable 9×9 official agent mark sits inside a one-pixel
 * status rail. Identity never deforms; only the rail animates.
 *
 * The 9×9 masks are generated directly from design/brand/*.svg. This file owns
 * only device-specific color and motion, keeping geometry canonical while
 * making every one of the Timebox's 121 LEDs intentional.
 */

import {
  OFFICIAL_TIMEBOX_GLYPHS,
  OFFICIAL_TIMEBOX_GLYPH_SIZE,
  type OfficialDotGlyphName,
} from './official-dot-glyphs.generated.js';

export type RGB = readonly [number, number, number];
export type MicroCreature = 'octopus' | 'jellyfish' | 'opencode' | 'crayfish' | 'antigravity' | 'kiro';
export type MicroAggregate = 'idle' | 'processing' | 'awaiting' | 'error';

export const MICRO_SIZE = 11;

const BACKGROUND: RGB = [2, 6, 10];
const IDLE_RAIL: RGB = [38, 170, 116];
const PROCESSING_RAIL: RGB = [82, 220, 255];
const AWAITING_RAIL: RGB = [255, 184, 54];
const ERROR_RAIL: RGB = [255, 70, 70];

const AGENT_COLORS: Record<Exclude<OfficialDotGlyphName, 'antigravity'>, RGB> = {
  claudeCode: [235, 130, 90],
  codex: [112, 124, 255],
  openCode: [238, 238, 238],
  openClaw: [255, 92, 92],
  kiro: [124, 58, 237],
};

const PERIMETER: ReadonlyArray<readonly [number, number]> = [
  ...Array.from({ length: 11 }, (_, x) => [x, 0] as const),
  ...Array.from({ length: 10 }, (_, i) => [10, i + 1] as const),
  ...Array.from({ length: 10 }, (_, i) => [9 - i, 10] as const),
  ...Array.from({ length: 9 }, (_, i) => [0, 9 - i] as const),
];

function setPixel(buf: Uint8Array, x: number, y: number, color: RGB, intensity = 1): void {
  if (x < 0 || x >= MICRO_SIZE || y < 0 || y >= MICRO_SIZE) return;
  const i = (y * MICRO_SIZE + x) * 3;
  buf[i] = Math.round(color[0] * intensity);
  buf[i + 1] = Math.round(color[1] * intensity);
  buf[i + 2] = Math.round(color[2] * intensity);
}

function officialName(creature: MicroCreature): OfficialDotGlyphName {
  switch (creature) {
    case 'octopus': return 'claudeCode';
    case 'jellyfish': return 'codex';
    case 'opencode': return 'openCode';
    case 'crayfish': return 'openClaw';
    case 'antigravity': return 'antigravity';
    case 'kiro': return 'kiro';
  }
}

function antigravityColor(sourceX: number): RGB {
  const bands: RGB[] = [
    [92, 214, 77], [245, 203, 36], [255, 132, 16],
    [255, 82, 65], [183, 92, 182], [102, 111, 225], [36, 126, 255],
  ];
  const index = Math.min(bands.length - 1, Math.floor(sourceX * bands.length / OFFICIAL_TIMEBOX_GLYPH_SIZE));
  return bands[index];
}

function paintOfficialMark(buf: Uint8Array, creature: MicroCreature, aggregate: MicroAggregate): void {
  const name = officialName(creature);
  const mask = OFFICIAL_TIMEBOX_GLYPHS[name];
  const stateIntensity = aggregate === 'idle' ? 0.92 : aggregate === 'error' ? 0.72 : 1;

  for (let y = 0; y < OFFICIAL_TIMEBOX_GLYPH_SIZE; y++) {
    for (let x = 0; x < OFFICIAL_TIMEBOX_GLYPH_SIZE; x++) {
      const alpha = mask[y * OFFICIAL_TIMEBOX_GLYPH_SIZE + x];
      // Four deliberate levels survive the Timebox's 4-bit channel packing while
      // restoring the contour/shading that the old two-step body reduced to a
      // flat block. Keep true cutouts black so the official negative space reads.
      const coverage = alpha >= 224 ? 1 : alpha >= 144 ? 0.82 : alpha >= 56 ? 0.56 : alpha >= 20 ? 0.32 : 0;
      if (coverage === 0) continue;
      const color = name === 'antigravity' ? antigravityColor(x) : AGENT_COLORS[name];
      const light = 0.88 + (1 - y / (OFFICIAL_TIMEBOX_GLYPH_SIZE - 1)) * 0.12;
      setPixel(buf, x + 1, y + 1, color, coverage * stateIntensity * light);
    }
  }

  // The official silhouette carries the lobster identity; two cyan eye pixels
  // remain a device-tuned accessibility accent on the 9px reduction.
  if (name === 'openClaw') {
    setPixel(buf, 4, 4, [0, 229, 204], stateIntensity);
    setPixel(buf, 7, 4, [0, 229, 204], stateIntensity);
  }
}

function paintStandby(buf: Uint8Array, animFrame: number): void {
  const pulse = 0.55 + 0.25 * ((Math.sin(animFrame * 0.18) + 1) / 2);
  const tide: RGB = [76, 206, 220];
  for (const [y, left, right] of [[4, 4, 6], [6, 3, 7], [8, 4, 6]] as const) {
    for (let x = left; x <= right; x++) setPixel(buf, x, y, tide, pulse);
  }
}

function paintStatusRail(buf: Uint8Array, aggregate: MicroAggregate, animFrame: number): void {
  const railColor = aggregate === 'processing' ? PROCESSING_RAIL
    : aggregate === 'awaiting' ? AWAITING_RAIL
      : aggregate === 'error' ? ERROR_RAIL : IDLE_RAIL;
  const baseIntensity = aggregate === 'idle' ? 0.10 : 0.13;
  for (const [x, y] of PERIMETER) setPixel(buf, x, y, railColor, baseIntensity);

  switch (aggregate) {
    case 'processing': {
      const head = Math.floor(animFrame / 3) % PERIMETER.length;
      for (let trail = 0; trail < 5; trail++) {
        const [x, y] = PERIMETER[(head - trail + PERIMETER.length) % PERIMETER.length];
        setPixel(buf, x, y, PROCESSING_RAIL, 1 - trail * 0.17);
      }
      break;
    }
    case 'awaiting': {
      const phase = (Math.floor(animFrame / 4) & 1) === 0;
      const points = phase
        ? [[0, 0], [1, 0], [0, 1], [10, 10], [9, 10], [10, 9]]
        : [[10, 0], [9, 0], [10, 1], [0, 10], [1, 10], [0, 9]];
      for (const [x, y] of points) setPixel(buf, x, y, AWAITING_RAIL);
      break;
    }
    case 'error': {
      const intensity = 0.65 + 0.35 * ((Math.sin(animFrame * 0.35) + 1) / 2);
      for (let i = 0; i < PERIMETER.length; i += 2) {
        const [x, y] = PERIMETER[i];
        setPixel(buf, x, y, ERROR_RAIL, intensity);
      }
      break;
    }
    case 'idle': {
      const intensity = 0.56 + 0.16 * ((Math.sin(animFrame * 0.12) + 1) / 2);
      for (const [x, y] of [[0, 0], [10, 0], [10, 10], [0, 10]] as const) {
        setPixel(buf, x, y, IDLE_RAIL, intensity);
      }
      break;
    }
  }
}

/** Paint a complete 11×11 Agent Beacon frame. */
export function paintTimeboxBeacon(
  buf: Uint8Array,
  creature: MicroCreature | null,
  aggregate: MicroAggregate,
  animFrame: number,
): void {
  if (buf.length !== MICRO_SIZE * MICRO_SIZE * 3) return;
  for (let i = 0; i < MICRO_SIZE * MICRO_SIZE; i++) buf.set(BACKGROUND, i * 3);
  if (creature) paintOfficialMark(buf, creature, aggregate);
  else paintStandby(buf, animFrame);
  paintStatusRail(buf, aggregate, animFrame);
}
