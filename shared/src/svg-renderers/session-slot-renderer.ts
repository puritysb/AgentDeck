/**
 * Session slot button SVG renderer for v4 dynamic layout.
 *
 * 144x144 canvas matching Stream Deck key images. Buttons carry their own
 * iconography; Stream Deck titles are treated as optional metadata only.
 */
import type { AgentType } from '../adapter.js';
import type { SessionInfo } from '../protocol.js';
import type { PromptOption } from '../states.js';
import { State } from '../states.js';
import { stateColor } from '../state-colors.js';
import { PASSIVE_OFFLINE_LABEL, OPEN_AGENTDECK_LABEL } from '../connection-status.js';
import { agentLogoIcon } from './agent-logos.js';
import { wrapTextByWidth, escSvgText } from './text-utils.js';

const SIZE = 144;
const BORDER_PERIMETER = 512;

/**
 * Dash travel per `animFrame` unit, shared by EVERY orbiting border on a session
 * slot (the processing state border and the focused-session ring).
 *
 * The single speed is a hard requirement, not a style choice: a surface that
 * pre-bakes the animation into a looping GIF (the D200H / Ulanzi plugin) can only
 * close the loop when every animated element returns to its starting phase at the
 * same frame. Dash phase repeats with period BORDER_PERIMETER, so a ring of speed
 * `v` closes after BORDER_PERIMETER / v units — two different speeds only agree
 * again at their common multiple, which for the old 22/16 pair was 256 units (11
 * dash cycles: far too much travel to sample at a watchable frame count). Keep
 * these in lockstep; if a future ring needs a different tempo it must be an
 * INTEGER multiple of this speed, or the GIF surfaces get a visible jump on wrap.
 */
const ORBIT_SPEED_PX = 22;

/**
 * `animFrame` units in one full animation cycle — after this span every orbiting
 * dash and every pulse is back at its starting value. A pre-baked loop (GIF) MUST
 * span exactly this, sampled at N even steps of `SESSION_SLOT_ANIM_CYCLE / N`.
 * Live tickers (Stream Deck) just keep incrementing and can ignore it.
 */
export const SESSION_SLOT_ANIM_CYCLE = BORDER_PERIMETER / ORBIT_SPEED_PX;

/**
 * Angular frequency of the opacity pulses (processing glow, awaiting breath),
 * chosen so `|sin(PULSE_OMEGA * animFrame)|` runs one full 0→1→0 breath across
 * exactly one `SESSION_SLOT_ANIM_CYCLE` and therefore lands back on 0 at the loop
 * seam. The previous hand-picked 0.12 / 0.14 were close to this value but not
 * commensurate with the cycle, so a baked loop snapped from a lit border back to
 * a dark one on every wrap.
 */
const PULSE_OMEGA = Math.PI / SESSION_SLOT_ANIM_CYCLE;

export type DisconnectedSlotKind = 'open-app' | 'empty';

export type ClusterQuadrant = 'tl' | 'tr' | 'bl' | 'br';

export interface DisconnectedSlotConfig {
  kind: DisconnectedSlotKind;
  label?: string;
  subtitle?: string;
  detail?: string;
  /**
   * When set, render the matching 144×144 quadrant of a 288×288 cluster
   * hero — used by even×even decks (SD+, SD XL) so the OFFLINE card sits
   * on the geometric center 2×2 of the keypad instead of one off-center key.
   */
  quadrant?: ClusterQuadrant;
  col?: number;
  row?: number;
  cols?: number;
  rows?: number;
}

export type StatusIconKind =
  | 'hub'
  | 'no-session'
  | 'agentdeck'
  | 'tool'
  | 'model'
  | 'mode'
  | 'ready'
  | 'activity'
  | 'open-app'
  | 'retry'
  | 'offline'
  | 'back'
  | 'more'
  | 'esc'
  | 'stop'
  | 'play'
  | 'review'
  | 'commit'
  | 'clear'
  | 'gateway'
  | 'status'
  | 'allow'
  | 'deny'
  | 'diff'
  | 'option';

export type StatusCardTone =
  | 'ready'
  | 'idle'
  | 'info'
  | 'warning'
  | 'danger'
  | 'muted'
  | 'agent'
  | 'action'
  | 'brand'
  | 'purple';

export interface StatusCardConfig {
  icon: StatusIconKind;
  label: string;
  subtitle?: string;
  detail?: string;
  tone?: StatusCardTone;
}

// Shared sanitizer: strips ANSI/control chars before entity-escaping (a raw
// control char in interpolated text makes resvg reject the entire SVG).
const escXml = escSvgText;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '\u2026';
}

function wrapSessionName(name: string, maxChars: number, maxLines = 4): string[] {
  if (name.length <= maxChars) return [name];
  const lines: string[] = [];
  let remaining = name.trim();
  while (remaining.length > maxChars && lines.length < maxLines - 1) {
    const breakpoints: number[] = [];
    for (let i = 1; i < remaining.length; i += 1) {
      if (remaining[i] === ' ' || (/[A-Z]/.test(remaining[i]) && /[a-z0-9]/.test(remaining[i - 1]))) {
        breakpoints.push(i);
      }
    }
    const split = breakpoints.filter(index => index <= maxChars).pop() ?? maxChars;
    lines.push(remaining.slice(0, split).trimEnd());
    remaining = remaining.slice(split).trimStart();
  }
  lines.push(remaining.length <= maxChars
    ? remaining
    : `${remaining.slice(0, maxChars - 1).trimEnd()}…`);
  return lines;
}

/**
 * Compact, readable model strings for narrow surfaces (StreamDeck 144\u00d7144 keys).
 * - claude-sonnet-4-6              \u2192 "sonnet 4.6"
 * - claude-opus-4-7                \u2192 "opus 4.7"
 * - claude-haiku-4-5-20251001      \u2192 "haiku 4.5"   (date suffix dropped)
 * - gpt-5-codex / gpt-5 / others   \u2192 unchanged (caller still truncates if needed)
 */
export function aliasModelName(name: string): string {
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d+)?$/i.exec(name);
  if (claude) return `${claude[1].toLowerCase()} ${claude[2]}.${claude[3]}`;
  return name;
}

function stateLabel(state?: string, agentType?: AgentType): string {
  if (!state) return PASSIVE_OFFLINE_LABEL;
  if (agentType === 'openclaw') {
    if (state === 'idle') return 'STANDBY';
    if (state === 'processing') return 'ROUTING';
  }
  switch (state) {
    case 'idle': return 'IDLE';
    case 'processing': return 'WORKING';
    case 'awaiting_option':
    case 'awaiting_permission':
    case 'awaiting_diff':
      return 'AWAITING';
    default: return state.toUpperCase();
  }
}

