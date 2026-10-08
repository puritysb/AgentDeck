/**
 * Pixoo64 "Tide" scene — an animation drawn for a 64×64 LED matrix fed over an
 * embedded HTTP server, not a downscaled aquarium.
 *
 * What the panel is bad at, and what that decided:
 *   - Fine detail and dark gradients turn to mush on LEDs, so the water is a
 *     handful of flat depth bands (dithered at the seams) and every moving
 *     thing is a bold, high-contrast shape. The official 24×24 agent masks are
 *     drawn at their native size instead of a ~58 px zoom that filled the panel.
 *   - Every frame costs one HTTP request and the device shows its loading
 *     hourglass while it ingests an upload, so the scene is ONE short closed
 *     loop the device plays by itself (`TIDE_LOOP`), uploaded when something
 *     visible changed and otherwise left alone (see pixoo-bridge's tide policy).
 *
 * The loop must close: every animated value is a function of `tick / frames`
 * that returns to its start on frame `frames`, and nothing uses `Math.random`
 * (a renderer's output is used as identity — see the "baked animation loop must
 * close" rule in .claude/rules/devices-and-wire.md). The usage HUD at the bottom
 * is the existing `drawUsageHUD`, untouched.
 */

import { TERRARIUM_RULES, foldCodexSessionsForDisplay, hasOpenClawSession } from '@agentdeck/shared';
import type { SessionInfo } from '@agentdeck/shared/protocol';
import type { StateUpdateEvent, UsageEvent } from '../types.js';
import { OFFICIAL_DOT_GLYPHS, OFFICIAL_DOT_GLYPH_SIZE, type OfficialDotGlyphName } from './official-dot-glyphs.generated.js';
import {
  type RGB, setPixel, blendPixel, glowPixel, drawOfficialDotGlyph, drawText,
} from './pixoo-sprites.js';
import type { Camera } from './pixoo-camera.js';
import {
  drawUsageHUD, drawCiCue, getUsageProviderCount, isCreatureAgent, creatureTypeFor, mapSessionState,
  type CiCueAnchor,
} from './pixoo-renderer.js';

/**
 * One closed loop: 6 frames × 500 ms = 3 s. Measured on the Pixoo64 (2026-10-08):
 * an upload takes ~0.27 s per frame (12 frames = 3.2 s, 8 = 2.1 s, 6 = 1.6 s) and
 * the panel shows its loading hourglass for that ingest, so the loop is as short
 * as the motion still reads as smooth.
 */
export const TIDE_LOOP = { frames: 6, picSpeedMs: 500 } as const;

const SIZE = 64;
const WATER_TOP = 5;
const FLOOR_ROWS = 4;
const MAX_MARKS = 4;

export type TideState = 'idle' | 'processing' | 'awaiting';
export interface TideMark {
  id: string;
  glyph: OfficialDotGlyphName;
  state: TideState;
  /** Gateway error on the OpenClaw mark (desaturated, as the aquarium does). */
  sick: boolean;
}

// ===== Palette (flat, saturated, LED-readable) =====

const AIR: RGB = [6, 18, 32];
const BANDS: readonly RGB[] = [
  [30, 138, 178], [24, 116, 160], [18, 92, 140], [13, 70, 116], [9, 51, 94], [6, 36, 70],
];
const CREST: RGB = [176, 242, 255];
const CREST_BODY: RGB = [74, 184, 218];
const SAND_TOP: RGB = [214, 176, 110];
const SAND: RGB = [168, 132, 78];
const PEBBLE: RGB = [118, 92, 56];
const WEED: RGB = [34, 168, 92];
const WEED_TIP: RGB = [76, 208, 124];
const BUBBLE: RGB = [220, 245, 255];
const FISH_BODY: RGB = [96, 224, 238];
const FISH_TAIL: RGB = [255, 112, 82];
const AMBER: RGB = [255, 176, 32];
const WHITE: RGB = [255, 255, 255];
const TEXT: RGB = [200, 230, 240];

