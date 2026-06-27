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
import type { StateUpdateEvent, UsageEvent } from '../types.js';
import type { SessionInfo } from '@agentdeck/shared/protocol';
import { hasOpenClawSession } from '@agentdeck/shared';
import { drawTextCentered } from './pixoo-font.js';
import {
  type RGB, COLORS, setPixel, blendPixel, glowPixel, fillRect, lerpColor,
  drawOctopus, drawJellyfish, drawOpenCode, drawCrayfish, drawTetra,
  drawText,
  getOctopusPaletteForSession, getJellyfishPaletteForSession, getOpenCodePaletteForSession,
  OCTO_WORLD_W, JF_WORLD_W, CF_WORLD_W,
} from './pixoo-sprites.js';
import {
  type Camera, type ActiveCreature, CAMERA_WIDE, blitWithCamera, quantizeCameraPixels,
  updateDirector, setZone, setOverride, resetDirector,
  worldToScreen, isVisible,
  WORLD_SIZE, ACTIVE_SIZE,
} from './pixoo-camera.js';
import {
  MICRO_SIZE, microStatusBg, paintMicroGlyph,
  type MicroCreature, type MicroState,
} from './micro-glyphs.js';

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
}

/** Golden ratio constant for position distribution. */
const PHI = (1 + Math.sqrt(5)) / 2;

/** Active creature instances keyed by sessionId. */
const creatureInstances = new Map<string, CreatureInstance>();

/** Agent types that represent coding agents (draw as octopus). */
const CODING_AGENTS = new Set(['claude-code']);
/** Agent types drawn as jellyfish (cloud creature). */
const JELLYFISH_AGENTS = new Set(['codex-cli', 'codex-app']);
/** Agent types drawn as nested-square opencode. */
const OPENCODE_AGENTS = new Set(['opencode']);

type CreatureType = 'octopus' | 'jellyfish' | 'opencode';

// Y positions by state — idle nearly on sand, active higher up
const IDLE_Y = 0.78;      // just above sand line (sleeping on ground)
const WORKING_Y = 0.42;   // mid-water (working/starburst)
const ASKING_Y = 0.38;    // slightly higher (room for "?" bubble)

function stateY(state: 'idle' | 'processing' | 'awaiting'): number {
  if (state === 'processing') return WORKING_Y;
  if (state === 'awaiting') return ASKING_Y;
  return IDLE_Y;
}

/** Check if agent type gets a creature. */
function isCreatureAgent(agentType: string): boolean {
  return CODING_AGENTS.has(agentType) || JELLYFISH_AGENTS.has(agentType) || OPENCODE_AGENTS.has(agentType);
}

function creatureTypeFor(agentType: string): CreatureType {
  if (JELLYFISH_AGENTS.has(agentType)) return 'jellyfish';
  if (OPENCODE_AGENTS.has(agentType)) return 'opencode';
  return 'octopus';
}

