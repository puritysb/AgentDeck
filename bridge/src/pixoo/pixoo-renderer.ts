/**
 * Pixoo64 Frame Renderer — camera-based animated terrarium.
 *
 * No text. All information encoded visually:
 *
 *   Water color  ↔  usage zone (blue → teal → amber → red)
 *   Waves        ↔  agent state (calm=IDLE, choppy=PROC, golden pulse=AWAITING)
 *   Bubbles      ↔  activity density
 *   Creatures    ↔  sessions + gateway
 *   Particles    ↔  data flow during processing
 *   Surface glow ↔  state color (green / blue / amber)
 *   Camera zoom  ↔  state-driven focus (wide, octopus close-up, crayfish, school, surface)
 *
 * Rendering pipeline:
 *   1. Environment → 64×64 world buffer (water, terrain, effects)
 *   2. blitWithCamera() → output buffer (crop + scale by camera zoom/pan)
 *   3. Scaled creatures → output buffer (HD grid sprites with camera-aware sizing)
 *   4. Screen-space overlays (danger flash) → output buffer
 */

import { State } from '../types.js';
import {
  PASSIVE_OFFLINE_LABEL,
  type SubagentActivityBySession,
  type SubagentVisualActivity,
} from '@agentdeck/shared';
import type { StateUpdateEvent, UsageEvent } from '../types.js';
import type { SessionInfo } from '@agentdeck/shared/protocol';
import { hasOpenClawSession, foldCodexSessionsForDisplay } from '@agentdeck/shared';
import {
  type CreatureSlot,
  layoutOctopuses, layoutCloudCreatures, layoutOpenCodeCreatures, layoutAntigravityCreatures,
} from '@agentdeck/shared';
import { drawTextCentered } from './pixoo-font.js';
import {
  type RGB, COLORS, setPixel, blendPixel, glowPixel, fillRect, lerpColor,
  drawOfficialDotGlyph, drawTetra,
  drawText,
  getOctopusPaletteForSession, getJellyfishPaletteForSession, getOpenCodePaletteForSession,
  getAntigravityPaletteForSession,
} from './pixoo-sprites.js';
import {
  type Camera, type ActiveCreature, CAMERA_WIDE, blitWithCamera, quantizeCameraPixels,
  updateDirector, setZone, setOverride, resetDirector,
  worldToScreen, isVisible,
  WORLD_SIZE, ACTIVE_SIZE,
} from './pixoo-camera.js';
import {
  MICRO_SIZE, paintTimeboxBeacon,
  type MicroCreature, type MicroAggregate,
} from './micro-glyphs.js';
import {
  OFFICIAL_DOT_GLYPHS, OFFICIAL_DOT_GLYPH_SIZE,
  type OfficialDotGlyphName,
} from './official-dot-glyphs.generated.js';

const W = WORLD_SIZE;
const ACTIVE_OFFSET = (WORLD_SIZE - ACTIVE_SIZE) / 2; // 16

// Track last render time for accurate dt calculation
let lastRenderTime = 0;

// ===== Layout (world-buffer pixel coords) =====
const SAND_TOP = ACTIVE_OFFSET + 54;      // 70
const SAND_BOT = ACTIVE_OFFSET + 59;      // 75
const SUBSTRATE_TOP = ACTIVE_OFFSET + 60;  // 76
const SURFACE_Y = ACTIVE_OFFSET + 2;      // 18

// ===== Creature World Positions (normalized 0~1) =====
const CF_DEFAULT_X = 0.72;
const CF_DEFAULT_Y = 0.76; // just above sand line (sitting on ground)

// ===== Creature Instance Management =====

interface CreatureInstance {
  sessionId: string;
  agentType: string;
  creatureType: CreatureType;
  state: 'idle' | 'processing' | 'awaiting';
  worldX: number;
  worldY: number;
  phaseOffset: number;
  /** Crowd-driven shrink from the shared CreatureLayout band engine. */
  sizeScale: number;
}

/** Golden ratio constant for position distribution. */
const PHI = (1 + Math.sqrt(5)) / 2;

/** Active creature instances keyed by sessionId. */
const creatureInstances = new Map<string, CreatureInstance>();

/** Agent types that represent coding agents (draw as octopus/robot). */
const CODING_AGENTS = new Set(['claude-code']);
/** Agent types drawn as jellyfish (cloud creature). */
const JELLYFISH_AGENTS = new Set(['codex-cli', 'codex-app']);
/** Agent types drawn as nested-square opencode. */
const OPENCODE_AGENTS = new Set(['opencode']);
/** Agent types drawn as the Antigravity peak/arc mark. */
const ANTIGRAVITY_AGENTS = new Set(['antigravity']);
/** Kiro CLI/IDE share the official ghost mark. */
const KIRO_AGENTS = new Set(['kiro-cli', 'kiro-ide']);

type CreatureType = 'octopus' | 'jellyfish' | 'opencode' | 'antigravity' | 'kiro';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Vertical stratification per creature type, applied on top of the band's base
 * Y. Each type keeps its own water layer so a mixed Claude+Codex+OpenCode tank
 * stays readable: clouds ride near the surface while working and sink to answer,
 * octopuses hold mid-water, and everything settles to the sand when idle.
 *
 * Mirror of `stateY(_:kind:baseY:)` in apple/AgentDeck/Daemon/Modules/PixooRenderer.swift.
 */
function stateYForType(
  state: 'idle' | 'processing' | 'awaiting',
  creatureType: CreatureType,
  baseY: number,
): number {
  switch (creatureType) {
    case 'octopus':
      if (state === 'processing') return clamp(baseY, 0.40, 0.54);
      if (state === 'awaiting') return clamp(baseY - 0.04, 0.35, 0.48);
      return 0.80;
    case 'jellyfish':
      if (state === 'processing') return clamp(baseY, 0.16, 0.28);
      if (state === 'awaiting') return clamp(baseY + 0.26, 0.52, 0.64);
      return clamp(baseY + 0.40, 0.80, 0.82);
    case 'opencode':
      if (state === 'processing') return clamp(baseY - 0.02, 0.20, 0.34);
      if (state === 'awaiting') return clamp(baseY + 0.22, 0.50, 0.62);
      return clamp(baseY + 0.36, 0.79, 0.81);
    case 'antigravity':
      if (state === 'processing') return clamp(baseY - 0.04, 0.16, 0.30);
      if (state === 'awaiting') return clamp(baseY + 0.22, 0.46, 0.54);
      return clamp(baseY + 0.34, 0.56, 0.64);
    case 'kiro':
      if (state === 'processing') return clamp(baseY - 0.04, 0.16, 0.30);
      if (state === 'awaiting') return clamp(baseY + 0.16, 0.42, 0.54);
      return clamp(baseY + 0.26, 0.60, 0.70);
  }
}

function slotsForType(creatureType: CreatureType, count: number): CreatureSlot[] {
  switch (creatureType) {
    case 'octopus': return layoutOctopuses(count);
    case 'jellyfish': return layoutCloudCreatures(count);
    case 'opencode': return layoutOpenCodeCreatures(count);
    case 'antigravity': return layoutAntigravityCreatures(count);
    // Until creature-layout.ts is generated across all three mirrors, reuse
    // the upper-right floating band instead of introducing another hand mirror.
    case 'kiro': return layoutAntigravityCreatures(count);
  }
}

const FALLBACK_SLOT: CreatureSlot = { x: 0.38, y: 0.42, scale: 1.0 };

function slotAt(slots: CreatureSlot[], index: number): CreatureSlot {
  if (slots.length === 0) return FALLBACK_SLOT;
  return slots[Math.min(index, slots.length - 1)];
}

/** Check if agent type gets a creature. */
function isCreatureAgent(agentType: string): boolean {
  return CODING_AGENTS.has(agentType) || JELLYFISH_AGENTS.has(agentType) || OPENCODE_AGENTS.has(agentType) || ANTIGRAVITY_AGENTS.has(agentType) || KIRO_AGENTS.has(agentType);
}

function creatureTypeFor(agentType: string): CreatureType {
  if (ANTIGRAVITY_AGENTS.has(agentType)) return 'antigravity';
  if (KIRO_AGENTS.has(agentType)) return 'kiro';
  if (JELLYFISH_AGENTS.has(agentType)) return 'jellyfish';
  if (OPENCODE_AGENTS.has(agentType)) return 'opencode';
  return 'octopus';
}

