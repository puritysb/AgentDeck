/**
 * Pixoo64 Creature Sprites + Environment — pixel art for 64×64 LED matrix.
 *
 * Grids match Android TerrainCreature designs:
 *   Octopus: 14×7 grid (Android OctopusCreature), PIXEL_ASPECT 2.0
 *   Crayfish: 12×8 grid (Android CrayfishCreature simplified)
 *   Tetra: 4-pixel fish (body 2 + stripe 1 + fin 1)
 *
 * Pixel art readability stack:
 *   1. Colored outline (body-color darkened 50% — silhouette definition)
 *   2. Silhouette-first grids (round head, separated tentacles)
 *   3. Bright eye highlights (warm white — visible on LED)
 *   4. LOD sprites (chunky grids for zoom < 1.3)
 *   5. Glow halo (subtle radial glow behind creatures, moderate for LOD — ×1.5 intensity)
 *   6. Camera timing (wide zone zoom 1.2, shorter dwell)
 *   7. LOD outline (alpha 0.6 — visible silhouette without shape smearing)
 *   8. Composite breathing wave (sin + harmonic — organic rhythm)
 *   9. Minimum animation amplitude (1px floor — no invisible motion)
 *
 * Camera-scaled rendering:
 *   cellPx = creature world width / grid columns × camera zoom
 *   zoom 1.2 → octopus ~8.4px wide, crayfish ~14.4px wide
 *   zoom 2.0 → octopus ~14px wide, crayfish ~24px wide
 */

import type { Camera } from './pixoo-camera.js';
import { worldToScreen, isVisible } from './pixoo-camera.js';
import { State, STATE_COLORS } from '@agentdeck/shared';
import {
  OFFICIAL_DOT_GLYPHS,
  OFFICIAL_DOT_GLYPH_SIZE,
  type OfficialDotGlyphName,
} from './official-dot-glyphs.generated.js';

// ===== Cell Types (shared with ESP32/Android) =====
const EMPTY = 0;
const BODY = 1;
const EYE = 2;
const LEFT_ARM = 3;
const RIGHT_ARM = 4;
const LEFT_LEG = 5;
const RIGHT_LEG = 6;
const ANTENNA = 7;