const TAU = Math.PI * 2;

// ===== Which marks are on the panel =====

const GLYPH_FOR = {
  octopus: 'claudeCode', jellyfish: 'codex', opencode: 'openCode',
  antigravity: 'antigravity', kiro: 'kiro', hermes: 'hermes', crayfish: 'openClaw',
} as const;

/** Sessions → the marks to draw, loudest first, with the count that did not fit. */
export function resolveTideMarks(
  stateEvent: StateUpdateEvent | null,
  sessions: SessionInfo[] | null,
): { marks: TideMark[]; overflow: number } {
  const all: TideMark[] = [];
  if (sessions) {
    // Codex rows fold by project first, exactly like the aquarium: one workspace
    // must not light up several cloud marks at once.
    for (const s of foldCodexSessionsForDisplay(sessions.filter(x => x.alive))) {
      if (!s.agentType || !isCreatureAgent(s.agentType)) continue;
      all.push({
        id: s.id, glyph: GLYPH_FOR[creatureTypeFor(s.agentType)],
        state: mapSessionState(s.state ?? 'idle'), sick: false,
      });
    }
    if (hasOpenClawSession(sessions)) {
      all.push({
        id: 'openclaw', glyph: 'openClaw',
        state: sessions.some(s => s.agentType === 'openclaw' && s.state === 'processing') ? 'processing' : 'idle',
        sick: stateEvent?.gatewayHasError === true,
      });
    }
  } else if (stateEvent) {
    // Sessions never received: the state event stands in as one session.
    const agentType = (stateEvent.agentType ?? 'claude-code') as string;
    if (isCreatureAgent(agentType)) {
      all.push({
        id: '_primary', glyph: GLYPH_FOR[creatureTypeFor(agentType)],
        state: mapSessionState(stateEvent.state ?? 'idle'), sick: false,
      });
    }
  }
  const rank: Record<TideState, number> = { awaiting: 0, processing: 1, idle: 2 };
  const ordered = all.map((m, i) => ({ m, i })).sort((a, b) => rank[a.m.state] - rank[b.m.state] || a.i - b.i);
  return {
    marks: ordered.slice(0, MAX_MARKS).map(x => x.m),
    overflow: Math.max(0, ordered.length - MAX_MARKS),
  };
}

/** Mark edge length and centre columns by how many marks share the panel. */
const LAYOUT: ReadonlyArray<{ size: number; xs: readonly number[] }> = [
  { size: 24, xs: [] },
  { size: 24, xs: [32] },
  { size: 24, xs: [18, 46] },
  { size: 18, xs: [12, 32, 52] },
  { size: 14, xs: [9, 25, 41, 57] },
];

// ===== Scene pieces =====

/** Waterline height at column x. One wavelength travels 1 cycle per loop. */
function waveY(x: number, t: number): number {
  return 3 + Math.round(1.3 * Math.sin(TAU * (x / 20 - t / TIDE_LOOP.frames)));
}

function drawWater(buf: Uint8Array, t: number, floorTop: number): void {
  const span = floorTop - WATER_TOP;
  for (let x = 0; x < SIZE; x++) {
    const wy = waveY(x, t);
    for (let y = 0; y < floorTop; y++) {
      if (y < wy) { setPixel(buf, x, y, AIR); continue; }
      const f = Math.max(0, (y - WATER_TOP) / span) * BANDS.length;
      let band = Math.min(BANDS.length - 1, Math.floor(f));
      // Dither the seam so a flat band edge reads as a soft step, not a stripe.
      if (f - Math.floor(f) > 0.7 && band < BANDS.length - 1 && ((x + y) & 1) === 0) band++;
      setPixel(buf, x, y, BANDS[band]);
    }
    setPixel(buf, x, wy, ((x * 3 + t * 2) % 12) < 2 ? WHITE : CREST);
    setPixel(buf, x, wy + 1, CREST_BODY);
  }
}