export function formatModelEffort(modelName?: string, effortLevel?: string, maxLen = 14): string {
  if (!modelName) return '';
  const aliased = aliasModelName(modelName);
  const showEffort = effortLevel && effortLevel !== 'medium' && effortLevel !== 'default';
  if (!showEffort) return truncate(aliased, maxLen);
  const combined = `${aliased} · ${effortLevel}`;
  if (combined.length <= maxLen) return combined;
  const effortSuffix = ` · ${effortLevel}`;
  const modelBudget = Math.max(4, maxLen - effortSuffix.length);
  return truncate(aliased, modelBudget) + effortSuffix;
}

function toneColors(tone: StatusCardTone = 'info') {
  switch (tone) {
    case 'ready':
      return { bg: '#06160d', panel: '#12331f', icon: '#86efac', accent: '#22c55e', text: '#dcfce7', sub: '#86efac' };
    case 'idle':
      return { bg: '#0b1320', panel: '#172033', icon: '#93c5fd', accent: '#60a5fa', text: '#dbeafe', sub: '#93c5fd' };
    case 'warning':
      return { bg: '#17110a', panel: '#2a1b0c', icon: '#fbbf24', accent: '#f59e0b', text: '#fde68a', sub: '#fbbf24' };
    case 'danger':
      return { bg: '#1c0c0c', panel: '#341312', icon: '#fca5a5', accent: '#ef4444', text: '#fee2e2', sub: '#fca5a5' };
    case 'muted':
      return { bg: '#0a0a0c', panel: '#17171a', icon: '#a1a1aa', accent: '#52525b', text: '#e4e4e7', sub: '#a1a1aa' };
    case 'agent':
      return { bg: '#141016', panel: '#241a2b', icon: '#f0abfc', accent: '#c084fc', text: '#fae8ff', sub: '#d8b4fe' };
    case 'action':
      return { bg: '#07170f', panel: '#12331f', icon: '#bbf7d0', accent: '#22c55e', text: '#dcfce7', sub: '#86efac' };
    case 'brand':
      // Aquarium-tide OFFLINE tone — matches the dark-scrim + cyan AgentDeck mark
      // the macOS/iOS/Android connection overlays and the ESP32 splash draw.
      return { bg: '#071a1e', panel: '#0e2e33', icon: '#3ED6E8', accent: '#3ED6E8', text: '#e6f7fa', sub: '#7fb2bc' };
    case 'purple':
      return { bg: '#120d1d', panel: '#24163a', icon: '#d8b4fe', accent: '#a78bfa', text: '#f3e8ff', sub: '#d8b4fe' };
    case 'info':
    default:
      return { bg: '#0b1626', panel: '#12223a', icon: '#bfdbfe', accent: '#60a5fa', text: '#dbeafe', sub: '#93c5fd' };
  }
}

function orbitOffset(animFrame: number, speedPx: number, phasePx = 0): number {
  return -((animFrame * speedPx + phasePx) % BORDER_PERIMETER);
}

function renderOrbitingRect(params: {
  x: number; y: number; width: number; height: number; rx: number; color: string; animFrame: number;
  speedPx?: number; phasePx?: number; dashPx?: number; gapPx?: number;
  railOpacity?: number; glowOpacity?: number; coreOpacity?: number;
  railWidth?: number; glowWidth?: number; coreWidth?: number; filterId?: string;
}): string {
  const {
    x, y, width, height, rx, color, animFrame,
    speedPx = 18, phasePx = 0, dashPx = 80, gapPx = BORDER_PERIMETER - dashPx,
    railOpacity = 0.18, glowOpacity = 0.58, coreOpacity = 0.96,
    railWidth = 1.2, glowWidth = 4.8, coreWidth = 2.2, filterId,
  } = params;
  const dashOffset = orbitOffset(animFrame, speedPx, phasePx);
  const filterAttr = filterId ? ` filter="url(#${filterId})"` : '';
  const common = `x="${x}" y="${y}" width="${width}" height="${height}" rx="${rx}" fill="none" stroke="${color}" stroke-linecap="round" stroke-linejoin="round"`;
  return [
    `<rect ${common} stroke-width="${railWidth}" opacity="${railOpacity.toFixed(2)}"/>`,
    `<rect ${common} stroke-width="${glowWidth}" stroke-dasharray="${dashPx} ${gapPx}" stroke-dashoffset="${dashOffset}" opacity="${glowOpacity.toFixed(2)}"${filterAttr}/>`,
    `<rect ${common} stroke-width="${coreWidth}" stroke-dasharray="${dashPx} ${gapPx}" stroke-dashoffset="${dashOffset}" opacity="${coreOpacity.toFixed(2)}"/>`,
  ].join('');
}

/**
 * AgentDeck product mark — the aquarium dome over a hardware deck (glass dome +
 * waterline + highlight + rounded deck base + three keys + two bubbles). Ported
 * unit-for-unit (0..24 space) from the SwiftUI `AgentDeckLogo` / Compose
 * `AgentDeckMark` so the Stream Deck / D200H offline hero shows the SAME brand
 * mark that the macOS/iOS/Android connection overlays and the ESP32 splash draw.
 * Centered on (x,y); `size` is the mark's width in px. `color` draws the dome/deck
 * strokes + keys; `accent` tints the waterline + bubbles.
 */
export function renderAgentDeckMark(x: number, y: number, size: number, color: string, accent = color): string {
  const u = size / 24; // unit-space (0..24) → px
  const ax = (p: number) => +(x + (p - 12) * u).toFixed(2);
  const ay = (p: number) => +(y + (p - 12) * u).toFixed(2);
  const w = (n: number) => +(n * u).toFixed(2);
  const cap = 'stroke-linecap="round" stroke-linejoin="round" fill="none"';
  return [
    // glass dome
    `<path d="M${ax(4.7)} ${ay(12.8)} C${ax(5.3)} ${ay(4.9)} ${ax(18.7)} ${ay(4.9)} ${ax(19.3)} ${ay(12.8)}" stroke="${color}" stroke-width="${w(1.6)}" ${cap}/>`,
    // waterline
    `<path d="M${ax(6.1)} ${ay(11.2)} C${ax(8.8)} ${ay(12.5)} ${ax(15.2)} ${ay(12.5)} ${ax(17.9)} ${ay(11.2)}" stroke="${accent}" stroke-width="${w(1.15)}" opacity="0.6" ${cap}/>`,
    // dome highlight
    `<path d="M${ax(8.0)} ${ay(7.7)} C${ax(10.0)} ${ay(5.7)} ${ax(13.2)} ${ay(5.4)} ${ax(15.8)} ${ay(6.1)}" stroke="${color}" stroke-width="${w(0.9)}" opacity="0.34" ${cap}/>`,
    // deck base
    `<rect x="${ax(3.4)}" y="${ay(12.2)}" width="${w(17.2)}" height="${w(7.8)}" rx="${w(2.2)}" stroke="${color}" stroke-width="${w(1.6)}" opacity="0.88" fill="none"/>`,
    // three deck keys
    `<rect x="${ax(6.5)}" y="${ay(15.4)}" width="${w(3.1)}" height="${w(2.0)}" rx="${w(1.0)}" fill="${color}" opacity="0.70"/>`,
    `<rect x="${ax(10.4)}" y="${ay(15.4)}" width="${w(3.1)}" height="${w(2.0)}" rx="${w(1.0)}" fill="${color}" opacity="0.92"/>`,
    `<rect x="${ax(14.3)}" y="${ay(15.4)}" width="${w(3.1)}" height="${w(2.0)}" rx="${w(1.0)}" fill="${color}" opacity="0.70"/>`,
    // interior bubbles
    `<circle cx="${ax(9.6)}" cy="${ay(9.0)}" r="${w(0.95)}" fill="${accent}" opacity="0.62"/>`,
    `<circle cx="${ax(14.8)}" cy="${ay(8.2)}" r="${w(0.6)}" fill="${accent}" opacity="0.42"/>`,
  ].join('');
}