function syncCreatures(
  sessions: SessionInfo[] | null,
  stateEvent: StateUpdateEvent | null,
): void {
  // Determine which sessions are alive creature agents (octopus or jellyfish).
  // Codex rows fold by project first: each Claude Code rescue/stop-gate spawns a
  // fresh codex thread, so without folding one workspace lights up 4-5 cloud
  // marks at once. Octopus / opencode are NOT folded — running several of those
  // against one project is a deliberate user pattern.
  const aliveCoding: { id: string; agentType: string; state: string }[] = [];
  if (sessions) {
    for (const s of foldCodexSessionsForDisplay(sessions.filter(s => s.alive))) {
      if (s.agentType && isCreatureAgent(s.agentType)) {
        aliveCoding.push({ id: s.id, agentType: s.agentType, state: s.state ?? 'idle' });
      }
    }
  }

  // If sessions data has never been received, use stateEvent as single session (only for creature agents)
  const stateAgentType = (stateEvent?.agentType ?? 'claude-code') as string;
  if (sessions === null && aliveCoding.length === 0 && stateEvent && isCreatureAgent(stateAgentType)) {
    aliveCoding.push({
      id: '_primary',
      agentType: stateAgentType,
      state: simplifiedState(stateEvent.state ?? State.IDLE),
    });
  }

  // Remove creatures for dead sessions
  for (const id of creatureInstances.keys()) {
    if (!aliveCoding.some(s => s.id === id)) {
      creatureInstances.delete(id);
    }
  }

  // Each agent type owns an X band and wraps to a second/third row as it fills,
  // so a mixed tank clusters by agent instead of interleaving along one line.
  const typeCounts = new Map<CreatureType, number>();
  for (const s of aliveCoding) {
    const t = creatureTypeFor(s.agentType);
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1);
  }
  const slotsByType = new Map<CreatureType, CreatureSlot[]>();
  for (const [type, count] of typeCounts) slotsByType.set(type, slotsForType(type, count));
  const typeIndices = new Map<CreatureType, number>();
  // Band base Y per session, kept so the `_primary` refresh below can re-derive
  // its stratified Y from the band instead of compounding onto an already
  // stratified worldY.
  const baseYById = new Map<string, number>();

  // Add/update creatures
  for (let i = 0; i < aliveCoding.length; i++) {
    const s = aliveCoding[i];
    const existing = creatureInstances.get(s.id);
    const sessionState = mapSessionState(s.state);
    const creatureType = creatureTypeFor(s.agentType);

    const slotIndex = typeIndices.get(creatureType) ?? 0;
    typeIndices.set(creatureType, slotIndex + 1);
    const slot = slotAt(slotsByType.get(creatureType) ?? [], slotIndex);
    const x = slot.x;
    baseYById.set(s.id, slot.y);
    const worldY = stateYForType(sessionState, creatureType, slot.y);

    if (existing) {
      existing.state = sessionState;
      existing.agentType = s.agentType;
      existing.creatureType = creatureType;
      existing.worldX = x; // Update X dynamically to maintain even spacing
      existing.worldY = worldY;
      existing.sizeScale = slot.scale;
    } else {
      creatureInstances.set(s.id, {
        sessionId: s.id,
        agentType: s.agentType,
        creatureType,
        state: sessionState,
        worldX: x,
        worldY,
        phaseOffset: i * 5,
        sizeScale: slot.scale,
      });
    }
  }

  // Refresh the synthetic `_primary` creature from stateEvent — it *is* the
  // stateEvent, so this keeps it precise before the first sessions_list lands.
  //
  // Real sessions are deliberately left alone. stateEvent.sessionId can name a
  // row that folding has already collapsed into a representative, and stamping
  // that member's state onto the representative would downgrade a group the fold
  // resolved to `processing` down to the one idle sibling the event came from.
  // The sessions list is daemon-pushed and already carries per-session state.
  const aType = stateEvent?.agentType as string | undefined;
  const isCreature = isCreatureAgent(aType ?? '');
  if (stateEvent && isCreature) {
    const primary = creatureInstances.get('_primary');
    if (primary) {
      const st = simplifiedState(stateEvent.state ?? State.IDLE) as 'idle' | 'processing' | 'awaiting';
      primary.state = st;
      primary.worldY = stateYForType(st, primary.creatureType, baseYById.get('_primary') ?? primary.worldY);
    }
  }
}

function mapSessionState(state: string): 'idle' | 'processing' | 'awaiting' {
  if (state === 'processing') return 'processing';
  if (state === 'awaiting' || state === 'awaiting_option' || state === 'awaiting_permission' || state === 'awaiting_diff') return 'awaiting';
  return 'idle';
}

// ===== Water Color Zones =====

interface WaterPalette {
  surface: RGB; light: RGB; mid: RGB; deep: RGB;
}

const ZONE_BLUE: WaterPalette = {
  surface: COLORS.waterSurface, light: COLORS.waterLight,
  mid: COLORS.waterMid, deep: COLORS.waterDeep,
};
const ZONE_TEAL: WaterPalette = {
  surface: COLORS.waterTealSurface, light: COLORS.waterTealLight,
  mid: COLORS.waterTealMid, deep: COLORS.waterTealDeep,
};
const ZONE_AMBER: WaterPalette = {
  surface: COLORS.waterAmberSurface, light: COLORS.waterAmberLight,
  mid: COLORS.waterAmberMid, deep: COLORS.waterAmberDeep,
};
const ZONE_RED: WaterPalette = {
  surface: COLORS.waterRedSurface, light: COLORS.waterRedLight,
  mid: COLORS.waterRedMid, deep: COLORS.waterRedDeep,
};

function getWaterPalette(pct: number): WaterPalette {
  if (pct < 50) {
    const t = pct / 50;
    return {
      surface: lerpColor(ZONE_BLUE.surface, ZONE_TEAL.surface, t),
      light: lerpColor(ZONE_BLUE.light, ZONE_TEAL.light, t),
      mid: lerpColor(ZONE_BLUE.mid, ZONE_TEAL.mid, t),
      deep: lerpColor(ZONE_BLUE.deep, ZONE_TEAL.deep, t),
    };
  } else if (pct < 75) {
    const t = (pct - 50) / 25;
    return {
      surface: lerpColor(ZONE_TEAL.surface, ZONE_AMBER.surface, t),
      light: lerpColor(ZONE_TEAL.light, ZONE_AMBER.light, t),
      mid: lerpColor(ZONE_TEAL.mid, ZONE_AMBER.mid, t),
      deep: lerpColor(ZONE_TEAL.deep, ZONE_AMBER.deep, t),
    };
  } else {
    const t = (pct - 75) / 25;
    return {
      surface: lerpColor(ZONE_AMBER.surface, ZONE_RED.surface, t),
      light: lerpColor(ZONE_AMBER.light, ZONE_RED.light, t),
      mid: lerpColor(ZONE_AMBER.mid, ZONE_RED.mid, t),
      deep: lerpColor(ZONE_AMBER.deep, ZONE_RED.deep, t),
    };
  }
}

function waterColorAt(palette: WaterPalette, surfaceY: number, y: number): RGB {
  const waterDepth = SAND_TOP - surfaceY;
  if (waterDepth <= 0) return palette.deep;
  const t = Math.max(0, (y - surfaceY) / waterDepth);
  if (t < 0.25) return lerpColor(palette.surface, palette.light, t / 0.25);
  if (t < 0.6) return lerpColor(palette.light, palette.mid, (t - 0.25) / 0.35);
  return lerpColor(palette.mid, palette.deep, (t - 0.6) / 0.4);
}

// ===== Tetra School =====

interface TetraState {
  x: number; y: number; heading: number; speed: number;
  phase: number; schoolId: number;
}

const NUM_TETRAS = 14;
let tetras: TetraState[] | null = null;

function initTetras(): TetraState[] {
  const result: TetraState[] = [];
  for (let i = 0; i < NUM_TETRAS; i++) {
    result.push({
      x: 12 + Math.random() * (WORLD_SIZE - 24),
      y: SURFACE_Y + 4 + Math.random() * 22,
      heading: Math.random() > 0.5 ? 1 : -1,
      speed: 0.08 + Math.random() * 0.12,  // slower — prevents teleporting at ~1fps
      phase: Math.random() * Math.PI * 2,
      schoolId: i < 7 ? 0 : 1,
    });
  }
  return result;
}

