/**
 * Native 11×11 creature glyphs for the Timebox Mini micro layout.
 *
 * The Timebox Mini has only 121 LEDs. Downscaling the 32×32 terrarium creature to
 * 11×11 bottoms out at a fuzzy silhouette — so for this device the creatures are
 * **hand-authored directly at 11×11** as bold, high-contrast bitmaps. Every pixel
 * is intentional, which is dramatically more legible than any downscale.
 *
 * The glyphs are the canonical brand marks (matching assets/logos/*_creature_gen.png
 * and design/brand/*.svg), not loose creature approximations:
 *   Claude  → rusty robot (rectangular head, two amber eyes, body, arms, legs)
 *   Codex   → lavender cloud carrying a white `>_` terminal prompt
 *   OpenClaw→ red lobster (raised top claws, teal eyes, segmented tail)
 *   OpenCode→ nested-square ring logo
 * The MicroCreature keys (octopus/jellyfish/opencode/crayfish) are legacy internal
 * codenames kept for the renderer mapping — only the art behind them is brand-true.
 *
 * Each glyph is an 11-row × 11-col string grid. Characters map to colors:
 *   '.' transparent (shows the status-color background)
 *   'B' body   'A' arm/antenna/leg   'C' claw   'D' joint/shadow   'E' eye   'M' prompt mark   'F' logo frame
 * `work` is an optional second frame for a simple processing animation (leg wiggle).
 */

export type RGB = readonly [number, number, number];
export type MicroCreature = 'octopus' | 'jellyfish' | 'opencode' | 'crayfish';
export type MicroState = 'idle' | 'working' | 'asking';

export const MICRO_SIZE = 11;

interface Glyph {
  colors: Record<string, RGB>;
  idle: string[];
  work?: string[];
}

// Claude Code — rusty robot (assets/logos/robot_creature_gen.png, design/brand/
// claudecode.svg): rectangular head with two glowing amber eyes, neck, body with
// arms (darker joints) jutting out the sides, two legs. Terracotta body (#C07058
// family, kept bright for the LED panel), amber eyes for the lit-display look.
const OCTOPUS: Glyph = {
  colors: { B: [235, 130, 90], D: [150, 84, 64], E: [255, 176, 64] },
  idle: [
    '...........',
    '..BBBBBBB..',
    '..BEEBEEB..',
    '..BBBBBBB..',
    '....BBB....',
    '.DBBBBBBBD.',
    '.DBBBBBBBD.',
    '..BBBBBBB..',
    '...BB.BB...',
    '...BB.BB...',
    '...........',
  ],
  work: [
    '...........',
    '..BBBBBBB..',
    '..BEEBEEB..',
    '..BBBBBBB..',
    '....BBB....',
    '.DBBBBBBBD.',
    '.DBBBBBBBD.',
    '..BBBBBBB..',
    '...BB.BB...',
    '..BB...BB..',
    '..D.....D..',
  ],
};

// Codex — lavender cloud (#6166E0, assets/logos/cloud_creature_gen.png): a bumpy
// round cloud body carrying a white `>` chevron + `_` terminal prompt — the Codex
// identity. Keyed 'jellyfish' to match the renderer's creatureType for codex agents.
const JELLYFISH: Glyph = {
  colors: { B: [120, 126, 236], M: [238, 240, 255] },
  idle: [
    '.BB.BB.BB..',
    'BBBBBBBBBB.',
    'BBBBBBBBBBB',
    'BBBBBBBBBBB',
    'BBMBBBBBBBB',
    'BBBMMBBBBBB',
    'BBMBBBBBBBB',
    'BBBBBMMMBBB',
    'BBBBBBBBBBB',
    '.BBBBBBBBB.',
    '..B.BB.B...',
  ],
};

// OpenCode — two overlapping HOLLOW squares (the canonical opencode.svg ring
// logo; no filled core — a solid center reads as a shadow). Light stroke so it
// reads (#3a3a3a brand gray is too dark for LEDs). Centered in the 11×11 field.
const OPENCODE: Glyph = {
  colors: { F: [232, 232, 232] },
  idle: [
    '...........',
    '.FFFFFF....',
    '.F....F....',
    '.F....F....',
    '.F..FFFFFF.',
    '.F..F...F..',
    '.FFFF...F..',
    '....F...F..',
    '....F...F..',
    '....FFFFFF.',
    '...........',
  ],
};

// OpenClaw — red mechanical lobster (#FF4D4D, assets/logos/lobster_creature_gen.png):
// two big claws raised at the top corners, antennae rising from the center, a head
// with two teal eyes (#00E5CC), and a vertical segmented tail fanning out at the
// bottom. Legs splay from the thorax. Darker red claws give them depth.
const CRAYFISH: Glyph = {
  colors: { B: [255, 92, 92], C: [210, 52, 52], A: [225, 180, 170], E: [0, 229, 204] },
  idle: [
    'CC.......CC',
    'CC...A...CC',
    '.C..AAA..C.',
    '...BEBEB...',
    '...BBBBB...',
    'A..BBBBB..A',
    '.A.BBBBB.A.',
    '...BBBBB...',
    '...BBBBB...',
    '...BB.BB...',
    '..BB...BB..',
  ],
  work: [
    'CC.......CC',
    '.C...A...C.',
    '..C.AAA.C..',
    '...BEBEB...',
    '...BBBBB...',
    '.A.BBBBB.A.',
    'A..BBBBB..A',
    '...BBBBB...',
    '...BBBBB...',
    '...B.B.B...',
    '..BB...BB..',
  ],
};

const GLYPHS: Record<MicroCreature, Glyph> = {
  octopus: OCTOPUS,
  jellyfish: JELLYFISH,
  opencode: OPENCODE,
  crayfish: CRAYFISH,
};

/** Dark status-color field so the bright creature pops. Amber awaiting pulses. */
export function microStatusBg(
  state: 'idle' | 'processing' | 'awaiting' | 'error',
  animFrame: number,
): RGB {
  switch (state) {
    case 'error': return [64, 18, 18];
    case 'awaiting': {
      const p = 0.78 + 0.22 * ((Math.sin(animFrame * 0.25) + 1) / 2);
      return [Math.round(74 * p), Math.round(50 * p), Math.round(10 * p)];
    }
    case 'processing': return [10, 28, 64];
    default: return [16, 56, 28];
  }
}

/**
 * Paint a creature glyph onto an 11×11 RGB buffer (only non-transparent pixels).
 * `working` alternates two leg frames; `asking` reuses the idle pose (the amber
 * field already signals "awaiting").
 */
export function paintMicroGlyph(
  buf: Uint8Array,
  creature: MicroCreature,
  state: MicroState,
  animFrame: number,
): void {
  const g = GLYPHS[creature];
  const grid = state === 'working' && g.work && ((animFrame >> 2) & 1) ? g.work : g.idle;
  for (let y = 0; y < MICRO_SIZE; y++) {
    const row = grid[y];
    for (let x = 0; x < MICRO_SIZE; x++) {
      const col = g.colors[row[x]];
      if (!col) continue;
      const i = (y * MICRO_SIZE + x) * 3;
      buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2];
    }
  }
}