/**
 * Small-size reduction of {@link renderAgentDeckMark}.
 *
 * The full mark carries a waterline, a dome highlight and interior bubbles at
 * 0.34–0.62 opacity. Those read at 72px+ but collapse into a grey blob by 20px,
 * which is the size Stream Deck draws action-list icons at. This keeps the
 * mark's three identifying features — dome arc, deck body, three keys — at full
 * opacity and drops everything that cannot survive the downsample.
 *
 * Keep the two in sync: if the mark's silhouette changes, change this too.
 */
export function renderAgentDeckMarkCompact(x: number, y: number, size: number, color: string): string {
  const u = size / 24;
  const ax = (p: number) => +(x + (p - 12) * u).toFixed(2);
  const ay = (p: number) => +(y + (p - 12) * u).toFixed(2);
  const w = (n: number) => +(n * u).toFixed(2);
  const cap = 'stroke-linecap="round" stroke-linejoin="round" fill="none"';
  const key = (kx: number) =>
    `<rect x="${ax(kx)}" y="${ay(14.6)}" width="${w(3.4)}" height="${w(2.4)}" rx="${w(1.2)}" fill="${color}"/>`;
  return [
    // dome arc, seated on the deck lip
    `<path d="M${ax(4.6)} ${ay(11.6)} C${ax(5.3)} ${ay(3.9)} ${ax(18.7)} ${ay(3.9)} ${ax(19.4)} ${ay(11.6)}" stroke="${color}" stroke-width="${w(1.7)}" ${cap}/>`,
    // deck body
    `<rect x="${ax(3.2)}" y="${ay(11.6)}" width="${w(17.6)}" height="${w(8.6)}" rx="${w(2.3)}" stroke="${color}" stroke-width="${w(1.7)}" fill="none"/>`,
    key(6.0), key(10.3), key(14.6),
  ].join('');
}