function updateTetras(frame: number, surfaceY: number, maxY: number): void {
  if (!tetras) tetras = initTetras();

  // Two school centers via Lissajous (meet and diverge every ~25s), scaled to WORLD_SIZE
  const sc0X = (WORLD_SIZE / 2 - 12) + Math.sin(frame * 0.02) * 24;
  const sc0Y = Math.max(surfaceY + 8, SURFACE_Y + 12) + Math.cos(frame * 0.015) * 8;
  const sc1X = (WORLD_SIZE / 2 + 12) + Math.sin(frame * 0.0175 + 2) * 24;
  const sc1Y = Math.max(surfaceY + 8, SURFACE_Y + 14) + Math.cos(frame * 0.0225 + 1) * 8;
  const centers = [{ x: sc0X, y: sc0Y }, { x: sc1X, y: sc1Y }];

  for (const t of tetras) {
    const sc = centers[t.schoolId];
    const dx = sc.x - t.x;
    const dy = sc.y - t.y;

    // Cohesion + individual motion (stronger cohesion for tighter schooling)
    t.x += dx * 0.025 + t.heading * (t.speed * 0.5);
    t.y += dy * 0.025 + Math.sin(frame * 0.05 + t.phase) * 0.2;

    // Boundary
    const minY = surfaceY + 3;
    if (t.x < 3 || t.x > WORLD_SIZE - 3) {
      t.heading *= -1;
      t.x = Math.max(3, Math.min(WORLD_SIZE - 3, t.x));
    }
    if (t.y < minY) t.y = minY;
    if (t.y > maxY) t.y = maxY;
  }
}

/** Average position of all tetras (normalized 0~1). */
function getSchoolCenter(): { x: number; y: number } {
  if (!tetras || tetras.length === 0) return { x: 0.5, y: 0.4 };
  let sx = 0, sy = 0;
  for (const t of tetras) { sx += t.x; sy += t.y; }
  const avgX = sx / tetras.length;
  const avgY = sy / tetras.length;
  return {
    x: (avgX - ACTIVE_OFFSET) / ACTIVE_SIZE,
    y: (avgY - ACTIVE_OFFSET) / ACTIVE_SIZE,
  };
}

// ===== Bubble System =====

interface Bubble {
  x: number; y: number; speed: number; wobblePhase: number; bright: boolean;
}

let bubbles: Bubble[] = [];

function spawnBubble(): Bubble {
  return {
    x: 4 + Math.random() * (WORLD_SIZE - 8),
    y: SAND_TOP - 1 - Math.random() * 4,
    speed: 0.3 + Math.random() * 0.4,
    wobblePhase: Math.random() * Math.PI * 2,
    bright: Math.random() > 0.6,
  };
}

function updateBubbles(frame: number, surfaceY: number, density: number): void {
  const maxBubbles = Math.round(density);
  while (bubbles.length < maxBubbles) bubbles.push(spawnBubble());

  for (const b of bubbles) {
    b.y -= (b.speed * 0.5);
    b.x += Math.sin(frame * 0.075 + b.wobblePhase) * 0.15;
  }

  bubbles = bubbles.filter(b => b.y > surfaceY + 1);
  while (bubbles.length > maxBubbles + 4) bubbles.shift();
}

// ===== Data Particles =====

interface DataParticle {
  x: number; y: number; vy: number; life: number; green: boolean;
}

let dataParticles: DataParticle[] = [];

function updateDataParticles(frame: number, surfaceY: number, active: boolean): void {
  if (active && frame % 6 === 0) { // spawn half as often
    dataParticles.push({
      x: 10 + Math.random() * (WORLD_SIZE - 20),
      y: surfaceY + 2 + Math.random() * 3,
      vy: 0.2 + Math.random() * 0.15,
      life: 60 + Math.random() * 40,
      green: Math.random() > 0.6,
    });
  }

  for (const p of dataParticles) {
    p.y += p.vy;
    p.x += Math.sin(frame * 0.1 + p.x * 0.3) * 0.2;
    p.life--;
  }

  dataParticles = dataParticles.filter(p =>
    p.life > 0 && p.y < SAND_TOP - 1 && p.y > surfaceY
  );
  if (dataParticles.length > 16) dataParticles.splice(0, dataParticles.length - 16);
}

// ===== Seaweed =====

const SEAWEED_POSITIONS = [
  // Outer left edge (padding region)
  { x: 2, h: 13, phase: 0 },
  { x: 5, h: 9, phase: 1.2 },
  { x: 8, h: 6, phase: 2.5 },
  // Active region left edge
  { x: ACTIVE_OFFSET + 2, h: 11, phase: 0.5 },
  { x: ACTIVE_OFFSET + 5, h: 7, phase: 1.7 },
  // Active region right edge
  { x: ACTIVE_OFFSET + 58, h: 8, phase: 2.2 },
  { x: ACTIVE_OFFSET + 61, h: 10, phase: 0.9 },
  // Outer right edge (padding region)
  { x: WORLD_SIZE - 9, h: 12, phase: 0.8 },
  { x: WORLD_SIZE - 6, h: 8, phase: 1.9 },
  { x: WORLD_SIZE - 3, h: 7, phase: 3.1 },
];

function drawSeaweed(buf: Uint8Array, frame: number, surfaceY: number): void {
  for (const sw of SEAWEED_POSITIONS) {
    const maxHeight = Math.min(sw.h, SAND_TOP - surfaceY - 2);
    if (maxHeight <= 0) continue;

    for (let i = 0; i < maxHeight; i++) {
      const swayAmount = (i / maxHeight) * 1.5;
      const sway = Math.round(Math.sin(frame * 0.06 + sw.phase + i * 0.4) * swayAmount);
      const color = i % 3 === 0 ? COLORS.seaweedLight
        : i % 2 === 0 ? COLORS.seaweed : COLORS.seaweedDark;
      const px = sw.x + sway;
      const py = SAND_TOP - 1 - i;
      if (py > surfaceY) setPixel(buf, px, py, color);
    }
  }
}

// ===== Light Rays =====

function drawLightRays(buf: Uint8Array, frame: number, surfaceY: number): void {
  const rays = [
    { baseX: 8 + Math.sin(frame * 0.018) * 3, angle: 0.1 }, // left padding ray
    { baseX: ACTIVE_OFFSET + 15 + Math.sin(frame * 0.02) * 5, angle: 0.15 },
    { baseX: ACTIVE_OFFSET + 35 + Math.sin(frame * 0.015 + 1) * 6, angle: -0.1 },
    { baseX: ACTIVE_OFFSET + 50 + Math.sin(frame * 0.025 + 2) * 4, angle: 0.2 },
    { baseX: WORLD_SIZE - 10 + Math.sin(frame * 0.022) * 3, angle: -0.15 }, // right padding ray
  ];

  for (const ray of rays) {
    const depth = SAND_TOP - surfaceY;
    for (let d = 2; d < depth - 2; d++) {
      const y = surfaceY + d;
      const x = Math.round(ray.baseX + d * ray.angle);
      const fadeIn = Math.min(1, d / 6);
      const fadeOut = Math.max(0, 1 - d / depth);
      const alpha = fadeIn * fadeOut * 0.2;
      if (alpha > 0.02) {
        glowPixel(buf, x, y, COLORS.lightRay, alpha);
        glowPixel(buf, x - 1, y, COLORS.lightRay, alpha * 0.4);
        glowPixel(buf, x + 1, y, COLORS.lightRay, alpha * 0.4);
      }
    }
  }
}

// ===== Caustics =====

function drawCaustics(buf: Uint8Array, frame: number, surfaceY: number): void {
  if (surfaceY >= SAND_TOP - 3) return;
  for (let x = 1; x < W - 1; x++) {
    const pattern = Math.sin(x * 0.5 + frame * 0.05) * Math.cos(x * 0.3 - frame * 0.035);
    if (pattern > 0.5) {
      const intensity = (pattern - 0.5) * 0.4;
      glowPixel(buf, x, SAND_TOP, COLORS.caustic, intensity);
      glowPixel(buf, x, SAND_TOP + 1, COLORS.caustic, intensity * 0.5);
    }
  }
}

// ===== Surface Waves =====