function syncCreatures(
  sessions: SessionInfo[] | null,
  stateEvent: StateUpdateEvent | null,
): void {
  // Determine which sessions are alive creature agents (octopus or jellyfish)
  const aliveCoding: { id: string; agentType: string; state: string }[] = [];
  if (sessions) {
    for (const s of sessions) {
      if (s.alive && s.agentType && isCreatureAgent(s.agentType)) {
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

  // Add/update creatures
  for (let i = 0; i < aliveCoding.length; i++) {
    const s = aliveCoding[i];
    const existing = creatureInstances.get(s.id);
    const sessionState = mapSessionState(s.state);
    
    // Uniformly distribute X positions to maximize spacing and prevent overlap
    const x = aliveCoding.length === 1
      ? 0.38  // single session: classic center-left
      : 0.15 + (i / (aliveCoding.length - 1)) * 0.70;

    if (existing) {
      existing.state = sessionState;
      existing.agentType = s.agentType;
      existing.creatureType = creatureTypeFor(s.agentType);
      existing.worldX = x; // Update X dynamically to maintain even spacing
      existing.worldY = stateY(sessionState);
    } else {
      creatureInstances.set(s.id, {
        sessionId: s.id,
        agentType: s.agentType,
        creatureType: creatureTypeFor(s.agentType),
        state: sessionState,
        worldX: x,
        worldY: stateY(sessionState),
        phaseOffset: i * 5,
      });
    }
  }

  // Override primary session state from stateEvent (more precise than polling)
  // Only when stateEvent is from a creature agent — daemon/openclaw report stale IDLE
  const aType = stateEvent?.agentType as string | undefined;
  const isCreature = isCreatureAgent(aType ?? '');
  if (stateEvent && isCreature && aliveCoding.length > 0) {
    const primaryId = aliveCoding[0].id;
    const primary = creatureInstances.get(primaryId);
    if (primary) {
      const st = simplifiedState(stateEvent.state ?? State.IDLE) as 'idle' | 'processing' | 'awaiting';
      primary.state = st;
      primary.worldY = stateY(st);
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
function gaugeColor(pct: number, animFrame: number): RGB {
  if (pct >= 90) {
    // Red with pulse
    const pulse = (Math.sin(animFrame * 0.2) + 1) * 0.3;
    return lerpColor(COLORS.stateError, COLORS.white, pulse) as RGB;
  }
  if (pct >= 70) return COLORS.stateAwaiting;  // amber
  if (pct >= 50) return [0x00, 0xC8, 0xB4] as unknown as RGB;  // teal
  return COLORS.stateProcessing;  // blue
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

/** Draw Usage HUD in screen space (bottom right, zoom-independent).
 *  Single row at rows 57-63:
 *    - 7d absent: full-width, right-aligned (original behavior)
 *    - 7d present: left half [0..30]=5h  |  right half [32..63]=7d
 */
function drawUsageHUD(
  buf: Uint8Array, usageEvent: UsageEvent | null, animFrame: number,
): void {
  // Hide the HUD entirely when upstream flags the data as stale — otherwise
  // an old "12%" frozen on-screen looks authoritative to the user even though
  // the CLI daemon isn't live to produce a fresh fetch. Matches the collapse
  // behavior on every other surface (macOS dashboard, plugin, Android, D200H).
  if (!usageEvent || usageEvent.fiveHourPercent == null) return;
  if (usageEvent.usageStale === true) return;

  const w = Math.sqrt(buf.length / 3);
  const textY = w === 32 ? 26 : 58;
  const bgTop = textY - 1;
  const bgBot = textY + 5;

  // Full-width dark base — hides sand/terrain at HUD rows regardless of camera zoom
  for (let y = bgTop; y <= bgBot; y++) {
    for (let x = 0; x < w; x++) {
      blendPixel(buf, x, y, COLORS.black, 0.55);
    }
  }

  const timeColor: RGB = [0x60, 0x70, 0x80];

  /** Render a zone: usage background fill + two-color text (pct + time). */
  function renderZone(
    pctText: string, timeText: string, pct: number, leftX: number, rightX: number,
  ): void {
    const color = gaugeColor(pct, animFrame);
    const zoneW = rightX - leftX + 1;
    const fillW = Math.round(zoneW * Math.max(0, Math.min(100, pct)) / 100);
    // Background fill proportional to usage
    for (let y = bgTop; y <= bgBot; y++) {
      for (let x = leftX; x < leftX + fillW; x++) {
        blendPixel(buf, x, y, color, 0.35);
      }
    }
    // Two-color text: time (dimmed) right-aligned, then pct (gauge color) to its left
    if (timeText) {
      drawText(buf, timeText, rightX, textY, timeColor);
      const timeW = timeText.length * 4; // 3px glyph + 1px gap per char
      drawText(buf, pctText, rightX - timeW, textY, color);
    } else {
      drawText(buf, pctText, rightX, textY, color);
    }
  }

  const pct5 = usageEvent.fiveHourPercent;

  if (w === 32) {
    // Single compact zone for 32x32 screens
    const r5 = formatResetDetailed(usageEvent.fiveHourResetsAt);
    renderZone(`${Math.round(pct5)}%`, r5, pct5, 0, 31);
    return;
  }

  if (usageEvent.sevenDayPercent == null) {
    // Single full-width zone
    const r5 = formatResetDetailed(usageEvent.fiveHourResetsAt);
    renderZone(`${Math.round(pct5)}%`, r5, pct5, 0, 63);
    return;
  }

  // Two-column layout: [5h | 7d]
  const pct7 = usageEvent.sevenDayPercent;
  const r5 = formatResetDetailed(usageEvent.fiveHourResetsAt);
  const r7 = formatResetDetailed(usageEvent.sevenDayResetsAt);
  renderZone(`${Math.round(pct5)}%`, r5, pct5, 0, 30);
  renderZone(`${Math.round(pct7)}%`, r7, pct7, 32, 63);
}

/**
 * Render the micro layout natively at 11×11 using hand-authored creature glyphs,
 * then nearest-scale into the `size`×`size` output. The Timebox Mini has 121 LEDs;
 * downscaling the 32×32 terrarium bottoms out at a fuzzy silhouette, so micro draws
 * a bold per-pixel glyph (octopus/jellyfish/opencode/crayfish) on a dark
 * status-color field. The device fetches `size=11` for a pixel-perfect 1:1 frame.
 */
function renderMicroFrame(
  outputBuf: Uint8Array,
  size: number,
  animFrame: number,
  stateEvent: StateUpdateEvent | null,
  sessions: SessionInfo[] | null,
  usagePct: number,
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

  const aggregate: 'idle' | 'processing' | 'awaiting' | 'error' =
    gatewayHasError || usagePct >= 90 ? 'error'
      : dominant?.state === 'awaiting' ? 'awaiting'
        : (dominant?.state === 'processing' || (!dominant && routing)) ? 'processing'
          : 'idle';

  // Build the native 11×11 frame: dark status field + bold creature glyph.
  const base = new Uint8Array(MICRO_SIZE * MICRO_SIZE * 3);
  const bg = microStatusBg(aggregate, animFrame);
  for (let i = 0; i < MICRO_SIZE * MICRO_SIZE; i++) {
    base[i * 3] = bg[0]; base[i * 3 + 1] = bg[1]; base[i * 3 + 2] = bg[2];
  }

  const glyphState: MicroState =
    dominant?.state === 'processing' ? 'working'
      : dominant?.state === 'awaiting' ? 'asking'
        : 'idle';
  if (dominant) {
    const creature: MicroCreature =
      dominant.creatureType === 'jellyfish' ? 'jellyfish'
        : dominant.creatureType === 'opencode' ? 'opencode'
          : 'octopus';
    paintMicroGlyph(base, creature, glyphState, animFrame);
  } else if (hasGateway) {
    paintMicroGlyph(base, 'crayfish', routing ? 'working' : 'idle', animFrame);
  }
  // else: no creatures at all → the solid status field is the whole signal.

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

/**
 * Render a complete frame with camera system.
 * Returns RGB buffer.
 *
 * `layout='micro'` renders a single dominant creature on a status field for
 * tiny screens (Timebox Mini 11×11); `'standard'` is the full terrarium.
 */
export function renderFrame(
  stateEvent: StateUpdateEvent | null,
  usageEvent: UsageEvent | null,
  sessions: SessionInfo[] | null,
  timeOverrideMs?: number,
  size: 11 | 32 | 64 = 64,
  layout: 'standard' | 'micro' = 'standard',
): Uint8Array {
  const worldBuf = new Uint8Array(W * W * 3);
  const outputBuf = new Uint8Array(size * size * 3);
  const animFrame = getAnimFrame(timeOverrideMs);

  if (layout === 'micro') {
    // Still sync creature instances so dominant-creature selection reflects live state.
    syncCreatures(sessions, stateEvent);
    renderMicroFrame(outputBuf, size, animFrame, stateEvent, sessions, usageEvent?.fiveHourPercent ?? 0);
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

  // Creature instances — octopus or jellyfish based on agent type
  const creatureOrder = [...creatureInstances.keys()];
  for (const c of creatureInstances.values()) {
    const sessionToneIndex = creatureOrder.indexOf(c.sessionId);
    const spriteState: 'idle' | 'working' | 'sleeping' | 'asking' =
      c.state === 'processing' ? 'working'
        : c.state === 'awaiting' ? 'asking'
          : 'idle'; // IDLE → idle (limbs move, body color preserved)

    if (c.creatureType === 'jellyfish') {
      drawJellyfish(
        outputBuf,
        c.worldX,
        c.worldY,
        spriteState,
        animFrame + c.phaseOffset,
        camera,
        getJellyfishPaletteForSession(sessionToneIndex),
      );
    } else if (c.creatureType === 'opencode') {
      drawOpenCode(
        outputBuf,
        c.worldX,
        c.worldY,
        spriteState,
        animFrame + c.phaseOffset,
        camera,
        getOpenCodePaletteForSession(sessionToneIndex),
      );
    } else {
      drawOctopus(
        outputBuf,
        c.worldX,
        c.worldY,
        spriteState,
        animFrame + c.phaseOffset,
        camera,
        getOctopusPaletteForSession(sessionToneIndex),
      );
    }
  }

  // Crayfish — always drawn when gateway available; IDLE = sitting (subtle breathing only)
  if (hasGateway) {
    const gatewayHasError = stateEvent?.gatewayHasError ?? false;
    drawCrayfish(outputBuf, cfX, cfY, crayfishRouting, animFrame, camera, gatewayHasError);
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
  drawTextCentered(buf, 29, 'OFFLINE', '#555555');
  return buf;
}

// ===== Preview API (re-export camera controls) =====
export { setZone, setOverride, resetDirector } from './pixoo-camera.js';
export type { Camera } from './pixoo-camera.js';
export { ZONES } from './pixoo-camera.js';
