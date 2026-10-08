/**
 * TUI Terrarium — canonical colored-cell aquarium animation.
 * Creature behavior matches Android/iOS/ESP32:
 * - IDLE/SLEEPING: octopus rests on sea floor (touching sand), gentle bob
 * - PROCESSING: octopus swims upward with starburst, tetra school converges
 * - AWAITING: octopus mid-water with "?" bubble
 * - Crayfish: larger than octopus, right side, heartbeat(sitting)/active(routing)
 * - Tetra: 2 schools (5 each), Lissajous centers, boids cohesion
 * - Scaling: small (default) / large (2×) based on terminal size
 */

import { fg, bg, RESET, DIM, BOLD, colors, sgr } from './ansi.js';
import { TERRARIUM_RULES, UI, agentBrandColor, type AgentType } from '@agentdeck/shared';
import { OFFICIAL_DOT_GLYPHS, OFFICIAL_DOT_GLYPH_SIZE, OFFICIAL_STANDARD_FEATURES } from '../pixoo/official-dot-glyphs.generated.js';

// ===== Sprite Scaling =====

type SpriteScale = 'small' | 'large' | 'xlarge';

export const TUI_SPRITE_SCALE_RULES = [
  { scale: 'xlarge', minWidth: 160, minHeight: 35 },
  { scale: 'large', minWidth: 100, minHeight: 20 },
] as const;
function getSpriteScale(width: number, height: number): SpriteScale {
  return TUI_SPRITE_SCALE_RULES.find(rule => width >= rule.minWidth && height >= rule.minHeight)?.scale ?? 'small';
}

// Existing terminal footprints are retained. Two colored half-block samples per
// cell preserve original materials; tiny details are area sampled, never enlarged
// into invented eyes. A terminal cell cannot independently color 8 braille dots.
const TERMINAL_FOOTPRINTS = {
  claudeCode: { small: [7, 2], large: [14, 3], xlarge: [21, 4] },
  codex: { small: [5, 2], large: [10, 4], xlarge: [15, 6] },
  openClaw: { small: [8, 2], large: [16, 4], xlarge: [24, 6] },
  openCode: { small: [5, 3], large: [5, 5], xlarge: [6, 7] },
  // Square marks sampled at the Codex footprint. Native previews mirror only
  // the four creatures above (scripts/generate-tui-creatures.mjs).
  antigravity: { small: [5, 2], large: [10, 4], xlarge: [15, 6] },
  kiro: { small: [5, 2], large: [10, 4], xlarge: [15, 6] },
  hermes: { small: [5, 2], large: [10, 4], xlarge: [15, 6] },
} as const;
const GLYPH_AGENT: Record<keyof typeof TERMINAL_FOOTPRINTS, string> = {
  claudeCode: 'claude-code', codex: 'codex-cli', openClaw: 'openclaw', openCode: 'opencode',
  antigravity: 'antigravity', kiro: 'kiro-cli', hermes: 'hermes',
};
interface TerminalPixel { rgb: number[]; alpha: number; }
interface TerminalCell { char: string; top: TerminalPixel | null; bottom: TerminalPixel | null; }
interface TerminalSprite { braille: string[]; cells: TerminalCell[][]; color: string; }
export interface OctopusInstance { id: string; x: number; y: number; homeX: number; state: string; name?: string; phaseOffset: number; }
export interface JellyfishInstance { id: string; x: number; y: number; homeX: number; state: string; name?: string; phaseOffset: number; }
interface CrayfishState { visible: boolean; routing: boolean; sick: boolean; x: number; y: number; name?: string; }

export function canonicalTerminalSprite(glyph: string, scale: SpriteScale, color: string): TerminalSprite {
  if (!Object.hasOwn(TERMINAL_FOOTPRINTS, glyph)) return { braille: [], cells: [], color };
  const key = glyph as keyof typeof TERMINAL_FOOTPRINTS;
  const [cols, rows] = TERMINAL_FOOTPRINTS[key][scale];
  const n = OFFICIAL_DOT_GLYPH_SIZE;
  const hex = agentBrandColor(GLYPH_AGENT[key] as AgentType);
  const sourceRGB = color.match(/38;2;(\d+);(\d+);(\d+)m/);
  const rgb = sourceRGB ? sourceRGB.slice(1).map(Number) : [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const mask = OFFICIAL_DOT_GLYPHS[key];
  // Premultiplied sourceRGBA, followed by the exact semantic feature contours.
  const alpha = Array.from(mask, a => a / 255);
  const channels = alpha.map(a => rgb.map(c => c * a));
  for (const layer of OFFICIAL_STANDARD_FEATURES[key]) for (let y = 0; y < layer.height; y++) for (let x = 0; x < layer.width; x++) {
    const i = (layer.y + y) * n + layer.x + x, a = layer.alpha[y * layer.width + x] / 255;
    channels[i] = channels[i].map((c, channel) => c * (1 - a) + layer.rgb[channel] * a);
    alpha[i] = alpha[i] * (1 - a) + a;
  }
  const side = Math.min(cols, rows * 2), left = Math.floor((cols - side) / 2), top = Math.floor((rows * 2 - side) / 2);
  const sample = (x: number, y: number): TerminalPixel | null => {
    x -= left; y -= top;
    if (x < 0 || y < 0 || x >= side || y >= side) return null;
    const x0 = x * n / side, x1 = (x + 1) * n / side, y0 = y * n / side, y1 = (y + 1) * n / side;
    const sum = [0, 0, 0]; let a = 0;
    for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
      const weight = (Math.min(x1, sx + 1) - Math.max(x0, sx)) * (Math.min(y1, sy + 1) - Math.max(y0, sy));
      const i = sy * n + sx; a += alpha[i] * weight;
      channels[i].forEach((c, k) => { sum[k] += c * weight; });
    }
    if (a === 0) return null;
    return { rgb: sum.map(c => c / a), alpha: Math.min(1, a / ((x1 - x0) * (y1 - y0))) };
  };
  const cells = Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => {
    const upper = sample(col, row * 2), lower = sample(col, row * 2 + 1);
    return { char: upper ? '▀' : lower ? '▄' : ' ', top: upper, bottom: lower };
  }));
  return { braille: cells.map(row => row.map(c => c.char).join('')), cells, color };
}
function renderOctopus(inst: OctopusInstance, _frame: number, scale: SpriteScale): TerminalSprite {
  return canonicalTerminalSprite('claudeCode', scale, inst.state === 'disconnected' ? DIM + colors.octopus : colors.octopus);
}
function renderJellyfish(inst: JellyfishInstance, frame: number, scale: SpriteScale): TerminalSprite {
  const color = inst.state === 'disconnected' ? DIM + colors.jellyfish : inst.state === 'processing' && Math.sin((frame + inst.phaseOffset) * .2) > 0 ? colors.jellyfishGlow : colors.jellyfish;
  return canonicalTerminalSprite('codex', scale, color);
}
function renderCrayfish(state: CrayfishState, frame: number, scale: SpriteScale): TerminalSprite {
  const t = frame % 50, pulse = t < 5 || (t > 8 && t < 13);
  const color = state.sick ? DIM + fg(180, 140, 140) : state.routing || pulse ? colors.crayfish : DIM + colors.crayfish;
  return canonicalTerminalSprite('openClaw', scale, color);
}

