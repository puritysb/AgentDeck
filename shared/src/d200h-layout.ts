/**
 * D200H / deck layout engine — SHARED between the direct-HID renderer
 * (bridge/src/d200h/image-renderer.ts) and the Ulanzi Studio plugin
 * (plugin-ulanzi). Given the current agent state it computes, for a 5×3 key
 * grid, what each key shows (SVG) and does (command) — reflowing dynamically:
 * idle → sessions; a focused awaiting session → its options + ESC; processing →
 * STOP; plus mode / model / usage / tokens / cost.
 *
 * Key position is addressed as `col_row` (e.g. "0_0", "3_2") — the same scheme
 * the D200H firmware and Ulanzi Studio both use for keys.
 */
import {
  renderSessionSlot,
  renderEmptySlot,
  renderOptionButton,
  renderStopButton,
  renderEscButton,
  renderDetailInfo,
  renderBackButton,
  renderNextPageButton,
  renderInfoSlot,
  svgFrame,
} from './svg-renderers/index.js';
import { State, type PromptOption } from './states.js';
import type { SessionInfo, SubscriptionInfo } from './protocol.js';

/** Command dispatched when a key is pressed. `null` = inert tile (info/empty). */
export type ButtonCommand = { type: string; [k: string]: unknown };

export interface KeySlot {
  col: number;
  row: number;
  svg: string;
  label: string;
  /** What pressing this key does. Single source of truth for input. */
  command?: ButtonCommand | null;
}

/** 5 columns × 3 rows. Physical key index == row * GRID_COLS + col. */
export const GRID_COLS = 5;

export interface DashState {
  state: string;
  projectName: string;
  modelName: string;
  mode: string;
  agentType: string;
  fiveHourPercent: number;
  sevenDayPercent: number;
  totalTokens: number;
  totalCost: number;
  options: PromptOption[];
  currentTool: string;
  allSessions: SessionInfo[];
  /** Gated PreToolUse request id (observed/no-PTY session) → Allow/Deny via permission_decision. */
  requestId?: string;
  /** Live PTY option cursor is navigable (❯) — drives select_option vs respond. */
  navigable?: boolean;
  /**
   * True when the 5H/7D quota is actually known (subscription data present), so a
   * read-only surface can distinguish "0% used" from "no data" instead of drawing
   * a confident empty gauge. Absent/false on surfaces that don't supply it.
   */
  usageKnown?: boolean;
  /** ISO timestamp when the 5-hour quota window resets (for a countdown). */
  fiveHourResetsAt?: string;
  /** ISO timestamp when the 7-day quota window resets (for a countdown). */
  sevenDayResetsAt?: string;
  /** Active subscriptions (Claude / ChatGPT plan) with optional expiry. */
  subscriptions?: SubscriptionInfo[];
}

export function parseState(evt: any): DashState {
  return {
    state: evt?.state ?? 'DISCONNECTED',
    projectName: evt?.projectName ?? '',
    modelName: evt?.modelName ?? '',
    mode: evt?.mode ?? 'default',
    agentType: evt?.agentType ?? 'claude-code',
    fiveHourPercent: evt?.fiveHourPercent ?? 0,
    sevenDayPercent: evt?.sevenDayPercent ?? 0,
    totalTokens: evt?.totalTokens ?? 0,
    totalCost: evt?.totalCost ?? 0,
    options: (evt?.options ?? []).map((o: any) =>
      typeof o === 'string' ? { label: o } : { label: o?.label ?? '', shortcut: o?.shortcut ?? '' },
    ),
    currentTool: evt?.currentTool ?? '',
    allSessions: Array.isArray(evt?.allSessions) ? evt.allSessions : [],
    requestId: typeof evt?.requestId === 'string' ? evt.requestId : undefined,
    navigable: Boolean(evt?.navigable),
    // Prefer an explicit flag; otherwise infer from the presence of a real percent.
    usageKnown:
      typeof evt?.usageKnown === 'boolean'
        ? evt.usageKnown
        : evt?.fiveHourPercent != null || evt?.sevenDayPercent != null,
    fiveHourResetsAt: typeof evt?.fiveHourResetsAt === 'string' ? evt.fiveHourResetsAt : undefined,
    sevenDayResetsAt: typeof evt?.sevenDayResetsAt === 'string' ? evt.sevenDayResetsAt : undefined,
    subscriptions: Array.isArray(evt?.subscriptions) ? evt.subscriptions : undefined,
  };
}