function drawSurface(
  buf: Uint8Array, frame: number, surfaceY: number,
  palette: WaterPalette, state: State,
): void {
  const shimmerColor: RGB = state === State.PROCESSING ? COLORS.stateProcessing
    : state === State.AWAITING_OPTION || state === State.AWAITING_PERMISSION || state === State.AWAITING_DIFF
      ? COLORS.stateAwaiting
      : COLORS.stateIdle;

  const waveSpeed = state === State.PROCESSING ? 0.125 : 0.05;
  const waveAmp = state === State.PROCESSING ? 1.5 : 0.8;
  const shimmerIntensity = state === State.PROCESSING ? 0.35
    : (state === State.AWAITING_OPTION || state === State.AWAITING_PERMISSION || state === State.AWAITING_DIFF)
      ? 0.25 + Math.sin(frame * 0.15) * 0.15
      : 0.15;

  for (let x = 0; x < W; x++) {
    const wave = Math.sin(x * 0.25 + frame * waveSpeed) * waveAmp;
    const wy = surfaceY + Math.round(wave);

    blendPixel(buf, x, wy, palette.surface, 0.8);
    if (wave > waveAmp * 0.3) glowPixel(buf, x, wy, shimmerColor, shimmerIntensity);
    if (wave > waveAmp * 0.6 && (Math.floor(x + frame)) % 5 === 0) {
      glowPixel(buf, x, wy, COLORS.white, 0.15);
    }
  }
}

// ===== Terrain =====

function drawTerrain(buf: Uint8Array): void {
  for (let y = SAND_TOP; y <= SAND_BOT; y++) {
    for (let x = 0; x < W; x++) {
      const noise = ((x * 7 + y * 13) % 11);
      const color = noise < 3 ? COLORS.sandLight : noise < 7 ? COLORS.sand : COLORS.sandDark;
      setPixel(buf, x, y, color);
    }
  }

  // Distribute gravel positions across the entire 96 width
  const gravelPositions = [4, 12, 20, 24, 31, 38, 45, 53, 60, 67, 74, 80, 87, 92];
  for (const gx of gravelPositions) setPixel(buf, gx, SAND_TOP, COLORS.gravel);

  for (let y = SUBSTRATE_TOP; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const noise = ((x * 11 + y * 7) % 13);
      setPixel(buf, x, y, noise < 4 ? COLORS.rockLight : COLORS.rock);
    }
  }

  const rocks = [
    { x: 4, y: SAND_BOT + 1, w: 3, h: 2 }, // left padding rock
    { x: ACTIVE_OFFSET + 12, y: SAND_BOT, w: 4, h: 2 },
    { x: ACTIVE_OFFSET + 30, y: SAND_BOT + 1, w: 3, h: 2 },
    { x: ACTIVE_OFFSET + 48, y: SAND_BOT, w: 5, h: 3 },
    { x: WORLD_SIZE - 8, y: SAND_BOT, w: 4, h: 2 }, // right padding rock
  ];
  for (const r of rocks) {
    for (let dy = 0; dy < r.h; dy++) {
      for (let dx = 0; dx < r.w; dx++) {
        const edge = dx === 0 || dx === r.w - 1 || dy === 0;
        setPixel(buf, r.x + dx, r.y + dy, edge ? COLORS.rockLight : COLORS.rock);
      }
    }
  }
}

// ===== Main Render =====

// Time-based animation frame — ensures consistent speed regardless of who/how often
// calls renderFrame() (device push vs preview endpoint won't interfere).
// ~10 units/sec (100ms interval) to match 10fps loop.
function getAnimFrame(timeOverrideMs?: number): number {
  return Math.floor((timeOverrideMs ?? Date.now()) / 100); 
}

function creatureState(state: State): 'idle' | 'working' | 'sleeping' | 'asking' {
  switch (state) {
    case State.IDLE: return 'idle';
    case State.PROCESSING: return 'working';
    case State.AWAITING_OPTION:
    case State.AWAITING_PERMISSION:
    case State.AWAITING_DIFF:
      return 'asking';
    default: return 'idle';
  }
}

function simplifiedState(state: State): 'idle' | 'processing' | 'awaiting' {
  switch (state) {
    case State.PROCESSING: return 'processing';
    case State.AWAITING_OPTION:
    case State.AWAITING_PERMISSION:
    case State.AWAITING_DIFF:
      return 'awaiting';
    default: return 'idle';
  }
}

// ===== Usage HUD Helpers =====

/** Gauge bar color based on usage percentage. */
function gaugeColor(pct: number, animFrame: number, brand: RGB): RGB {
  if (pct >= 90) {
    // Red with pulse
    const pulse = (Math.sin(animFrame * 0.2) + 1) * 0.3;
    return lerpColor(COLORS.stateError, COLORS.white, pulse) as RGB;
  }
  if (pct >= 70) return COLORS.stateAwaiting;  // amber
  return brand;
}