// ===== Octopus HD 24×24 — Claude Code mascot aligned with SVG viewBox =====
export const OCTOPUS_GRID_HD: number[][] = [
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
  [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
  [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
  [0,0,0,1,1,1,2,2,1,1,1,1,1,1,1,1,2,2,1,1,1,0,0,0],
  [0,0,0,1,1,1,2,2,1,1,1,1,1,1,1,1,2,2,1,1,1,0,0,0],
  [0,0,0,1,1,1,2,2,1,1,1,1,1,1,1,1,2,2,1,1,1,0,0,0],
  [3,3,3,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,4,4,4],
  [3,3,3,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,4,4,4],
  [3,3,3,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,4,4,4],
  [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
  [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
  [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
  [0,0,0,0,5,5,0,0,5,5,0,0,0,0,6,6,0,0,6,6,0,0,0,0],
  [0,0,0,0,5,5,0,0,5,5,0,0,0,0,6,6,0,0,6,6,0,0,0,0],
  [0,0,0,0,5,5,0,0,5,5,0,0,0,0,6,6,0,0,6,6,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
];
const OCTO_HD_COLS = 24;
const OCTO_HD_ROWS = 24;

// ===== Octopus MD 14×13 — Claude Code boxy mascot =====
export const OCTOPUS_GRID_MD: number[][] = [
  [0,1,1,1,1,1,1,1,1,1,1,1,1,0],  // Flat top (12)
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1],  // (14)
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1],  // (14)
  [1,1,2,2,1,1,1,1,1,1,2,2,1,1],  // Wide eye holes (2px)
  [1,1,2,2,1,1,1,1,1,1,2,2,1,1],  // Eye holes bottom
  [3,3,1,1,1,1,1,1,1,1,1,1,4,4],  // Arms + body (14)
  [3,3,1,1,1,1,1,1,1,1,1,1,4,4],  // Arms + body (14)
  [3,3,1,1,1,1,1,1,1,1,1,1,4,4],  // Arms + body (14)
  [0,1,1,1,1,1,1,1,1,1,1,1,1,0],  // Slightly tapered waist (12)
  [0,1,1,1,1,1,1,1,1,1,1,1,1,0],  // (12)
  [0,5,5,0,5,5,0,0,6,6,0,6,6,0],  // Thick 2px legs for distortion-free downscaling
  [0,5,5,0,5,5,0,0,6,6,0,6,6,0],
  [0,5,5,0,0,0,0,0,0,0,0,6,6,0]
];
const OCTO_GRID_MD_COLS = 14;
const OCTO_GRID_MD_ROWS = 13;

export const OCTOPUS_GRID = OCTOPUS_GRID_HD; // alias for compatibility
const OCTO_COLS = OCTO_HD_COLS;
const OCTO_ROWS = OCTO_HD_ROWS;

/** World width of octopus in normalized coords. */
export const OCTO_WORLD_W = 7 / 64;

// ===== Octopus LOD 7×7 — chunky grid for zoom < 1.3 =====
export const OCTOPUS_LOD: number[][] = [
  [0,1,1,1,1,1,0],
  [1,1,1,1,1,1,1],
  [1,2,2,1,2,2,1],  // Bold eye holes
  [3,1,1,1,1,1,4],  // Arms + body
  [0,1,1,1,1,1,0],
  [0,5,5,1,6,6,0],  // Thick limbs
  [0,5,0,0,0,6,0],
];
const OCTO_LOD_COLS = 7;
const OCTO_LOD_ROWS = 7;

// ===== Crayfish HD 24×24 — OpenClaw mascot, round full body matching design/brand/openclaw.svg =====
// Round body, antennae curving to the top corners, two separated side-claw blobs (3/4), two leg
// stubs (5/6). Eyes are NOT in the grid — drawn as a teal+black overlay at eyeRow/eyeCols below.
export const CRAYFISH_GRID_HD: number[][] = [
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,7,7,0,0,0,0,0,0,0,0,7,7,0,0,0,0,0,0],
  [0,0,0,0,0,7,0,0,0,0,0,0,0,0,0,0,0,0,7,0,0,0,0,0],
  [0,0,0,0,7,0,0,0,0,0,1,1,1,1,0,0,0,0,0,7,0,0,0,0],
  [0,0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0],
  [0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0],
  [0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0],
  [0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0],
  [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0], // eyes overlaid at cols 8,14
  [0,3,3,1,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,1,4,4,0],
  [3,3,3,3,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,4,4,4,4],
  [3,3,3,3,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,4,4,4,4],
  [0,3,3,1,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,1,4,4,0],
  [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
  [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
  [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
  [0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0],
  [0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0],
  [0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0],
  [0,0,0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,1,5,5,1,1,1,1,6,6,1,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,5,5,1,1,1,1,6,6,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
];
const CF_HD_COLS = 24;
const CF_HD_ROWS = 24;

// ===== Crayfish MD 12×8 — OpenClaw mascot, round body (eyes overlaid at row 3, cols 4/7) =====
export const CRAYFISH_GRID_MD: number[][] = [
  [0,7,0,0,0,0,0,0,0,0,7,0],  // Antennae tips at the corners
  [0,0,7,0,0,1,1,0,0,7,0,0],  // Antennae + head crown
  [0,0,0,1,1,1,1,1,1,0,0,0],  // Rounded head dome
  [0,3,3,1,1,1,1,1,1,4,4,0],  // Claws + body (eyes overlay row 3)
  [3,3,1,1,1,1,1,1,1,1,4,4],  // Wide claws + body
  [0,0,1,1,1,1,1,1,1,1,0,0],  // Thorax
  [0,0,0,1,1,1,1,1,1,0,0,0],  // Lower body
  [0,0,0,5,5,0,0,6,6,0,0,0]   // Walking legs
];
const CF_GRID_MD_COLS = 12;
const CF_GRID_MD_ROWS = 8;

export const CRAYFISH_GRID = CRAYFISH_GRID_HD; // alias for compatibility
const CF_COLS = CF_HD_COLS;
const CF_ROWS = CF_HD_ROWS;

/** World width of crayfish in normalized coords. */
export const CF_WORLD_W = 12 / 64;

// ===== Crayfish LOD 8×6 — compact round body (eyes overlaid at row 2, cols 2/5) =====
export const CRAYFISH_LOD: number[][] = [
  [0,7,0,0,0,0,7,0],  // Antennae at corners
  [0,0,1,1,1,1,0,0],  // Head crown
  [3,3,1,1,1,1,4,4],  // Claws + body (eyes overlay row 2)
  [0,1,1,1,1,1,1,0],  // Body
  [0,1,1,1,1,1,1,0],  // Body
  [0,0,5,0,0,6,0,0],  // Legs
];
const CF_LOD_COLS = 8;
const CF_LOD_ROWS = 6;

// ===== Jellyfish HD 24×24 — Codex cloud mascot aligned with SVG viewBox =====
export const JELLYFISH_GRID_HD: number[][] = [
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,1,1,1,1,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
  [0,0,0,0,0,1,1,1,1,1,1,0,0,1,1,1,1,1,1,0,0,0,0,0],
  [0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0],
  [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
  [0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
  [0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
  [0,0,1,1,1,1,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0], // prompt `>`
  [0,0,1,1,1,1,1,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
  [0,0,1,1,1,1,1,1,2,2,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
  [0,0,1,1,1,1,1,1,1,2,2,1,1,1,1,1,1,1,1,1,1,1,0,0],
  [0,0,1,1,1,1,1,1,1,2,2,1,1,1,1,1,1,1,1,1,1,1,0,0],
  [0,0,1,1,1,1,1,1,2,2,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
  [0,0,1,1,1,1,1,2,2,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
  [0,0,1,1,1,1,2,2,1,1,1,1,2,2,2,2,2,2,1,1,1,1,0,0], // prompt `_`
  [0,0,0,1,1,1,1,1,1,1,1,1,2,2,2,2,2,2,1,1,1,0,0,0],
  [0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0],
  [0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0],
  [0,0,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0],
  [0,0,0,0,0,3,3,3,3,3,1,1,1,1,3,3,3,3,3,0,0,0,0,0], // bottom lobes are BREATHE_EDGE
  [0,0,0,0,0,0,3,3,3,0,0,0,0,0,0,3,3,3,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
];
const JF_HD_COLS = 24;
const JF_HD_ROWS = 24;

// ===== Jellyfish MD 13×11 — Codex mascot =====
export const JELLYFISH_GRID_MD: number[][] = [
  [0,0,0,1,1,1,1,1,0,0,0,0,0],  // Rounded top lobe
  [0,1,1,1,1,1,1,1,1,1,1,1,0],
  [1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1],
  [3,1,2,2,1,1,1,1,1,1,1,1,3],  // `>` top stroke (2px thick)
  [3,1,1,2,2,1,1,2,2,2,2,1,3],  // `>` point + long `_` prompt (4px)
  [3,1,2,2,1,1,1,1,1,1,1,1,3],  // `>` bottom stroke
  [1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1],
  [0,1,1,1,1,1,1,1,1,1,1,1,0],
  [0,0,0,1,1,1,1,1,0,0,0,0,0]   // Bottom cloud lobe, not dangling legs
];
const JF_GRID_MD_COLS = 13;
const JF_GRID_MD_ROWS = 11;

export const JELLYFISH_GRID = JELLYFISH_GRID_HD; // alias for compatibility
const JF_COLS = JF_HD_COLS;
const JF_ROWS = JF_HD_ROWS;

/** World width of jellyfish in normalized coords. */
export const JF_WORLD_W = 13 / 64;

// ===== Jellyfish LOD 9×7 — compact for zoom < 1.3 =====
export const JELLYFISH_LOD: number[][] = [
  [0,0,1,1,1,1,1,0,0],
  [0,1,1,1,1,1,1,1,0],
  [1,2,2,1,1,1,1,1,1],  // `>` upper stroke (2px)
  [1,1,2,2,1,2,2,2,1],  // `>` point + `_` prompt (3px)
  [1,2,2,1,1,1,1,1,1],  // `>` lower stroke
  [0,1,1,1,1,1,1,1,0],
  [0,0,1,1,1,1,1,0,0],
];
const JF_LOD_COLS = 9;
const JF_LOD_ROWS = 7;

// Cell type constants for jellyfish
const MARKING = 2;
const BREATHE_EDGE = 3;

// ===== OpenCode HD 24×24 — OpenCode mascot aligned with SVG viewBox =====
export const OPENCODE_GRID_HD: number[][] = [
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,8,8,8,8,8,8,8,8,8,8,8,8,8,8,0,0,0,0,0,0],
  [0,0,0,0,8,8,8,8,8,8,8,8,8,8,8,8,8,8,0,0,0,0,0,0],
  [0,0,0,0,8,8,0,0,0,0,0,0,0,0,0,0,8,8,0,0,0,0,0,0],
  [0,0,0,0,8,8,0,0,0,0,0,0,0,0,0,0,8,8,0,0,0,0,0,0],
  [0,0,0,0,8,8,0,0,0,0,0,0,0,0,0,0,8,8,0,0,0,0,0,0],
  [0,0,0,0,8,8,0,0,0,0,0,0,0,0,0,0,8,8,0,0,0,0,0,0],
  [0,0,0,0,8,8,0,0,0,0,9,9,9,9,9,9,8,8,9,9,9,9,9,9],
  [0,0,0,0,8,8,0,0,0,0,9,9,9,9,9,9,8,8,9,9,9,9,9,9],
  [0,0,0,0,8,8,0,0,0,0,9,9,9,9,9,9,8,8,9,9,9,9,9,9],
  [0,0,0,0,8,8,0,0,0,0,9,9,9,9,9,9,8,8,9,9,9,9,9,9],
  [0,0,0,0,8,8,0,0,0,0,9,9,9,9,9,9,8,8,9,9,9,9,9,9],
  [0,0,0,0,8,8,0,0,0,0,9,9,9,9,9,9,8,8,9,9,9,9,9,9],
  [0,0,0,0,8,8,8,8,8,8,8,8,8,8,8,8,8,8,9,9,9,9,9,9],
  [0,0,0,0,8,8,8,8,8,8,8,8,8,8,8,8,8,8,9,9,9,9,9,9],
  [0,0,0,0,0,0,0,0,0,0,9,9,9,9,9,9,9,9,9,9,9,9,9,9],
  [0,0,0,0,0,0,0,0,0,0,9,9,9,9,9,9,9,9,9,9,9,9,9,9],
  [0,0,0,0,0,0,0,0,0,0,9,9,9,9,9,9,9,9,9,9,9,9,9,9],
  [0,0,0,0,0,0,0,0,0,0,9,9,9,9,9,9,9,9,9,9,9,9,9,9],
  [0,0,0,0,0,0,0,0,0,0,9,9,9,9,9,9,9,9,9,9,9,9,9,9],
  [0,0,0,0,0,0,0,0,0,0,9,9,9,9,9,9,9,9,9,9,9,9,9,9],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
];
const OC_HD_COLS = 24;
const OC_HD_ROWS = 24;

// ===== OpenCode MD 10×10 — nested-square logo =====
const OPENCODE_FRAME = 8;
const OPENCODE_CORE = 9;
export const OPENCODE_GRID_MD: number[][] = [
  [8,8,8,8,8,8,0,0,0,0],
  [8,0,0,0,0,8,0,0,0,0],
  [8,0,0,0,0,8,0,0,0,0],
  [8,0,0,0,0,8,0,0,0,0],
  [8,0,0,0,9,8,9,9,9,9],
  [8,8,8,8,8,8,9,9,9,9],
  [0,0,0,0,9,9,9,9,9,9],
  [0,0,0,0,9,9,9,9,9,9],
  [0,0,0,0,9,9,9,9,9,9],
  [0,0,0,0,0,0,0,0,0,0],
];
const OC_GRID_MD_COLS = 10;
const OC_GRID_MD_ROWS = 10;

export const OPENCODE_GRID = OPENCODE_GRID_HD; // alias for compatibility
const OC_COLS = OC_HD_COLS;
const OC_ROWS = OC_HD_ROWS;

export const OPENCODE_LOD: number[][] = [
  [8,8,8,8,0,0],
  [8,0,0,8,0,0],
  [8,0,9,8,9,9],
  [8,8,8,8,9,9],
  [0,0,9,9,9,9],
  [0,0,9,9,9,9],
];
const OC_LOD_COLS = 6;
const OC_LOD_ROWS = 6;

// ===== Antigravity — rainbow peak/arc mark =====
const ANTIGRAVITY_GRID: string[] = [
  '....YOO....',
  '....YOO....',
  '...LYOOR...',
  '...LTORR...',
  '..LLTVPP...',
  '..TTKKVPP..',
  '.TQQK.KVU..',
  '.QQK...KUU.',
  'NQK.....KUU',
  'NN.......UU',
  '...........',
];
const AG_COLS = 11;
const AG_ROWS = 11;

// ===== Grid Selection Utility =====
interface GridSelection {
  grid: number[][];
  cols: number;
  rows: number;
}

function selectGrid(
  zoom: number,
  canvasWidth: number,
  hd: number[][], hdCols: number, hdRows: number,
  md: number[][], mdCols: number, mdRows: number,
  lod: number[][], lodCols: number, lodRows: number,
): GridSelection {
  if (canvasWidth <= 32) {
    if (zoom < 1.3) {
      return { grid: lod, cols: lodCols, rows: lodRows };
    } else {
      // Zoomed-in on a 32px display (iDotMatrix): use the full HD grid, not MD. Now that cell size
      // is resolution-aware (creatureCellSize), HD fits the 32px frame (~60% width) and keeps the
      // creature's true silhouette instead of the coarser MD approximation. MD/LOD stay for the
      // wide (zoom<1.3) shots where the creature is small and detail would just alias.
      return { grid: hd, cols: hdCols, rows: hdRows };
    }
  } else {
    if (zoom < 1.3) {
      return { grid: md, cols: mdCols, rows: mdRows };
    } else {
      return { grid: hd, cols: hdCols, rows: hdRows };
    }
  }
}

/**
 * On-screen creature width as a fraction of (zoom × output width), independent of LOD grid.
 *
 * A sprite spans `SPRITE_W_FRAC × zoom × w` pixels regardless of which HD/MD/LOD grid is selected
 * (cellSz = span / cols, so the `cols` term cancels). Multiplying by `w` (32 or 64) is what makes
 * sizing resolution-aware — at 32px a creature is exactly half the pixels it is at 64px, so it stays
 * inside the iDotMatrix frame instead of overflowing. 0.1875 reproduces the legacy 64px HD size
 * (24 cols × zoom×0.5 = 12×zoom px = 0.1875 × zoom × 64). See drawOpenCode for the original pattern.
 */
const SPRITE_W_FRAC = 0.1875;

/** Resolution-aware square cell size for a creature sprite.
 *
 * Rounded to a whole pixel so every grid cell is a uniform integer block. A
 * fractional cell size makes adjacent cells round to alternating 1/2px widths,
 * and on the 2×2 eye holes that intermittently opens a 1px body-coloured seam
 * between the two eye rows while the creature moves — the eyes appear to "break"
 * into dots. Integer cells render the eye as a solid block every frame.
 *
 * The sizing zoom is itself quantized to a coarse 0.25 step first. The raw zoom
 * lerps continuously during camera transitions, so a cell size sitting right on
 * a rounding threshold (e.g. zoom where `…/cols` ≈ x.5) flickers 1↔2px frame to
 * frame — and since the eye sits at a fixed column, a cellSz change jumps it by
 * `eyeCol` pixels. Snapping the zoom to discrete steps holds cellSz stable
 * through a transition so the eye only ever moves by whole-creature translation. */
export function creatureCellSize(zoom: number, canvasW: number, cols: number): number {
  const zq = Math.round(zoom * 4) / 4; // 0.25 steps — kills threshold-straddle flicker
  return Math.max(1, Math.round((SPRITE_W_FRAC * zq * canvasW) / cols));
}

// ===== Colors — Android-matching darker palette =====
type RGB = readonly [number, number, number];

/** Canonical `#rrggbb` → RGB tuple (LED frame buffers take tuples, not hex). */
function hexRgb(hex: string): RGB {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
export interface OctopusPalette {
  body: RGB;
  arm: RGB;
  leg: RGB;
  sleeping: RGB;
  starburst: RGB;
}

export const COLORS = {
  // Octopus (terracotta — Android match)
  octopusBody:      [0xC0, 0x70, 0x58] as const,
  octopusEye:          [0x10, 0x08, 0x08] as const,  // near-black — simple dot eyes
  octopusEyePupil:     [0x10, 0x08, 0x08] as const,   // same as eye (unified)
  octopusArm:       [0xA0, 0x58, 0x40] as const,
  octopusLeg:       [0xA0, 0x58, 0x40] as const,
  octopusSleeping:  [0x80, 0x50, 0x40] as const,
  octopusStarburst: [0xD0, 0x88, 0x70] as const,
  octopusGlow:      [0x60, 0x38, 0x2C] as const,  // warm terracotta glow

  // Crayfish (red — Android match)
  crayfishBody:    [0xFF, 0x4D, 0x4D] as const,
  crayfishEye:     [0x00, 0xE5, 0xCC] as const,  // teal — OpenClaw signature (1px center)
  crayfishEyeRing: [0x10, 0x08, 0x08] as const,  // near-black surround (3×3 eye)
  crayfishClaw:    [0xCC, 0x44, 0x33] as const,  // brighter than body for visibility on dark water
  crayfishLeg:     [0xCC, 0x33, 0x33] as const,
  crayfishRouting: [0xFF, 0x6B, 0x6B] as const,
  crayfishAntenna: [0xDD, 0x55, 0x55] as const,
  crayfishGlow:    [0x80, 0x20, 0x20] as const,  // warm red glow
  crayfishSick:    [0x88, 0x66, 0x66] as const,  // desaturated gray-red (gateway error)

  // Jellyfish / Codex CLI (indigo — TUI/Android match)
  jellyfishBody:    [0x63, 0x66, 0xF1] as const,  // indigo #6366F1
  jellyfishEdge:    [0x4F, 0x46, 0xE5] as const,  // darker edge (breathe cells)
  jellyfishMarking: [0xF5, 0xF7, 0xFF] as const,  // near-white (>_ prompt)
  jellyfishGlow:    [0x31, 0x33, 0x78] as const,   // dim indigo glow halo
  jellyfishPulse:   [0xA5, 0xB4, 0xFC] as const,   // bioluminescent pulse
  jellyfishSleeping:[0x3A, 0x3C, 0x90] as const,   // dimmed indigo

  // OpenCode (nested square)
  opencodeOuter:    [0xF1, 0xEC, 0xEC] as const,  // light frame
  opencodeInner:    [0x4B, 0x46, 0x46] as const,  // dark core
  opencodePulse:    [0xCF, 0xCE, 0xCD] as const,  // pulse state
  opencodeSleeping: [0x8A, 0x84, 0x84] as const,  // sleep dim

  // Antigravity (reference rainbow peak/arc)
  antigravityLime:   [0x5C, 0xD6, 0x4D] as const,
  antigravityTeal:   [0x1F, 0xC6, 0xB3] as const,
  antigravityCyan:   [0x3A, 0xC7, 0xEB] as const,
  antigravityYellow: [0xF5, 0xCB, 0x24] as const,
  antigravityOrange: [0xFF, 0x84, 0x10] as const,
  antigravityRed:    [0xFF, 0x52, 0x41] as const,
  antigravityPink:   [0xB7, 0x5C, 0xB6] as const,
  antigravityViolet: [0x66, 0x6F, 0xE1] as const,
  antigravityBlue:   [0x24, 0x7E, 0xFF] as const,
  antigravitySky:    [0x29, 0xB8, 0xEE] as const,

  // Tetra (neon)
  tetraNeon: [0x00, 0xE5, 0xFF] as const,
  tetraBody: [0x1E, 0x40, 0xAF] as const,
  tetraFin:  [0xFF, 0x6B, 0x6B] as const,

  // Environment — brightened for LED visibility (was Android-dark, too dim on Pixoo)
  waterDeep:    [0x14, 0x24, 0x3C] as const,
  waterMid:     [0x1C, 0x38, 0x58] as const,
  waterLight:   [0x24, 0x48, 0x6C] as const,
  waterSurface: [0x2C, 0x58, 0x80] as const,

  // Teal zone (50-70%) — brightened for LED
  waterTealDeep:    [0x10, 0x30, 0x3C] as const,
  waterTealMid:     [0x18, 0x44, 0x50] as const,
  waterTealLight:   [0x22, 0x58, 0x64] as const,
  waterTealSurface: [0x2C, 0x6C, 0x78] as const,

  // Amber zone (70-90%) — brightened for LED
  waterAmberDeep:    [0x34, 0x24, 0x14] as const,
  waterAmberMid:     [0x4C, 0x36, 0x1C] as const,
  waterAmberLight:   [0x60, 0x48, 0x24] as const,
  waterAmberSurface: [0x78, 0x5C, 0x2E] as const,

  // Red zone (90%+) — brightened for LED
  waterRedDeep:    [0x3C, 0x14, 0x14] as const,
  waterRedMid:     [0x58, 0x1E, 0x1E] as const,
  waterRedLight:   [0x70, 0x28, 0x28] as const,
  waterRedSurface: [0x88, 0x32, 0x32] as const,

  // Terrain — brightened for LED
  sand:      [0x38, 0x2C, 0x1E] as const,
  sandLight: [0x4C, 0x3C, 0x28] as const,
  sandDark:  [0x28, 0x20, 0x14] as const,
  gravel:    [0x44, 0x36, 0x24] as const,
  rock:      [0x2C, 0x24, 0x1A] as const,  // dark earth (blends with sand)
  rockLight: [0x38, 0x2E, 0x22] as const,  // warm earth (blends with sand)

  // Seaweed (Android green)
  seaweed:      [0x22, 0xC5, 0x5E] as const,
  seaweedDark:  [0x18, 0x90, 0x42] as const,
  seaweedLight: [0x30, 0xE0, 0x70] as const,

  // Effects
  bubble:            [0x40, 0x70, 0xA0] as const,
  bubbleBright:      [0x60, 0x98, 0xCC] as const,
  lightRay:          [0x20, 0x40, 0x60] as const,
  caustic:           [0x1C, 0x36, 0x50] as const,
  dataParticle:      [0x70, 0xB0, 0xFF] as const,
  dataParticleGreen: [0x50, 0xF0, 0x90] as const,

  // Tank walls (above water)
  tankWall:     [0x06, 0x0A, 0x10] as const,
  tankWallEdge: [0x10, 0x14, 0x1C] as const,

  // State shimmer — derived from the canonical shared palette
  stateIdle:       hexRgb(STATE_COLORS[State.IDLE]),
  stateProcessing: hexRgb(STATE_COLORS[State.PROCESSING]),
  stateAwaiting:   hexRgb(STATE_COLORS[State.AWAITING_PERMISSION]),
  stateError:      [0xEF, 0x44, 0x44] as const, // red — no canonical error state color exists

  white: [0xFF, 0xFF, 0xFF] as const,
  black: [0x00, 0x00, 0x00] as const,
};

export { type RGB };

const SESSION_TONE_FACTORS = [1.08, 1.0, 0.9, 0.8, 0.72, 0.64] as const;

function scaleColor(color: RGB, factor: number): RGB {
  return [
    Math.max(0, Math.min(255, Math.round(color[0] * factor))),
    Math.max(0, Math.min(255, Math.round(color[1] * factor))),
    Math.max(0, Math.min(255, Math.round(color[2] * factor))),
  ] as const;
}

/**
 * Multi-session Pixoo creatures can't show textual #1/#2 labels well.
 * Use a stable brightness ramp instead: first session stays slightly brighter,
 * later sessions get progressively darker while preserving the base hue.
 */
export function getOctopusPaletteForSession(sessionIndex = 0): OctopusPalette {
  const tone = SESSION_TONE_FACTORS[
    Math.max(0, Math.min(SESSION_TONE_FACTORS.length - 1, sessionIndex))
  ];
  return {
    body: scaleColor(COLORS.octopusBody, tone),
    arm: scaleColor(COLORS.octopusArm, tone),
    leg: scaleColor(COLORS.octopusLeg, tone),
    sleeping: scaleColor(COLORS.octopusSleeping, tone),
    starburst: scaleColor(COLORS.octopusStarburst, tone),
  };
}

export interface JellyfishPalette {
  body: RGB;
  edge: RGB;
  marking: RGB;
  sleeping: RGB;
  pulse: RGB;
}

/**
 * Multi-session jellyfish palette with brightness ramp (same as octopus).
 */
export function getJellyfishPaletteForSession(sessionIndex = 0): JellyfishPalette {
  const tone = SESSION_TONE_FACTORS[
    Math.max(0, Math.min(SESSION_TONE_FACTORS.length - 1, sessionIndex))
  ];
  return {
    body: scaleColor(COLORS.jellyfishBody, tone),
    edge: scaleColor(COLORS.jellyfishEdge, tone),
    marking: scaleColor(COLORS.jellyfishMarking, tone),
    sleeping: scaleColor(COLORS.jellyfishSleeping, tone),
    pulse: scaleColor(COLORS.jellyfishPulse, tone),
  };
}

export interface OpenCodePalette {
  outer: RGB;
  inner: RGB;
  sleeping: RGB;
  pulse: RGB;
}

export function getOpenCodePaletteForSession(sessionIndex = 0): OpenCodePalette {
  const tone = SESSION_TONE_FACTORS[
    Math.max(0, Math.min(SESSION_TONE_FACTORS.length - 1, sessionIndex))
  ];
  return {
    outer: scaleColor(COLORS.opencodeOuter, tone),
    inner: scaleColor(COLORS.opencodeInner, tone),
    sleeping: scaleColor(COLORS.opencodeSleeping, tone),
    pulse: scaleColor(COLORS.opencodePulse, tone),
  };
}

export interface AntigravityPalette {
  lime: RGB;
  teal: RGB;
  cyan: RGB;
  yellow: RGB;
  orange: RGB;
  red: RGB;
  pink: RGB;
  violet: RGB;
  blue: RGB;
  sky: RGB;
  cutout: RGB;
}

export function getAntigravityPaletteForSession(sessionIndex = 0): AntigravityPalette {
  const tone = SESSION_TONE_FACTORS[
    Math.max(0, Math.min(SESSION_TONE_FACTORS.length - 1, sessionIndex))
  ];
  return {
    lime: scaleColor(COLORS.antigravityLime, tone),
    teal: scaleColor(COLORS.antigravityTeal, tone),
    cyan: scaleColor(COLORS.antigravityCyan, tone),
    yellow: scaleColor(COLORS.antigravityYellow, tone),
    orange: scaleColor(COLORS.antigravityOrange, tone),
    red: scaleColor(COLORS.antigravityRed, tone),
    pink: scaleColor(COLORS.antigravityPink, tone),
    violet: scaleColor(COLORS.antigravityViolet, tone),
    blue: scaleColor(COLORS.antigravityBlue, tone),
    sky: scaleColor(COLORS.antigravitySky, tone),
    cutout: COLORS.black,
  };
}

// ===== Pixel Operations =====

/** Set a pixel in the dynamic RGB buffer. */
export function setPixel(buf: Uint8Array, x: number, y: number, color: RGB): void {
  const w = Math.sqrt(buf.length / 3);
  if (x < 0 || x >= w || y < 0 || y >= w) return;
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || ix >= w || iy < 0 || iy >= w) return;
  const idx = (iy * w + ix) * 3;
  buf[idx] = color[0];
  buf[idx + 1] = color[1];
  buf[idx + 2] = color[2];
}

/** Alpha-blend a pixel onto existing buffer content. */
export function blendPixel(buf: Uint8Array, x: number, y: number, color: RGB, alpha: number): void {
  const w = Math.sqrt(buf.length / 3);
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || ix >= w || iy < 0 || iy >= w || alpha <= 0) return;
  const idx = (iy * w + ix) * 3;
  const a = Math.min(1, alpha);
  const inv = 1 - a;
  buf[idx] = Math.min(255, Math.round(buf[idx] * inv + color[0] * a));
  buf[idx + 1] = Math.min(255, Math.round(buf[idx + 1] * inv + color[1] * a));
  buf[idx + 2] = Math.min(255, Math.round(buf[idx + 2] * inv + color[2] * a));
}

/** Additive-blend (glow) a pixel. */
export function glowPixel(buf: Uint8Array, x: number, y: number, color: RGB, intensity: number): void {
  const w = Math.sqrt(buf.length / 3);
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || ix >= w || iy < 0 || iy >= w || intensity <= 0) return;
  const idx = (iy * w + ix) * 3;
  buf[idx] = Math.min(255, buf[idx] + Math.round(color[0] * intensity));
  buf[idx + 1] = Math.min(255, buf[idx + 1] + Math.round(color[1] * intensity));
  buf[idx + 2] = Math.min(255, buf[idx + 2] + Math.round(color[2] * intensity));
}

/** Fill a rectangle. */
export function fillRect(
  buf: Uint8Array, x: number, y: number, w: number, h: number, color: RGB
): void {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      setPixel(buf, x + dx, y + dy, color);
    }
  }
}

/** Fill a scaled cell (variable size rectangle) — edge rounding for correct PIXEL_ASPECT. */
function fillCell(buf: Uint8Array, x: number, y: number, w: number, h: number, color: RGB): void {
  const ix1 = Math.round(x);
  const iy1 = Math.round(y);
  const ix2 = Math.round(x + w);
  const iy2 = Math.round(y + h);
  const iw = Math.max(1, ix2 - ix1);
  const ih = Math.max(1, iy2 - iy1);
  for (let dy = 0; dy < ih; dy++) {
    for (let dx = 0; dx < iw; dx++) {
      setPixel(buf, ix1 + dx, iy1 + dy, color);
    }
  }
}

/** Fill a scaled cell and track drawn pixels for outline generation. */
function fillCellTracked(
  buf: Uint8Array, x: number, y: number, w: number, h: number,
  color: RGB, pixels: Set<number>,
): void {
  const canvasW = Math.sqrt(buf.length / 3);
  const ix1 = Math.round(x);
  const iy1 = Math.round(y);
  const ix2 = Math.round(x + w);
  const iy2 = Math.round(y + h);
  const iw = Math.max(1, ix2 - ix1);
  const ih = Math.max(1, iy2 - iy1);
  for (let dy = 0; dy < ih; dy++) {
    for (let dx = 0; dx < iw; dx++) {
      const px = ix1 + dx;
      const py = iy1 + dy;
      if (px >= 0 && px < canvasW && py >= 0 && py < canvasW) {
        const idx = (py * canvasW + px) * 3;
        buf[idx] = color[0];
        buf[idx + 1] = color[1];
        buf[idx + 2] = color[2];
        pixels.add(py * canvasW + px);
      }
    }
  }
}

/** Glow-fill a scaled cell — edge rounding. */
function glowCell(buf: Uint8Array, x: number, y: number, w: number, h: number, color: RGB, intensity: number): void {
  const ix1 = Math.round(x);
  const iy1 = Math.round(y);
  const ix2 = Math.round(x + w);
  const iy2 = Math.round(y + h);
  const iw = Math.max(1, ix2 - ix1);
  const ih = Math.max(1, iy2 - iy1);
  for (let dy = 0; dy < ih; dy++) {
    for (let dx = 0; dx < iw; dx++) {
      glowPixel(buf, ix1 + dx, iy1 + dy, color, intensity);
    }
  }
}

/** Linearly interpolate between two colors. */
export function lerpColor(a: RGB, b: RGB, t: number): RGB {
  const s = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * s),
    Math.round(a[1] + (b[1] - a[1]) * s),
    Math.round(a[2] + (b[2] - a[2]) * s),
  ] as unknown as RGB;
}

// ===== Creature Glow Halo =====

/** Draw elliptical glow halo behind a creature (additive blend). */
function drawCreatureGlow(
  buf: Uint8Array,
  cx: number, cy: number,
  rx: number, ry: number,
  glowColor: RGB,
  intensity = 0.15,
  isLOD = false,
): void {
  // LOD: moderate glow — enough to hint presence without blurring silhouette
  const actualIntensity = isLOD ? intensity * 1.5 : intensity;
  const spread = isLOD ? 1.2 : 1.3;
  const irx = Math.ceil(rx * spread);
  const iry = Math.ceil(ry * spread);
  for (let dy = -iry; dy <= iry; dy++) {
    for (let dx = -irx; dx <= irx; dx++) {
      const dist = Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2);
      if (dist > spread) continue;
      const falloff = (1 - dist / spread) ** 2;
      glowPixel(buf, cx + dx, cy + dy, glowColor, actualIntensity * falloff);
    }
  }
}

// ===== Creature Outline =====

/** 8-directional colored outline around tracked creature pixels. */
function drawCreatureOutline(
  buf: Uint8Array,
  creaturePixels: Set<number>,
  bodyColor: RGB,
  alpha = 0.8,
): void {
  const w = Math.sqrt(buf.length / 3);
  const outlineColor: RGB = [
    Math.round(bodyColor[0] * 0.5),
    Math.round(bodyColor[1] * 0.5),
    Math.round(bodyColor[2] * 0.5),
  ] as unknown as RGB;

  const neighbors = [-1, 0, 1];
  for (const key of creaturePixels) {
    const cx = key % w;
    const cy = Math.floor(key / w);
    for (const ndx of neighbors) {
      for (const ndy of neighbors) {
        if (ndx === 0 && ndy === 0) continue;
        const nx = cx + ndx;
        const ny = cy + ndy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= w) continue;
        if (!creaturePixels.has(ny * w + nx)) {
          blendPixel(buf, nx, ny, outlineColor, alpha);
        }
      }
    }
  }
}

// ===== Octopus Cell Color =====

function getOctopusCellColor(
  cellType: number, state: 'idle' | 'working' | 'sleeping' | 'asking',
  blinkPhase: boolean, isLOD: boolean,
): RGB | null {
  if (cellType === EMPTY) return null;
  if (state === 'sleeping') return COLORS.octopusSleeping;
  switch (cellType) {
    case BODY: return state === 'working' ? COLORS.octopusStarburst : COLORS.octopusBody;
    case EYE:
      return COLORS.octopusEye; // always-on black dot (no blink — consistent 2px vertical)
    case LEFT_ARM: case RIGHT_ARM: return COLORS.octopusArm;
    case LEFT_LEG: case RIGHT_LEG: return COLORS.octopusLeg;
    default: return COLORS.octopusBody;
  }
}

// ===== Crayfish Cell Color =====

function getCrayfishCellColor(cellType: number, routing: boolean, sick = false): RGB | null {
  if (cellType === EMPTY) return null;
  if (sick) {
    // SICK: desaturated, muted colors — gateway error state
    switch (cellType) {
      case EYE: return COLORS.crayfishSick; // eyes drawn as overlay; grid cell = body
      case LEFT_ARM: case RIGHT_ARM: return [0x77, 0x55, 0x55] as unknown as RGB;
      case LEFT_LEG: case RIGHT_LEG: return [0x77, 0x55, 0x55] as unknown as RGB;
      case ANTENNA: return [0x88, 0x66, 0x66] as unknown as RGB;
      default: return COLORS.crayfishSick;
    }
  }
  const bodyColor = routing ? COLORS.crayfishRouting : COLORS.crayfishBody;
  switch (cellType) {
    case BODY: return bodyColor;
    case EYE: return bodyColor; // eyes drawn as fixed 3×3 overlay after grid
    case LEFT_ARM: case RIGHT_ARM: return COLORS.crayfishClaw;
    case LEFT_LEG: case RIGHT_LEG: return COLORS.crayfishLeg;
    case ANTENNA: return COLORS.crayfishAntenna;
    default: return bodyColor;
  }
}

// ===== Animation Helpers =====

/** Ensure animation offset has at least `minPx` magnitude when non-zero. */
function ensureMinAmplitude(value: number, minPx: number): number {
  if (Math.abs(value) < 0.01) return 0; // truly zero → stay zero
  const rounded = Math.round(value);
  if (rounded === 0) return value > 0 ? minPx : -minPx;
  return rounded;
}

// ===== Scaled Creature Renderers (camera-aware) =====

/**
 * Draw octopus — LED pixel art style (square pixels, no outline/glow).
 *
 * LED pixels glow naturally — no artificial outline or glow needed.
 * Eyes rendered as negative space (black pixels within body).
 * Body stays fixed; only arms and tentacles animate.
 */
export function drawOctopus(
  buf: Uint8Array,
  worldX: number, worldY: number,
  state: 'idle' | 'working' | 'sleeping' | 'asking',
  animFrame: number,
  cam: Camera,
  palette: OctopusPalette = getOctopusPaletteForSession(1),
): void {
  if (!isVisible(worldX, worldY, cam, 0.15)) return;

  const [scx, scy] = worldToScreen(worldX, worldY, cam);
  const w = Math.sqrt(buf.length / 3);

  // LOD selection
  const select = selectGrid(
    cam.zoom, w,
    OCTOPUS_GRID_HD, OCTO_HD_COLS, OCTO_HD_ROWS,
    OCTOPUS_GRID_MD, OCTO_GRID_MD_COLS, OCTO_GRID_MD_ROWS,
    OCTOPUS_LOD, OCTO_LOD_COLS, OCTO_LOD_ROWS
  );
  const grid = select.grid;
  const cols = select.cols;
  const rows = select.rows;

  // Resolution-aware cell size — sprite spans a fixed fraction of (zoom × output width),
  // so it scales down on the 32px iDotMatrix instead of overflowing the frame.
  const cellSz = creatureCellSize(cam.zoom, w, cols);
  const spriteW = cols * cellSz;
  const spriteH = rows * cellSz;

  // Snap the sprite origin to whole pixels. The cells tile from this origin via
  // round(base + col*cellSz); if `base` is fractional, a swimming creature's
  // sub-pixel screen drift shifts the rounding phase every frame, so each cell
  // oscillates ±1px (shimmer). On the small high-contrast eye holes that reads
  // as the eyes "breaking up" while the octopus moves. Rounding the origin makes
  // the cell pattern frame-stable (only an integer translation changes), so the
  // creature moves in clean 1px steps with rock-steady eyes.
  const baseX = Math.round(scx - spriteW / 2);
  const baseY = Math.round(scy - spriteH / 2);

  // Working: gentle vertical bob (scaled by cellSz)
  const breathPx = state === 'working'
    ? Math.round(Math.sin(animFrame * 0.3) * cellSz * 1.5)
    : 0;

  // Body color by state
  const bodyColor = state === 'working' ? palette.starburst
    : state === 'sleeping' ? palette.sleeping
      : palette.body;

  // Track drawn pixels for outline generation
  const trackedPixels = new Set<number>();

  // Draw all cells
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cellType = grid[row][col];
      if (cellType === EMPTY) continue;

      // Cell color — arms same as body (unified silhouette), eyes = negative space
      let color: RGB;
      if (cellType === EYE) {
        color = COLORS.octopusEye; // black — negative space
      } else if (cellType === LEFT_ARM || cellType === RIGHT_ARM) {
        color = state === 'working' ? palette.starburst : palette.arm;
      } else if (cellType === LEFT_LEG || cellType === RIGHT_LEG) {
        color = palette.leg;
      } else {
        color = bodyColor;
      }

      // Tentacle animation only — arms stay fixed (attached to body)
      let dx = 0;
      if (state !== 'sleeping' && (cellType === LEFT_LEG || cellType === RIGHT_LEG)) {
        dx = Math.round(Math.sin(animFrame * 0.2 + col * 1.8) * cellSz * 1.5);
      }

      fillCellTracked(buf,
        baseX + col * cellSz + dx,
        baseY + row * cellSz + breathPx,
        cellSz, cellSz, color, trackedPixels
      );
    }
  }

  // Draw outline to separate octopus from blue water (matches crayfish style)
  drawCreatureOutline(buf, trackedPixels, bodyColor, 0.8);

  // "?" bubble when asking
  if (state === 'asking') {
    const bobY = Math.round(Math.sin(animFrame * 0.25));
    const bx = scx;
    const by = baseY - Math.round(cellSz * 3) + bobY;
    const r = 3;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r) {
          blendPixel(buf, bx + dx, by + dy, COLORS.white, 0.7);
        }
      }
    }
    const qx = Math.round(bx);
    const qy = Math.round(by);
    setPixel(buf, qx + 1, qy - Math.round(r * 0.4), COLORS.stateAwaiting);
    setPixel(buf, qx + 1, qy - Math.round(r * 0.2), COLORS.stateAwaiting);
    setPixel(buf, qx, qy, COLORS.stateAwaiting);
    setPixel(buf, qx, qy + Math.max(1, Math.round(r * 0.35)), COLORS.stateAwaiting);
  }

  // Starburst particles when working
  if (state === 'working') {
    const sparkPhase = animFrame * 0.35;
    const dist = (5 + Math.sin(animFrame * 0.25) * 3) * cellSz;
    for (let i = 0; i < 6; i++) {
      const angle = sparkPhase + (i * Math.PI * 2 / 6);
      const sx = scx + Math.cos(angle) * dist;
      const sy = scy + breathPx + Math.sin(angle) * dist * 0.6;
      setPixel(buf, Math.round(sx), Math.round(sy), palette.starburst);
    }
  }
}

/**
 * Draw jellyfish — Codex CLI cloud creature (6-lobe clover, indigo).
 *
 * LED pixel art style matching octopus approach.
 * Bell pulse: edge cells contract/expand rhythmically.
 * >_ marking blinks subtly. Bioluminescent glow when processing.
 */
export function drawJellyfish(
  buf: Uint8Array,
  worldX: number, worldY: number,
  state: 'idle' | 'working' | 'sleeping' | 'asking',
  animFrame: number,
  cam: Camera,
  palette: JellyfishPalette = getJellyfishPaletteForSession(1),
): void {
  if (!isVisible(worldX, worldY, cam, 0.15)) return;

  const [scx, scy] = worldToScreen(worldX, worldY, cam);
  const w = Math.sqrt(buf.length / 3);

  // LOD selection
  const select = selectGrid(
    cam.zoom, w,
    JELLYFISH_GRID_HD, JF_HD_COLS, JF_HD_ROWS,
    JELLYFISH_GRID_MD, JF_GRID_MD_COLS, JF_GRID_MD_ROWS,
    JELLYFISH_LOD, JF_LOD_COLS, JF_LOD_ROWS
  );
  const grid = select.grid;
  const cols = select.cols;
  const rows = select.rows;

  // Resolution-aware cell size (see creatureCellSize) — scales with output width.
  const cellSz = creatureCellSize(cam.zoom, w, cols);
  const spriteW = cols * cellSz;
  const spriteH = rows * cellSz;

  const baseX = scx - spriteW / 2;
  const baseY = scy - spriteH / 2;

  // Bell pulse: contraction/expansion
  const pulseSpeed = state === 'working' ? 0.25 : 0.06;
  const pulsePhase = Math.sin(animFrame * pulseSpeed);
  const contracting = pulsePhase < 0;

  // Vertical bob when working (scaled by cellSz)
  const breathPx = state === 'working'
    ? Math.round(Math.sin(animFrame * 0.3) * cellSz * 1.5)
    : 0;

  // Bioluminescent body color pulse when working
  const bodyColor = state === 'working'
    ? lerpColor(palette.body, palette.pulse, 0.18 + ((Math.sin(animFrame * 0.2) + 1) * 0.18))
    : state === 'sleeping' ? palette.sleeping
      : palette.body;

  // >_ marking blink
  const markingVisible = (animFrame % 60) > 5;

  // Draw all cells
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cellType = grid[row][col];
      if (cellType === EMPTY) continue;

      // Breathe edge: hide when contracting
      if (cellType === BREATHE_EDGE) {
        if (contracting) continue;
        fillCell(buf,
          baseX + col * cellSz,
          baseY + row * cellSz + breathPx,
          cellSz, cellSz, palette.edge,
        );
        continue;
      }

      // >_ marking: blink
      if (cellType === MARKING) {
        if (!markingVisible) {
          // Show body color when marking hidden
          fillCell(buf,
            baseX + col * cellSz,
            baseY + row * cellSz + breathPx,
            cellSz, cellSz, bodyColor,
          );
          continue;
        }
        fillCell(buf,
          baseX + col * cellSz,
          baseY + row * cellSz + breathPx,
          cellSz, cellSz, palette.marking,
        );
        continue;
      }

      // Body cell
      fillCell(buf,
        baseX + col * cellSz,
        baseY + row * cellSz + breathPx,
        cellSz, cellSz, bodyColor,
      );
    }
  }

  // "?" bubble when asking
  if (state === 'asking') {
    const bobY = Math.round(Math.sin(animFrame * 0.25));
    const bx = scx;
    const by = baseY - Math.round(cellSz * 3) + bobY;
    const r = 3;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r) {
          blendPixel(buf, bx + dx, by + dy, COLORS.white, 0.7);
        }
      }
    }
    const qx = Math.round(bx);
    const qy = Math.round(by);
    setPixel(buf, qx + 1, qy - Math.round(r * 0.4), COLORS.stateAwaiting);
    setPixel(buf, qx + 1, qy - Math.round(r * 0.2), COLORS.stateAwaiting);
    setPixel(buf, qx, qy, COLORS.stateAwaiting);
    setPixel(buf, qx, qy + Math.max(1, Math.round(r * 0.35)), COLORS.stateAwaiting);
  }

  // Orbiting glow particles when working (bioluminescent)
  if (state === 'working') {
    const orbitPhase = animFrame * 0.2;
    const dist = (5 + Math.sin(animFrame * 0.15) * 2) * cellSz;
    for (let i = 0; i < 4; i++) {
      const angle = orbitPhase + (i * Math.PI * 2 / 4);
      const sx = scx + Math.cos(angle) * dist;
      const sy = scy + breathPx + Math.sin(angle) * dist * 0.6;
      setPixel(buf, Math.round(sx), Math.round(sy), palette.pulse);
    }
  }
}