// --- SVG helpers for info / usage / mode / offline tiles ---

function escXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function gaugeBar(pct: number, width = 8): string {
  const filled = Math.round(Math.min(pct, 100) / 100 * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function gaugeColor(pct: number): string {
  return pct > 80 ? '#ef4444' : pct > 50 ? '#eab308' : '#22c55e';
}

export function renderUsageButton(label: string, percent: number, color: string, known = true): string {
  // When the subscription quota is unknown (no OAuth data / stale hub), draw a
  // muted "—" instead of a confident 0% that would read as "fully available".
  if (!known) {
    const dim = '#475569';
    const elements = [
      `<text x="72" y="36" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#94a3b8">${escXml(label)}</text>`,
      `<text x="72" y="60" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="14" fill="${dim}">${escXml('░'.repeat(8))}</text>`,
      `<text x="72" y="90" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="${dim}">—</text>`,
      `<rect x="16" y="110" width="112" height="2" rx="1" fill="#1e293b"/>`,
    ].join('');
    return svgFrame('#0f172a', elements);
  }
  const gBar = gaugeBar(percent, 8);
  const elements = [
    `<text x="72" y="36" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" fill="#94a3b8">${escXml(label)}</text>`,
    `<text x="72" y="60" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="14" fill="${color}">${escXml(gBar)}</text>`,
    `<text x="72" y="90" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="#ffffff">${Math.round(percent)}%</text>`,
    `<rect x="16" y="110" width="112" height="2" rx="1" fill="#1e293b"/>`,
    `<rect x="16" y="110" width="${Math.round(112 * Math.min(percent, 100) / 100)}" height="2" rx="1" fill="${color}"/>`,
  ].join('');
  return svgFrame('#0f172a', elements);
}

/** Wide merged slot (3_2) — 288×144 SVG. Two columns: 5H | 7D. Direct-HID only. */
export function renderUsageWideSlot(fiveHourPct: number, sevenDayPct: number, known = true): string {
  const c5 = gaugeColor(fiveHourPct);
  const c7 = gaugeColor(sevenDayPct);
  // Unknown quota → "—" instead of a confident 0% (mirrors renderUsageButton).
  const pct5 = known ? `${Math.round(fiveHourPct)}%` : '—';
  const pct7 = known ? `${Math.round(sevenDayPct)}%` : '—';
  const w5 = known ? Math.round(120 * Math.min(fiveHourPct, 100) / 100) : 0;
  const w7 = known ? Math.round(120 * Math.min(sevenDayPct, 100) / 100) : 0;
  const valColor = known ? '#ffffff' : '#475569';
  const elements = [
    `<rect x="0" y="0" width="144" height="144" fill="#0f172a"/>`,
    `<rect x="144" y="0" width="144" height="144" fill="#0f172a"/>`,
    `<rect x="8" y="8" width="128" height="128" rx="8" fill="#1e293b" opacity="0.3"/>`,
    `<rect x="152" y="8" width="128" height="128" rx="8" fill="#1e293b" opacity="0.3"/>`,
    `<text x="72" y="26" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="#94a3b8">5H</text>`,
    `<text x="216" y="26" text-anchor="middle" font-family="Arial,sans-serif" font-size="12" font-weight="bold" fill="#94a3b8">7D</text>`,
    `<text x="72" y="70" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" font-weight="bold" fill="${valColor}">${pct5}</text>`,
    `<text x="216" y="70" text-anchor="middle" font-family="Arial,sans-serif" font-size="32" font-weight="bold" fill="${valColor}">${pct7}</text>`,
    `<rect x="12" y="132" width="120" height="2" rx="1" fill="#1e293b"/>`,
    `<rect x="156" y="132" width="120" height="2" rx="1" fill="#1e293b"/>`,
    `<rect x="12" y="132" width="${w5}" height="2" rx="1" fill="${c5}"/>`,
    `<rect x="156" y="132" width="${w7}" height="2" rx="1" fill="${c7}"/>`,
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="288" height="144" viewBox="0 0 288 144">${elements}</svg>`;
}

function renderInfoButton(title: string, value: string, titleColor = '#94a3b8', valueColor = '#ffffff'): string {
  const valueFontSize = value.length > 8 ? 16 : value.length > 5 ? 20 : 24;
  const elements = [
    `<text x="72" y="52" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="${titleColor}">${escXml(title)}</text>`,
    `<text x="72" y="${86 + (valueFontSize < 20 ? 2 : 0)}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${valueFontSize}" font-weight="bold" fill="${valueColor}">${escXml(value)}</text>`,
  ].join('');
  return svgFrame('#1C1C1E', elements);
}

function renderModeButton(mode: string): string {
  const elements = [
    `<text x="72" y="52" text-anchor="middle" font-family="Arial,sans-serif" font-size="14" font-weight="bold" fill="#94a3b8">MODE</text>`,
    `<text x="72" y="88" text-anchor="middle" font-family="Arial,sans-serif" font-size="18" font-weight="bold" fill="#a78bfa">${escXml(mode.toUpperCase())}</text>`,
  ].join('');
  return svgFrame('#1C1C1E', elements);
}

function renderOfflineSlot(hero = false): string {
  if (hero) {
    const colors = { bg: '#07170f', text: '#dcfce7', sub: '#86efac' };
    const elements = [
      `<text x="72" y="54" text-anchor="middle" font-family="Arial,sans-serif" font-size="28" font-weight="bold" fill="${colors.text}">OFFLINE</text>`,
      `<text x="72" y="82" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="${colors.sub}">Open AgentDeck</text>`,
    ].join('');
    return svgFrame(colors.bg, elements);
  }
  return svgFrame('#0a0a0a', `<text x="72" y="80" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#1f2937">--</text>`);
}

/**
 * Compute the dynamic 5×3 grid for the current state. Returns slots 0–12
 * (the merged wide usage slot 3_2 is rendered by the direct-HID consumer
 * separately; see `usageTileForGrid` for the per-key variant).
 *
 * `animFrame` advances the shared renderer's session-tile animation; pass a
 * fixed value (e.g. 0) for a static frame.
 */
/**
 * One row-of-actions key for the legacy single-page D200H layout. Renders the
 * i-th real option when the focused/PTY session reported options; otherwise, for
 * an observed gated PreToolUse session (no PTY options but a `requestId`), shows
 * Allow/Deny in slots 0/1 wired to `permission_decision`. Falls back to an empty
 * slot — never a hardcoded Yes/No/Always that can't drive the agent.
 */
function awaitingActionSlot(state: DashState, isAwaiting: boolean, i: number, col: number, row: number): KeySlot {
  if (isAwaiting) {
    const opt = state.options[i];
    if (opt) {
      return { col, row, svg: renderOptionButton(opt, i), label: '', command: { type: 'select_option', index: i } };
    }
    if (state.options.length === 0 && state.requestId) {
      if (i === 0) return { col, row, svg: renderOptionButton({ index: 0, label: 'Allow' }, 0), label: '', command: { type: 'permission_decision', requestId: state.requestId, decision: 'allow' } };
      if (i === 1) return { col, row, svg: renderOptionButton({ index: 1, label: 'Deny' }, 1), label: '', command: { type: 'permission_decision', requestId: state.requestId, decision: 'deny' } };
    }
  }
  return { col, row, svg: renderEmptySlot(), label: '', command: null };
}

export function computeLayout(state: DashState, animFrame = 0, animated = false): KeySlot[] {
  const isDisconnected = state.state === 'DISCONNECTED' || state.state === 'disconnected';
  if (isDisconnected) {
    const slots: KeySlot[] = [];
    const heroCol = 2, heroRow = 1;
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 5; col++) {
        slots.push({ col, row, svg: renderOfflineSlot(col === heroCol && row === heroRow), label: '', command: null });
      }
    }
    return slots;
  }

  const slots: KeySlot[] = [];
  const isAwaiting = state.state.startsWith('AWAITING') || state.state.startsWith('awaiting');
  const isProcessing = state.state === 'PROCESSING' || state.state === 'processing';

  const activeSession: SessionInfo = {
    id: 'local',
    agentType: state.agentType as any,
    projectName: state.projectName,
    modelName: state.modelName,
    state: state.state.toLowerCase(),
    alive: true,
    port: 0,
  };

  const sessionsToDisplay = state.allSessions.length > 0 ? state.allSessions.slice(0, 4) : [activeSession];
  const isMultiSession = sessionsToDisplay.length > 1;

  if (isMultiSession) {
    slots.push({ col: 0, row: 0, svg: renderModeButton(state.mode), label: '', command: { type: 'mode_toggle' } });
    for (let i = 0; i < 4; i++) {
      const col = i + 1;
      const sess = sessionsToDisplay[i];
      if (sess) {
        const isActive = sess.projectName === activeSession.projectName && sess.agentType === activeSession.agentType;
        slots.push({ col, row: 0, svg: renderSessionSlot(sess, isActive, animFrame, undefined, { animated }), label: '', command: { type: 'focus_session', sessionId: sess.id } });
      } else {
        slots.push({ col, row: 0, svg: renderEmptySlot(), label: '', command: null });
      }
    }
    for (let i = 0; i < 4; i++) {
      const col = i;
      slots.push(awaitingActionSlot(state, isAwaiting, i, col, 1));
    }
    slots.push({ col: 4, row: 1, svg: renderInfoButton('MODEL', state.modelName.slice(0, 12) || 'N/A'), label: '', command: null });
  } else {
    const heroSession = state.allSessions.length > 0 ? sessionsToDisplay[0] : null;
    slots.push({ col: 0, row: 0, svg: renderModeButton(state.mode), label: '', command: { type: 'mode_toggle' } });
    slots.push({ col: 1, row: 0, svg: renderSessionSlot(sessionsToDisplay[0], true, animFrame, undefined, { animated }), label: '', command: heroSession ? { type: 'focus_session', sessionId: heroSession.id } : null });
    slots.push({ col: 2, row: 0, svg: renderDetailInfo(sessionsToDisplay[0], state.state.toLowerCase() as State, state.currentTool, state.modelName, state.mode), label: '', command: null });

    for (let i = 0; i < 4; i++) {
      const col = (i + 3) % 5;
      const row = Math.floor((i + 3) / 5);
      slots.push(awaitingActionSlot(state, isAwaiting, i, col, row));
    }
    slots.push({ col: 2, row: 1, svg: renderInfoButton('MODEL', state.modelName.slice(0, 12) || 'N/A'), label: '', command: null });
    slots.push({ col: 3, row: 1, svg: renderUsageButton('5H', state.fiveHourPercent, '#28a0b4', state.usageKnown !== false), label: '', command: { type: 'usage_toggle' } });
    slots.push({ col: 4, row: 1, svg: renderUsageButton('7D', state.sevenDayPercent, '#2850a0', state.usageKnown !== false), label: '', command: { type: 'usage_toggle' } });
  }

  // Row 2 shared actions: STOP/ESC, TOKENS, COST
  if (isProcessing) {
    slots.push({ col: 0, row: 2, svg: renderStopButton(true), label: '', command: { type: 'interrupt' } });
  } else if (isAwaiting) {
    slots.push({ col: 0, row: 2, svg: renderEscButton(true), label: '', command: { type: 'interrupt' } });
  } else {
    slots.push({ col: 0, row: 2, svg: renderStopButton(false), label: '', command: { type: 'interrupt' } });
  }
  const tk = state.totalTokens > 1000 ? `${(state.totalTokens / 1000).toFixed(0)}K` : `${state.totalTokens}`;
  slots.push({ col: 1, row: 2, svg: renderInfoButton('TOKENS', tk), label: '', command: null });
  slots.push({ col: 2, row: 2, svg: renderInfoButton('COST', `$${state.totalCost.toFixed(2)}`), label: '', command: null });

  return slots;
}

/** Physical-key-index → command map (index = row*GRID_COLS+col). Direct-HID input. */
export function buildButtonCommandMap(stateEvt: any): Map<number, ButtonCommand> {
  const layout = computeLayout(parseState(stateEvt));
  const map = new Map<number, ButtonCommand>();
  for (const slot of layout) {
    if (slot.command) map.set(slot.row * GRID_COLS + slot.col, slot.command);
  }
  return map;
}

export interface DeckCell {
  svg: string;
  command: ButtonCommand | null;
}

/**
 * `col_row` → {svg, command} map for the WHOLE grid, for plugins that address
 * keys by position (Ulanzi Studio). Unlike direct-HID, slot 3_2 is a normal
 * per-key usage tile (no hardware merge), and 4_2 mirrors it.
 */
export function buildLayoutMap(stateEvt: any, animFrame = 0, animated = false): Map<string, DeckCell> {
  const state = parseState(stateEvt);
  const map = new Map<string, DeckCell>();
  for (const slot of computeLayout(state, animFrame, animated)) {
    map.set(`${slot.col}_${slot.row}`, { svg: slot.svg, command: slot.command ?? null });
  }
  // Per-key usage tiles for the right side of row 2 (direct-HID merges these).
  if (!map.has('3_2')) {
    map.set('3_2', { svg: renderUsageButton('5H', state.fiveHourPercent, '#28a0b4', state.usageKnown !== false), command: { type: 'usage_toggle' } });
  }
  if (!map.has('4_2')) {
    map.set('4_2', { svg: renderUsageButton('7D', state.sevenDayPercent, '#2850a0', state.usageKnown !== false), command: { type: 'usage_toggle' } });
  }
  return map;
}

// ============================================================================
// Session-centric two-level deck (v4) — the canonical AgentDeck layout.
// List view: one session per key (fixed position, awaiting emphasized).
// Detail view: press a session → keys reflow to its options / permission /
// quick-actions + BACK + STOP. Stateless; the caller tracks the DeckView.
// Addresses keys by `col_row`, laid out over whatever positions the device has.
// ============================================================================

/** A press resolves to a daemon command and/or a local view change. */
export type DeckAction =
  | { kind: 'open'; sessionId: string }   // enter detail (+ focus_session)
  | { kind: 'back' }                      // return to list
  | { kind: 'page'; delta: number }       // paginate current view
  | { kind: 'command'; command: ButtonCommand }
  | { kind: 'launch' }                    // daemon down → open the companion app locally
  | null;

export interface SessionDeckCell { svg: string; action: DeckAction; }

export interface DeckView {
  mode: 'list' | 'detail';
  openSessionId?: string;
  page?: number;
  animFrame?: number;
  animated?: boolean;
  /**
   * Opt-in: pin the last two list-view positions to 5H/7D subscription-usage
   * tiles (the global quota gauges). Used by surfaces with no encoder LCD to
   * carry usage (Ulanzi D200H, classic Stream Deck). Off by default so other
   * consumers keep the full grid for sessions.
   */
  showUsage?: boolean;
}

const AGENT_RANK: Record<string, number> = { openclaw: 0, 'claude-code': 1, 'codex-cli': 2, 'codex-app': 2, codex: 2, opencode: 3 };

/** Stable order → a session keeps the same key while the set is unchanged. */
function sortSessions(sessions: SessionInfo[]): SessionInfo[] {
  return [...sessions].sort((a, b) => {
    const ra = AGENT_RANK[a.agentType ?? ''] ?? 9;
    const rb = AGENT_RANK[b.agentType ?? ''] ?? 9;
    if (ra !== rb) return ra - rb;
    const pa = a.projectName ?? '', pb = b.projectName ?? '';
    if (pa !== pb) return pa < pb ? -1 : 1;
    return (a.id ?? '') < (b.id ?? '') ? -1 : 1;
  });
}

/** Row-major position order ("0_0","1_0",…,"4_2"). */
function sortPositions(positions: string[]): string[] {
  return [...positions].sort((a, b) => {
    const [ac, ar] = a.split('_').map(Number);
    const [bc, br] = b.split('_').map(Number);
    return ar !== br ? ar - br : ac - bc;
  });
}

const awaitingState = (s?: string) => !!s && s.toLowerCase().startsWith('awaiting');
const processingState = (s?: string) => s?.toLowerCase() === 'processing';

/** Small colored action tile (Allow/Deny/Always/quick-action). */
function actionTile(label: string, color: string, subtitle?: string): string {
  const els = [
    `<text x="72" y="${subtitle ? 70 : 80}" text-anchor="middle" font-family="Arial,sans-serif" font-size="22" font-weight="bold" fill="${color}">${label}</text>`,
    subtitle ? `<text x="72" y="98" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" fill="#94a3b8">${subtitle}</text>` : '',
  ].join('');
  return svgFrame('#16181d', els);
}

export function buildSessionDeck(stateEvt: any, view: DeckView, positions: string[]): Map<string, SessionDeckCell> {
  const state = parseState(stateEvt);
  const slots = sortPositions(positions);
  const out = new Map<string, SessionDeckCell>();
  const animFrame = view.animFrame ?? 0;
  const animated = view.animated ?? false;
  if (slots.length === 0) return out;

  // Daemon down → OFFLINE hero on the center key, rest dim. Every key launches
  // the companion app on press (parity with the SD/SD+ keypad). If AgentDeck
  // isn't installed yet, the hero shows the install command so a marketplace-only
  // user knows the daemon is the missing piece.
  if (state.state === 'DISCONNECTED' || state.state === 'disconnected') {
    const hero = Math.floor(slots.length / 2);
    slots.forEach((pos, i) => out.set(pos, {
      svg: i === hero ? renderInfoSlot('OFFLINE', 'Open AgentDeck', 'activity', 'info', 'npx @agentdeck/setup') : renderEmptySlot(),
      action: { kind: 'launch' },
    }));
    return out;
  }

  if (view.mode === 'detail' && view.openSessionId) {
    return buildDetail(state, stateEvt, view, slots, animFrame, animated, out);
  }
  return buildList(state, view, slots, animFrame, animated, out);
}

function buildList(
  state: DashState, view: DeckView, slots: string[], animFrame: number, animated: boolean,
  out: Map<string, SessionDeckCell>,
): Map<string, SessionDeckCell> {
  const sessions = sortSessions(state.allSessions);

  // Pin the bottom-right two keys to 5H/7D global usage gauges (opt-in). On the
  // D200H these land just left of the native clock widget; on classic Stream
  // Deck they replace the encoder LCD this surface lacks. `usageHere` maps a
  // reserved position → its tile, so paging math below treats those keys as
  // unavailable for sessions and pins them on EVERY page (usage is global).
  const usageHere = new Map<string, SessionDeckCell>();
  if (view.showUsage && slots.length >= 6) {
    const known = state.usageKnown !== false;
    const last = slots[slots.length - 1];
    const prev = slots[slots.length - 2];
    usageHere.set(prev, {
      svg: renderUsageButton('5H', state.fiveHourPercent, '#28a0b4', known),
      action: { kind: 'command', command: { type: 'query_usage' } },
    });
    usageHere.set(last, {
      svg: renderUsageButton('7D', state.sevenDayPercent, '#2850a0', known),
      action: { kind: 'command', command: { type: 'query_usage' } },
    });
  }
  // Positions left for sessions / NEXT after carving out usage.
  const freeSlots = slots.filter((pos) => !usageHere.has(pos));

  if (sessions.length === 0) {
    freeSlots.forEach((pos, i) => out.set(pos, {
      svg: i === 0 ? renderInfoSlot('NO SESSION', 'waiting', 'activity', 'info') : renderEmptySlot(),
      action: null,
    }));
    for (const [pos, cell] of usageHere) out.set(pos, cell);
    return out;
  }

  const overflow = sessions.length > freeSlots.length;
  const sessionSlots = overflow ? freeSlots.length - 1 : freeSlots.length;
  const pages = Math.max(1, Math.ceil(sessions.length / Math.max(1, sessionSlots)));
  const page = ((view.page ?? 0) % pages + pages) % pages;
  const pageSessions = sessions.slice(page * sessionSlots, page * sessionSlots + sessionSlots);

  freeSlots.forEach((pos, i) => {
    if (overflow && i === freeSlots.length - 1) {
      out.set(pos, { svg: renderNextPageButton(`${page + 1}/${pages}`), action: { kind: 'page', delta: 1 } });
      return;
    }
    const sess = pageSessions[i];
    if (sess) {
      out.set(pos, {
        svg: renderSessionSlot(sess, false, animFrame, undefined, { animated }),
        action: { kind: 'open', sessionId: sess.id },
      });
    } else {
      out.set(pos, { svg: renderEmptySlot(), action: null });
    }
  });
  for (const [pos, cell] of usageHere) out.set(pos, cell);
  return out;
}

function buildDetail(
  state: DashState, stateEvt: any, view: DeckView, slots: string[], animFrame: number, animated: boolean,
  out: Map<string, SessionDeckCell>,
): Map<string, SessionDeckCell> {
  const sid = view.openSessionId!;
  const sess = state.allSessions.find((s) => s.id === sid);
  // Focused-session detail comes from the top-level state_update when it relays
  // this session (focusedSessionId/sessionId match); else fall back to SessionInfo.
  const focused = stateEvt?.focusedSessionId === sid || stateEvt?.sessionId === sid;
  const sState = (focused ? state.state : (sess?.state ?? 'idle')).toLowerCase();
  const options = (focused ? state.options : (sess?.options ?? [])) ?? [];
  const requestId = (focused ? stateEvt?.requestId : sess?.requestId) as string | undefined;
  const tool = focused ? state.currentTool : sess?.currentTool;
  const model = sess?.modelName ?? state.modelName;

  const heroSess: SessionInfo = sess ?? {
    id: sid, port: 0, alive: true, projectName: state.projectName,
    agentType: state.agentType as any, state: sState, modelName: model,
  };

  const first = slots[0];
  const last = slots[slots.length - 1];
  out.set(first, { svg: renderBackButton(), action: { kind: 'back' } });
  out.set(slots[1] ?? first, {
    svg: renderDetailInfo(heroSess, sState as State, tool, model, undefined),
    action: null,
  });
  if (processingState(sState)) {
    out.set(last, { svg: renderStopButton(true), action: { kind: 'command', command: { type: 'interrupt' } } });
  } else if (awaitingState(sState)) {
    out.set(last, { svg: renderEscButton(true), action: { kind: 'command', command: { type: 'escape' } } });
  } else {
    out.set(last, { svg: renderStopButton(false), action: { kind: 'command', command: { type: 'interrupt' } } });
  }

  // Content slots between INFO and STOP.
  const content = slots.slice(2, slots.length - 1);
  const cells: SessionDeckCell[] = [];

  if (awaitingState(sState)) {
    // A focused PTY session reports `navigable` on the live state_update; a
    // non-focused SessionInfo never carries it (and rarely carries options).
    const navigable = Boolean(focused ? stateEvt?.navigable : false);
    if (options.length > 0) {
      // Render the REAL option set (permission OR multi-select) regardless of
      // promptType — the parser already extracted the actual labels (e.g.
      // "Yes" / "Yes, and don't ask again" / "No, tell Claude"). Navigable TUI
      // (❯ cursor) → select_option so the daemon drives arrows+Enter;
      // non-navigable inline prompts → respond with the option's shortcut.
      options.forEach((opt, i) => {
        const command: ButtonCommand = navigable
          ? { type: 'select_option', index: i, sessionId: sid }
          : { type: 'respond', value: opt.shortcut || opt.label?.charAt(0)?.toLowerCase() || String(i + 1) };
        cells.push({ svg: renderOptionButton(opt, i), action: { kind: 'command', command } });
      });
    } else if (requestId != null) {
      // Observed gated PreToolUse (no PTY): the hook only supports allow/deny,
      // so present exactly those — never a fake "Always".
      cells.push({ svg: actionTile('Allow', '#22c55e'), action: { kind: 'command', command: { type: 'permission_decision', requestId, decision: 'allow' } } });
      cells.push({ svg: actionTile('Deny', '#ef4444'), action: { kind: 'command', command: { type: 'permission_decision', requestId, decision: 'deny' } } });
    } else {
      // Awaiting but not remotely answerable (Notification-only signal, or a
      // multi-option prompt on a no-PTY session). Don't fabricate Yes/No/Always
      // buttons that go nowhere — guide the user to the terminal instead.
      cells.push({ svg: renderInfoSlot('AWAITING', 'answer in terminal', 'activity', 'action'), action: null });
    }
  } else if (processingState(sState)) {
    cells.push({ svg: renderInfoSlot('RUNNING', tool || 'working', 'activity', 'action'), action: null });
  } else {
    // idle quick-actions
    const presets: Array<[string, string]> = [['GO ON', 'continue'], ['REVIEW', 'review the changes'], ['COMMIT', 'commit the changes'], ['CLEAR', '/clear']];
    presets.forEach(([label, text]) => cells.push({ svg: actionTile(label, '#cbd5e1'), action: { kind: 'command', command: { type: 'send_prompt', text } } }));
  }

  // Paginate cells into content slots; reserve last content slot for MORE if overflow.
  const cap = content.length;
  const overflow = cells.length > cap;
  const perPage = overflow ? cap - 1 : cap;
  const pages = Math.max(1, Math.ceil(cells.length / Math.max(1, perPage)));
  const page = ((view.page ?? 0) % pages + pages) % pages;
  const pageCells = cells.slice(page * perPage, page * perPage + perPage);
  content.forEach((pos, i) => {
    if (overflow && i === content.length - 1) {
      out.set(pos, { svg: renderNextPageButton(`${page + 1}/${pages}`), action: { kind: 'page', delta: 1 } });
      return;
    }
    out.set(pos, pageCells[i] ?? { svg: renderEmptySlot(), action: null });
  });
  return out;
}
