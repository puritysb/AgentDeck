/**
 * Non-interactive display tiles for the v4 session-per-button keypad.
 *
 * Some keypad slots are pure status READOUTS, not controls: the detail-view
 * session INFO tile and the STATUS cards (MODEL / MODE / READY·STANDBY /
 * AWAITING / current TOOL / IDLE / HUB READY / NO SESSION). Pressing them is a
 * harmless no-op, so they must not wear the chunky button costume (raised key
 * bezel, big centered glyph, bold centered label) that the genuinely-pressable
 * tiles (sessions, options, presets, BACK/MORE/ESC/STOP) use.
 *
 * These renderers give those slots a deliberately FLAT readout look instead:
 *  - full-bleed flat background (no raised inner bezel / pressed affordance)
 *  - a thin left accent bar + left-aligned text (a "data row", not a button)
 *  - no centered action glyph
 *  - slightly dimmed throughout
 *
 * The visual contract: at a glance, centered-glyph bezel tiles = controls,
 * flat left-aligned bar tiles = readouts. Lives in the plugin (not @agentdeck/
 * shared) because the shared renderers are owned elsewhere.
 */
import type { AgentType, SessionInfo, StatusCardTone, State } from '@agentdeck/shared';
import { stateColor, formatModelEffort, escSvgText, PASSIVE_OFFLINE_LABEL, agentSlotAccent } from '@agentdeck/shared';

const SIZE = 144;
const FONT = 'Inter, -apple-system, system-ui, Helvetica Neue, sans-serif';

/** Flat readout background — darker/quieter than the button bezel surface. */
const READOUT_BG = '#08090d';
const READOUT_INK = '#cbd5e1';

interface ReadoutTone {
  accent: string;
  value: string;
  sub: string;
}

function readoutTone(tone: StatusCardTone = 'info'): ReadoutTone {
  switch (tone) {
    case 'ready':
    case 'action':
      return { accent: '#22c55e', value: '#dcfce7', sub: '#86efac' };
    case 'idle':
      return { accent: '#60a5fa', value: '#dbeafe', sub: '#93c5fd' };
    case 'warning':
      return { accent: '#f59e0b', value: '#fde68a', sub: '#fbbf24' };
    case 'danger':
      return { accent: '#ef4444', value: '#fee2e2', sub: '#fca5a5' };
    case 'agent':
      return { accent: '#c084fc', value: '#fae8ff', sub: '#d8b4fe' };
    case 'purple':
      return { accent: '#a78bfa', value: '#f3e8ff', sub: '#d8b4fe' };
    case 'muted':
      return { accent: '#52525b', value: '#e4e4e7', sub: '#a1a1aa' };
    case 'info':
    default:
      return { accent: '#60a5fa', value: '#dbeafe', sub: '#93c5fd' };
  }
}

// Shared sanitizer: strips ANSI/control chars before entity-escaping (raw
// control chars in session text break the SVG parse → blank tile).
const escXml = escSvgText;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** Flat frame: full-bleed background, no raised inner bezel, thin left accent bar. */
function readoutFrame(accent: string, inner: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">`,
    `<rect width="${SIZE}" height="${SIZE}" rx="16" fill="${READOUT_BG}"/>`,
    // Left accent bar — the "readout strip" signature (no button glyph/bezel).
    `<rect x="0" y="22" width="4" height="100" rx="2" fill="${accent}" opacity="0.55"/>`,
    inner,
    `</svg>`,
  ].join('');
}

export interface StatusReadoutConfig {
  label: string;
  subtitle?: string;
  detail?: string;
  tone?: StatusCardTone;
}

/**
 * Flat, non-interactive status readout (drop-in for the shared renderStatusCard
 * button look). Left-aligned label/value/detail on a flat surface — reads as a
 * status display, not a pressable control.
 */
export function renderStatusReadout(config: StatusReadoutConfig): string {
  const c = readoutTone(config.tone);
  const label = truncate(config.label, 14);
  const subtitle = config.subtitle ? truncate(config.subtitle, 18) : '';
  const detail = config.detail ? truncate(config.detail, 18) : '';

  const els: string[] = [];
  // Primary line (the state/category). Dimmed vs. a bold button label.
  els.push(
    `<text x="16" y="${subtitle ? 64 : 78}" font-family="${FONT}" font-size="${label.length > 11 ? '17' : '19'}" font-weight="800" fill="${c.value}" opacity="0.9">${escXml(label)}</text>`,
  );
  if (subtitle) {
    els.push(
      `<text x="16" y="86" font-family="${FONT}" font-size="13" font-weight="600" fill="${c.sub}" opacity="0.72">${escXml(subtitle)}</text>`,
    );
  }
  if (detail) {
    els.push(
      `<text x="16" y="108" font-family="${FONT}" font-size="10" font-weight="600" fill="${c.sub}" opacity="0.5">${escXml(detail)}</text>`,
    );
  }
  return readoutFrame(c.accent, els.join(''));
}


/**
 * Flat, non-interactive session INFO tile for the detail view (drop-in for the
 * shared renderDetailInfo button look). Keeps the info — project name, model,
 * mode, live state — but renders it as a readout strip, not a pressable button.
 */
export function renderSessionReadout(
  session: SessionInfo,
  state: State | undefined,
  modelName?: string,
  displayName?: string,
  effortLevel?: string,
): string {
  const agent = (session.agentType as AgentType) || 'claude-code';
  const accent = agentSlotAccent(agent);
  const name = truncate(displayName ?? session.projectName, 12);
  const effectiveState = (state || session.state) as string | undefined;
  const sColor = effectiveState ? stateColor(effectiveState) : READOUT_INK;
  const stateLbl = stateLabelFor(effectiveState, agent);
  const showModel = modelName && agent !== 'openclaw';

  const els: string[] = [];
  // Agent dot (top-right) — quiet identity marker, not a button badge.
  els.push(`<circle cx="124" cy="22" r="5" fill="${accent}" opacity="0.85"/>`);
  els.push(
    `<text x="16" y="38" font-family="${FONT}" font-size="18" font-weight="800" fill="#e2e8f0" opacity="0.92">${escXml(name)}</text>`,
  );
  if (showModel) {
    els.push(
      `<text x="16" y="60" font-family="${FONT}" font-size="12" font-weight="600" fill="#94a3b8">${escXml(formatModelEffort(modelName, effortLevel, 17))}</text>`,
    );
  }
  els.push(
    `<text x="16" y="122" font-family="${FONT}" font-size="12" font-weight="700" fill="${sColor}" opacity="0.85">${escXml(stateLbl)}</text>`,
  );
  return readoutFrame(accent, els.join(''));
}

function stateLabelFor(state: string | undefined, agent: AgentType): string {
  if (!state) return PASSIVE_OFFLINE_LABEL;
  if (agent === 'openclaw') {
    if (state === 'idle') return 'STANDBY';
    if (state === 'processing') return 'ROUTING';
  }
  switch (state) {
    case 'idle':
      return 'IDLE';
    case 'processing':
      return 'WORKING';
    case 'awaiting_option':
    case 'awaiting_permission':
    case 'awaiting_diff':
      return 'AWAITING';
    default:
      return state.toUpperCase();
  }
}