// ===== OpenCode — nested-square logo (simulator SSOT) =====

export function drawOpenCode(
  buf: Uint8Array,
  worldX: number,
  worldY: number,
  state: 'idle' | 'working' | 'sleeping' | 'asking',
  animFrame: number,
  camera: Camera,
  palette: OpenCodePalette,
): void {
  const w = Math.sqrt(buf.length / 3);
  const [scx, scy] = worldToScreen(worldX, worldY, camera);

  // Canonical opencode mark: a single-color vertical rectangular RING (16:20) with a
  // HOLLOW center — drawn procedurally so it scales cleanly to any panel (64px, 32px,
  // iDotMatrix) instead of grid sprites that overflowed 32px or drew a filled shadow.
  const worldW = 10 / 64;
  const unit = Math.max(1, Math.round((worldW * camera.zoom * w) / OC_GRID_MD_COLS));
  const outerW = Math.max(5, 6 * unit);
  const outerH = Math.max(6, Math.round(outerW * 1.25)); // slightly tall (16:20)
  const thick = Math.max(1, Math.round(outerW * 0.28));   // frame thickness ~ brand 4/16

  const breathPx = state === 'working'
    ? Math.round(Math.sin(animFrame * 0.3) * 1.5)
    : state === 'idle' ? Math.round(Math.sin(animFrame * 0.08) * 0.7) : 0;

  const color = state === 'working'
    ? lerpColor(palette.outer, palette.pulse, 0.5 + Math.sin(animFrame * 0.2) * 0.5)
    : state === 'sleeping' ? palette.sleeping : palette.outer;

  const x0 = scx - Math.round(outerW / 2);
  const y0 = scy + breathPx - Math.round(outerH / 2);
  for (let dy = 0; dy < outerH; dy++) {
    for (let dx = 0; dx < outerW; dx++) {
      const onFrame = dx < thick || dx >= outerW - thick || dy < thick || dy >= outerH - thick;
      if (!onFrame) continue; // hollow center
      setPixel(buf, x0 + dx, y0 + dy, color);
    }
  }

  if (state === 'asking') {
    // Amber three-dot asking indicator above the mark
    const dotCx = scx + Math.round(outerW / 2) + 3;
    const dotCy = y0 - 2 + Math.round(Math.sin(animFrame * 0.26) * 1.4);
    for (let i = -1; i <= 1; i++) {
      blendPixel(buf, dotCx + i * 3, dotCy, COLORS.stateAwaiting, 0.75);
      blendPixel(buf, dotCx + i * 3 + 1, dotCy, COLORS.stateAwaiting, 0.45);
    }
  }
}