function renderGlyphIcon(kind: StatusIconKind, color: string, accent: string, x = 72, y = 43, scale = 1): string {
  const s = scale;
  const sx = (n: number) => x + n * s;
  const sy = (n: number) => y + n * s;
  const common = `stroke="${color}" stroke-linecap="round" stroke-linejoin="round"`;
  const accentStroke = `stroke="${accent}" stroke-linecap="round" stroke-linejoin="round"`;

  switch (kind) {
    case 'hub':
      return [
        `<circle cx="${x}" cy="${y}" r="${9 * s}" fill="${accent}" opacity="0.18" stroke="${color}" stroke-width="${2.4 * s}"/>`,
        `<circle cx="${sx(-24)}" cy="${sy(17)}" r="${5 * s}" fill="${color}" opacity="0.9"/>`,
        `<circle cx="${sx(24)}" cy="${sy(17)}" r="${5 * s}" fill="${color}" opacity="0.9"/>`,
        `<circle cx="${x}" cy="${sy(-25)}" r="${5 * s}" fill="${color}" opacity="0.9"/>`,
        `<path d="M${sx(-7)} ${sy(7)} L${sx(-20)} ${sy(14)} M${sx(7)} ${sy(7)} L${sx(20)} ${sy(14)} M${x} ${sy(-9)} L${x} ${sy(-20)}" ${accentStroke} stroke-width="${2.6 * s}" opacity="0.72" fill="none"/>`,
      ].join('');
    case 'no-session':
      return [
        `<path d="M${sx(-25)} ${sy(-3)} H${sx(25)} V${sy(21)} Q${sx(25)} ${sy(27)} ${sx(19)} ${sy(27)} H${sx(-19)} Q${sx(-25)} ${sy(27)} ${sx(-25)} ${sy(21)} Z" fill="${accent}" opacity="0.14" stroke="${color}" stroke-width="${2.4 * s}"/>`,
        `<path d="M${sx(-14)} ${sy(-14)} H${sx(14)} M${sx(-7)} ${sy(-24)} H${sx(7)}" ${common} stroke-width="${2.6 * s}" opacity="0.82"/>`,
        `<circle cx="${sx(-10)}" cy="${sy(13)}" r="${2.8 * s}" fill="${color}" opacity="0.55"/><circle cx="${x}" cy="${sy(13)}" r="${2.8 * s}" fill="${color}" opacity="0.38"/><circle cx="${sx(10)}" cy="${sy(13)}" r="${2.8 * s}" fill="${color}" opacity="0.24"/>`,
      ].join('');
    case 'agentdeck':
      // The canonical dome-over-deck brand mark (parity with the native overlays).
      return renderAgentDeckMark(x, y, 54 * s, color, accent);
    case 'tool':
      return `<circle cx="${sx(-18)}" cy="${sy(-13)}" r="${7 * s}" fill="none" stroke="${color}" stroke-width="${2.6 * s}"/><path d="M${sx(-12)} ${sy(-7)} L${sx(4)} ${sy(9)}" ${common} stroke-width="${3.8 * s}" fill="none"/><rect x="${sx(4)}" y="${sy(5)}" width="${22 * s}" height="${12 * s}" rx="${5 * s}" transform="rotate(45 ${sx(15)} ${sy(11)})" fill="${accent}" opacity="0.82"/>`;
    case 'model':
      return `<path d="M${x} ${sy(-27)} L${sx(24)} ${sy(-13)} V${sy(15)} L${x} ${sy(29)} L${sx(-24)} ${sy(15)} V${sy(-13)} Z" fill="${accent}" opacity="0.12" stroke="${color}" stroke-width="${2.4 * s}"/><path d="M${sx(-24)} ${sy(-13)} L${x} ${sy(1)} L${sx(24)} ${sy(-13)} M${x} ${sy(1)} V${sy(29)}" ${common} stroke-width="${2 * s}" opacity="0.7" fill="none"/>`;
    case 'mode':
      return `<path d="M${sx(-24)} ${sy(-18)} H${sx(24)} M${sx(-24)} ${y} H${sx(24)} M${sx(-24)} ${sy(18)} H${sx(24)}" ${common} stroke-width="${2.8 * s}" opacity="0.72"/><circle cx="${sx(-8)}" cy="${sy(-18)}" r="${5 * s}" fill="${accent}" stroke="${color}" stroke-width="${2 * s}"/><circle cx="${sx(13)}" cy="${y}" r="${5 * s}" fill="${accent}" stroke="${color}" stroke-width="${2 * s}"/><circle cx="${sx(-15)}" cy="${sy(18)}" r="${5 * s}" fill="${accent}" stroke="${color}" stroke-width="${2 * s}"/>`;
    case 'ready':
    case 'allow':
      return `<circle cx="${x}" cy="${y}" r="${27 * s}" fill="${accent}" opacity="0.15" stroke="${color}" stroke-width="${2.6 * s}"/><path d="M${sx(-13)} ${sy(0)} L${sx(-3)} ${sy(11)} L${sx(16)} ${sy(-12)}" ${common} stroke-width="${5 * s}" fill="none"/>`;
    case 'activity':
      return `<path d="M${sx(-29)} ${y} H${sx(-18)} L${sx(-10)} ${sy(-16)} L${sx(3)} ${sy(18)} L${sx(12)} ${sy(-4)} H${sx(29)}" ${common} stroke-width="${4 * s}" fill="none"/><circle cx="${sx(29)}" cy="${y}" r="${4 * s}" fill="${accent}"/>`;
    case 'open-app':
    case 'play':
      return `<rect x="${sx(-25)}" y="${sy(-22)}" width="${50 * s}" height="${44 * s}" rx="${9 * s}" fill="${accent}" opacity="0.16" stroke="${color}" stroke-width="${2.2 * s}"/><polygon points="${sx(-7)},${sy(-13)} ${sx(-7)},${sy(13)} ${sx(15)},${y}" fill="${color}"/>`;
    case 'retry':
      return `<path d="M${sx(20)} ${sy(-12)} A${26 * s} ${26 * s} 0 1 0 ${sx(23)} ${sy(13)}" fill="none" ${common} stroke-width="${4.5 * s}"/><path d="M${sx(20)} ${sy(-28)} V${sy(-10)} H${sx(2)}" fill="none" ${common} stroke-width="${4.5 * s}"/>`;
    case 'offline':
      return `<circle cx="${x}" cy="${y}" r="${25 * s}" fill="${accent}" opacity="0.14" stroke="${color}" stroke-width="${2.4 * s}"/><circle cx="${x}" cy="${y}" r="${4.5 * s}" fill="${color}"/><path d="M${x} ${sy(5)} V${sy(17)} M${sx(-16)} ${sy(18)} H${sx(16)}" ${accentStroke} stroke-width="${2.6 * s}" opacity="0.68"/>`;
    case 'back':
      return `<path d="M${sx(21)} ${y} H${sx(-18)} M${sx(-18)} ${y} L${sx(-2)} ${sy(-16)} M${sx(-18)} ${y} L${sx(-2)} ${sy(16)}" ${common} stroke-width="${5 * s}" fill="none"/>`;
    case 'more':
      return `<path d="M${sx(-18)} ${sy(-15)} L${sx(0)} ${y} L${sx(-18)} ${sy(15)} M${sx(3)} ${sy(-15)} L${sx(21)} ${y} L${sx(3)} ${sy(15)}" ${common} stroke-width="${4.5 * s}" fill="none"/>`;
    case 'esc':
    case 'deny':
      return `<circle cx="${x}" cy="${y}" r="${27 * s}" fill="${accent}" opacity="0.14" stroke="${color}" stroke-width="${2.2 * s}"/><path d="M${sx(-12)} ${sy(-12)} L${sx(12)} ${sy(12)} M${sx(12)} ${sy(-12)} L${sx(-12)} ${sy(12)}" ${common} stroke-width="${4.8 * s}" fill="none"/>`;
    case 'stop':
      return `<rect x="${sx(-22)}" y="${sy(-22)}" width="${44 * s}" height="${44 * s}" rx="${8 * s}" fill="${accent}" opacity="0.16" stroke="${color}" stroke-width="${2.2 * s}"/><rect x="${sx(-11)}" y="${sy(-11)}" width="${22 * s}" height="${22 * s}" rx="${3 * s}" fill="${color}"/>`;
    case 'review':
    case 'diff':
      return `<rect x="${sx(-18)}" y="${sy(-25)}" width="${36 * s}" height="${50 * s}" rx="${5 * s}" fill="${accent}" opacity="0.13" stroke="${color}" stroke-width="${2.4 * s}"/><path d="M${sx(-9)} ${sy(-10)} H${sx(10)} M${sx(-9)} ${sy(1)} H${sx(6)} M${sx(-9)} ${sy(12)} H${sx(2)}" ${common} stroke-width="${2.2 * s}" opacity="0.76"/>`;
    case 'commit':
      return `<circle cx="${x}" cy="${sy(-15)}" r="${7 * s}" fill="${color}"/><circle cx="${sx(-21)}" cy="${sy(18)}" r="${7 * s}" fill="${color}"/><circle cx="${sx(21)}" cy="${sy(18)}" r="${7 * s}" fill="${color}"/><path d="M${x} ${sy(-8)} V${sy(7)} M${x} ${sy(7)} H${sx(-21)} V${sy(11)} M${x} ${sy(7)} H${sx(21)} V${sy(11)}" ${accentStroke} stroke-width="${3 * s}" fill="none"/>`;
    case 'clear':
      return `<path d="M${sx(-16)} ${sy(-16)} L${sx(16)} ${sy(16)} M${sx(16)} ${sy(-16)} L${sx(-16)} ${sy(16)}" ${common} stroke-width="${4.5 * s}" fill="none"/>`;
    case 'gateway':
      return `<rect x="${sx(-28)}" y="${sy(-21)}" width="${56 * s}" height="${42 * s}" rx="${6 * s}" fill="${accent}" opacity="0.12" stroke="${color}" stroke-width="${2.2 * s}"/><path d="M${sx(-28)} ${sy(-8)} H${sx(28)} M${sx(-12)} ${sy(7)} H${sx(12)} M${x} ${sy(-5)} V${sy(19)}" ${common} stroke-width="${2.2 * s}" opacity="0.72"/>`;
    case 'status':
      return `<circle cx="${x}" cy="${y}" r="${27 * s}" fill="${accent}" opacity="0.14" stroke="${color}" stroke-width="${2.4 * s}"/><path d="M${x} ${sy(-15)} V${sy(4)}" ${common} stroke-width="${4.4 * s}"/><circle cx="${x}" cy="${sy(17)}" r="${4.5 * s}" fill="${color}"/>`;
    case 'option':
    default:
      return `<rect x="${sx(-25)}" y="${sy(-20)}" width="${50 * s}" height="${40 * s}" rx="${8 * s}" fill="${accent}" opacity="0.13" stroke="${color}" stroke-width="${2.2 * s}"/><circle cx="${sx(-12)}" cy="${y}" r="${4 * s}" fill="${color}"/><circle cx="${x}" cy="${y}" r="${4 * s}" fill="${color}"/><circle cx="${sx(12)}" cy="${y}" r="${4 * s}" fill="${color}"/>`;
  }
}