const PEBBLES: ReadonlyArray<readonly [number, number]> = [
  [3, 1], [11, 2], [18, 1], [27, 3], [33, 1], [41, 2], [49, 1], [56, 3], [61, 2],
];

function drawFloor(buf: Uint8Array, floorTop: number): void {
  for (let x = 0; x < SIZE; x++) {
    setPixel(buf, x, floorTop, SAND_TOP);
    for (let r = 1; r < FLOOR_ROWS; r++) setPixel(buf, x, floorTop + r, SAND);
  }
  for (const [x, r] of PEBBLES) setPixel(buf, x, floorTop + r, PEBBLE);
}

const WEEDS: ReadonlyArray<readonly [number, number]> = [[5, 9], [21, 7], [43, 10], [58, 8]];

function drawSeaweed(buf: Uint8Array, t: number, floorTop: number): void {
  WEEDS.forEach(([bx, h], k) => {
    for (let i = 0; i < h; i++) {
      const sway = Math.round(1.5 * Math.sin(TAU * t / TIDE_LOOP.frames + i * 0.5 + k * 1.3) * (i / h));
      setPixel(buf, bx + sway, floorTop - 1 - i, i > h - 3 ? WEED_TIP : WEED);
    }
  });
}

const BUBBLE_X = [11, 24, 38, 50, 57, 5] as const;

function drawBubbles(buf: Uint8Array, t: number, floorTop: number, count: number): void {
  const span = floorTop - WATER_TOP - 1;
  // floor(t·span/frames) is span on the last frame, i.e. 0 mod span: the rise closes.
  const rise = Math.floor(t * span / TIDE_LOOP.frames);
  for (let k = 0; k < count; k++) {
    const oy = (k * 13) % span;
    const y = WATER_TOP + span - 1 - ((oy + rise) % span);
    const x = BUBBLE_X[k] + Math.round(Math.sin(TAU * t / TIDE_LOOP.frames + k));
    blendPixel(buf, x, y, BUBBLE, 0.65);
  }
}

function drawFish(buf: Uint8Array, t: number, floorTop: number): void {
  const span = floorTop - WATER_TOP - 10;
  // Two identical fish half a panel apart: after one loop each stands where the
  // other began, so the loop closes while each crosses 32 px per 3 s.
  for (let k = 0; k < 2; k++) {
    const x = (k * 32 + t * 32 / TIDE_LOOP.frames) % SIZE;
    const y = Math.round(WATER_TOP + 5 + span * (0.5 + 0.5 * Math.sin(TAU * x / SIZE + 1)));
    for (const ox of [Math.round(x), Math.round(x) - SIZE]) {
      for (let b = 0; b < 4; b++) setPixel(buf, ox - b, y, FISH_BODY);
      setPixel(buf, ox - 1, y - 1, FISH_BODY); setPixel(buf, ox - 2, y - 1, FISH_BODY);
      setPixel(buf, ox - 4, y - (t % 2), FISH_TAIL);
    }
  }
}

// ===== Marks =====

const CAM: Camera = { cx: 0.5, cy: 0.5, zoom: 1, width: SIZE };