function antigravityCellColor(ch: string, palette: AntigravityPalette): RGB | null {
  switch (ch) {
    case 'L': return palette.lime;
    case 'T': return palette.teal;
    case 'Q': return palette.cyan;
    case 'Y': return palette.yellow;
    case 'O': return palette.orange;
    case 'R': return palette.red;
    case 'P': return palette.pink;
    case 'V': return palette.violet;
    case 'U': return palette.blue;
    case 'N': return palette.sky;
    case 'K': return palette.cutout;
    default: return null;
  }
}

function drawQuestionMark(buf: Uint8Array, x: number, y: number, color: RGB): void {
  setPixel(buf, x, y, color);
  setPixel(buf, x + 1, y, color);
  setPixel(buf, x + 1, y + 1, color);
  setPixel(buf, x, y + 2, color);
  setPixel(buf, x, y + 4, color);
}

/**
 * Awaiting affordance: a soft white disc with an amber "?" on top.
 *
 * (centerX, centerY) is the CENTER of the disc. The disc is the backing that
 * keeps the mark legible against mid-water blues; the glyph is the 5-pixel
 * question mark above, which is the smallest form that still reads as "?"
 * rather than as noise.
 *
 * Mirror of `drawQuestionBubble` in apple/AgentDeck/Daemon/Modules/PixooRenderer.swift —
 * keep the radius, alpha, and glyph offsets identical.
 */