/** Pixoo HUD reset time: "1h23", "4d6", "59m". */
export function formatResetDetailed(resetsAt: string | undefined): string {
  if (!resetsAt) return '';
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return '0m';
  const totalMins = Math.max(1, Math.ceil(ms / 60000));
  const hours = Math.floor(totalMins / 60);
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  const mins = totalMins % 60;
  if (days > 0 && remHours > 0) return `${days}d${remHours}`;
  if (days > 0) return `${days}d`;
  if (hours > 0 && mins > 0) return `${hours}h${mins}`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

/** Draw Usage HUD in screen space (bottom, zoom-independent).
 *  Each provider uses the same seven-pixel band with its official creature
 *  silhouette, full-height usage fill, percentage and reset countdown. When both are present Claude occupies
 *  rows 50-56 and Codex rows 57-63; a lone provider stays on rows 57-63.
 *  Primary/5h is the left zone and secondary/7d is the right zone.
 *  When Codex only reports 7d, its subscription date occupies the otherwise
 *  empty primary zone.
 */
function drawUsageHUD(
  buf: Uint8Array, usageEvent: UsageEvent | null, animFrame: number,
): void {
  if (!usageEvent) return;
  type Window = { percent: number; resetsAt?: string };
  type Provider = {
    glyph: OfficialDotGlyphName; brand: RGB;
    primary?: Window; secondary?: Window;
    subscriptionUntil?: string;
  };

  const providers: Provider[] = [];
  if (usageEvent.usageStale !== true && usageEvent.fiveHourPercent != null) {
    providers.push({
      glyph: 'claudeCode', brand: [255, 112, 76],
      primary: { percent: usageEvent.fiveHourPercent, resetsAt: usageEvent.fiveHourResetsAt },
      secondary: usageEvent.sevenDayPercent == null ? undefined : {
        percent: usageEvent.sevenDayPercent, resetsAt: usageEvent.sevenDayResetsAt,
      },
    });
  }
  // A window counts as renderable only when it is both fresh AND carries a
  // number. "Not stale but no percent" is a malformed frame, not a zero — the
  // gauge must stay absent rather than draw an authoritative-looking 0%.
  // Mirror of `freshCodexWindow` in apple/AgentDeck/Daemon/Modules/PixooRenderer.swift.
  const freshCodexWindow = (w: { stale?: boolean; usedPercent?: number; resetsAt?: string } | undefined) =>
    w && w.stale !== true && w.usedPercent != null
      ? { percent: w.usedPercent, resetsAt: w.resetsAt }
      : undefined;
  const codexPrimaryWindow = freshCodexWindow(usageEvent.codexRateLimits?.primary);
  const codexSecondaryWindow = freshCodexWindow(usageEvent.codexRateLimits?.secondary);
  if (codexPrimaryWindow || codexSecondaryWindow) {
    providers.push({
      glyph: 'codex', brand: [126, 116, 255],
      primary: codexPrimaryWindow,
      secondary: codexSecondaryWindow,
      subscriptionUntil: usageEvent.codexSubscriptionActiveUntil,
    });
  }
  if (providers.length === 0) return;

  const timeColor: RGB = [0x60, 0x70, 0x80];
  const firstY = providers.length > 1 ? 50 : 57;

  function drawCreatureMarker(provider: Provider, rowY: number): void {
    const mask = OFFICIAL_DOT_GLYPHS[provider.glyph];
    const sourceSize = OFFICIAL_DOT_GLYPH_SIZE;
    // Sample the canonical square canvas instead of cropping its occupied
    // bounds. Claude's source silhouette is intentionally wider than it is
    // tall; cropping and stretching those bounds to 7x7 turns the robot into
    // a square. The 9px slot leaves one physical LED on both sides.
    const markerSize = 7;
    const markerX = 1;
    for (let dy = 0; dy < 7; dy++) {
      const sy = Math.min(sourceSize - 1, Math.floor((dy + 0.5) * sourceSize / markerSize));
      for (let dx = 0; dx < markerSize; dx++) {
        const sx = Math.min(sourceSize - 1, Math.floor((dx + 0.5) * sourceSize / markerSize));
        const alpha = mask[sy * sourceSize + sx];
        if (alpha <= 16) continue;
        const intensity = alpha >= 96 ? 1 : 0.56;
        setPixel(buf, markerX + dx, rowY + dy, lerpColor(COLORS.black, provider.brand, intensity));
      }
    }
  }

  function fittedReset(resetsAt: string | undefined, pctText: string, zoneWidth: number): string {
    const detailed = formatResetDetailed(resetsAt);
    if (!detailed) return '';
    const maxChars = Math.floor(zoneWidth / 4);
    if (pctText.length + detailed.length <= maxChars) return detailed;
    const unit = detailed.match(/^(\d+)[dhm]/);
    return unit ? `${unit[1]}${unit[0].at(-1)}` : detailed.slice(0, Math.max(0, maxChars - pctText.length));
  }

  function subscriptionDate(until: string | undefined): string {
    const value = until?.trim();
    if (!value) return '';
    const iso = value.match(/^\d{4}-(\d{1,2})-(\d{1,2})/);
    if (iso) return `${Number(iso[1])}/${Number(iso[2])}`;
    const compact = value.match(/^~?(\d{1,2})\/(\d{1,2})$/);
    return compact ? `${Number(compact[1])}/${Number(compact[2])}` : '';
  }

  function drawCenteredLabel(text: string, leftX: number, rightX: number, rowY: number): void {
    if (!text) return;
    const textWidth = text.length * 4 - 1;
    const startX = leftX + Math.max(0, Math.floor((rightX - leftX - textWidth) / 2));
    drawText(buf, text, startX + textWidth, rowY + 1, timeColor);
  }

  function renderWindow(
    window: Window, leftX: number, rightX: number, rowY: number, brand: RGB,
  ): void {
    const pct = Math.max(0, Math.min(100, window.percent));
    const color = gaugeColor(pct, animFrame, brand);
    const zoneWidth = rightX - leftX;
    const fillWidth = Math.round(zoneWidth * pct / 100);
    // TC001-style fill: the used portion is a dim full-height color field, so
    // the gauge reads at a glance while bright text remains crisp above it.
    for (let y = rowY; y < rowY + 7; y++) {
      for (let x = leftX; x < leftX + fillWidth; x++) blendPixel(buf, x, y, color, 0.24);
    }
    const pctText = `${Math.round(pct)}%`;
    const resetText = fittedReset(window.resetsAt, pctText, zoneWidth);
    if (resetText) {
      drawText(buf, resetText, rightX, rowY + 1, timeColor);
      drawText(buf, pctText, rightX - resetText.length * 4, rowY + 1, color);
    } else {
      drawText(buf, pctText, rightX, rowY + 1, color);
    }
  }

  providers.forEach((provider, index) => {
    const rowY = firstY + index * 7;
    for (let y = rowY; y < rowY + 7; y++) {
      for (let x = 0; x < 64; x++) {
        blendPixel(buf, x, y, COLORS.black, 0.70);
        blendPixel(buf, x, y, provider.brand, 0.08);
      }
    }
    // A slightly denser identity dock lets the official mark join the same
    // color band without placing quota fill behind the silhouette itself.
    for (let y = rowY; y < rowY + 7; y++) {
      for (let x = 0; x < 9; x++) blendPixel(buf, x, y, provider.brand, 0.12);
    }
    drawCreatureMarker(provider, rowY);

    if (provider.primary && provider.secondary) {
      for (let y = rowY + 1; y < rowY + 6; y++) blendPixel(buf, 36, y, provider.brand, 0.28);
      renderWindow(provider.primary, 9, 36, rowY, provider.brand);
      renderWindow(provider.secondary, 37, 64, rowY, provider.brand);
    } else if (!provider.primary && provider.secondary && subscriptionDate(provider.subscriptionUntil)) {
      for (let y = rowY + 1; y < rowY + 6; y++) blendPixel(buf, 36, y, provider.brand, 0.28);
      drawCenteredLabel(subscriptionDate(provider.subscriptionUntil), 9, 36, rowY);
      renderWindow(provider.secondary, 37, 64, rowY, provider.brand);
    } else {
      const only = provider.primary ?? provider.secondary;
      if (only) renderWindow(only, 9, 64, rowY, provider.brand);
    }
  });
}

/**
 * Render the Timebox Mini's native 11×11 Agent Beacon, then nearest-scale into
 * the requested output. A stable 9×9 official mark carries identity while the
 * one-pixel perimeter rail alone carries state and motion.
 */
function renderMicroFrame(
  outputBuf: Uint8Array,
  size: number,
  animFrame: number,
  stateEvent: StateUpdateEvent | null,
  sessions: SessionInfo[] | null,
  usagePct: number,
  subagentActivity: SubagentActivityBySession,
  now: number,
): void {
  // Presence-driven SSOT: the crayfish renders iff the daemon emitted an
  // OpenClaw session — never from raw gateway flags. The daemon emits it iff
  // the Gateway is authenticated, so reachability/error alone won't draw it.
  const hasGateway = hasOpenClawSession(sessions ?? []);
  const gatewayHasError = stateEvent?.gatewayHasError ?? false;

  // Pick the dominant creature: awaiting (most urgent) → processing → idle.
  const byPriority = (c: CreatureInstance) =>
    c.state === 'awaiting' ? 0 : c.state === 'processing' ? 1 : 2;
  const dominant = [...creatureInstances.values()].sort((a, b) => byPriority(a) - byPriority(b))[0];

  // When the only creature is the gateway crayfish, its routing state still
  // drives the background (no dominant creature instance exists for OpenClaw).
  const routing = sessions?.some((s) => s.agentType === 'openclaw' && s.state === 'processing') ?? false;

  const aggregate: MicroAggregate =
    gatewayHasError || usagePct >= 90 ? 'error'
      : dominant?.state === 'awaiting' ? 'awaiting'
        : (dominant?.state === 'processing' || (!dominant && routing)) ? 'processing'
          : 'idle';

  const base = new Uint8Array(MICRO_SIZE * MICRO_SIZE * 3);
  let creature: MicroCreature | null = null;
  if (dominant) {
    creature =
      dominant.agentType === 'antigravity' ? 'antigravity'
        : dominant.creatureType === 'kiro' ? 'kiro'
        : dominant.creatureType === 'jellyfish' ? 'jellyfish'
          : dominant.creatureType === 'opencode' ? 'opencode'
            : 'octopus';
  } else if (hasGateway) {
    creature = 'crayfish';
  }
  paintTimeboxBeacon(base, creature, aggregate, animFrame);

  // At 11×11 a literal orbit would destroy the official mark. Keep only a
  // fixed perimeter constellation: up to three cyan companion pixels owned by
  // the dominant parent. It is static, legible, and still non-interactive.
  const dominantActivity = dominant
    ? subagentActivity[dominant.sessionId]
    : undefined;
  const companionPixels: ReadonlyArray<readonly [number, number]> = [
    [0, 0], [10, 0], [10, 10],
  ];
  for (let i = 0; i < Math.min(dominantActivity?.activeCount ?? 0, 3); i++) {
    setPixel(base, companionPixels[i][0], companionPixels[i][1], [0, 229, 255]);
  }
  const completionAge = dominantActivity?.lastCompletedAt == null
    ? Infinity
    : now - dominantActivity.lastCompletedAt;
  if (completionAge >= 0 && completionAge < 4_000) {
    setPixel(base, 0, 10, [170, 245, 255]);
  }

  // Scale the 11×11 base into the size×size output (1:1 when size === 11).
  for (let y = 0; y < size; y++) {
    const sy = Math.min(MICRO_SIZE - 1, Math.floor((y * MICRO_SIZE) / size));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(MICRO_SIZE - 1, Math.floor((x * MICRO_SIZE) / size));
      const s = (sy * MICRO_SIZE + sx) * 3;
      const d = (y * size + x) * 3;
      outputBuf[d] = base[s]; outputBuf[d + 1] = base[s + 1]; outputBuf[d + 2] = base[s + 2];
    }
  }
}

/** Native 32×32 iDotMatrix identity stage. The panel gets saturated official
 * marks on a quiet field plus four fixed telemetry rails; no 64px scene is
 * downsampled, so cutouts remain physical pixels. */