function drawMark(
  buf: Uint8Array, mark: TideMark, index: number, cx: number, cy: number, size: number, t: number,
): void {
  const frames = TIDE_LOOP.frames;
  const phase = TAU * (t + index * 3) / frames;
  const bob = mark.state === 'processing' ? Math.round(2 * Math.sin(phase))
    : mark.state === 'idle' ? Math.round(Math.sin(phase)) : 0;
  const y = cy + bob;
  const x0 = Math.round(cx - size / 2);
  const y0 = Math.round(y - size / 2);

  if (mark.state === 'awaiting') {
    // The only pulse on the panel (amber = needs you): a dotted ring.
    const pulse = 0.35 + 0.65 * (0.5 + 0.5 * Math.cos(TAU * t / frames));
    const r = size / 2 + 3;
    for (let a = 0; a < 16; a++) {
      const ang = TAU * a / 16;
      blendPixel(buf, cx + Math.cos(ang) * r, y + Math.sin(ang) * r, AMBER, pulse);
    }
  }

  // animFrame 0 keeps the sprite's own (unclosed) bob and pulse at rest; the
  // motion above and below is the loop's.
  drawOfficialDotGlyph(
    buf, mark.glyph, cx / SIZE, y / SIZE,
    mark.state === 'processing' ? 'working' : mark.state === 'awaiting' ? 'asking' : 'idle',
    0, CAM, index, size / 12, mark.sick,
  );

  if (mark.state === 'processing') {
    // A light band sweeps the mark once per loop — working, not just floating.
    const reach = 2 * size + 10;
    const p = (t / frames) * reach - 5;
    const mask = OFFICIAL_DOT_GLYPHS[mark.glyph];
    for (let dy = 0; dy < size; dy++) {
      const sy = Math.min(OFFICIAL_DOT_GLYPH_SIZE - 1, Math.floor(dy * OFFICIAL_DOT_GLYPH_SIZE / size));
      for (let dx = 0; dx < size; dx++) {
        const sx = Math.min(OFFICIAL_DOT_GLYPH_SIZE - 1, Math.floor(dx * OFFICIAL_DOT_GLYPH_SIZE / size));
        if (mask[sy * OFFICIAL_DOT_GLYPH_SIZE + sx] < 128) continue;
        const d = Math.abs(dx + dy - p);
        if (d < 2) glowPixel(buf, x0 + dx, y0 + dy, WHITE, 0.38 * (1 - d / 2));
      }
    }
  }
}

// ===== Frames =====

/** One frame of the loop (tick 0 … frames-1; tick === frames repeats tick 0). */
export function renderTideFrame(
  stateEvent: StateUpdateEvent | null,
  usageEvent: UsageEvent | null,
  sessions: SessionInfo[] | null,
  nowMs: number,
  tick: number,
): Uint8Array {
  const t = ((tick % TIDE_LOOP.frames) + TIDE_LOOP.frames) % TIDE_LOOP.frames;
  const buf = new Uint8Array(SIZE * SIZE * 3);
  const hudRows = getUsageProviderCount(usageEvent) * TERRARIUM_RULES.pixooUsageRowHeight;
  const sceneH = SIZE - hudRows;
  const floorTop = sceneH - FLOOR_ROWS;
  const { marks, overflow } = resolveTideMarks(stateEvent, sessions);

  drawWater(buf, t, floorTop);
  drawFloor(buf, floorTop);
  drawSeaweed(buf, t, floorTop);
  drawFish(buf, t, floorTop);
  const busy = marks.some(m => m.state === 'processing');
  drawBubbles(buf, t, floorTop, busy ? 6 : 2);

  const layout = LAYOUT[marks.length];
  const cy = Math.round((WATER_TOP + floorTop) / 2);
  const anchors: CiCueAnchor[] = [];
  marks.forEach((mark, i) => {
    const cx = layout.xs[i];
    drawMark(buf, mark, i, cx, cy, layout.size, t);
    anchors.push({ sessionId: mark.id, x: cx, y: cy, bodySize: layout.size });
  });
  if (overflow > 0) drawText(buf, `+${overflow}`, SIZE - 2, 1, TEXT);

  // The CI companion is time-driven; the loop shows it frozen at `nowMs`.
  drawCiCue(buf, SIZE, sessions, nowMs, anchors, false, sceneH);
  drawUsageHUD(buf, usageEvent, 0);
  return buf;
}