export function drawQuestionBubble(buf: Uint8Array, centerX: number, centerY: number): void {
  const r = 3;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r) blendPixel(buf, centerX + dx, centerY + dy, COLORS.white, 0.7);
    }
  }
  // 5-px "?" centered in the disc — every pixel stays inside radius 3.
  drawQuestionMark(buf, centerX, centerY - 2, COLORS.stateAwaiting);
}

/**
 * Draw a canonical agent mark rasterized from design/brand/*.svg.
 *
 * Pixoo64 and iDotMatrix used to maintain independent hand-drawn creature grids;
 * the Swift daemon carried another copy. That made the smallest panels look like
 * approximations of the agents while vector/e-ink surfaces showed their real marks.
 * This renderer consumes the generated 24×24 alpha masks so both daemon families
 * preserve the official silhouette and cutouts. State remains a motion/color layer
 * around the mark, never a geometry rewrite.
 */
export function drawOfficialDotGlyph(
  buf: Uint8Array,
  glyph: OfficialDotGlyphName,
  worldX: number,
  worldY: number,
  state: 'idle' | 'working' | 'sleeping' | 'asking',
  animFrame: number,
  camera: Camera,
  sessionToneIndex = 0,
  sizeScale = 1.0,
  sick = false,
): void {
  if (!isVisible(worldX, worldY, camera, 0.15)) return;
  const [scx, scy] = worldToScreen(worldX, worldY, camera);
  const canvasW = Math.sqrt(buf.length / 3);
  // The 8px floor is the legibility limit of the official mask — a crowd shrink
  // is allowed to reach it but never to go under it and turn a brand mark into mush.
  const target = Math.max(8, Math.round(0.1875 * sizeScale * camera.zoom * canvasW));
  const bob = state === 'working' ? Math.round(Math.sin(animFrame * 0.28) * Math.max(1, target / 14)) : 0;
  const x0 = Math.round(scx - target / 2);
  const y0 = Math.round(scy - target / 2) + bob;
  const mask = OFFICIAL_DOT_GLYPHS[glyph];

  const octopus = getOctopusPaletteForSession(sessionToneIndex);
  const codex = getJellyfishPaletteForSession(sessionToneIndex);
  const openCode = getOpenCodePaletteForSession(sessionToneIndex);
  const processingPulse = 0.28 + 0.18 * ((Math.sin(animFrame * 0.2) + 1) / 2);

  const solidColor = (): RGB => {
    if (sick) return COLORS.crayfishSick;
    switch (glyph) {
      case 'claudeCode':
        return state === 'working' ? octopus.starburst : state === 'sleeping' ? octopus.sleeping : octopus.body;
      case 'codex':
        return state === 'working' ? lerpColor(codex.body, codex.pulse, processingPulse) : state === 'sleeping' ? codex.sleeping : codex.body;
      case 'openCode':
        return state === 'working' ? lerpColor(openCode.outer, openCode.pulse, processingPulse) : state === 'sleeping' ? openCode.sleeping : openCode.outer;
      case 'openClaw': {
        const base = state === 'working' ? COLORS.crayfishRouting : COLORS.crayfishBody;
        return sick ? COLORS.crayfishSick : base;
      }
      case 'antigravity':
        return COLORS.white;
    }
  };
  const base = solidColor();

  for (let dy = 0; dy < target; dy++) {
    const sy = Math.min(OFFICIAL_DOT_GLYPH_SIZE - 1, Math.floor(dy * OFFICIAL_DOT_GLYPH_SIZE / target));
    for (let dx = 0; dx < target; dx++) {
      const sx = Math.min(OFFICIAL_DOT_GLYPH_SIZE - 1, Math.floor(dx * OFFICIAL_DOT_GLYPH_SIZE / target));
      const alpha = mask[sy * OFFICIAL_DOT_GLYPH_SIZE + sx] / 255;
      if (alpha <= 0.02) continue;
      let color = base;
      if (glyph === 'antigravity') {
        const t = sx / (OFFICIAL_DOT_GLYPH_SIZE - 1);
        color = t < 0.25 ? lerpColor([0x5c, 0xd6, 0x4d], [0xf5, 0xcb, 0x24], t * 4)
          : t < 0.55 ? lerpColor([0xf5, 0xcb, 0x24], [0xff, 0x52, 0x41], (t - 0.25) / 0.3)
            : t < 0.78 ? lerpColor([0xff, 0x52, 0x41], [0xb7, 0x5c, 0xb6], (t - 0.55) / 0.23)
              : lerpColor([0xb7, 0x5c, 0xb6], [0x24, 0x7e, 0xff], (t - 0.78) / 0.22);
      }
      blendPixel(buf, x0 + dx, y0 + dy, color, alpha);
    }
  }

  // OpenClaw's official mark has eye cutouts too small to survive every 32px
  // camera position. Re-light the canonical eye coordinates without changing
  // the silhouette so the hardware keeps its teal OpenClaw signature.
  if (glyph === 'openClaw' && !sick) {
    const eye: RGB = COLORS.crayfishEye;
    for (const [vx, vy] of [[9.05, 7.63], [15.38, 7.63]] as const) {
      setPixel(buf, x0 + Math.round(vx / 24 * target), y0 + Math.round(vy / 24 * target), eye);
    }
  }

  if (state === 'asking') {
    drawQuestionBubble(buf, x0 + target + 1, y0);
  } else if (state === 'working') {
    const sparkle = glyph === 'antigravity' ? [0xff, 0xd8, 0x50] as RGB : lerpColor(base, COLORS.white, 0.45);
    for (let i = 0; i < 4; i++) {
      const angle = animFrame * 0.22 + i * Math.PI / 2;
      const distance = target / 2 + 2;
      setPixel(buf, Math.round(scx + Math.cos(angle) * distance), Math.round(scy + bob + Math.sin(angle) * distance), sparkle);
    }
  }
}