function renderCompact32Frame(
  outputBuf: Uint8Array,
  animFrame: number,
  stateEvent: StateUpdateEvent | null,
  sessions: SessionInfo[] | null,
  usageEvent: UsageEvent | null,
  subagentActivity: SubagentActivityBySession,
  now: number,
): void {
  const set = (x: number, y: number, color: RGB) => setPixel(outputBuf, x, y, color);
  const state = String(stateEvent?.state ?? State.IDLE);

  for (let y = 0; y < 28; y++) {
    const t = y / 27;
    const color: RGB = [2 + Math.round(5 * t), 7 + Math.round(10 * t), 18 + Math.round(18 * t)];
    for (let x = 0; x < 32; x++) set(x, y, color);
  }
  const surface: RGB = state.startsWith('awaiting') ? [255, 190, 45]
    : state === 'processing' ? [50, 225, 255] : [38, 210, 145];
  for (let x = 0; x < 32; x++) {
    if ((x + Math.floor(animFrame / 4)) % (state === 'processing' ? 3 : 6) === 0) set(x, 2, surface);
  }

  const glyphFor = (kind: CreatureType): OfficialDotGlyphName =>
    kind === 'jellyfish' ? 'codex' : kind === 'opencode' ? 'openCode'
      : kind === 'antigravity' ? 'antigravity' : kind === 'kiro' ? 'kiro' : 'claudeCode';
  const priority = (s: CreatureInstance['state']) => s === 'awaiting' ? 0 : s === 'processing' ? 1 : 2;
  const marks: Array<{
    glyph: OfficialDotGlyphName;
    state: CreatureInstance['state'];
    sessionId?: string;
  }> = [...creatureInstances.values()].map((c) => ({
    glyph: glyphFor(c.creatureType),
    state: c.state,
    sessionId: c.sessionId,
  }));
  if (hasOpenClawSession(sessions ?? [])) {
    const routing = sessions?.some((s) => s.agentType === 'openclaw' && s.state === 'processing') ?? false;
    marks.push({ glyph: 'openClaw', state: routing ? 'processing' : 'idle' });
  }
  marks.sort((a, b) => priority(a.state) - priority(b.state));
  marks.splice(3);

  const slots = marks.length === 1 ? [{ x: 16, y: 14, size: 18 }]
    : marks.length === 2 ? [{ x: 9, y: 14, size: 13 }, { x: 23, y: 14, size: 13 }]
      : [{ x: 6, y: 14, size: 10 }, { x: 16, y: 14, size: 10 }, { x: 26, y: 14, size: 10 }];
  const antigravityBands: RGB[] = [
    [92, 214, 77], [245, 203, 36], [255, 132, 16], [255, 82, 65],
    [183, 92, 182], [102, 111, 225], [36, 126, 255],
  ];
  const baseColor = (glyph: OfficialDotGlyphName, sx: number): RGB => {
    if (glyph === 'claudeCode') return [255, 112, 76];
    if (glyph === 'codex') return [126, 116, 255];
    if (glyph === 'openCode') return [255, 246, 248];
    if (glyph === 'openClaw') return [255, 67, 84];
    if (glyph === 'kiro') return [124, 58, 237];
    return antigravityBands[Math.min(antigravityBands.length - 1,
      Math.floor(sx * antigravityBands.length / OFFICIAL_DOT_GLYPH_SIZE))];
  };

  marks.forEach((mark, index) => {
    const slot = slots[index];
    const mask = OFFICIAL_DOT_GLYPHS[mark.glyph];
    const bob = mark.state === 'processing' ? Math.round(Math.sin((animFrame + index * 5) * 0.28)) : 0;
    const x0 = slot.x - Math.floor(slot.size / 2);
    const y0 = slot.y - Math.floor(slot.size / 2) + bob;
    for (let dy = 0; dy < slot.size; dy++) {
      const sy = Math.min(OFFICIAL_DOT_GLYPH_SIZE - 1, Math.floor(dy * OFFICIAL_DOT_GLYPH_SIZE / slot.size));
      for (let dx = 0; dx < slot.size; dx++) {
        const sx = Math.min(OFFICIAL_DOT_GLYPH_SIZE - 1, Math.floor(dx * OFFICIAL_DOT_GLYPH_SIZE / slot.size));
        const alpha = mask[sy * OFFICIAL_DOT_GLYPH_SIZE + sx] / 255;
        if (alpha <= 0.04) continue;
        const color = baseColor(mark.glyph, sx);
        blendPixel(outputBuf, x0 + dx + 1, y0 + dy + 1, [0, 0, 0], alpha * 0.55);
        if (alpha > 0.42) {
          blendPixel(outputBuf, x0 + dx - 1, y0 + dy, color, 0.055);
          blendPixel(outputBuf, x0 + dx + 1, y0 + dy, color, 0.055);
        }
        const coverage = Math.min(1, Math.pow(alpha, 0.72) * 1.12);
        const light = 1.08 - dy / Math.max(1, slot.size - 1) * 0.12;
        const lit: RGB = [
          Math.min(255, Math.round(color[0] * light)),
          Math.min(255, Math.round(color[1] * light)),
          Math.min(255, Math.round(color[2] * light)),
        ];
        blendPixel(outputBuf, x0 + dx, y0 + dy, lit, coverage);
      }
    }
    if (mark.glyph === 'openClaw') {
      set(x0 + Math.round(9.05 / 24 * slot.size), y0 + Math.round(7.63 / 24 * slot.size), [0, 229, 204]);
      set(x0 + Math.round(15.38 / 24 * slot.size), y0 + Math.round(7.63 / 24 * slot.size), [0, 229, 204]);
    }
    if (mark.state === 'processing') {
      for (let spark = 0; spark < 3; spark++) {
        const angle = animFrame * 0.24 + spark * Math.PI * 2 / 3;
        const radius = slot.size / 2 + 1;
        set(Math.round(slot.x + Math.cos(angle) * radius), Math.round(slot.y + bob + Math.sin(angle) * radius), [110, 235, 255]);
      }
    } else if (mark.state === 'awaiting') {
      set(Math.min(31, x0 + slot.size), Math.max(2, y0), [255, 190, 45]);
      set(Math.min(31, x0 + slot.size), Math.max(2, y0 + 1), [255, 190, 45]);
    }

    const activity = mark.sessionId ? subagentActivity[mark.sessionId] : undefined;
    const visibleCount = Math.min(activity?.activeCount ?? 0, 3);
    for (let satellite = 0; satellite < visibleCount; satellite++) {
      const angle = now / 2_500 + satellite * Math.PI * 2 / visibleCount;
      const radius = slot.size / 2 + 2;
      const sx = Math.round(slot.x + Math.cos(angle) * radius);
      const sy = Math.round(slot.y + bob + Math.sin(angle) * radius * 0.45);
      set(Math.round((slot.x + sx) / 2), Math.round((slot.y + bob + sy) / 2), [20, 92, 112]);
      set(sx, sy, [0, 229, 255]);
    }
    const completionAge = activity?.lastCompletedAt == null
      ? Infinity
      : now - activity.lastCompletedAt;
    if (completionAge >= 0 && completionAge < 4_000) {
      set(Math.max(0, x0 - 1), Math.max(2, y0 - 1), [170, 245, 255]);
      set(Math.min(31, x0 + slot.size), Math.max(2, y0 - 1), [170, 245, 255]);
    }
  });

  if (marks.length === 0) {
    for (const [x, y] of [[14, 12], [15, 11], [16, 12], [17, 11], [18, 12], [15, 14], [16, 15], [17, 14]]) {
      set(x, y, [76, 206, 220]);
    }
  }

  const primary = usageEvent?.codexRateLimits?.primary?.stale === true
    ? undefined : usageEvent?.codexRateLimits?.primary?.usedPercent;
  const secondary = usageEvent?.codexRateLimits?.secondary?.stale === true
    ? undefined : usageEvent?.codexRateLimits?.secondary?.usedPercent;
  // One-pixel telemetry rails, PRESENT ONES ONLY. On a 32-row panel each rail is
  // 3% of the whole display, so reserving a row for a provider that reports
  // nothing (a Claude-only user, a free-tier Codex account, the App Store Swift
  // daemon with no Claude quota path) spent that height on a dead black stripe.
  // Building the list first and anchoring it to the BOTTOM edge keeps the rails
  // where the eye expects them while every unclaimed row falls back to the tank.
  const telemetry: Array<[number, RGB]> = [];
  const rail = (raw: number | undefined, brand: RGB): void => {
    if (raw != null) telemetry.push([raw, brand]);
  };
  rail(usageEvent?.fiveHourPercent, [42, 220, 154]);
  rail(usageEvent?.sevenDayPercent, [54, 154, 255]);
  rail(primary, [185, 86, 255]);
  rail(secondary, [104, 116, 255]);
  const firstRailY = 32 - telemetry.length;
  telemetry.forEach(([raw, brand], row) => {
    const y = firstRailY + row;
    for (let x = 0; x < 32; x++) set(x, y, [5, 8, 14]);
    const pct = Math.max(0, Math.min(100, raw));
    const color: RGB = pct >= 90 ? [255, 58, 72] : pct >= 70 ? [255, 183, 38] : brand;
    set(0, y, brand); set(1, y, brand);
    const width = Math.round(pct / 100 * 29);
    for (let x = 3; x < 3 + width; x++) set(x, y, color);
  });
}