// Creature status grammar (DESIGN.md §6.4): input-needed is a solid amber
// `!`, working adds a cyan geometric spark. Colour stays redundant with shape.
function tokenFg(hex: string): string {
  return fg(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
}
const ATTN_BADGE = tokenFg(UI.attn);
const WORK_SPARK = tokenFg(UI.cyan);

// ===== Neon Tetra =====

interface Fish { x: number; y: number; vx: number; vy: number; }
interface FishSchool { fish: Fish[]; centerX: number; centerY: number; }

function initSchool(count: number, seed: number): FishSchool {
  const fish: Fish[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    fish.push({
      x: 0.4 + seed * 0.2 + Math.cos(angle) * 0.08,
      y: 0.3 + Math.sin(angle) * 0.06,
      vx: (seed % 2 === 0 ? 1 : -1) * (0.003 + Math.random() * 0.002),
      vy: (Math.random() - 0.5) * 0.002,
    });
  }
  return { fish, centerX: 0.4 + seed * 0.2, centerY: 0.3 + seed * 0.1 };
}

function updateSchool(
  school: FishSchool, frame: number, seed: number,
  attractTarget?: { x: number; y: number },
): void {
  const t = frame * 0.015;
  school.centerX = 0.3 + 0.25 * Math.sin(t * (1.0 + seed * 0.4));
  school.centerY = 0.2 + 0.18 * Math.cos(t * (0.7 + seed * 0.3));

  for (const f of school.fish) {
    let targetX = school.centerX;
    let targetY = school.centerY;
    if (attractTarget) {
      targetX = targetX * 0.7 + attractTarget.x * 0.3;
      targetY = targetY * 0.7 + attractTarget.y * 0.3;
    }
    f.vx += (targetX - f.x) * 0.008;
    f.vy += (targetY - f.y) * 0.008;
    for (const other of school.fish) {
      if (other === f) continue;
      const sx = f.x - other.x, sy = f.y - other.y;
      const dist = Math.sqrt(sx * sx + sy * sy);
      if (dist < 0.05 && dist > 0) {
        f.vx += (sx / dist) * 0.002;
        f.vy += (sy / dist) * 0.002;
      }
    }
    const speed = Math.sqrt(f.vx * f.vx + f.vy * f.vy);
    if (speed > 0.008) { f.vx = (f.vx / speed) * 0.008; f.vy = (f.vy / speed) * 0.008; }
    f.x += f.vx; f.y += f.vy;
    if (f.x > 0.92) { f.x = 0.92; f.vx *= -0.5; }
    if (f.x < 0.03) { f.x = 0.03; f.vx *= -0.5; }
    if (f.y > 0.62) { f.y = 0.62; f.vy *= -0.5; }
    if (f.y < 0.08) { f.y = 0.08; f.vy *= -0.5; }
  }
}

// ===== Environment =====

const WAVE_CHARS = ['~', '\u2248', '\u223F', '~', '\u2248'];
const BUBBLE_CHARS = ['\u00B0', '\u00B7', '\u25CB', '\u25E6'];

interface Bubble { x: number; y: number; char: string; speed: number; }

// ===== OpenCode — Canonical Hollow Vertical Ring =====

export interface OpenCodeInstance {
  id: string;
  x: number;
  y: number;
  homeX: number;
  state: string;
  name?: string;
  phaseOffset: number;
}

function renderOpenCode(inst: OpenCodeInstance, frame: number, scale: SpriteScale): TerminalSprite & { lines: string[] } {
  const sleeping = inst.state === 'sleeping' || inst.state === 'paused';
  const color = sleeping ? DIM + fg(160, 158, 158) : inst.state === 'processing' && ((frame + inst.phaseOffset) % 30 < 15) ? fg(207, 206, 205) : fg(241, 236, 236);
  const sprite = canonicalTerminalSprite('openCode', scale, color);
  return { ...sprite, lines: sprite.braille };
}

interface TerrariumContext {
  bubbles: Bubble[];
  schools: FishSchool[];
  octopi: OctopusInstance[];
  jellyfish: JellyfishInstance[];
  opencode: OpenCodeInstance[];
  residents: ResidentInstance[];
  crayfish: CrayfishState;
  voiceAssistantState: string;
}

/**
 * Agents whose creature is their canonical mark drawn as-is: Antigravity, Kiro
 * and Hermes. Before these existed the TUI drew nothing for them (the correct
 * polarity for an UNKNOWN agent, wrong for a known one).
 */
export type ResidentGlyph = 'antigravity' | 'kiro' | 'hermes';
export interface ResidentInstance {
  id: string; glyph: ResidentGlyph; x: number; y: number; homeX: number;
  state: string; name?: string; phaseOffset: number;
}
const RESIDENT_GLYPH: Record<string, ResidentGlyph> = {
  antigravity: 'antigravity', 'kiro-cli': 'kiro', 'kiro-ide': 'kiro', hermes: 'hermes',
};

export function initTerrarium(): TerrariumContext {
  const bubbles: Bubble[] = [];
  for (let i = 0; i < 8; i++) {
    bubbles.push({
      x: 0.1 + Math.random() * 0.8,
      y: 0.3 + Math.random() * 0.6,
      char: BUBBLE_CHARS[Math.floor(Math.random() * BUBBLE_CHARS.length)],
      speed: 0.008 + Math.random() * 0.015,
    });
  }
  return {
    bubbles,
    schools: [initSchool(5, 0), initSchool(5, 1)],
    octopi: [],
    jellyfish: [],
    opencode: [],
    residents: [],
    crayfish: { visible: false, routing: false, sick: false, x: 0.75, y: 0.88 },
    voiceAssistantState: 'disabled',
  };
}

export function updateTerrarium(ctx: TerrariumContext, frame: number): void {
  for (const b of ctx.bubbles) {
    b.y -= b.speed;
    b.x += Math.sin(frame * 0.1 + b.x * 10) * 0.003;
    if (b.y < 0.02) {
      b.y = 0.85 + Math.random() * 0.1;
      b.x = 0.1 + Math.random() * 0.8;
    }
  }

  // Attract target: processing octopus > processing jellyfish > routing crayfish > none
  const activeOct = ctx.octopi.find(o => o.state === 'processing');
  const activeJelly = ctx.jellyfish.find(j => j.state === 'processing');
  let attractTarget: { x: number; y: number } | undefined;
  if (activeOct) {
    attractTarget = { x: activeOct.x, y: activeOct.y };
  } else if (activeJelly) {
    attractTarget = { x: activeJelly.x, y: activeJelly.y };
  } else if (ctx.crayfish.visible && ctx.crayfish.routing) {
    attractTarget = { x: ctx.crayfish.x, y: ctx.crayfish.y };
  }
  for (let i = 0; i < ctx.schools.length; i++) {
    updateSchool(ctx.schools[i], frame, i, attractTarget);
  }

  // Animate octopi Y — IDLE touches the floor (0.88), PROCESSING swims up
  for (const oct of ctx.octopi) {
    // Target Y: idle/disconnected/sleeping → floor, processing → swimming, awaiting → mid
    const targetY = oct.state === 'processing' ? 0.30 :
                    oct.state.startsWith('awaiting') ? 0.50 :
                    0.88; // idle, disconnected → flush with sand
    oct.y += (targetY - oct.y) * 0.05;
    // Bob: small for idle (resting), larger for swimming
    const bobAmp = oct.state === 'processing' ? 0.02 : 0.005;
    const bobFreq = oct.state === 'processing' ? 0.15 : 0.04;
    oct.y += Math.sin((frame + oct.phaseOffset) * bobFreq) * bobAmp;
  }

  // Animate jellyfish — near surface when processing, floor when idle
  for (const jf of ctx.jellyfish) {
    const isProcessing = jf.state === 'processing';
    const targetY = isProcessing ? 0.10 :
                    jf.state.startsWith('awaiting') ? 0.50 :
                    0.85;
    jf.y += (targetY - jf.y) * 0.03;
    const bobAmp = isProcessing ? 0.015 : 0.01;
    const bobFreq = isProcessing ? 0.12 : 0.03;
    jf.y += Math.sin((frame + jf.phaseOffset) * bobFreq) * bobAmp;
    // Processing: wide side-to-side drift near surface
    const driftAmp = isProcessing ? 0.06 : 0.002;
    const driftSpeed = isProcessing ? 0.02 : 0.02;
    jf.x += Math.sin((frame + jf.phaseOffset) * driftSpeed) * driftAmp;
    // Cap the drift at the crayfish clear anchor — idle jellyfish also sink
    // to the floor and 0.65 reached into the crayfish claws (left edge ~0.64).
    jf.x = Math.max(0.08, Math.min(TERRARIUM_RULES.crayfish.clearMaxX, jf.x));
  }

  // OpenCode Y — same state-Y mapping as octopus
  for (const oc of ctx.opencode) {
    const targetY = oc.state === 'processing' ? 0.30 :
                    oc.state.startsWith('awaiting') ? 0.50 : 0.88;
    oc.y += (targetY - oc.y) * 0.04;
    if (oc.state === 'processing') {
      oc.y += Math.sin((frame + oc.phaseOffset) * 0.08) * 0.006;
    }
  }

  // Mark residents — same state→depth grammar as the octopus, gentle drift.
  for (const r of ctx.residents) {
    const working = r.state === 'processing';
    const targetY = working ? 0.32 : r.state.startsWith('awaiting') ? 0.50 : 0.86;
    r.y += (targetY - r.y) * 0.04;
    r.y += Math.sin((frame + r.phaseOffset) * (working ? 0.12 : 0.04)) * (working ? 0.012 : 0.004);
    const drift = working ? Math.sin((frame + r.phaseOffset) * 0.03) * 0.04 : 0;
    r.x = Math.max(0.06, Math.min(TERRARIUM_RULES.crayfish.clearMaxX, r.homeX + drift));
  }

  // Crayfish Y: routing swims up, sitting rests on floor
  const crayfishTargetY = ctx.crayfish.routing ? 0.50 : 0.85;
  ctx.crayfish.y += (crayfishTargetY - ctx.crayfish.y) * 0.04;
}

export function setOctopi(
  ctx: TerrariumContext,
  sessions: Array<{ id?: string; state: string; name?: string; agentType?: string }>,
): void {
  // Allow-list, not a deny-list. Spelled the other way round this read
  // "everything that isn't one of these five is a Claude octopus", so every
  // agent added after it was written swam as Claude: antigravity and both Kiro
  // types were drawn with Claude's creature in the TUI aquarium. A wrong
  // identity is worse than a missing one — an unknown agent renders as nothing
  // here, which is the documented polarity (AGENTS.md, "An unknown agentType
  // renders as nothing or as a neutral default — never as another agent").
  // Mirrors `isOctopusAgent` (Swift) / `isOctopusAgentType` (Kotlin) and
  // `CODING_AGENTS` in bridge/src/pixoo/pixoo-renderer.ts.
  const octSessions = sessions.filter(s => (s.agentType as string) === 'claude-code');
  const count = octSessions.length;
  // Count name occurrences to number duplicates
  const nameCounts = new Map<string, number>();
  for (const s of octSessions) {
    const n = s.name || '';
    nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
  }
  const nameSeq = new Map<string, number>();
  const newOctopi: OctopusInstance[] = [];
  for (let i = 0; i < count; i++) {
    const s = octSessions[i];
    const sid = s.id || `oct-${i}`;
    const baseName = s.name || '';
    const seq = (nameSeq.get(baseName) || 0) + 1;
    nameSeq.set(baseName, seq);
    const displayName = (nameCounts.get(baseName) || 0) > 1
      ? `${baseName} #${seq}` : baseName;
    const homeX = count === 1 ? 0.28 : 0.12 + (i * 0.40) / Math.max(1, count - 1);
    const existing = ctx.octopi.find(o => o.id === sid);
    if (existing) {
      existing.state = s.state;
      existing.name = displayName || undefined;
      existing.homeX = homeX;
      existing.x = homeX;
      newOctopi.push(existing);
    } else {
      newOctopi.push({
        id: sid,
        x: homeX, y: 0.88, homeX,
        state: s.state, name: displayName || undefined,
        phaseOffset: Math.floor(Math.random() * 40),
      });
    }
  }
  ctx.octopi = newOctopi;
}

export function setCrayfish(ctx: TerrariumContext, visible: boolean, routing: boolean, name?: string, sick?: boolean): void {
  ctx.crayfish.visible = visible;
  ctx.crayfish.routing = routing;
  ctx.crayfish.sick = sick || false;
  if (name !== undefined) ctx.crayfish.name = name;
}

export function setJellyfish(
  ctx: TerrariumContext,
  sessions: Array<{ id?: string; state: string; name?: string; agentType?: string }>,
): void {
  const jellySessions = sessions.filter(s => (s.agentType as string) === 'codex-cli' || (s.agentType as string) === 'codex-app');
  const count = jellySessions.length;
  const nameCounts = new Map<string, number>();
  for (const s of jellySessions) {
    const n = s.name || '';
    nameCounts.set(n, (nameCounts.get(n) || 0) + 1);
  }
  const nameSeq = new Map<string, number>();
  const newJellyfish: JellyfishInstance[] = [];
  for (let i = 0; i < count; i++) {
    const s = jellySessions[i];
    const sid = s.id || `jf-${i}`;
    const baseName = s.name || '';
    const seq = (nameSeq.get(baseName) || 0) + 1;
    nameSeq.set(baseName, seq);
    const displayName = (nameCounts.get(baseName) || 0) > 1
      ? `${baseName} #${seq}` : baseName;
    // Jellyfish home: right of center, between octopi and crayfish
    const homeX = count === 1 ? 0.50 : 0.38 + (i * 0.25) / Math.max(1, count - 1);
    const existing = ctx.jellyfish.find(j => j.id === sid);
    if (existing) {
      existing.state = s.state;
      existing.name = displayName || undefined;
      existing.homeX = homeX;
      existing.x = homeX;
      newJellyfish.push(existing);
    } else {
      newJellyfish.push({
        id: sid,
        x: homeX, y: 0.55, homeX,
        state: s.state, name: displayName || undefined,
        phaseOffset: Math.floor(Math.random() * 60),
      });
    }
  }
  ctx.jellyfish = newJellyfish;
}

export function setOpenCode(
  ctx: TerrariumContext,
  sessions: Array<{ id?: string; state: string; name?: string; agentType?: string }>,
): void {
  const ocSessions = sessions.filter(s => (s.agentType as string) === 'opencode');
  const count = ocSessions.length;
  const nameCounts = new Map<string, number>();
  for (const s of ocSessions) { const n = s.name || ''; nameCounts.set(n, (nameCounts.get(n) || 0) + 1); }
  const nameSeq = new Map<string, number>();
  const newOc: OpenCodeInstance[] = [];
  for (let i = 0; i < count; i++) {
    const s = ocSessions[i];
    const sid = s.id || `oc-${i}`;
    const baseName = s.name || '';
    const seq = (nameSeq.get(baseName) || 0) + 1;
    nameSeq.set(baseName, seq);
    const displayName = (nameCounts.get(baseName) || 0) > 1 ? `${baseName} #${seq}` : baseName;
    // Idle OpenCode sinks to the floor at homeX — keep the anchor clear of the
    // crayfish territory (cross-platform rule, shared/src/terrarium-rules.ts).
    const homeX = Math.min(
      TERRARIUM_RULES.crayfish.clearMaxX,
      count === 1 ? 0.55 : 0.48 + (i * 0.20) / Math.max(1, count - 1),
    );
    const existing = ctx.opencode.find(o => o.id === sid);
    if (existing) {
      existing.state = s.state; existing.name = displayName || undefined;
      existing.homeX = homeX; existing.x = homeX;
      newOc.push(existing);
    } else {
      newOc.push({ id: sid, x: homeX, y: 0.88, homeX, state: s.state, name: displayName || undefined, phaseOffset: Math.floor(Math.random() * 40) });
    }
  }
  ctx.opencode = newOc;
}

export function setResidents(
  ctx: TerrariumContext,
  sessions: Array<{ id?: string; state: string; name?: string; agentType?: string }>,
): void {
  const list = sessions.filter(s => RESIDENT_GLYPH[s.agentType ?? ''] !== undefined);
  const count = list.length;
  const next: ResidentInstance[] = [];
  for (let i = 0; i < count; i++) {
    const s = list[i]!;
    const sid = s.id || `res-${i}`;
    // Spread across the open water left of the crayfish's floor territory.
    const homeX = Math.min(
      TERRARIUM_RULES.crayfish.clearMaxX,
      count === 1 ? 0.40 : 0.16 + (i * 0.44) / Math.max(1, count - 1),
    );
    const glyph = RESIDENT_GLYPH[s.agentType!]!;
    const existing = ctx.residents.find(r => r.id === sid);
    if (existing) {
      Object.assign(existing, { glyph, state: s.state, name: s.name || undefined, homeX });
      next.push(existing);
    } else {
      next.push({ id: sid, glyph, x: homeX, y: 0.86, homeX, state: s.state, name: s.name || undefined, phaseOffset: Math.floor(Math.random() * 40) });
    }
  }
  ctx.residents = next;
}

export function setVoiceAssistantState(ctx: TerrariumContext, state: string): void {
  ctx.voiceAssistantState = state;
}

// ===== Render Frame =====

function stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Priority for tag placement: needs-you, working, then quiet. */
function labelRank(state: string): number {
  return state.startsWith('awaiting') ? 0 : state === 'processing' ? 1 : 2;
}

function placeLabel(
  chars: string[], charColors: string[], charBackgrounds: string[], taken: boolean[],
  text: string, centerX: number, color: string,
): void {
  const plain = stripAnsiCodes(text);
  const startX = centerX - Math.floor(plain.length / 2);
  for (let i = 0; i < plain.length; i++) {
    const px = startX + i;
    if (px < 0 || px >= chars.length || taken[px]) return;
    // A creature cell (half-block body) is never covered by a tag.
    if (chars[px] === '\u2580' || chars[px] === '\u2584' || charBackgrounds[px]) return;
  }
  for (let i = 0; i < plain.length; i++) {
    const px = startX + i;
    chars[px] = plain[i]!;
    charColors[px] = color;
    taken[px] = true;
  }
}

export function renderTerrariumFrame(
  ctx: TerrariumContext, width: number, height: number, frame: number,
): string[] {
  if (height < 3 || width < 20) return [];
  const scale = getSpriteScale(width, height);
  const scaleFactor = scale === 'xlarge' ? 3 : scale === 'large' ? 2 : 1;
  const lines: string[] = [];
  const octopusSprites = ctx.octopi.map(o => renderOctopus(o, frame, scale));
  const codexSprites = ctx.jellyfish.map(o => renderJellyfish(o, frame, scale));
  const openCodeSprites = ctx.opencode.map(o => renderOpenCode(o, frame, scale));
  const residentSprites = ctx.residents.map(r => canonicalTerminalSprite(r.glyph, scale, r.state === 'disconnected' ? DIM : ''));
  const clawSprite = renderCrayfish(ctx.crayfish, frame, scale);
  const sandRow = height - 2; // sand starts at this row

  for (let row = 0; row < height; row++) {
    const t = row / height;
    const r = Math.floor(10 + t * 20);
    const g = Math.floor(22 + t * 36);
    const bv = Math.floor(40 + t * 55);
    const bgColor = bg(r, g, bv);
    const chars: string[] = new Array(width).fill(' ');
    const charColors: string[] = new Array(width).fill('');
    const charBackgrounds: string[] = new Array(width).fill('');
    // Name tags are collected and drawn after every creature (DESIGN.md §6.4:
    // one post-creature pass, priority order, a tag never hides a body).
    const labels: Array<{ text: string; x: number; color: string; rank: number }> = [];
    const placeCell = (px: number, cell: TerminalCell, color: string) => {
      if (px < 0 || px >= width || (!cell.top && !cell.bottom)) return;
      const paint = (p: TerminalPixel) => p.rgb.map((c, i) => Math.round(c * p.alpha + [r, g, bv][i] * (1 - p.alpha)));
      const upper = cell.top ? paint(cell.top) : null, lower = cell.bottom ? paint(cell.bottom) : null;
      const foreground = upper ?? lower!;
      chars[px] = cell.char;
      charColors[px] = sgr(22) + (color.includes(DIM) ? DIM : '') + fg(foreground[0], foreground[1], foreground[2]);
      charBackgrounds[px] = upper && lower ? bg(lower[0], lower[1], lower[2]) : '';
    };

    // Water surface wave (row 0)
    if (row === 0) {
      for (let x = 0; x < width; x++) {
        chars[x] = WAVE_CHARS[(x + frame) % WAVE_CHARS.length];
        charColors[x] = fg(100, 149, 237);
      }
    }

    // Sand/gravel bottom (last 2 rows)
    if (row >= sandRow) {
      for (let x = 0; x < width; x++) {
        const sandChars = row === height - 1 ? '░▒░░░░▒▒░░' : '░░░░▒░░░░░';
        chars[x] = sandChars[(x * 7 + 3) % sandChars.length];
        charColors[x] = colors.sand;
      }
    }

    // Seaweed
    if (row >= height - 5 && row < sandRow) {
      const positions = [0.04, 0.10, 0.18, 0.85, 0.92, 0.97];
      for (const pos of positions) {
        const sx = Math.floor(pos * width);
        if (sx >= 0 && sx < width) {
          const depth = sandRow - row;
          if (depth <= 1) chars[sx] = '\u2502';
          else chars[sx] = Math.sin(frame * 0.05 + pos * 15) > 0 ? '\u2571' : '\u2572';
          charColors[sx] = colors.seaweed;
        }
      }
    }

    // Bubbles
    for (const b of ctx.bubbles) {
      const bx = Math.floor(b.x * width);
      const by = Math.floor(b.y * height);
      if (by === row && bx >= 0 && bx < width) {
        chars[bx] = b.char;
        charColors[bx] = colors.bubble;
      }
    }

    // Fish (scale-aware: small=3, large=5, xlarge=7 chars)
    for (const school of ctx.schools) {
      for (const f of school.fish) {
        const fx = Math.floor(f.x * width);
        const fy = Math.floor(f.y * height);
        const fishStrs = scale === 'xlarge'
          ? (f.vx > 0 ? '>>><>>>' : '<<<><<<')
          : scale === 'large'
          ? (f.vx > 0 ? '>><>>' : '<<><>')
          : (f.vx > 0 ? '><>' : '<><');
        const fishLen = fishStrs.length;
        const midIdx = Math.floor(fishLen / 2);
        if (fy === row && fx >= 1 && fx < width - fishLen + 1) {
          for (let c = 0; c < fishLen; c++) {
            if (fx + c < width) {
              chars[fx + c] = fishStrs[c];
              charColors[fx + c] = c === midIdx ? colors.tetraStripe : colors.tetraNeon;
            }
          }
        }
      }
    }

    // Octopi (scale-aware braille)
    for (const [index, oct] of ctx.octopi.entries()) {
      const { braille, color, cells } = octopusSprites[index];
      const octHalfW = Math.floor(braille[0]?.length / 2) || 3;
      const ox = Math.floor(oct.x * width) - octHalfW;
      const oy = Math.floor(oct.y * height) - Math.floor(braille.length / 2);
      for (let br = 0; br < braille.length; br++) {
        if (oy + br === row) {
          for (let bc = 0; bc < braille[br].length; bc++) {
            const px = ox + bc;
            if (px >= 0 && px < width) {
              placeCell(px, cells[br][bc], color);
            }
          }
        }
      }
      // Name tag — directly above braille sprite
      if (oct.name && oy - 1 === row) {
        const name = oct.name.length > 12 ? oct.name.slice(0, 11) + '\u2026' : oct.name;
        labels.push({ text: name, x: Math.floor(oct.x * width), color: fg(180, 180, 180), rank: labelRank(oct.state) });
      }
      // "?" bubble — below sprite (not on name tag row, to avoid overlap)
      if (oct.state.startsWith('awaiting') && oy + braille.length === row) {
        const qx = Math.floor(oct.x * width) + octHalfW + 1;
        if (qx >= 0 && qx < width) { chars[qx] = '!'; charColors[qx] = BOLD + ATTN_BADGE; }
      }
      // Voice assistant indicator — above active octopus (first octopus or processing one)
      if (ctx.voiceAssistantState !== 'disabled' && ctx.voiceAssistantState !== 'idle') {
        const isVoiceTarget = ctx.octopi.length <= 1 || oct === ctx.octopi.find(o => o.state === 'processing') || oct === ctx.octopi[0];
        if (isVoiceTarget) {
          if (ctx.voiceAssistantState === 'listening') {
            // Musical note above octopus
            if (oy - 1 === row) {
              const mX = Math.floor(oct.x * width) + octHalfW + 2;
              if (mX >= 0 && mX < width) { chars[mX] = '\u266A'; charColors[mX] = fg(0, 220, 220); }
            }
            // Expanding listening circles (radio wave visualization)
            for (let ring = 0; ring < 2; ring++) {
              const ringPhase = (frame * 0.15 + ring * 2.5) % 5;
              const radius = (1.5 + ringPhase) * scaleFactor * 0.6;
              for (let p = 0; p < 6; p++) {
                const angle = (p / 6) * Math.PI * 2;
                const px = Math.floor(oct.x * width + Math.cos(angle) * radius);
                const py = Math.floor(oct.y * height + Math.sin(angle) * radius * 0.5);
                if (py === row && px >= 0 && px < width && chars[px] === ' ') {
                  chars[px] = '\u00B7'; charColors[px] = fg(0, 200, 200);
                }
              }
            }
          } else if (ctx.voiceAssistantState === 'processing') {
            // Animated "..." dots above octopus
            if (oy - 1 === row) {
              const dotCount = (Math.floor(frame / 5) % 3) + 1;
              const dots = '.'.repeat(dotCount);
              const dX = Math.floor(oct.x * width) + octHalfW + 2;
              for (let d = 0; d < dots.length; d++) {
                const px = dX + d;
                if (px >= 0 && px < width) { chars[px] = '.'; charColors[px] = fg(220, 180, 50); }
              }
            }
          } else if (ctx.voiceAssistantState === 'speaking') {
            // Musical double note above octopus
            if (oy - 1 === row) {
              const mX = Math.floor(oct.x * width) + octHalfW + 2;
              if (mX >= 0 && mX < width) { chars[mX] = '\u266C'; charColors[mX] = fg(50, 220, 50); }
            }
            // Wave pattern around octopus
            for (let w = 0; w < 4; w++) {
              const wAngle = (w / 4) * Math.PI * 2 + frame * 0.2;
              const wR = (2.0 + Math.sin(frame * 0.1) * 0.5) * scaleFactor * 0.5;
              const px = Math.floor(oct.x * width + Math.cos(wAngle) * wR);
              const py = Math.floor(oct.y * height + Math.sin(wAngle) * wR * 0.5);
              if (py === row && px >= 0 && px < width && chars[px] === ' ') {
                chars[px] = '\u223F'; charColors[px] = fg(50, 200, 50);
              }
            }
          }
        }
      }
      // Starburst particles
      if (oct.state === 'processing') {
        const burstR = (2 + (frame % 8) * 0.3) * (scaleFactor * 0.75);
        for (let p = 0; p < 6; p++) {
          const angle = (p / 6) * Math.PI * 2 + frame * 0.15;
          const px = Math.floor(oct.x * width + Math.cos(angle) * burstR);
          const py = Math.floor(oct.y * height + Math.sin(angle) * burstR * 0.5);
          // Sparks fill open water only — never over a name tag or a body.
          if (py === row && px >= 0 && px < width && chars[px] === ' ') {
            chars[px] = '\u2727'; charColors[px] = WORK_SPARK;
          }
        }
      }
    }

    // Jellyfish (scale-aware braille)
    for (const [index, jf] of ctx.jellyfish.entries()) {
      const { braille, color, cells } = codexSprites[index];
      const jfHalfW = Math.floor(braille[0]?.length / 2) || 3;
      const jx = Math.floor(jf.x * width) - jfHalfW;
      const jy = Math.floor(jf.y * height) - Math.floor(braille.length / 2);
      for (let br = 0; br < braille.length; br++) {
        if (jy + br === row) {
          for (let bc = 0; bc < braille[br].length; bc++) {
            const px = jx + bc;
            if (px >= 0 && px < width) {
              placeCell(px, cells[br][bc], color);
            }
          }
        }
      }
      // Name tag
      if (jf.name && jy - 1 === row) {
        const name = jf.name.length > 12 ? jf.name.slice(0, 11) + '\u2026' : jf.name;
        labels.push({ text: name, x: Math.floor(jf.x * width), color: fg(180, 180, 180), rank: labelRank(jf.state) });
      }
      // "?" bubble when awaiting
      if (jf.state.startsWith('awaiting') && jy + braille.length === row) {
        const qx = Math.floor(jf.x * width) + jfHalfW + 1;
        if (qx >= 0 && qx < width) { chars[qx] = '!'; charColors[qx] = BOLD + ATTN_BADGE; }
      }
      // Bioluminescent glow particles when processing
      if (jf.state === 'processing') {
        const glowR = (1.5 + Math.sin(frame * 0.1) * 0.5) * (scaleFactor * 0.75);
        for (let p = 0; p < 4; p++) {
          const angle = (p / 4) * Math.PI * 2 + frame * 0.08;
          const px = Math.floor(jf.x * width + Math.cos(angle) * glowR);
          const py = Math.floor(jf.y * height + Math.sin(angle) * glowR * 0.6);
          if (py === row && px >= 0 && px < width && chars[px] === ' ') {
            chars[px] = '\u2022'; // •
            charColors[px] = colors.jellyfishGlow;
          }
        }
      }
    }

    // OpenCode (single-color hollow vertical ring)
    for (const [index, oc] of ctx.opencode.entries()) {
      const { lines, color, cells } = openCodeSprites[index];
      const ocHalfW = Math.floor((lines[0]?.replace(/\x1b\[[^m]*m/g, '').length ?? 5) / 2);
      const ox = Math.floor(oc.x * width) - ocHalfW;
      const oy = Math.floor(oc.y * height) - Math.floor(lines.length / 2);
      for (let lr = 0; lr < lines.length; lr++) {
        if (oy + lr === row) {
          const stripped = lines[lr].replace(/\x1b\[[^m]*m/g, '');
          for (let ci = 0; ci < stripped.length; ci++) {
            const px = ox + ci;
            if (px >= 0 && px < width) {
              placeCell(px, cells[lr][ci], color);
            }
          }
        }
      }
      if (oc.name && oy - 1 === row) {
        const name = oc.name.length > 12 ? oc.name.slice(0, 11) + '\u2026' : oc.name;
        labels.push({ text: name, x: Math.floor(oc.x * width), color: fg(180, 180, 180), rank: labelRank(oc.state) });
      }
      if (oc.state.startsWith('awaiting') && oy + lines.length === row) {
        const qx = Math.floor(oc.x * width) + ocHalfW + 1;
        if (qx >= 0 && qx < width) { chars[qx] = '!'; charColors[qx] = BOLD + ATTN_BADGE; }
      }
    }

    // Mark residents (Antigravity, Kiro, Hermes)
    for (const [index, res] of ctx.residents.entries()) {
      const { braille, color, cells } = residentSprites[index]!;
      const halfW = Math.floor((braille[0]?.length ?? 5) / 2);
      const rx = Math.floor(res.x * width) - halfW;
      const ry = Math.floor(res.y * height) - Math.floor(braille.length / 2);
      for (let br = 0; br < braille.length; br++) {
        if (ry + br !== row) continue;
        for (let bc = 0; bc < braille[br]!.length; bc++) {
          const px = rx + bc;
          if (px >= 0 && px < width) placeCell(px, cells[br]![bc]!, color);
        }
      }
      if (res.name && ry - 1 === row) {
        const name = res.name.length > 12 ? res.name.slice(0, 11) + '\u2026' : res.name;
        labels.push({ text: name, x: Math.floor(res.x * width), color: fg(180, 180, 180), rank: labelRank(res.state) });
      }
      if (res.state.startsWith('awaiting') && ry + braille.length === row) {
        const qx = Math.floor(res.x * width) + halfW + 1;
        if (qx >= 0 && qx < width) { chars[qx] = '!'; charColors[qx] = BOLD + ATTN_BADGE; }
      }
      if (res.state === 'processing') {
        const r = (1.6 + (frame % 10) * 0.2) * (scaleFactor * 0.75);
        for (let p = 0; p < 4; p++) {
          const angle = (p / 4) * Math.PI * 2 + frame * 0.12;
          const px = Math.floor(res.x * width + Math.cos(angle) * r);
          const py = Math.floor(res.y * height + Math.sin(angle) * r * 0.5);
          if (py === row && px >= 0 && px < width && chars[px] === ' ') { chars[px] = '\u2727'; charColors[px] = WORK_SPARK; }
        }
      }
    }

    // Crayfish (scale-aware braille)
    if (ctx.crayfish.visible) {
      const { braille, color, cells } = clawSprite;
      const cfHalfW = Math.floor(braille[0]?.length / 2) || 4;
      const cx = Math.floor(ctx.crayfish.x * width) - cfHalfW;
      const cy = Math.floor(ctx.crayfish.y * height) - Math.floor(braille.length / 2);
      for (let br = 0; br < braille.length; br++) {
        if (cy + br === row) {
          for (let bc = 0; bc < braille[br].length; bc++) {
            const px = cx + bc;
            if (px >= 0 && px < width) {
              placeCell(px, cells[br][bc], color);
            }
          }
        }
      }
      // Crayfish name tag — directly above braille sprite
      const cfBaseName = ctx.crayfish.name || 'OpenClaw';
      const cfName = ctx.crayfish.sick ? `\u26A0 ${cfBaseName}` : cfBaseName;
      const cfNameColor = ctx.crayfish.sick ? fg(200, 120, 120) : fg(180, 180, 180);
      if (cy - 1 === row) {
        labels.push({ text: cfName, x: Math.floor(ctx.crayfish.x * width), color: cfNameColor, rank: ctx.crayfish.sick ? 0 : ctx.crayfish.routing ? 1 : 2 });
      }

      // Signal wave rings + orbiting dots when ROUTING
      if (ctx.crayfish.routing) {
        const cfCenterX = ctx.crayfish.x * width;
        const cfCenterY = ctx.crayfish.y * height;
        const waveScale = scaleFactor * 0.75;
        const waveChars = ['\u25E6', '\u00B7', '\u2219']; // ◦ · ∙

        // 3 concentric signal wave rings, expanding outward
        for (let ring = 0; ring < 3; ring++) {
          const ringPhase = (frame * 0.12 + ring * 2.1) % 6;
          const radius = (2 + ringPhase) * waveScale;
          // Semi-circle (upper half — signals radiate upward/outward)
          for (let p = 0; p < 8; p++) {
            const angle = (p / 8) * Math.PI + Math.PI; // upper semicircle
            const px = Math.floor(cfCenterX + Math.cos(angle) * radius);
            const py = Math.floor(cfCenterY + Math.sin(angle) * radius * 0.5);
            if (py === row && px >= 0 && px < width && chars[px] === ' ') {
              chars[px] = waveChars[ring];
              // Fade opacity with distance
              const fade = Math.max(0, 1 - ringPhase / 6);
              const r = Math.floor(255 * fade);
              const g = Math.floor(107 * fade);
              const b = Math.floor(107 * fade);
              charColors[px] = fg(Math.max(r, 60), Math.max(g, 30), Math.max(b, 30));
            }
          }
        }

        // 4 orbiting signal dots (cyan ✦ — contrasts with octopus gold ✧)
        for (let d = 0; d < 4; d++) {
          const orbitAngle = (d / 4) * Math.PI * 2 + frame * 0.2;
          const orbitRx = (3.5 + Math.sin(frame * 0.08) * 0.5) * waveScale;
          const orbitRy = (1.8 + Math.cos(frame * 0.08) * 0.3) * waveScale;
          const px = Math.floor(cfCenterX + Math.cos(orbitAngle) * orbitRx);
          const py = Math.floor(cfCenterY + Math.sin(orbitAngle) * orbitRy);
          if (py === row && px >= 0 && px < width && chars[px] === ' ') {
            chars[px] = '\u2726'; // ✦
            charColors[px] = colors.tetraNeon;
          }
        }
      }
    }

    // Tags last: most urgent first; a tag yields to bodies and to a tag
    // already placed, but is drawn over water, fish, bubbles and sparks.
    labels.sort((a, b) => a.rank - b.rank);
    const taken = new Array<boolean>(width).fill(false);
    for (const l of labels) placeLabel(chars, charColors, charBackgrounds, taken, l.text, l.x, l.color);

    // Build line
    let line = bgColor;
    for (let x = 0; x < width; x++) {
      line += (charColors[x] || '') + charBackgrounds[x] + chars[x];
      if (charBackgrounds[x]) line += bgColor;
      if (charColors[x].includes(DIM) || charColors[x].includes(BOLD)) line += sgr(22);
    }
    line += RESET;
    lines.push(line);
  }
  return lines;
}