export function renderSessionSlot(
  session: SessionInfo,
  isActive: boolean,
  animFrame: number,
  displayName?: string,
  options?: {
    animated?: boolean;
    processingStartFrame?: number;
    isStale?: boolean;
    /** Use typography tuned for the original 72px Stream Deck keys. */
    lowResolutionKey?: boolean;
  },
): string {
  const isWorking = session.state === 'processing';
  const isAsking = session.state?.startsWith('awaiting') ?? false;
  const isIdle = !isWorking && !isAsking;
  const animated = options?.animated ?? true;
  const agent = (session.agentType as AgentType) || 'claude-code';
  const nameForDisplay = displayName ?? session.projectName;
  const modelText = formatModelEffort(session.modelName, session.effortLevel, 15);
  const p1 = agent === 'claude-code' ? '#D97757' : (agent === 'codex-cli' || agent === 'codex-app') ? '#8BA4FF' : agent === 'openclaw' ? '#FF6B6B' : '#F1ECEC';
  const sColor = stateColor(session.state);
  // RUNNING reads as a COOL teal (calm "in progress"); PERM keeps the semantic
  // amber (stateColor → #f59e0b). Previously RUNNING used a gold #F5B942 that
  // collided with awaiting's amber, so the two states looked near-identical.
  const WORKING_COLOR = '#2DD4BF';   // teal — cool, clearly not amber
  const signalColor = isWorking ? WORKING_COLOR : sColor;
  const fontFam = 'Inter, -apple-system, system-ui, Helvetica Neue, sans-serif';
  const lowResolutionKey = options?.lowResolutionKey === true;
  const stateLbl = isWorking ? 'RUNNING' : isAsking ? 'PERMIT?' : 'IDLE';
  const colorText = isWorking ? '#CCFBF1' : isAsking ? '#FCD34D' : p1;
  const nameLines = wrapSessionName(nameForDisplay, lowResolutionKey ? 11 : 15);
  const nameStartY = nameLines.length === 1 ? (lowResolutionKey ? 60 : 54)
    : nameLines.length === 2 ? (lowResolutionKey ? 56 : 53)
      : nameLines.length === 3 ? (lowResolutionKey ? 53 : 52)
        : (lowResolutionKey ? 52 : 50);
  const nameLineHeight = nameLines.length === 4
    ? (lowResolutionKey ? 18 : 15)
    : (lowResolutionKey ? 20 : 18);
  const nameText = nameLines.map((line, index) =>
    `<text x="20" y="${nameStartY + index * nameLineHeight}" font-size="${lowResolutionKey ? '20' : '16'}" font-weight="${lowResolutionKey ? '700' : '600'}" text-anchor="start" fill="#E2E8F0" font-family="${fontFam}">${escXml(line)}</text>`,
  ).join('');
  const gradId = `sd-bg-${agent}-${session.state || 'idle'}`;
  const filterId = `pg-${animFrame}`;
  let defs = `<linearGradient id="${gradId}" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#1C1C1E"/><stop offset="100%" stop-color="#0C0C0E"/></linearGradient>`;
  const blurDef = `<filter id="${filterId}" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur in="SourceGraphic" stdDeviation="2.4"/></filter>`;
  let stateBorder = '';
  let activeRing = '';
  let askDot = '';
  let runBadge = '';

  if (isWorking) {
    // RUNNING: a teal border of marching dashes ORBITING the key — motion that
    // reads as "work travelling around", distinct from PERM's steady breath.
    defs += blurDef;
    const pulseOpacity = animated ? 0.72 + 0.20 * Math.abs(Math.sin(animFrame * PULSE_OMEGA)) : 0.9;
    const borderColor = signalColor;
    const orbitSpeedPx = ORBIT_SPEED_PX;
    // Anchor the rotation to when this session entered the animated state so
    // sibling buttons that started later orbit out of phase, not in lockstep.
    // Defaulting to `animFrame` would make the phase cancel the rotation exactly
    // (phase = -animFrame*speed, offset = -(animFrame*speed + phase) = 0), which
    // froze the dashes for every caller that does not track a start frame.
    const startFrame = options?.processingStartFrame ?? 0;
    const processingPhasePx = -((startFrame * orbitSpeedPx) % BORDER_PERIMETER);
    stateBorder = animated
      ? renderOrbitingRect({
          x: 8, y: 8, width: 128, height: 128, rx: 12, color: borderColor, animFrame,
          speedPx: orbitSpeedPx, dashPx: 92,
          phasePx: processingPhasePx,
          glowOpacity: pulseOpacity * 0.72, coreOpacity: Math.min(1, pulseOpacity + 0.06), filterId,
        })
      : `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${borderColor}" stroke-width="4.5" opacity="${pulseOpacity.toFixed(2)}" filter="url(#${filterId})"/><rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${borderColor}" stroke-width="1.5" opacity="${(pulseOpacity * 0.9).toFixed(2)}"/>`;
    runBadge = `<rect x="99" y="14" width="30" height="16" rx="8" fill="${signalColor}" opacity="0.9" /><text x="114" y="25" font-size="9" font-weight="800" text-anchor="middle" fill="#0C0C0E" font-family="${fontFam}">RUN</text>`;
  } else if (isAsking) {
    // PERM / AWAITING: a SOLID amber border that BREATHES (full perimeter, no
    // marching dashes) — a deliberately different motion + hue from RUNNING so
    // "needs you" is unmistakable at a glance. Plus a bold amber PERM badge.
    defs += blurDef;
    const amber = sColor; // #f59e0b
    const breathe = animated ? 0.45 + 0.55 * Math.abs(Math.sin(animFrame * PULSE_OMEGA)) : 1;
    stateBorder = [
      `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${amber}" stroke-width="7" opacity="${(breathe * 0.6).toFixed(2)}" filter="url(#${filterId})"/>`,
      `<rect x="8" y="8" width="128" height="128" rx="12" fill="none" stroke="${amber}" stroke-width="3" opacity="0.97"/>`,
    ].join('');
    // Bold filled amber pill — far more legible than the old 5px dot.
    askDot = `<rect x="90" y="12" width="42" height="19" rx="9.5" fill="${amber}"/><text x="111" y="26" font-size="11" font-weight="800" text-anchor="middle" fill="#221500" font-family="${fontFam}">PERM</text>`;
  }

  if (isActive) {
    if (animated && isIdle) defs += blurDef;
    activeRing = animated
      ? renderOrbitingRect({
          x: 10.5, y: 10.5, width: 123, height: 123, rx: 10.5, color: '#60A5FA', animFrame,
          speedPx: ORBIT_SPEED_PX, phasePx: 170, dashPx: isIdle ? 72 : 52,
          railOpacity: isIdle ? 0.20 : 0.10, glowOpacity: isIdle ? 0.42 : 0.24,
          coreOpacity: isIdle ? 0.95 : 0.58, railWidth: 1, glowWidth: isIdle ? 3.6 : 2.6,
          coreWidth: isIdle ? 1.8 : 1.3, filterId: isIdle ? filterId : undefined,
        })
      : `<rect x="10.5" y="10.5" width="123" height="123" rx="10.5" fill="none" stroke="#60A5FA" stroke-width="1.5" opacity="${isIdle ? '0.72' : '0.36'}"/>`;
  }

  const watermark = `<g transform="translate(92, 80)" opacity="${isIdle ? '0.62' : '0.55'}">${agentLogoIcon(agent, 72, 1, 0, 0)}</g>`;
  const badgeObj = isIdle ? `<rect x="100" y="14" width="28" height="16" rx="8" fill="#ffffff" opacity="0.1" /><text x="114" y="25" font-size="10" font-weight="700" text-anchor="middle" fill="#A1A1AA" font-family="${fontFam}">ACT</text>` : '';
  const toolStr = isWorking ? 'Running task' : modelText;

  const elements = [
    `<defs>${defs}</defs>`,
    `<rect width="${SIZE}" height="${SIZE}" rx="16" fill="url(#${gradId})"/>`,
    `<rect x="8" y="8" width="128" height="128" rx="12" fill="#2C2C2E" opacity="0.8"/>`,
    stateBorder, activeRing, watermark, askDot, runBadge, badgeObj,
    `<text x="20" y="32" font-size="${lowResolutionKey ? '18' : '17'}" font-weight="800" text-anchor="start" fill="${colorText}" font-family="${fontFam}">${escXml(stateLbl)}</text>`,
    nameText,
    `<text x="20" y="${lowResolutionKey ? '128' : '120'}" font-size="${lowResolutionKey ? '15' : (isWorking ? '13' : '14')}" font-weight="500" text-anchor="start" fill="${colorText}" opacity="0.8" font-family="${fontFam}">${escXml(toolStr)}</text>`,
    // Stale overlay: the daemon stopped responding (no pings/state for the
    // stale window) but hasn't yet hit the hard disconnect. Dim the last-known
    // render and flag it so the state on screen isn't mistaken for live.
    options?.isStale
      ? `<rect width="${SIZE}" height="${SIZE}" rx="16" fill="#0C0C0E" opacity="0.5"/>`
        + `<rect x="20" y="62" width="50" height="17" rx="8" fill="#71717A" opacity="0.92"/>`
        + `<text x="45" y="74" font-size="10" font-weight="800" text-anchor="middle" fill="#0C0C0E" font-family="${fontFam}">STALE</text>`
      : '',
  ].join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${elements}</svg>`;
}

export function renderEmptySlot(): string {
  return renderQuietSlot();
}

export function renderQuietSlot(): string {
  return svgFrame('#0a0a0a', '');
}

export function renderStatusCard(config: StatusCardConfig): string {
  const colors = toneColors(config.tone);
  const fontFam = 'Inter, -apple-system, system-ui, Helvetica Neue, sans-serif';
  const label = truncate(config.label, 14);
  const subtitle = truncate(config.subtitle ?? '', 18);
  // 22, not 17: the only detail we ship is the daemon install hint
  // (`npx @agentdeck/setup`, 20 chars) on the D200H offline hero, and a 17-char
  // cap rendered it as `npx @agentdeck/s…` — a truncated command is worse than
  // none. At font-size 9 on the 144-wide canvas, 22 chars is ~99px, still well
  // inside the frame.
  const detail = truncate(config.detail ?? '', 22);
  const elements = [
    `<rect x="25" y="18" width="94" height="58" rx="14" fill="${colors.panel}" opacity="0.68" stroke="${colors.accent}" stroke-width="1.2" stroke-opacity="0.28"/>`,
    renderGlyphIcon(config.icon, colors.icon, colors.accent, 72, 43, 0.94),
    `<text x="72" y="${subtitle ? 94 : 103}" text-anchor="middle" font-family="${fontFam}" font-size="${label.length > 11 ? '14' : '16'}" font-weight="800" fill="${colors.text}">${escXml(label)}</text>`,
    subtitle ? `<text x="72" y="112" text-anchor="middle" font-family="${fontFam}" font-size="11" font-weight="650" fill="${colors.sub}" opacity="0.86">${escXml(subtitle)}</text>` : '',
    detail ? `<text x="72" y="127" text-anchor="middle" font-family="${fontFam}" font-size="9" font-weight="600" fill="${colors.sub}" opacity="0.52">${escXml(detail)}</text>` : '',
  ].join('');
  return svgFrame(colors.bg, elements);
}

export function renderDisconnectedSlot(config: DisconnectedSlotConfig): string {
  if (config.kind === 'empty') return renderQuietSlot();
  if (
    config.col !== undefined &&
    config.row !== undefined &&
    config.cols !== undefined &&
    config.rows !== undefined
  ) {
    return renderOpenAppGrid(
      config.col,
      config.row,
      config.cols,
      config.rows,
      config.label ?? PASSIVE_OFFLINE_LABEL,
      config.subtitle ?? OPEN_AGENTDECK_LABEL
    );
  }
  if (config.quadrant) {
    return renderOpenAppQuadrant(config.quadrant, config.label ?? PASSIVE_OFFLINE_LABEL, config.subtitle ?? OPEN_AGENTDECK_LABEL);
  }
  return renderStatusCard({ icon: 'agentdeck', label: config.label ?? PASSIVE_OFFLINE_LABEL, subtitle: config.subtitle ?? OPEN_AGENTDECK_LABEL, detail: config.detail, tone: 'brand' });
}

/**
 * Renders a single 144×144 viewport into a 288×288 cluster hero. Each of the
 * four center keys (tl/tr/bl/br) emits the same logical content offset by its
 * quadrant; viewBox clipping keeps only the relevant 144×144 visible. The
 * cluster reads as one card visually, with the inner panel + glyph + text
 * spanning all four keys while each key keeps its own outer rounded bezel.
 */
export function renderOpenAppQuadrant(quadrant: ClusterQuadrant, label = PASSIVE_OFFLINE_LABEL, subtitle = OPEN_AGENTDECK_LABEL): string {
  const colors = toneColors('brand');
  const fontFam = 'Inter, -apple-system, system-ui, Helvetica Neue, sans-serif';
  const offsetX = (quadrant === 'tr' || quadrant === 'br') ? -SIZE : 0;
  const offsetY = (quadrant === 'bl' || quadrant === 'br') ? -SIZE : 0;
  const gradId = `frame-bg-cluster-${quadrant}`;
  // 288×288 cluster content. All coordinates are in the logical cluster space;
  // the per-key viewBox + transform crops to one quadrant.
  const cluster = [
    `<rect x="16" y="16" width="256" height="256" rx="28" fill="${colors.panel}" opacity="0.68" stroke="${colors.accent}" stroke-width="2.4" stroke-opacity="0.28"/>`,
    renderGlyphIcon('agentdeck', colors.icon, colors.accent, 144, 86, 1.88),
    `<text x="144" y="208" text-anchor="middle" font-family="${fontFam}" font-size="36" font-weight="800" fill="${colors.text}">${escXml(truncate(label, 14))}</text>`,
    `<text x="144" y="240" text-anchor="middle" font-family="${fontFam}" font-size="20" font-weight="650" fill="${colors.sub}" opacity="0.86">${escXml(truncate(subtitle, 18))}</text>`,
  ].join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="${colors.bg}"/><stop offset="100%" stop-color="#0A0A0E"/></linearGradient></defs>`,
    `<rect width="${SIZE}" height="${SIZE}" rx="16" fill="url(#${gradId})"/>`,
    `<g transform="translate(${offsetX} ${offsetY})">${cluster}</g>`,
    `</svg>`,
  ].join('');
}