function drawSubagentPixelLine(
  buf: Uint8Array,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: RGB,
): void {
  let x = Math.round(fromX);
  let y = Math.round(fromY);
  const targetX = Math.round(toX);
  const targetY = Math.round(toY);
  const dx = Math.abs(targetX - x);
  const sx = x < targetX ? 1 : -1;
  const dy = -Math.abs(targetY - y);
  const sy = y < targetY ? 1 : -1;
  let error = dx + dy;
  let step = 0;
  while (true) {
    if ((step++ & 1) === 0) blendPixel(buf, x, y, color, 0.42);
    if (x === targetX && y === targetY) break;
    const twiceError = error * 2;
    if (twiceError >= dy) {
      error += dy;
      x += sx;
    }
    if (twiceError <= dx) {
      error += dx;
      y += sy;
    }
  }
}

function drawSubagentOrbitForCreature(
  buf: Uint8Array,
  creature: CreatureInstance,
  camera: Camera,
  activity: SubagentVisualActivity,
  animFrame: number,
  now: number,
): void {
  const completionAge = activity.lastCompletedAt == null
    ? Infinity
    : now - activity.lastCompletedAt;
  const completionProgress = completionAge >= 0 && completionAge < 4_000
    ? completionAge / 4_000
    : null;
  if (activity.activeCount <= 0 && completionProgress == null) return;

  const [centerX, centerY] = worldToScreen(creature.worldX, creature.worldY, camera);
  const radiusX = Math.max(6, 7.5 * creature.sizeScale * camera.zoom);
  const radiusY = Math.max(2, radiusX * 0.38);
  const tilt = -0.28;
  const point = (angle: number, multiplier = 1): [number, number] => {
    const localX = Math.cos(angle) * radiusX * multiplier;
    const localY = Math.sin(angle) * radiusY * multiplier;
    return [
      centerX + localX * Math.cos(tilt) - localY * Math.sin(tilt),
      centerY + localX * Math.sin(tilt) + localY * Math.cos(tilt),
    ];
  };

  if (activity.activeCount > 0) {
    const ringColor: RGB = [20, 105, 126];
    for (let step = 0; step < 44; step += 2) {
      const [x, y] = point(step / 44 * Math.PI * 2);
      blendPixel(buf, Math.round(x), Math.round(y), ringColor, 0.76);
    }

    const visibleCount = Math.min(activity.activeCount, 3);
    for (let index = 0; index < visibleCount; index++) {
      const angle = animFrame * 0.072 + index * Math.PI * 2 / visibleCount;
      const [satelliteX, satelliteY] = point(angle);
      drawSubagentPixelLine(
        buf,
        centerX,
        centerY,
        satelliteX,
        satelliteY,
        [16, 90, 110],
      );
      glowPixel(
        buf,
        Math.round(satelliteX),
        Math.round(satelliteY),
        [0, 229, 255],
        0.88,
      );

      if (index === 2 && activity.activeCount > 3) {
        const labelX = Math.max(4, Math.min(57, Math.round(satelliteX + 5)));
        const labelY = Math.max(1, Math.min(58, Math.round(satelliteY - 3)));
        setPixel(buf, labelX, labelY + 2, [160, 245, 255]);
        setPixel(buf, labelX - 1, labelY + 2, [160, 245, 255]);
        setPixel(buf, labelX + 1, labelY + 2, [160, 245, 255]);
        setPixel(buf, labelX, labelY + 1, [160, 245, 255]);
        setPixel(buf, labelX, labelY + 3, [160, 245, 255]);
        drawText(
          buf,
          String(activity.activeCount - 3),
          Math.min(64, labelX + 8),
          labelY,
          [160, 245, 255],
        );
      }
    }
  }

  if (completionProgress != null) {
    const pulseRadius = radiusX * (0.72 + completionProgress * 0.58);
    const pulseColor: RGB = [130, 238, 255];
    for (let step = 0; step < 36; step += 2) {
      const angle = step / 36 * Math.PI * 2;
      blendPixel(
        buf,
        Math.round(centerX + Math.cos(angle) * pulseRadius),
        Math.round(centerY + Math.sin(angle) * pulseRadius),
        pulseColor,
        (1 - completionProgress) * 0.76,
      );
    }
  }
}

function drawSubagentOrbits(
  buf: Uint8Array,
  camera: Camera,
  activityBySession: SubagentActivityBySession,
  animFrame: number,
  now: number,
): void {
  for (const creature of creatureInstances.values()) {
    const activity = activityBySession[creature.sessionId];
    if (!activity) continue;
    drawSubagentOrbitForCreature(buf, creature, camera, activity, animFrame, now);
  }
}

/**
 * Render a complete frame with camera system.
 * Returns RGB buffer.
 *
 * `layout='micro'` renders the Timebox Mini Agent Beacon;
 * `'standard'` is the full terrarium.
 */