export function drawAntigravity(
  buf: Uint8Array,
  worldX: number,
  worldY: number,
  state: 'idle' | 'working' | 'sleeping' | 'asking',
  animFrame: number,
  camera: Camera,
  palette: AntigravityPalette,
): void {
  if (!isVisible(worldX, worldY, camera, 0.15)) return;

  const [scx, scy] = worldToScreen(worldX, worldY, camera);
  const w = Math.sqrt(buf.length / 3);
  const cellSz = creatureCellSize(camera.zoom, w, AG_COLS);
  const spriteW = AG_COLS * cellSz;
  const spriteH = AG_ROWS * cellSz;
  const breathPx = state === 'working'
    ? Math.round(Math.sin(animFrame * 0.28) * cellSz)
    : state === 'idle' ? Math.round(Math.sin(animFrame * 0.08) * 0.5) : 0;
  const cameraNudgeX = state === 'working' && ((animFrame >> 3) & 1) ? cellSz : 0;
  const cameraNudgeY = state !== 'idle' && ((animFrame >> 2) & 1) ? -cellSz : 0;
  const baseX = Math.round(scx - spriteW / 2) + cameraNudgeX;
  const baseY = Math.round(scy - spriteH / 2) + breathPx + cameraNudgeY;

  const trackedPixels = new Set<number>();
  for (let row = 0; row < AG_ROWS; row++) {
    const line = ANTIGRAVITY_GRID[row];
    for (let col = 0; col < AG_COLS; col++) {
      const color = antigravityCellColor(line[col], palette);
      if (!color) continue;
      fillCellTracked(buf, baseX + col * cellSz, baseY + row * cellSz, cellSz, cellSz, color, trackedPixels);
    }
  }

  drawCreatureOutline(buf, trackedPixels, palette.violet, 0.45);

  if (state === 'asking') {
    drawQuestionMark(buf, Math.round(scx + spriteW * 0.48), Math.round(baseY + spriteH * 0.18), COLORS.stateAwaiting);
  }

  if (state === 'working') {
    const sparkle = lerpColor(palette.yellow, COLORS.white, 0.35);
    const dist = Math.max(2, cellSz * 3);
    for (let i = 0; i < 4; i++) {
      const t = animFrame * 0.22 + i * Math.PI / 2;
      setPixel(buf, Math.round(scx + Math.cos(t) * dist), Math.round(baseY - 1 + Math.sin(t) * dist * 0.35), sparkle);
    }
  }
}