/** The frames of one closed device loop, played at `TIDE_LOOP.picSpeedMs`. */
export function renderTideLoop(
  stateEvent: StateUpdateEvent | null,
  usageEvent: UsageEvent | null,
  sessions: SessionInfo[] | null,
  nowMs: number,
): Uint8Array[] {
  return Array.from({ length: TIDE_LOOP.frames }, (_, t) =>
    renderTideFrame(stateEvent, usageEvent, sessions, nowMs, t));
}

// ===== Upload policy =====
//
// The panel shows a loading hourglass while it ingests an upload, and on a busy
// desk "something changed" is true every few seconds. So an upload is justified
// only by what the panel would actually SHOW differently, and a flapping session
// may not buy more than one per floor.

export const TIDE_POLICY = {
  /** A different set of marks or states re-bakes the loop at most this often. */
  sceneFloorMs: 15_000,
  /** A usage-only change (percentages, reset countdown ticking over a minute) at most this often. */
  hudFloorMs: 300_000,
  /** With nothing to show, ask the device whether it still shows our loop this often. */
  verifyMs: 30_000,
  /** After a failed upload, no tide upload for this long. Never a single-frame fallback. */
  retryMs: 60_000,
} as const;

export interface TideSignature { scene: string; hud: string }

/** What the panel would show: the marks (and CI state) vs. the usage strip. */
export function tideSignature(
  stateEvent: StateUpdateEvent | null,
  usageEvent: UsageEvent | null,
  sessions: SessionInfo[] | null,
): TideSignature {
  const { marks, overflow } = resolveTideMarks(stateEvent, sessions);
  const shown = new Set(marks.map(m => m.id));
  const ci = (sessions ?? [])
    .filter(s => s.alive && s.waitingOn && shown.has(s.id))
    .map(s => `${s.id}:${s.waitingOn?.phase}:${s.waitingOn?.agentWaiting === true}`);
  const scene = [
    ...marks.map(m => `${m.glyph}:${m.state}:${m.sick}`), `+${overflow}`, ...ci,
  ].join('|');
  const pct = (v: number | null | undefined) => (v == null ? '-' : String(Math.floor(v)));
  const cx = usageEvent?.codexRateLimits;
  const zai = usageEvent?.zaiRateLimits;
  const hud = usageEvent ? [
    pct(usageEvent.fiveHourPercent), pct(usageEvent.sevenDayPercent),
    usageEvent.fiveHourResetsAt ?? '', usageEvent.sevenDayResetsAt ?? '',
    pct(cx?.primary?.usedPercent), pct(cx?.secondary?.usedPercent),
    usageEvent.usageStale === true, cx?.primary?.stale === true, cx?.secondary?.stale === true,
    // The z.ai row and the Codex subscription date are on the strip too; without
    // them a change there never reached the panel until the scene next changed.
    pct(zai?.primary?.usedPercent), pct(zai?.secondary?.usedPercent),
    zai?.primary?.stale === true, zai?.secondary?.stale === true,
    usageEvent.codexSubscriptionActiveUntil ?? '',
  ].join('|') : '';
  return { scene, hud };
}

export interface TideUploadRecord { sig: TideSignature; at: number }
export type TideDecision = 'upload' | 'verify' | 'wait';

/** Pure: what the bridge does about one tide device this tick. */
export function tideDecision(
  sig: TideSignature,
  uploaded: TideUploadRecord | undefined,
  lastAttemptAt: number,
  retryAt: number,
  now: number,
): TideDecision {
  if (now < retryAt) return 'wait';
  if (!uploaded) return 'upload';
  const sinceUpload = now - uploaded.at;
  const sceneChanged = sig.scene !== uploaded.sig.scene;
  const hudChanged = sig.hud !== uploaded.sig.hud;
  if (sceneChanged && sinceUpload >= TIDE_POLICY.sceneFloorMs) return 'upload';
  if (!sceneChanged && hudChanged && sinceUpload >= TIDE_POLICY.hudFloorMs) return 'upload';
  return now - lastAttemptAt >= TIDE_POLICY.verifyMs ? 'verify' : 'wait';
}