export function renderFrame(
  stateEvent: StateUpdateEvent | null,
  usageEvent: UsageEvent | null,
  sessions: SessionInfo[] | null,
  timeOverrideMs?: number,
  size: 11 | 32 | 64 = 64,
  layout: 'standard' | 'micro' = 'standard',
  subagentActivity: SubagentActivityBySession = {},
): Uint8Array {
  const worldBuf = new Uint8Array(W * W * 3);
  const outputBuf = new Uint8Array(size * size * 3);
  const animFrame = getAnimFrame(timeOverrideMs);

  if (layout === 'micro') {
    // Still sync creature instances so dominant-creature selection reflects live state.
    syncCreatures(sessions, stateEvent);
    renderMicroFrame(
      outputBuf,
      size,
      animFrame,
      stateEvent,
      sessions,
      usageEvent?.fiveHourPercent ?? 0,
      subagentActivity,
      timeOverrideMs ?? Date.now(),
    );
    return outputBuf;
  }

  if (size === 32) {
    syncCreatures(sessions, stateEvent);
    renderCompact32Frame(
      outputBuf,
      animFrame,
      stateEvent,
      sessions,
      usageEvent,
      subagentActivity,
      timeOverrideMs ?? Date.now(),
    );
    return outputBuf;
  }

  const state = stateEvent?.state ?? State.IDLE;
  const usagePct = usageEvent?.fiveHourPercent ?? 0;
  const surfaceY = SURFACE_Y;
  const palette = ZONE_BLUE; // Water stays blue — usage shown only via HUD gauge

  // Presence-driven SSOT: crayfish renders iff the daemon emitted an OpenClaw
  // session (authenticated), not from raw gateway reachability/error flags.
  const hasGateway = hasOpenClawSession(sessions ?? []);

  // === Sync creature instances ===
  syncCreatures(sessions, stateEvent);

  // === Build active creatures list for camera ===
  const activeCreatures: ActiveCreature[] = [];
  for (const c of creatureInstances.values()) {
    if (c.state === 'awaiting') {
      activeCreatures.push({ x: c.worldX, y: c.worldY, priority: 0 });
    } else if (c.state === 'processing') {
      activeCreatures.push({ x: c.worldX, y: c.worldY, priority: 1 });
    }
  }

  // Crayfish routing
  const cfX = CF_DEFAULT_X;
  const cfY = CF_DEFAULT_Y;
  const crayfishRouting = hasGateway && (sessions?.some(s =>
    s.agentType === 'openclaw' && s.state === 'processing'
  ) ?? false);
  if (crayfishRouting) {
    activeCreatures.push({ x: cfX, y: cfY, priority: 2 });
  }

  // === Update camera director ===
  const now = timeOverrideMs ?? Date.now();
  const dt = lastRenderTime > 0 ? Math.min(5, (now - lastRenderTime) / 1000) : 1.0;
  lastRenderTime = now;
  const schoolPos = getSchoolCenter();
  let camera = updateDirector(
    dt, activeCreatures, crayfishRouting,
    hasGateway ? { x: cfX, y: cfY } : null,
    schoolPos,
  );
  
  // Adaptive zoom out when multiple sessions are active to increase spacing & breathing room
  const activeSessionCount = creatureInstances.size;
  if (activeSessionCount > 1 && camera.zoom === 1.0) {
    camera.zoom = Math.max(0.78, 1.0 - (activeSessionCount - 1) * 0.11);
  }
  
  camera.width = size; // Set camera target resolution width

  // Snap the camera center to whole device pixels so a fixed sprite cell (a
  // creature eye) doesn't sub-step as the camera lerps. Applied to the single
  // camera shared by the background blit and every creature draw → they stay
  // pixel-aligned. Must run after the adaptive-zoom tweak above so the final
  // zoom is what we quantize against.
  camera = quantizeCameraPixels(camera);

  // ========================================
  // Phase 1: Render environment → world buffer
  // ========================================

  // Water body
  for (let y = 0; y < SAND_TOP; y++) {
    const color = waterColorAt(palette, surfaceY, y);
    for (let x = 0; x < W; x++) setPixel(worldBuf, x, y, color);
  }

  // Terrain
  drawTerrain(worldBuf);

  // Light rays
  drawLightRays(worldBuf, animFrame, surfaceY);

  // Caustics
  drawCaustics(worldBuf, animFrame, surfaceY);

  // Seaweed
  drawSeaweed(worldBuf, animFrame, surfaceY);

  // Effective state: prefer creature-derived state over stateEvent (daemon may be stale)
  const anyCreatureProcessing = [...creatureInstances.values()].some(c => c.state === 'processing');
  const anyCreatureAwaiting = [...creatureInstances.values()].some(c => c.state === 'awaiting');
  const effectiveState = anyCreatureProcessing ? State.PROCESSING
    : anyCreatureAwaiting ? State.AWAITING_OPTION
      : state;

  // Bubbles
  const bubbleDensity = effectiveState === State.PROCESSING ? 10 : effectiveState === State.IDLE ? 3 : 5;
  updateBubbles(animFrame, surfaceY, bubbleDensity);
  for (const b of bubbles) {
    const bx = Math.round(b.x);
    const by = Math.round(b.y);
    blendPixel(worldBuf, bx, by, b.bright ? COLORS.bubbleBright : COLORS.bubble, 0.6);
  }

  // Data particles (spawn when any creature is processing)
  const anyProcessing = [...creatureInstances.values()].some(c => c.state === 'processing');
  updateDataParticles(animFrame, surfaceY, anyProcessing);
  for (const p of dataParticles) {
    const fadeAlpha = Math.min(1, p.life / 10);
    const color = p.green ? COLORS.dataParticleGreen : COLORS.dataParticle;
    glowPixel(worldBuf, Math.round(p.x), Math.round(p.y), color, 0.5 * fadeAlpha);
  }

  // Tetras — update always
  const tetraMaxY = SAND_TOP - 3;
  updateTetras(animFrame, surfaceY, tetraMaxY);

  // Surface waves — use effectiveState so daemon doesn't suppress wave animation
  drawSurface(worldBuf, animFrame, surfaceY, palette, effectiveState);

  // ========================================
  // Phase 2: Blit world → output with camera
  // ========================================
  blitWithCamera(worldBuf, outputBuf, camera);

  // ========================================
  // Phase 3: Draw scaled creatures → output
  // ========================================

  // Tetras (always drawn — camera-scaled)
  if (tetras) {
    for (const t of tetras) {
      drawTetra(outputBuf, t.x / W, t.y / W, t.heading, camera);
    }
  }

  drawSubagentOrbits(
    outputBuf,
    camera,
    subagentActivity,
    animFrame,
    now,
  );

  // Creature instances — octopus or jellyfish based on agent type
  const creatureOrder = [...creatureInstances.keys()];
  for (const c of creatureInstances.values()) {
    const sessionToneIndex = creatureOrder.indexOf(c.sessionId);
    const spriteState: 'idle' | 'working' | 'sleeping' | 'asking' =
      c.state === 'processing' ? 'working'
        : c.state === 'awaiting' ? 'asking'
          : 'idle'; // IDLE → idle (limbs move, body color preserved)

    const glyph = c.creatureType === 'jellyfish' ? 'codex'
      : c.creatureType === 'opencode' ? 'openCode'
        : c.creatureType === 'antigravity' ? 'antigravity'
          : c.creatureType === 'kiro' ? 'kiro'
          : 'claudeCode';
    drawOfficialDotGlyph(
      outputBuf,
      glyph,
      c.worldX,
      c.worldY,
      spriteState,
      animFrame + c.phaseOffset,
      camera,
      sessionToneIndex,
      c.sizeScale,
    );
  }

  // Crayfish — always drawn when gateway available; IDLE = sitting (subtle breathing only)
  if (hasGateway) {
    const gatewayHasError = stateEvent?.gatewayHasError ?? false;
    drawOfficialDotGlyph(
      outputBuf,
      'openClaw',
      cfX,
      cfY,
      crayfishRouting ? 'working' : 'idle',
      animFrame,
      camera,
      0,
      1.0,
      gatewayHasError,
    );
  }

  // ========================================
  // Phase 4: Screen-space overlays
  // ========================================

  // Danger flash (>90% usage)
  if (usagePct >= 90) {
    const flashIntensity = (Math.sin(animFrame * 0.2) + 1) * 0.08;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        glowPixel(outputBuf, x, y, COLORS.stateError, flashIntensity);
      }
    }
  }

  // Session count indicator (top-left, screen-space) — colored dots when 2+ sessions
  const sessionCount = creatureInstances.size;
  if (sessionCount >= 2) {
    const orderedCreatures = [...creatureInstances.values()];
    for (let i = 0; i < Math.min(sessionCount, 6); i++) {
      const dotX = 1 + i * 3;  // 2px dot + 1px gap
      const c = orderedCreatures[i];
      // Color the dot by agent type so OpenCode is distinguishable, not painted as an octopus.
      const dotColor = c.creatureType === 'jellyfish'
        ? getJellyfishPaletteForSession(i).body
        : c.creatureType === 'opencode'
          ? getOpenCodePaletteForSession(i).outer
          : c.creatureType === 'antigravity'
            ? getAntigravityPaletteForSession(i).yellow
          : c.creatureType === 'kiro'
            ? [124, 58, 237] as RGB
          : getOctopusPaletteForSession(i).body;
      setPixel(outputBuf, dotX, 1, dotColor);
      setPixel(outputBuf, dotX + 1, 1, dotColor);
      setPixel(outputBuf, dotX, 2, dotColor);
      setPixel(outputBuf, dotX + 1, 2, dotColor);
    }
  }

  // Usage HUD (bottom-right, screen-space)
  drawUsageHUD(outputBuf, usageEvent, animFrame);

  return outputBuf;
}

// ===== Disconnected Frame =====

/** Render a static black frame with centered grey "OFFLINE" text. */
export function renderDisconnectedFrame(): Uint8Array {
  const buf = new Uint8Array(64 * 64 * 3); // black
  drawTextCentered(buf, 29, PASSIVE_OFFLINE_LABEL, '#555555');
  return buf;
}

// ===== Preview API (re-export camera controls) =====
/**
 * Introspection seam: the creature set `renderFrame` would draw for this input,
 * without rasterizing anything. Counting marks back out of a 64×64 buffer is
 * far too fragile to assert on, so tests and the preview CLI read the resolved
 * world placement from here instead.
 *
 * This runs the same `syncCreatures` the renderer runs, so it mutates the module's
 * creature state exactly as a real frame would.
 */
export function getCreatureLayoutSnapshot(
  sessions: SessionInfo[] | null,
  stateEvent: StateUpdateEvent | null,
): Array<{
  sessionId: string;
  agentType: string;
  creatureType: CreatureType;
  state: 'idle' | 'processing' | 'awaiting';
  worldX: number;
  worldY: number;
  sizeScale: number;
}> {
  syncCreatures(sessions, stateEvent);
  return [...creatureInstances.values()].map(c => ({
    sessionId: c.sessionId,
    agentType: c.agentType,
    creatureType: c.creatureType,
    state: c.state,
    worldX: c.worldX,
    worldY: c.worldY,
    sizeScale: c.sizeScale,
  }));
}

export { setZone, setOverride, resetDirector } from './pixoo-camera.js';
export type { Camera } from './pixoo-camera.js';
export { ZONES } from './pixoo-camera.js';