/**
 * Draw crayfish scaled by camera zoom.
 * @param worldX  Crayfish center in normalized world X (0~1)
 * @param worldY  Crayfish center in normalized world Y (0~1)
 */
export function drawCrayfish(
  buf: Uint8Array,
  worldX: number, worldY: number,
  routing: boolean,
  animFrame: number,
  cam: Camera,
  sick = false,
): void {
  if (!isVisible(worldX, worldY, cam, 0.15)) return;

  const [scx, scy] = worldToScreen(worldX, worldY, cam);
  const w = Math.sqrt(buf.length / 3);

  // LOD selection — matches octopus threshold
  const select = selectGrid(
    cam.zoom, w,
    CRAYFISH_GRID_HD, CF_HD_COLS, CF_HD_ROWS,
    CRAYFISH_GRID_MD, CF_GRID_MD_COLS, CF_GRID_MD_ROWS,
    CRAYFISH_LOD, CF_LOD_COLS, CF_LOD_ROWS
  );
  const grid = select.grid;
  const cols = select.cols;
  const rows = select.rows;

  // Resolution-aware square cells (see creatureCellSize). Square (cellH = cellW) — the old
  // cellH = cellW*1.5 stretched the round OpenClaw body into a tall pointed shape.
  const cellW = creatureCellSize(cam.zoom, w, cols);
  const cellH = cellW;
  const spriteW = cols * cellW;
  const spriteH = rows * cellH;
  const baseX = scx - spriteW / 2;
  const baseY = scy - spriteH / 2;

  // SICK: suppress breathing, no heartbeat
  // Composite breathing — asymmetric (slow inhale, quick exhale)
  const breathRaw = sick ? 0 : Math.pow(Math.abs(Math.sin(animFrame * 0.15)), 0.7)
    * Math.sign(Math.sin(animFrame * 0.15));
  const breathPx = sick ? 0 : ensureMinAmplitude(breathRaw * cellH * 0.5, 1);

  // Heartbeat glow (time-based for consistent 4s period regardless of frame step)
  const heartPhase = (animFrame * 0.075) % (Math.PI * 2);
  const beat1 = Math.max(0, Math.sin(heartPhase * 2) * 0.8);
  const beat2 = Math.max(0, Math.sin(heartPhase * 2 + 1.2) * 0.5);
  const heartGlow = sick ? 0 : Math.max(beat1, beat2);

  // 1. Glow halo (before creature — stronger for LOD)
  const glowRx = spriteW / 2 + 2;
  const glowRy = spriteH / 2 + 2;
  drawCreatureGlow(buf, scx, scy + breathPx, glowRx, glowRy, COLORS.crayfishGlow, 0.12, cols === 8);

  // 2. Draw cells with pixel tracking
  const trackedPixels = new Set<number>();

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cellType = grid[row][col];
      const color = getCrayfishCellColor(cellType, routing, sick);
      if (!color) continue;

      let dx = 0;
      const dy = breathPx;

      if (!sick) {
        // Antenna wiggle — with occasional twitch
        if (cellType === ANTENNA) {
          const spd = routing ? 0.35 : 0.15;
          const wiggle = Math.sin(animFrame * spd + col * 3) * cellW * 1.5;
          // Random-ish twitch: sharp spike every ~30 frames
          const twitch = ((animFrame + col * 17) % 60) < 4 ? cellW * 2 * (col < cols / 2 ? -1 : 1) : 0;
          dx = ensureMinAmplitude(wiggle + twitch, 1);
        }

        // Claw animation — routing: slower, wider clap; idle: gentle sway
        if (cellType === LEFT_ARM || cellType === RIGHT_ARM) {
          if (routing) {
            const clap = Math.sin(animFrame * 0.3) * cellW * 3; // slower + wider
            dx = ensureMinAmplitude(cellType === LEFT_ARM ? clap : -clap, 1);
          } else {
            const gentle = Math.sin(animFrame * 0.125) * cellW;
            dx = ensureMinAmplitude(cellType === LEFT_ARM ? gentle : -gentle, 1);
          }
        }

        // Leg shift — larger amplitude for visibility
        if (cellType === LEFT_LEG || cellType === RIGHT_LEG) {
          dx = ensureMinAmplitude(
            Math.sin(animFrame * 0.1 + (cellType === LEFT_LEG ? 0 : Math.PI)) * cellW * 1.2, 1
          );
        }
      } else {
        // SICK: tilt — left side up, right side down (droopy posture)
        const tiltPx = (col - cols / 2) * 0.15;
        dx = col < cols / 2 ? 1 : -1; // slight inward collapse
        fillCellTracked(buf,
          baseX + col * cellW + dx,
          baseY + row * cellH + dy + tiltPx,
          cellW, cellH, color, trackedPixels,
        );
        continue;
      }

      fillCellTracked(buf,
        baseX + col * cellW + dx,
        baseY + row * cellH + dy,
        cellW, cellH, color, trackedPixels,
      );
    }
  }

  // 3. Colored outline — moderate alpha for LOD
  const bodyColor = routing ? COLORS.crayfishRouting : COLORS.crayfishBody;
  const outlineAlpha = cols === 8 ? 0.6 : 0.8;
  drawCreatureOutline(buf, trackedPixels, bodyColor, outlineAlpha);

  // Fixed 3×3 eyes (teal center + black ring) — drawn at grid eye positions
  const eyeRow = cols === 24 ? 9 : (cols === 8 ? 2 : 3);
  const eyeCols = cols === 24 ? [8, 14] : (cols === 8 ? [2, 5] : [4, 7]);
  const sickEyeCenter: RGB = [0x44, 0x66, 0x60] as unknown as RGB; // dim teal for sick
  const eyeCenter = sick ? sickEyeCenter : COLORS.crayfishEye;
  const eyeRing = sick ? ([0x44, 0x33, 0x33] as unknown as RGB) : COLORS.crayfishEyeRing;
  for (const ec of eyeCols) {
    const ex = Math.round(baseX + (ec + 0.5) * cellW);
    const ey = Math.round(baseY + (eyeRow + 0.5) * cellH + breathPx);
    // Black surround (8 neighbors)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        setPixel(buf, ex + dx, ey + dy, eyeRing);
      }
    }
    // Teal center
    setPixel(buf, ex, ey, eyeCenter);
  }

  // Routing: signal wave particles (after outline)
  if (routing) {
    const wavePhase = animFrame * 0.3;
    for (let i = 0; i < 4; i++) {
      const angle = wavePhase + (i * Math.PI / 2);
      const dist = (4 + Math.sin(animFrame * 0.2 + i)) * cellW;
      const sx = scx + Math.cos(angle) * dist;
      const sy = scy + breathPx + Math.sin(angle) * dist * 0.5;
      glowCell(buf, sx, sy, cellW, cellW, COLORS.crayfishEye, 0.4);
    }

    // Body glow pulse
    const bodyPulse = (Math.sin(animFrame * 0.25) + 1) * 0.15;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (grid[row]?.[col] !== EMPTY) {
          glowCell(buf,
            baseX + col * cellW, baseY + row * cellH + breathPx,
            cellW, cellH, COLORS.crayfishRouting, bodyPulse,
          );
        }
      }
    }
  }
}