export function renderBackButton(): string {
  return renderStatusCard({ icon: 'back', label: 'BACK', subtitle: 'sessions', tone: 'muted' });
}

export function renderNextPageButton(pageLabel: string): string {
  return renderStatusCard({ icon: 'more', label: 'MORE', subtitle: pageLabel, tone: 'info' });
}

export function renderEscButton(active = true): string {
  return renderStatusCard({ icon: 'esc', label: 'ESC', subtitle: active ? 'cancel' : 'idle', tone: active ? 'warning' : 'muted' });
}

export function renderStopButton(active = true): string {
  return renderStatusCard({ icon: 'stop', label: 'STOP', subtitle: active ? 'interrupt' : 'idle', tone: active ? 'danger' : 'muted' });
}

export function renderDetailInfo(
  session: SessionInfo | undefined,
  state: State,
  tool?: string,
  modelName?: string,
  mode?: string,
  displayName?: string,
  effortLevel?: string,
): string {
  if (!session) return renderEmptySlot();
  const agent = (session.agentType as AgentType) || 'claude-code';
  const nameForDisplay = displayName ?? session.projectName;
  const fontFam = 'Inter, -apple-system, system-ui, Helvetica Neue, sans-serif';
  const effectiveState = state || session.state;
  const sColor = stateColor(effectiveState);
  const stateLbl = stateLabel(effectiveState, agent);
  const gradId = `sd-bg-detail-${agent}`;
  const watermark = `<g transform="translate(92, 80)" opacity="0.42">${agentLogoIcon(agent, 48, 1, 0, 0)}</g>`;
  const badgeObj = `<rect x="100" y="14" width="28" height="16" rx="8" fill="#ffffff" opacity="0.1" /><text x="114" y="25" font-size="10" font-weight="700" text-anchor="middle" fill="#A1A1AA" font-family="${fontFam}">INFO</text>`;
  const toolDisplay = tool ? `▶ ${truncate(tool, 18)}` : stateLbl;
  const elements = [
    `<defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#151720"/><stop offset="100%" stop-color="#0A0B10"/></linearGradient></defs>`,
    `<rect width="${SIZE}" height="${SIZE}" rx="16" fill="url(#${gradId})"/>`,
    `<rect x="8" y="8" width="128" height="128" rx="12" fill="#1C1F2E" opacity="0.8"/>`,
    watermark, badgeObj,
    `<text x="20" y="34" font-size="18" font-weight="800" text-anchor="start" fill="#ffffff" font-family="${fontFam}">${escXml(truncate(nameForDisplay, 10))}</text>`,
    (modelName && agent !== 'openclaw') ? `<text x="20" y="56" font-size="12" font-weight="600" text-anchor="start" fill="#94a3b8" font-family="${fontFam}">${escXml(formatModelEffort(modelName, effortLevel, 17))}</text>` : '',
    (mode && mode !== 'default' && agent !== 'openclaw') ? `<text x="20" y="74" font-size="11" font-weight="700" text-anchor="start" fill="#a78bfa" font-family="${fontFam}">${escXml(mode.toUpperCase())}</text>` : '',
    `<text x="20" y="120" font-size="12" font-weight="700" text-anchor="start" fill="${tool ? '#fbbf24' : sColor}" font-family="${fontFam}">${escXml(toolDisplay)}</text>`,
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">${elements}</svg>`;
}

function optionVisual(label: string): { icon: StatusIconKind; tone: StatusCardTone } {
  const lower = label.toLowerCase();
  if (lower.includes('diff') || lower.includes('review') || lower.includes('view')) return { icon: 'diff', tone: 'info' };
  if (lower.startsWith('yes') || lower.startsWith('allow') || lower.startsWith('apply') || lower.includes("don't ask") || lower.includes('always')) return { icon: 'allow', tone: 'ready' };
  if (lower.startsWith('no') || lower.startsWith('deny') || lower.startsWith('reject') || lower.includes('cancel')) return { icon: 'deny', tone: 'danger' };
  return { icon: 'option', tone: 'purple' };
}

export function renderOptionButton(option: PromptOption, index: number): string {
  const label = option.label || `Option ${index + 1}`;
  const { icon, tone } = optionVisual(label);
  const colors = toneColors(tone);
  const fontFam = 'Inter, -apple-system, system-ui, Helvetica Neue, sans-serif';
  const lines = wrapTextByWidth(label, 112, 13).slice(0, 2);
  const startY = lines.length === 1 ? 103 : 96;
  const slotNum = `<circle cx="119" cy="23" r="12" fill="${colors.panel}" stroke="${colors.accent}" stroke-width="1" opacity="0.9"/><text x="119" y="28" text-anchor="middle" font-family="${fontFam}" font-size="12" font-weight="800" fill="${colors.text}" opacity="0.8">${index + 1}</text>`;
  const textEls = lines.map((line, i) => `<text x="72" y="${startY + i * 17}" text-anchor="middle" font-family="${fontFam}" font-size="${line.length > 13 ? '12' : '13'}" font-weight="800" fill="${colors.text}">${escXml(line)}</text>`).join('');
  return svgFrame(
    colors.bg,
    `<rect x="25" y="18" width="94" height="58" rx="14" fill="${colors.panel}" opacity="0.58" stroke="${colors.accent}" stroke-width="1.2" stroke-opacity="0.26"/>`
      + renderGlyphIcon(icon, colors.icon, colors.accent, 72, 43, 0.84)
      + slotNum
      + textEls,
  );
}

export function renderPresetButton(label: string, iconSvg: string, color: string, textColor: string, subtitle?: string, loading?: boolean): string {
  const fontFam = 'Inter, -apple-system, system-ui, Helvetica Neue, sans-serif';
  if (loading) {
    return svgFrame(color, iconSvg + `<text x="72" y="103" text-anchor="middle" font-family="${fontFam}" font-size="13" font-weight="800" fill="${textColor}">SWITCHING</text>`);
  }
  const labelEl = `<text x="72" y="100" text-anchor="middle" font-family="${fontFam}" font-size="16" font-weight="800" fill="${textColor}">${escXml(label)}</text>`;
  const subEl = subtitle ? `<text x="72" y="118" text-anchor="middle" font-family="${fontFam}" font-size="11" font-weight="650" fill="${textColor}" opacity="0.7">${escXml(truncate(subtitle, 14))}</text>` : '';
  return svgFrame(color, iconSvg + labelEl + subEl);
}

export function renderInfoSlot(label: string, subtitle?: string, icon: StatusIconKind = 'activity', tone: StatusCardTone = 'info', detail?: string): string {
  return renderStatusCard({ icon, label, subtitle, detail, tone });
}

export function svgFrame(bgColor: string, innerElements: string): string {
  // Derived from the only input the gradient depends on, never random. A random
  // id made two renders of an IDENTICAL tile differ as strings, which silently
  // defeated every downstream identity check: the D200H plugin re-pushed
  // unchanged quiet keys to the device on every broadcast, its "does this tile
  // animate?" probe answered yes for every one of them, and the GIF encoded from
  // that answer could never hit its cache. Sibling frames here (cluster, grid)
  // were already keyed off their own parameters — this one was the outlier.
  const gradId = `frame-bg-${bgColor.replace(/[^a-zA-Z0-9]/g, '') || 'default'}`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="${bgColor}"/><stop offset="100%" stop-color="#0A0A0E"/></linearGradient></defs>`,
    `<rect width="${SIZE}" height="${SIZE}" rx="16" fill="url(#${gradId})"/>`,
    `<rect x="8" y="8" width="128" height="128" rx="12" fill="#2C2C2E" opacity="0.6"/>`,
    innerElements,
    `</svg>`,
  ].join('');
}

export function renderOpenAppGrid(
  col: number,
  row: number,
  cols: number,
  rows: number,
  label = PASSIVE_OFFLINE_LABEL,
  subtitle = OPEN_AGENTDECK_LABEL,
): string {
  const colors = toneColors('brand');
  const fontFam = 'Inter, -apple-system, system-ui, Helvetica Neue, sans-serif';
  const offsetX = -col * SIZE;
  const offsetY = -row * SIZE;
  const gradId = `frame-bg-grid-${col}-${row}`;

  const minDim = Math.min(cols, rows);
  const baseScale = Math.max(1.0, minDim * 0.8);

  const totalW = cols * SIZE;
  const totalH = rows * SIZE;

  const padX = Math.max(8, 16 * cols / 4);
  const padY = Math.max(8, 16 * rows / 2);
  const rectW = totalW - padX * 2;
  const rectH = totalH - padY * 2;
  const rx = Math.max(12, 28 * minDim / 2);

  const glyphX = totalW / 2;
  const glyphY = totalH / 2 - (24 * baseScale);

  const labelY = totalH / 2 + (20 * baseScale);
  const subY = labelY + (28 * baseScale);

  const fontSizeLabel = Math.max(16, Math.round(36 * (minDim / 2)));
  const fontSizeSub = Math.max(11, Math.round(20 * (minDim / 2)));

  const cluster = [
    `<rect x="${padX}" y="${padY}" width="${rectW}" height="${rectH}" rx="${rx}" fill="${colors.panel}" opacity="0.68" stroke="${colors.accent}" stroke-width="${(2.4 * baseScale).toFixed(1)}" stroke-opacity="0.28"/>`,
    renderGlyphIcon('agentdeck', colors.icon, colors.accent, glyphX, glyphY, baseScale),
    `<text x="${totalW / 2}" y="${labelY}" text-anchor="middle" font-family="${fontFam}" font-size="${fontSizeLabel}" font-weight="800" fill="${colors.text}">${escXml(truncate(label, 16))}</text>`,
    `<text x="${totalW / 2}" y="${subY}" text-anchor="middle" font-family="${fontFam}" font-size="${fontSizeSub}" font-weight="650" fill="${colors.sub}" opacity="0.86">${escXml(truncate(subtitle, 24))}</text>`,
  ].join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="${colors.bg}"/><stop offset="100%" stop-color="#0A0A0E"/></linearGradient></defs>`,
    `<rect width="${SIZE}" height="${SIZE}" rx="16" fill="url(#${gradId})"/>`,
    `<g transform="translate(${offsetX} ${offsetY})">${cluster}</g>`,
    `</svg>`,
  ].join('');
}