/**
 * Draw a scaled neon tetra.
 * At zoom 1.0: ~4 screen pixels. At zoom 2.0: ~8 screen pixels.
 */
export function drawTetra(
  buf: Uint8Array,
  worldX: number, worldY: number,
  heading: number,
  cam: Camera,
): void {
  if (!isVisible(worldX, worldY, cam, 0.08)) return;

  const [sx, sy] = worldToScreen(worldX, worldY, cam);
  const w = Math.sqrt(buf.length / 3);
  const px = cam.zoom * (w / 64); // resolution-aware pixel scale (half-size on 32px iDotMatrix)

  // Body (2px-equivalent)
  const bw = Math.max(1, Math.round(px * 2));
  const bh = Math.max(1, Math.round(px));
  fillCell(buf, sx, sy, bw, bh, COLORS.tetraBody);

  // Neon stripe (1px behind body)
  const stripeX = heading > 0 ? sx - Math.round(px) : sx + Math.round(px * 2);
  fillCell(buf, stripeX, sy, Math.max(1, Math.round(px)), bh, COLORS.tetraNeon);

  // Tail fin
  const finX = heading > 0 ? stripeX - Math.max(1, Math.round(px * 0.5)) : stripeX + Math.max(1, Math.round(px));
  fillCell(buf, finX, sy, Math.max(1, Math.round(px * 0.5)), bh, COLORS.tetraFin);
}

// ===== Legacy World-Buffer Renderers (used for environment-embedded drawing) =====

/** Draw a tetra at pixel coordinates (for world buffer, zoom-unaware). */
export function drawTetraWorld(
  buf: Uint8Array, x: number, y: number, heading: number
): void {
  setPixel(buf, x, y, COLORS.tetraBody);
  const tailX = heading > 0 ? x - 1 : x + 1;
  setPixel(buf, tailX, y, COLORS.tetraNeon);
}

// ===== 3×5 Pixel Font + HUD Helpers =====

/**
 * 3×5 bitmask font for HUD numerals.
 * Each glyph is 5 rows of 3 bits (MSB = left pixel).
 */
const PIXEL_FONT: Record<string, number[]> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b001, 0b001, 0b001],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  '%': [0b101, 0b001, 0b010, 0b100, 0b101],
  '/': [0b001, 0b001, 0b010, 0b100, 0b100],
  'h': [0b100, 0b100, 0b111, 0b101, 0b101],
  'm': [0b101, 0b111, 0b101, 0b101, 0b101],  // two pillars joined — distinct from 'n'
  'd': [0b001, 0b001, 0b011, 0b101, 0b011],  // lowercase d — for day units (e.g. "6d22h")
  ' ': [0b000, 0b000, 0b000, 0b000, 0b000],
  // Uppercase initials for scoped per-model quota rows. The OAuth usage payload
  // carves weekly sub-limits by model display name (Fable, Opus, Sonnet,
  // Cowork); the HUD dock shows the first letter where a provider row would
  // show its official mark. Unlisted letters fall back to a solid chip.
  'C': [0b111, 0b100, 0b100, 0b100, 0b111],
  'F': [0b111, 0b100, 0b110, 0b100, 0b100],
  'O': [0b111, 0b101, 0b101, 0b101, 0b111],
  'S': [0b111, 0b100, 0b111, 0b001, 0b111],
};

/** True when the 3×5 font can render every character of `text`. */
export function fontCanRender(text: string): boolean {
  for (const ch of text) if (!PIXEL_FONT[ch]) return false;
  return true;
}

/** Draw right-aligned text using 3×5 pixel font. */
export function drawText(
  buf: Uint8Array, text: string, rightX: number, y: number, color: RGB,
): void {
  let cursorX = rightX;
  // Render right-to-left
  for (let ci = text.length - 1; ci >= 0; ci--) {
    const glyph = PIXEL_FONT[text[ci]];
    if (!glyph) { cursorX -= 2; continue; } // unknown char = 1px gap
    cursorX -= 3; // glyph width
    for (let row = 0; row < 5; row++) {
      const bits = glyph[row];
      for (let col = 0; col < 3; col++) {
        if (bits & (1 << (2 - col))) {
          setPixel(buf, cursorX + col, y + row, color);
        }
      }
    }
    cursorX -= 1; // 1px kerning gap
  }
}

/** Draw a horizontal gauge bar. */
export function drawGaugeBar(
  buf: Uint8Array, x: number, y: number,
  width: number, height: number,
  percent: number, color: RGB, bgColor: RGB,
): void {
  const filled = Math.round(width * Math.max(0, Math.min(1, percent / 100)));
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      setPixel(buf, x + dx, y + dy, dx < filled ? color : bgColor);
    }
  }
}