export function renderOfflineTouchStrip(index: number): string {
  const fontFam = 'Inter, -apple-system, system-ui, Helvetica Neue, sans-serif';
  const colors = toneColors('brand');
  const W_total = 800;
  const H_total = 100;

  const offsetX = -index * 200;
  const gradId = `touchstrip-offline-bg-${index}`;

  // Entire 800x100 content
  const content = [
    // Background card panel
    `<rect x="15" y="10" width="770" height="80" rx="16" fill="${colors.panel}" opacity="0.68" stroke="${colors.accent}" stroke-width="2" stroke-opacity="0.28"/>`,

    // Left side: AgentDeck brand mark (x=120, y=50)
    renderGlyphIcon('agentdeck', colors.icon, colors.accent, 120, 50, 1.2),

    // Center: Offline text and helper instruction
    `<text x="400" y="44" text-anchor="middle" font-family="${fontFam}" font-size="22" font-weight="800" fill="${colors.text}">AGENTDECK OFFLINE</text>`,
    `<text x="400" y="70" text-anchor="middle" font-family="${fontFam}" font-size="12" font-weight="650" fill="${colors.sub}" opacity="0.86">Open the AgentDeck app — or install:  npx @agentdeck/setup</text>`,

    // Right side: offline icon (x=680, y=50)
    renderGlyphIcon('offline', colors.icon, colors.accent, 680, 50, 1.2),
  ].join('');

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100">`,
    `<defs><linearGradient id="${gradId}" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="${colors.bg}"/><stop offset="100%" stop-color="#0A0A0E"/></linearGradient></defs>`,
    `<rect width="200" height="100" fill="url(#${gradId})"/>`,
    `<g transform="translate(${offsetX} 0)">${content}</g>`,
    `</svg>`
  ].join('');
}
