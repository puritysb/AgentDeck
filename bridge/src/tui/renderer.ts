import { dotDeckPresentation } from '@agentdeck/shared';
/**
 * TUI Dashboard renderer — the "tide console".
 *
 * One information hierarchy, three arrangements (DESIGN.md §5.13):
 *   wide     SESSIONS │ AQUARIUM + ACTIVITY │ USAGE + MODELS + DEVICES
 *   standard SESSIONS + ACTIVITY │ AQUARIUM + USAGE + MODELS + DEVICES
 *   narrow   one named tab at a time (Sessions / Usage / Activity / Devices)
 *
 * Width invariant: every output line is exactly `cols` terminal cells (wide
 * CJK counts two — see width.ts). Columns stack titled sections; a section
 * boundary draws a junction-aware divider so borders never cross text.
 */

import {
  cursor, screen as screenCodes, RESET, BOLD,
  box, hLine, truncText, padRight, visLen, terminalCaps, centerText,
} from './ansi.js';
import type { DashboardState, LayoutMode } from './dashboard.js';
import type { ModelCatalogEntry, OllamaStatus, TimelineEntryType } from '@agentdeck/shared';
import { DAEMON_LINK_LABELS, Brand } from '@agentdeck/shared';
import {
  ink, toneColor, stateGlyph, stateChip, quotaColor, brandColor, agentMark, agentName, hex,
} from './theme.js';
import {
  buildRoster, rosterCounts, rosterDensity, summarizeRoster, buildUsageGroups,
  buildTimelineRows, type RosterCard, type UsageGroupVM, type UsageRowVM,
} from './model.js';

export { buildHudEntries, formatTaskEvalSuffix, type HudEntry } from './model.js';

// ===== View state =====

export type ViewTab = 'sessions' | 'usage' | 'activity' | 'devices';

export interface ViewState {
  /** Roster cursor (session id). Defaults to the most urgent session. */
  selectedId?: string;
  /** Which list the arrow keys drive. */
  focus: 'roster' | 'activity';
  /** Show the selected session's detail card. */
  detail: boolean;
  /** Narrow the activity feed to the selected session. */
  follow: boolean;
  /** Narrow layout: the one panel on screen. */
  tab: ViewTab;
}

export function defaultView(): ViewState {
  return { focus: 'roster', detail: false, follow: false, tab: 'sessions' };
}

// ===== Layout breakpoints =====

export function getLayout(cols: number, _rows: number): LayoutMode {
  if (cols >= 120) return 'wide';
  if (cols >= 80) return 'standard';
  return 'narrow';
}

export function shouldShowTerrarium(cols: number, rows: number): boolean {
  if (cols < 60) return false;
  if (rows < 16) return false;
  return true;
}

interface Geometry {
  layout: LayoutMode;
  /** Column widths (content cells, borders excluded). */
  widths: number[];
  /** Body rows between the top and bottom border. */
  bodyH: number;
  aquarium: { width: number; height: number } | null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function geometry(cols: number, rows: number): Geometry {
  const layout = getLayout(cols, rows);
  const bodyH = rows - 4; // content rows: minus header, top border, bottom border, footer
  const showAq = shouldShowTerrarium(cols, rows);
  if (layout === 'wide') {
    const left = clamp(Math.floor(cols * 0.30), 36, 54);
    const right = clamp(Math.floor(cols * 0.24), 32, 42);
    const center = cols - left - right - 4;
    const h = clamp(Math.round(bodyH * (rows >= 40 ? 0.46 : 0.40)), 6, 20);
    return { layout, widths: [left, center, right], bodyH, aquarium: showAq ? { width: center, height: h } : null };
  }
  if (layout === 'standard') {
    const right = clamp(Math.floor(cols * 0.42), 34, 48);
    const left = cols - right - 3;
    const h = clamp(Math.round(bodyH * 0.30), 5, 10);
    return { layout, widths: [left, right], bodyH, aquarium: showAq ? { width: right, height: h } : null };
  }
  return { layout, widths: [cols - 2], bodyH, aquarium: null };
}

/** The terrarium size the dashboard should render for this screen. */
export function aquariumSize(cols: number, rows: number): { width: number; height: number } | null {
  return geometry(cols, rows).aquarium;
}

// ===== Column compositor =====

interface Section {
  title: string;
  lines: string[];
  /** Natural height (content rows). */
  want: number;
  min: number;
  /** Fixed sections never grow past `want`. */
  fixed?: boolean;
  /** What the rows are, for an honest "N more <noun>" when they don't fit. */
  noun?: string;
}

/** Split `total` content rows across sections; dividers cost one row each. */
function allocate(sections: Section[], total: number): number[] {
  const avail = Math.max(0, total - (sections.length - 1));
  const heights = sections.map(s => Math.min(s.min, s.want));
  let left = avail - heights.reduce((a, b) => a + b, 0);
  // Grow toward natural height in order, then give the rest to growable ones.
  for (let i = 0; i < sections.length && left > 0; i++) {
    const add = Math.min(left, Math.max(0, sections[i]!.want - heights[i]!));
    heights[i]! += add;
    left -= add;
  }
  const growable = sections.map((s, i) => (s.fixed ? -1 : i)).filter(i => i >= 0);
  const last = growable[growable.length - 1];
  if (left > 0 && last !== undefined) heights[last]! += left;
  // Over-committed minima: shrink from the end.
  let over = heights.reduce((a, b) => a + b, 0) - avail;
  for (let i = heights.length - 1; i >= 0 && over > 0; i--) {
    const cut = Math.min(over, heights[i]!);
    heights[i]! -= cut;
    over -= cut;
  }
  return heights;
}

interface ColumnRow { divider?: string; text?: string }

function columnRows(sections: Section[], bodyH: number): { top: string; rows: ColumnRow[] } {
  const heights = allocate(sections, bodyH);
  const rows: ColumnRow[] = [];
  sections.forEach((s, i) => {
    if (i > 0) rows.push({ divider: s.title });
    const h = heights[i]!;
    const lines = s.lines.slice(0, h);
    // Bounded collection (DESIGN.md §5.11): never drop rows silently.
    const hidden = s.lines.slice(h).filter(l => l.trim() !== '').length;
    if (hidden > 0 && h > 0 && s.noun) {
      const more = s.lines.slice(h - 1).filter(l => l.trim() !== '').length;
      lines[h - 1] = `  ${ink.faint}${more} more ${s.noun}${RESET}`;
    }
    for (let r = 0; r < h; r++) rows.push({ text: lines[r] ?? '' });
  });
  while (rows.length < bodyH) rows.push({ text: '' });
  return { top: sections[0]?.title ?? '', rows: rows.slice(0, bodyH) };
}

function titleRule(title: string, width: number): string {
  if (!title) return `${ink.rule}${hLine(width)}${RESET}`;
  const label = truncText(title, Math.max(0, width - 4));
  const fill = Math.max(0, width - visLen(label) - 3);
  return `${ink.rule}${box.h} ${RESET}${label}${ink.rule} ${hLine(fill)}${RESET}`;
}

function compose(columns: Array<{ width: number; sections: Section[] }>, bodyH: number): string[] {
  const built = columns.map(c => ({ width: c.width, ...columnRows(c.sections, bodyH) }));
  const out: string[] = [];
  const b = (ch: string) => `${ink.rule}${ch}${RESET}`;
  const uni = terminalCaps.unicode;
  const cross = uni ? '┼' : '+';

  let top = b(box.tl);
  built.forEach((c, i) => {
    top += titleRule(c.top, c.width) + b(i === built.length - 1 ? box.tr : box.tee);
  });
  out.push(top);

  for (let r = 0; r < bodyH; r++) {
    let line = '';
    for (let i = 0; i < built.length; i++) {
      const cur = built[i]!.rows[r]!;
      const prev = i > 0 ? built[i - 1]!.rows[r]! : undefined;
      const curDiv = cur.divider !== undefined;
      const prevDiv = prev?.divider !== undefined;
      const edge = i === 0 ? (curDiv ? box.lTee : box.v)
        : curDiv && prevDiv ? cross : curDiv ? box.lTee : prevDiv ? box.rTee : box.v;
      line += b(edge);
      line += curDiv ? titleRule(cur.divider!, built[i]!.width) : padRight(truncText(cur.text ?? '', built[i]!.width), built[i]!.width);
    }
    const last = built[built.length - 1]!.rows[r]!;
    line += b(last.divider !== undefined ? box.rTee : box.v);
    out.push(line);
  }

  let bottom = b(box.bl);
  built.forEach((c, i) => {
    bottom += `${ink.rule}${hLine(c.width)}${RESET}` + b(i === built.length - 1 ? box.br : box.bTee);
  });
  out.push(bottom);
  return out;
}

// ===== Small text helpers =====

/** Left text and right text on one line of exactly `width` cells. */
function spread(left: string, right: string, width: number): string {
  const rw = visLen(right);
  if (!right) return truncText(left, width);
  const lw = Math.max(0, width - rw - 1);
  return padRight(truncText(left, lw), lw) + ' ' + right;
}

function title(label: string, extra = ''): string {
  return `${ink.accent}${BOLD}${label}${RESET}${extra ? `${ink.faint} ${extra}${RESET}` : ''}`;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
export function spinner(frame: number): string {
  return terminalCaps.unicode ? SPINNER_FRAMES[Math.floor(frame / 2) % SPINNER_FRAMES.length]! : '|/-\\'[frame % 4]!;
}

function clock(now = new Date()): string {
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

// ===== Header & footer =====

function linkLabel(state: DashboardState): { dot: string; text: string } {
  if (state.connectionStatus === 'connected') {
    return { dot: `${ink.ok}●${RESET}`, text: `${DAEMON_LINK_LABELS.connected} :${state.currentPort ?? ''}` };
  }
  const phase = state.hasConnected ? 'reconnecting' : state.connectionStatus === 'reconnecting' ? 'connecting' : 'searching';
  return { dot: `${ink.attn}◔${RESET}`, text: DAEMON_LINK_LABELS[phase] };
}

function renderHeader(state: DashboardState, cards: RosterCard[], cols: number, frame: number): string {
  const mark = `${ink.accent}${BOLD}${terminalCaps.unicode ? '◈' : '#'} AgentDeck${RESET}`;
  const link = linkLabel(state);
  const stale = state.isStale ? ` ${ink.attn}stale${RESET}` : '';
  const c = rosterCounts(cards);
  const parts: string[] = [];
  if (c.awaiting) parts.push(`${toneColor('awaiting_permission', frame)}${stateGlyph('awaiting_permission')} ${c.awaiting} need${c.awaiting === 1 ? 's' : ''} you${RESET}`);
  if (c.working) parts.push(`${ink.accent}${stateGlyph('processing')} ${c.working} working${RESET}`);
  if (c.ci) parts.push(`${ink.accent}CI ${c.ci} waiting${RESET}`);
  if (c.idle) parts.push(`${ink.idle}${stateGlyph('idle')} ${c.idle} idle${RESET}`);
  if (c.offline) parts.push(`${ink.offline}${stateGlyph('disconnected')} ${c.offline} offline${RESET}`);
  if (state.gatewayHasError) parts.push(`${ink.error}${terminalCaps.unicode ? '⚠' : '!'} Gateway error${RESET}`);
  if (state.connectionStatus === "connected" && state.dot?.configured) parts.push(`${ink.sub}Dot · ${dotDeckPresentation(state.dot).label} · report${RESET}`);
  const voice = voiceLabel(state);
  if (voice) parts.push(voice);
  const left = ` ${mark}  ${link.dot} ${ink.sub}${link.text}${RESET}${stale}`;
  const mid = parts.length ? `   ${parts.join('  ')}` : (state.connectionStatus === 'connected' ? `   ${ink.faint}No sessions${RESET}` : '');
  return spread(left + mid, `${ink.faint}${clock()}${RESET} `, cols);
}

function voiceLabel(state: DashboardState): string {
  const v = state.voiceAssistantState;
  if (!v || v === 'disabled' || v === 'idle') return '';
  if (v === 'listening') return `${ink.ok}Listening...${RESET}`;
  if (v === 'processing') return `${ink.accent}${state.voiceAssistantText ? truncText(state.voiceAssistantText, 24) : 'Thinking...'}${RESET}`;
  if (v === 'speaking') return `${ink.ok}Speaking...${RESET}`;
  return '';
}

function renderFooter(state: DashboardState, view: ViewState, layout: LayoutMode, cols: number): string {
  const hints: string[] = [];
  if (layout === 'narrow') {
    return ` ${ink.faint}${truncText('tab panel  \u2191\u2193  \u23CE detail  f follow  ? help  q quit', cols - 2)}${RESET}`;
  }
  hints.push(`tab ${view.focus === 'roster' ? 'activity' : 'sessions'}`);
  hints.push(view.focus === 'roster' ? '↑↓ select' : '↑↓ scroll');
  hints.push(`⏎ ${view.detail ? 'close' : 'detail'}`);
  hints.push(`f ${view.follow ? 'all activity' : 'follow'}`);
  if (state.sessions.length > 0) hints.push('1-9 switch');
  hints.push('? help', 'q quit');
  return ` ${ink.faint}${truncText(hints.join('   '), cols - 2)}${RESET}`;
}

// ===== Sessions =====

function cardHead(card: RosterCard, selected: boolean, width: number, frame: number): string {
  const bar = selected ? `${ink.accent}${terminalCaps.unicode ? '▌' : '>'}${RESET}` : ' ';
  const key = card.hotkey ? `${ink.faint}${card.hotkey}${RESET}` : ' ';
  const mark = `${brandColor(card.agentType)}${agentMark(card.agentType)}${RESET}`;
  const name = `${selected ? BOLD : ''}${ink.text}${card.displayName}${RESET}`;
  return spread(`${bar}${key} ${mark} ${name}`, stateChip(card.state, frame), width);
}

function focusLine(card: RosterCard): string {
  if (!card.focus) return '';
  switch (card.focus.kind) {
    case 'question': return `${ink.attn}${card.focus.text}${RESET}`;
    case 'ci': return ciColor(card) + card.focus.text + RESET;
    case 'activity': return `${ink.sub}${card.focus.text}${RESET}`;
    default: return `${ink.faint}${card.focus.text}${RESET}`;
  }
}

function ciColor(card: RosterCard): string {
  const phase = card.ci?.phase;
  return phase === 'passed' ? ink.ok : phase === 'failed' ? ink.error : phase === 'unknown' ? ink.idle : ink.accent;
}

function cardBadges(card: RosterCard): string {
  const parts: string[] = [];
  if (card.subagents > 0) parts.push(`${ink.accent}+${card.subagents} sub${RESET}`);
  if (card.ci && card.focus?.kind !== 'ci') parts.push(`${ciColor(card)}${card.ci.label}${RESET}`);
  if (card.review) parts.push(`${ink.sub}${card.review}${RESET}`);
  if (card.context !== undefined) parts.push(`${card.context >= 90 ? ink.attn : ink.faint}ctx ${card.context}%${RESET}`);
  return parts.join(`${ink.faint} · ${RESET}`);
}

function renderRoster(state: DashboardState, cards: RosterCard[], view: ViewState, width: number, height: number, frame: number): string[] {
  if (cards.length === 0) {
    const msg = state.connectionStatus === 'connected' ? 'No sessions yet' : linkLabel(state).text;
    return ['', `  ${ink.faint}${msg}${RESET}`];
  }
  const selected = view.selectedId;
  const density = rosterDensity(cards.length);
  const indent = '    ';
  const blocks: Array<{ id: string; lines: string[] }> = [];
  const detailed = density === 'detailed' && cards.length * 4 <= height + 1;
  let list = cards;
  let hiddenNote = '';
  if (density === 'summarized') {
    const sum = summarizeRoster(cards, selected);
    list = sum.shown;
    const notes: string[] = [];
    if (sum.hiddenIdle) notes.push(`${sum.hiddenIdle} idle session${sum.hiddenIdle === 1 ? '' : 's'} hidden`);
    if (sum.hiddenOffline) notes.push(`${sum.hiddenOffline} offline hidden`);
    hiddenNote = notes.join(' · ');
  }
  for (const card of list) {
    const isSel = card.id === selected;
    if (detailed) {
      const meta = card.meta.join(' · ');
      const badges = cardBadges(card);
      const lines = [cardHead(card, isSel, width, frame)];
      lines.push(spread(`${indent}${ink.faint}${meta}${RESET}`, '', width));
      const fl = focusLine(card);
      if (fl || badges) {
        lines.push(fl ? `${indent}${fl}` : `${indent}${badges}`);
        if (fl && badges) lines.push(`${indent}${badges}`);
      }
      lines.push('');
      blocks.push({ id: card.id, lines });
    } else {
      const fl = focusLine(card) || `${ink.faint}${card.meta[0] ?? ''}${RESET}`;
      const bar = isSel ? `${ink.accent}${terminalCaps.unicode ? '▌' : '>'}${RESET}` : ' ';
      const key = card.hotkey ? `${ink.faint}${card.hotkey}${RESET}` : ' ';
      const head = `${bar}${key} ${brandColor(card.agentType)}${agentMark(card.agentType)}${RESET} ${ink.text}${card.displayName}${RESET}`;
      const chip = stateChip(card.state, frame, 'tiny');
      const nameW = Math.min(visLen(head), Math.max(14, Math.floor(width * 0.45)));
      const left = padRight(truncText(head, nameW), nameW);
      blocks.push({ id: card.id, lines: [spread(`${left} ${fl}`, chip, width)] });
    }
  }
  // Scroll window keeps the selected block visible.
  const flat: string[] = [];
  let selStart = 0;
  let selEnd = 0;
  for (const blk of blocks) {
    if (blk.id === selected) { selStart = flat.length; selEnd = flat.length + blk.lines.length; }
    flat.push(...blk.lines);
  }
  const room = height - (hiddenNote ? 1 : 0);
  let offset = 0;
  if (selEnd > room) offset = Math.min(selStart, selEnd - room);
  const shown = flat.slice(offset, offset + room);
  const above = offset;
  const below = Math.max(0, flat.length - offset - room);
  if (above > 0 && shown.length) shown[0] = `  ${ink.faint}↑ ${above} more line${above === 1 ? '' : 's'}${RESET}`;
  if (below > 0 && shown.length) shown[shown.length - 1] = `  ${ink.faint}↓ ${below} more line${below === 1 ? '' : 's'}${RESET}`;
  if (hiddenNote) shown.push(`  ${ink.faint}${hiddenNote}${RESET}`);
  return shown;
}

function selectedCard(cards: RosterCard[], view: ViewState): RosterCard | undefined {
  return cards.find(c => c.id === view.selectedId) ?? cards[0];
}

function renderDetail(card: RosterCard | undefined, width: number, frame: number): string[] {
  if (!card) return [`  ${ink.faint}Select a session${RESET}`];
  const s = card.session;
  const lines: string[] = [];
  const kind = agentName(card.agentType);
  const kindLabel = card.displayName.startsWith(kind) ? '' : ` ${ink.faint}${kind}${RESET}`;
  lines.push(spread(` ${brandColor(card.agentType)}${agentMark(card.agentType)}${RESET} ${BOLD}${ink.text}${card.displayName}${RESET}${kindLabel}`, stateChip(card.state, frame), width));
  const meta: string[] = [];
  if (card.modelName) meta.push(`model ${card.modelName}`);
  if (s?.effortLevel) meta.push(`effort ${s.effortLevel}`);
  if (s?.permissionMode) meta.push(`mode ${s.permissionMode}`);
  meta.push(card.controlMode === 'observed' ? 'observed' : card.port ? `managed :${card.port}` : 'managed');
  lines.push(` ${ink.faint}${meta.join(' · ')}${RESET}`);
  if (card.tone === 'awaiting') {
    lines.push(` ${ink.attn}${BOLD}${stateGlyph(card.state)} ${card.focus?.text ?? ''}${RESET}`);
    if (s?.questionDetail) lines.push(`   ${ink.sub}${s.questionDetail}${RESET}`);
    (s?.options ?? []).slice(0, 5).forEach((o, i) => {
      lines.push(`   ${ink.attn}${i + 1}${RESET} ${ink.text}${o.label}${RESET}`);
    });
  }
  const label = card.subagents > 0 ? `${card.subagents} SUBAGENT${card.subagents === 1 ? '' : 'S'}` : 'NOW';
  const what = s?.activity ?? s?.currentTask ?? s?.goal;
  if (what) lines.push(` ${ink.accent}${label}${RESET} ${ink.sub}${what}${RESET}`);
  if (s?.goal && s.goal !== what) lines.push(` ${ink.faint}GOAL${RESET} ${ink.faint}${s.goal}${RESET}`);
  if (card.ci) lines.push(` ${ciColor(card)}${card.ci.label}${RESET}${s?.waitingOn?.runUrl ? ` ${ink.faint}${s.waitingOn.runUrl}${RESET}` : ''}`);
  const stats: string[] = [];
  if (card.context !== undefined) stats.push(`context ${card.context}%`);
  if (typeof card.totalTokens === 'number') stats.push(`${formatCount(card.totalTokens)} tokens`);
  if (typeof s?.elapsedSec === 'number') stats.push(`up ${formatDuration(s.elapsedSec)}`);
  if (s?.coordination?.backgroundJobs) stats.push(`${s.coordination.backgroundJobs} background`);
  if (stats.length) lines.push(` ${ink.faint}${stats.join(' · ')}${RESET}`);
  if (card.review) lines.push(` ${ink.sub}${card.review}${RESET}`);
  return lines;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d${h % 24}h`;
  if (h > 0) return `${h}h${m % 60}m`;
  return `${Math.max(1, m)}m`;
}

// ===== Usage =====

function gauge(used: number | undefined, width: number, muted: boolean, inactive?: boolean): string {
  const pct = typeof used === 'number' && Number.isFinite(used) ? clamp(used, 0, 100) : 0;
  const filled = Math.round((pct / 100) * width);
  const color = quotaColor(used, { muted, inactive });
  const full = terminalCaps.unicode ? '█' : '#';
  const empty = terminalCaps.unicode ? '░' : '.';
  return `${color}${full.repeat(filled)}${ink.rule}${empty.repeat(width - filled)}${RESET}`;
}

const NOTE_W = 8; // '↻23h59m', '42m ago', 'stale'

function usageRow(row: UsageRowVM, width: number): string {
  const label = padRight(truncText(row.label, 7), 7);
  if (row.value !== undefined) {
    return spread(`  ${ink.sub}${label}${RESET} ${ink.text}${row.value}${RESET}`, row.note ? `${ink.faint}${row.note}${RESET}` : '', width);
  }
  const pct = typeof row.used === 'number' ? Math.round(row.used) : undefined;
  const pctText = pct === undefined ? '  ?' : `${String(pct).padStart(3)}%`;
  // Fixed note column so every gauge in the panel lines up.
  const gw = clamp(width - 2 - 7 - 1 - 5 - NOTE_W - 1, 4, 18);
  const pctColored = `${quotaColor(row.used, { muted: row.muted, inactive: row.inactive })}${pctText}${RESET}`;
  const left = `  ${ink.sub}${label}${RESET} ${gauge(row.used, gw, row.muted, row.inactive)} ${pctColored}`;
  return spread(left, row.note ? `${ink.faint}${row.note}${RESET}` : '', width);
}

function providerMark(g: UsageGroupVM): string {
  if (g.id === 'zai') return `${hex(Brand.zai, 34)}${terminalCaps.unicode ? 'Z' : 'Z'}${RESET}`;
  return `${brandColor(g.brand)}${agentMark(g.brand)}${RESET}`;
}

function renderUsage(state: DashboardState, width: number, compact = false): string[] {
  const groups = buildUsageGroups(state.usage);
  const lines: string[] = [];
  if (groups.length === 0) return [`  ${ink.faint}${state.usage ? 'No provider data' : 'Waiting for usage data...'}${RESET}`];
  groups.forEach((g, i) => {
    if (i > 0 && !compact) lines.push('');
    const plan = [g.tier, g.until].filter(Boolean).join(' · ');
    lines.push(spread(` ${providerMark(g)} ${BOLD}${ink.text}${g.title}${RESET}`, plan ? `${ink.sub}${plan}${RESET}` : '', width));
    if (g.alert) {
      const c = g.alert.level === 'error' ? ink.error : g.alert.level === 'warn' ? ink.attn : ink.faint;
      lines.push(`   ${c}${g.alert.text}${RESET}`);
    }
    for (const row of g.rows) lines.push(usageRow(row, width));
  });
  const u = state.usage;
  if (u && (u.inputTokens || u.outputTokens || u.estimatedCostUsd)) {
    const parts: string[] = [];
    if (u.inputTokens || u.outputTokens) parts.push(`${formatCount(u.inputTokens)} in / ${formatCount(u.outputTokens)} out`);
    if (u.estimatedCostUsd) parts.push(`$${u.estimatedCostUsd.toFixed(2)}`);
    lines.push('', ` ${ink.faint}${parts.join(' · ')}${RESET}`);
  }
  return lines;
}

// ===== Models =====

function renderModels(state: DashboardState, width: number): string[] {
  const lines: string[] = [];
  const u = state.usage;
  if (state.modelName && state.agentType !== 'daemon') {
    const dot = u?.oauthConnected ? `${ink.ok}●${RESET}` : `${ink.faint}○${RESET}`;
    lines.push(` ${dot} ${truncText(state.modelName, width - 4)}`);
  }
  lines.push(...renderOauthCatalogLines(state.modelCatalog, u?.oauthConnected, width));
  lines.push(...renderOllamaSummaryLines(u?.ollamaStatus, width));
  return lines;
}

function renderOauthCatalogLines(modelCatalog: ModelCatalogEntry[], oauthConnected: boolean | undefined, width: number): string[] {
  const models = (modelCatalog ?? []).filter((m) => m.available).map((m) => m.name);
  if (models.length > 0) return wrapCommaList(' OAuth: ', models, width, 4);
  if (oauthConnected === true) return [`${ink.faint}${truncText(' OAuth: connected', width)}${RESET}`];
  if (oauthConnected === false) return [`${ink.faint}${truncText(' OAuth: disconnected', width)}${RESET}`];
  return [];
}

function wrapCommaList(prefix: string, items: string[], width: number, maxLines: number): string[] {
  const lines: string[] = [];
  const indent = ' '.repeat(prefix.length);
  let current = prefix;
  for (let i = 0; i < items.length; i++) {
    const chunk = current === prefix || current === indent ? items[i]! : `, ${items[i]}`;
    if (visLen(current) + visLen(chunk) <= width || current === prefix || current === indent) {
      current += chunk;
      continue;
    }
    lines.push(`${ink.faint}${current}${RESET}`);
    if (lines.length >= maxLines) {
      const hidden = items.length - i;
      lines.push(`${ink.faint}${truncText(` ${hidden} more model${hidden === 1 ? '' : 's'}`, width)}${RESET}`);
      return lines;
    }
    current = indent + items[i];
  }
  if (current.trim()) lines.push(`${ink.faint}${truncText(current, width)}${RESET}`);
  return lines;
}

function renderOllamaSummaryLines(ollamaStatus: OllamaStatus | undefined, width: number): string[] {
  if (!ollamaStatus) return [];
  if (!ollamaStatus.available || ollamaStatus.models.length === 0) {
    return [`${ink.faint}${truncText(' Ollama: stopped', width)}${RESET}`];
  }
  return ollamaStatus.models.map((m) => {
    const size = m.sizeVram > 0 ? m.sizeVram : m.size;
    const sizeText = size > 0 ? ` ${(size / 1e9).toFixed(1)}G` : '';
    return `${ink.faint}${truncText(` Ollama: ${m.name}${sizeText}`, width)}${RESET}`;
  });
}

// ===== Devices (downstream module health) =====

type ModuleMap = Record<string, unknown>;
const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asNumber = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function renderModuleHealthLines(moduleHealth: ModuleMap | undefined, width: number): string[] {
  const lines: string[] = [];
  if (!moduleHealth) return lines;
  const push = (label: string, detail: string, ok: boolean, warning = false) => {
    const icon = terminalCaps.unicode ? (ok ? '●' : warning ? '◆' : '○') : (ok ? 'o' : warning ? '!' : 'x');
    const color = ok ? ink.ok : warning ? ink.attn : ink.faint;
    lines.push(` ${color}${icon}${RESET} ${truncText(`${label} ${detail}`.trim(), width - 4)}`);
  };

  const serial = asRecord(moduleHealth.serial);
  if (serial) {
    const connections = asArray(serial.connections).map(asRecord).filter(Boolean) as Record<string, unknown>[];
    const connected = connections.filter((c) => c.connected === true || c.transportOpen === true);
    const boards = connected
      .map((c) => asRecord(c.deviceInfo)?.board)
      .filter((b): b is string => typeof b === 'string' && b.length > 0);
    const count = asNumber(serial.connectionCount) ?? connected.length;
    const shown = boards.slice(0, 3).join(', ');
    const more = boards.length > 3 ? ` and ${boards.length - 3} more` : '';
    push('Serial', count > 0 ? `${count}${shown ? `: ${shown}${more}` : ''}` : 'none', count > 0, Boolean(serial.lastError));
  }

  const pixoo = asRecord(moduleHealth.pixoo);
  if (pixoo) {
    const devices = asArray(pixoo.devices).map(asRecord).filter(Boolean) as Record<string, unknown>[];
    const configured = asNumber(pixoo.configuredDeviceCount) ?? devices.length;
    const online = devices.filter((d) => d.online === true && d.backedOff !== true).length;
    const dimmed = pixoo.displayDimmed === true ? ' dim' : '';
    push('Pixoo', `${online}/${configured}${dimmed}`, configured > 0 && online > 0, configured > 0);
  }

  // BLE matrix panels. The Node daemon only knows a panel is configured (the
  // Python BLE worker owns the link), so configured-but-unknown reads amber
  // "cfg" rather than a false-negative red offline.
  for (const [key, label] of [['timebox', 'Timebox'], ['idotmatrix', 'iDotMatrix']] as const) {
    const m = asRecord(moduleHealth[key]);
    if (!m) continue;
    const configured = asNumber(m.configuredDeviceCount) ?? asArray(m.devices).length;
    if (configured <= 0) continue;
    const connected = m.connected === true;
    const dimmed = m.displayDimmed === true ? ' dim' : '';
    const reason = typeof m.statusReason === 'string' ? m.statusReason : '';
    push(label, connected ? `ready${dimmed}` : (reason || `${configured} cfg`), connected, !connected);
  }

  // The daemon only emits d200h while the Ulanzi Studio plugin is connected.
  const d200h = asRecord(moduleHealth.d200h);
  if (d200h) {
    const connected = d200h.connected === true;
    push('D200H', connected ? 'ready plugin' : 'offline', connected);
  }

  const adb = asRecord(moduleHealth.adb);
  if (adb) {
    const devices = asArray(adb.devices);
    const reverse = asNumber(adb.reverseReadyCount) ?? devices.length;
    const available = adb.available === true;
    push('ADB', available ? `${reverse} reverse` : 'missing', available && reverse > 0, available);
  }

  const streamDeck = asRecord(moduleHealth.streamDeck);
  if (streamDeck) {
    for (const dev of asArray(streamDeck.devices).map(asRecord).filter(Boolean) as Record<string, unknown>[]) {
      const name = typeof dev.name === 'string' && dev.name.length > 0 ? dev.name : 'Stream Deck';
      const c = asNumber(dev.columns);
      const r = asNumber(dev.rows);
      push(name, c && r ? `${c}×${r}` : '', true);
    }
  }

  // WiFi-only ESP32 boards; dual-homed boards already appear under Serial.
  const esp32Wifi = asRecord(moduleHealth.esp32Wifi);
  if (esp32Wifi) {
    const devices = asArray(esp32Wifi.devices).map(asRecord).filter(Boolean) as Record<string, unknown>[];
    for (const dev of devices.filter((d) => d.serialActive !== true)) {
      const board = typeof dev.board === 'string' && dev.board.length > 0 ? dev.board : 'esp32';
      const ip = typeof dev.ip === 'string' ? dev.ip : '';
      const stale = dev.stale === true;
      push(`Wi-Fi ESP32 ${board}`, [ip, 'WiFi', stale ? 'stale' : ''].filter(Boolean).join(' · '), !stale, stale);
    }
  }

  const tuiDashboards = asRecord(moduleHealth.tuiDashboards);
  if (tuiDashboards) {
    for (const dev of asArray(tuiDashboards.devices).map(asRecord).filter(Boolean) as Record<string, unknown>[]) {
      push('TUI Dashboard', typeof dev.name === 'string' ? dev.name : '', true);
    }
  }
  return lines;
}

// ===== Activity (timeline) =====

function typeIcon(type: TimelineEntryType): string {
  if (!terminalCaps.unicode) {
    switch (type) {
      case 'chat_start': return '>';
      case 'chat_end': case 'task_start': case 'task_end': return '=';
      case 'chat_response': return ':';
      case 'tool_resolved': case 'task_milestone': return '+';
      case 'error': return 'x';
      case 'model_call': case 'model_response': return 'm';
      case 'memory_recall': return 'r';
      case 'scheduled': return 's';
      case 'user_action': return 'u';
      case 'eval_result': return '#';
      default: return '*';
    }
  }
  switch (type) {
    case 'chat_start': case 'user_action': return '▶';
    case 'chat_end': return '■';
    case 'chat_response': return '□';
    case 'tool_request': case 'tool_exec': return '◆';
    case 'tool_resolved': case 'task_milestone': return '✓';
    case 'error': return '✗';
    case 'model_call': case 'model_response': return '◈';
    case 'memory_recall': return '◌';
    case 'scheduled': return '◑';
    case 'task_start': case 'task_end': return '▣';
    case 'eval_result': return '★';
    default: return '◆';
  }
}

function typeColor(type: TimelineEntryType): string {
  switch (type) {
    case 'chat_start': case 'user_action': return ink.text;
    case 'chat_end': case 'chat_response': case 'tool_resolved': case 'task_milestone': return ink.ok;
    case 'tool_request': case 'tool_exec': return ink.accent;
    case 'error': return ink.error;
    case 'eval_result': return ink.attn;
    default: return ink.faint;
  }
}

function activityRows(state: DashboardState, card: RosterCard | undefined, view: ViewState): ReturnType<typeof buildTimelineRows> {
  return buildTimelineRows(state.timeline, view.follow && card ? followTarget(card) : undefined);
}

export function followTarget(card: RosterCard): { id: string; agentType?: string } {
  return { id: card.session?.id ?? card.id, agentType: card.agentType };
}

function renderActivity(state: DashboardState, card: RosterCard | undefined, view: ViewState, width: number, height: number, scrollOffset: number): string[] {
  const rows = activityRows(state, card, view);
  if (rows.length === 0) return [`  ${ink.faint}${view.follow ? 'No events for this session yet' : 'No events yet'}${RESET}`];
  const end = Math.max(0, rows.length - scrollOffset);
  const start = Math.max(0, end - height);
  return rows.slice(start, end).map(({ entry, text, pending }) => {
    const time = rowTime(entry.ts);
    const mark = entry.agentType ? `${brandColor(entry.agentType)}${agentMark(entry.agentType)}${RESET}` : ' ';
    const tag = pending ? ` ${ink.attn}PENDING${RESET}` : '';
    const body = `${typeColor(entry.type)}${typeIcon(entry.type)}${RESET} ${ink.text}${text}${RESET}`;
    return truncText(` ${ink.faint}${time}${RESET} ${mark} ${body}`, width - visLen(tag)) + tag;
  });
}

/** `HH:MM` today; `MM/DD` for earlier days so mixed-day rows never read as one morning. */
function rowTime(ts: number, now = new Date()): string {
  const t = new Date(ts);
  const sameDay = t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
  return sameDay
    ? `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
    : `${String(t.getMonth() + 1).padStart(2, '0')}/${String(t.getDate()).padStart(2, '0')}`;
}

function activityTitle(state: DashboardState, card: RosterCard | undefined, view: ViewState, scrollOffset: number, focused: boolean): string {
  const total = activityRows(state, card, view).length;
  const scope = view.follow && card ? card.displayName : 'all sessions';
  const off = scrollOffset > 0 ? ` · -${scrollOffset}` : '';
  return title(focused ? 'ACTIVITY ◂' : 'ACTIVITY', `${scope} · ${total}${off}`);
}

// ===== Help =====

function renderHelpOverlay(cols: number, rows: number): string {
  const boxW = Math.min(cols - 4, 78);
  const boxH = Math.min(rows - 4, 24);
  const left = Math.max(1, Math.floor((cols - boxW) / 2));
  const top = Math.max(1, Math.floor((rows - boxH) / 2));
  const lines = [
    `${ink.accent}${BOLD}AgentDeck TUI Help${RESET}`,
    '',
    `${BOLD}Keys${RESET}`,
    ' q          quit dashboard',
    ' ? / h      toggle help',
    ' ↑ ↓ / j k  select a session (or scroll activity)',
    ' tab        switch between sessions and activity',
    '            (narrow: next panel; s u a d jump to one)',
    ' enter      session detail: question, options, CI, subagents',
    ' f          follow: activity for the selected session only',
    ' 1-9        connect to a numbered managed session',
    ' Esc        close help or detail',
    '',
    `${BOLD}Reading the UI${RESET}`,
    ` ${stateChip('awaiting_permission')}  needs you (the only thing that pulses)`,
    ` ${stateChip('processing')}  working     ${stateChip('idle')}  idle`,
    ' Usage      green normal · amber 70% · red 90% · grey not current',
    '',
    `${BOLD}Terminal${RESET}`,
    ` Unicode: ${terminalCaps.unicode ? 'on' : 'fallback'}  Color: ${terminalCaps.trueColor ? 'truecolor' : '16-color'}  Emoji: ${terminalCaps.emoji ? 'on' : 'fallback'}`,
  ];
  let output = cursor.moveTo(1, 1) + screenCodes.clear;
  output += cursor.moveTo(top, left) + `${ink.rule}${box.tl}${hLine(boxW - 2)}${box.tr}${RESET}`;
  for (let i = 0; i < boxH - 2; i++) {
    const content = lines[i] ?? '';
    output += cursor.moveTo(top + 1 + i, left) + `${ink.rule}${box.v}${RESET}` +
      padRight(truncText(i === 0 ? centerText(content, boxW - 2) : content, boxW - 2), boxW - 2) +
      `${ink.rule}${box.v}${RESET}`;
  }
  output += cursor.moveTo(top + boxH - 1, left) + `${ink.rule}${box.bl}${hLine(boxW - 2)}${box.br}${RESET}`;
  output += cursor.moveTo(Math.min(rows, top + boxH), left) + `${ink.faint}Press ? or Esc to return${RESET}`;
  return output;
}

// ===== Main render =====

function flush(lines: string[], cols: number, rows: number): string {
  let output = '';
  for (let i = 0; i < rows; i++) {
    output += cursor.moveTo(i + 1, 1) + screenCodes.clearLine + (lines[i] !== undefined ? padRight(truncText(lines[i]!, cols), cols) : '');
  }
  return output;
}

function sessionsSection(state: DashboardState, cards: RosterCard[], view: ViewState, width: number, height: number, frame: number): Section {
  const focused = view.focus === 'roster';
  const counts = rosterCounts(cards);
  const lines = renderRoster(state, cards, view, width, Math.max(1, height), frame);
  return { title: title(focused ? 'SESSIONS ◂' : 'SESSIONS', String(counts.total)), lines, want: lines.length, min: Math.min(lines.length, 3), noun: 'session lines' };
}

export function renderDashboard(
  state: DashboardState, cols: number, rows: number,
  terrariumLines: string[], frame: number, scrollOffset: number,
  view: ViewState = defaultView(),
): string {
  if (state.helpVisible) return renderHelpOverlay(cols, rows);
  if (cols < 40 || rows < 10) {
    return cursor.moveTo(1, 1) + screenCodes.clear + `Resize terminal to at least 40×10 (current: ${cols}×${rows})`;
  }
  const g = geometry(cols, rows);
  const cards = buildRoster(state);
  if (!view.selectedId || !cards.some(c => c.id === view.selectedId)) view.selectedId = cards[0]?.id;
  const card = selectedCard(cards, view);
  const out: string[] = [renderHeader(state, cards, cols, frame)];
  const activityFocused = view.focus === 'activity';

  if (g.layout === 'wide') {
    const [lw, cw, rw] = g.widths as [number, number, number];
    const left = [sessionsSection(state, cards, view, lw, g.bodyH, frame)];
    const center: Section[] = [];
    if (g.aquarium) center.push({ title: title('AQUARIUM'), lines: terrariumLines, want: g.aquarium.height, min: 3, fixed: true });
    if (view.detail) {
      const d = renderDetail(card, cw, frame);
      center.push({ title: title('DETAIL', card?.displayName ?? ''), lines: d, want: d.length, min: Math.min(d.length, 4), fixed: true });
    }
    const actH = g.bodyH;
    center.push({ title: activityTitle(state, card, view, scrollOffset, activityFocused), lines: renderActivity(state, card, view, cw, actH, scrollOffset), want: 3, min: 3 });
    const right = rightSections(state, rw, g.bodyH);
    // Activity lines are sized after allocation so the newest rows stay visible.
    const heights = allocate(center, g.bodyH);
    const last = center[center.length - 1]!;
    last.lines = renderActivity(state, card, view, cw, heights[heights.length - 1]!, scrollOffset);
    out.push(...compose([{ width: lw, sections: left }, { width: cw, sections: center }, { width: rw, sections: right }], g.bodyH));
  } else if (g.layout === 'standard') {
    const [lw, rw] = g.widths as [number, number];
    const left: Section[] = [];
    const roster = sessionsSection(state, cards, view, lw, Math.floor((g.bodyH) * 0.55), frame);
    roster.fixed = true;
    left.push(roster);
    if (view.detail) {
      const d = renderDetail(card, lw, frame);
      left.push({ title: title('DETAIL', card?.displayName ?? ''), lines: d, want: d.length, min: Math.min(d.length, 3), fixed: true });
    }
    left.push({ title: activityTitle(state, card, view, scrollOffset, activityFocused), lines: [], want: 3, min: 2 });
    const heights = allocate(left, g.bodyH);
    left[left.length - 1]!.lines = renderActivity(state, card, view, lw, heights[heights.length - 1]!, scrollOffset);
    const right: Section[] = [];
    if (g.aquarium) right.push({ title: title('AQUARIUM'), lines: terrariumLines, want: g.aquarium.height, min: 3, fixed: true });
    right.push(...rightSections(state, rw, g.bodyH - (g.aquarium ? g.aquarium.height + 1 : 0)));
    out.push(...compose([{ width: lw, sections: left }, { width: rw, sections: right }], g.bodyH));
  } else {
    const w = g.widths[0]!;
    out.push(tabBar(view, cols));
    const bodyH = g.bodyH - 1; // tab bar row
    let sections: Section[];
    if (view.tab === 'usage') {
      sections = rightSections(state, w, bodyH).filter(s => !s.title.includes('DEVICES'));
    } else if (view.tab === 'devices') {
      const lines = renderModuleHealthLines(state.moduleHealth, w);
      sections = [{ title: title('DEVICES'), lines: lines.length ? lines : [`  ${ink.faint}No downstream devices${RESET}`], want: 1, min: 1 }];
    } else if (view.tab === 'activity') {
      sections = [{ title: activityTitle(state, card, view, scrollOffset, true), lines: renderActivity(state, card, view, w, bodyH, scrollOffset), want: bodyH, min: 1 }];
    } else {
      sections = [sessionsSection(state, cards, view, w, bodyH, frame)];
      if (view.detail) {
        const d = renderDetail(card, w, frame);
        sections[0]!.fixed = true;
        sections.push({ title: title('DETAIL', card?.displayName ?? ''), lines: d, want: d.length, min: Math.min(d.length, 3) });
      }
    }
    out.push(...compose([{ width: w, sections }], bodyH));
  }
  out.push(renderFooter(state, view, g.layout, cols));
  return flush(out, cols, rows);
}

function rightSections(state: DashboardState, width: number, budget = Infinity): Section[] {
  let usage = renderUsage(state, width);
  const models = renderModels(state, width);
  const devices = renderModuleHealthLines(state.moduleHealth, width);
  const need = (u: string[], m: string[]) => u.length + (m.length ? m.length + 1 : 0) + (devices.length ? Math.min(devices.length, 3) + 1 : 0);
  let showModels = models.length > 0;
  // Tight column: models are the least glanceable, then blank group gaps go.
  if (need(usage, showModels ? models : []) > budget) showModels = false;
  if (need(usage, []) > budget) usage = renderUsage(state, width, true);
  const sections: Section[] = [{ title: title('USAGE'), lines: usage, want: usage.length, min: Math.min(usage.length, 4), noun: 'usage rows' }];
  if (showModels) sections.push({ title: title('MODELS'), lines: models, want: models.length, min: 1, noun: 'model lines' });
  if (devices.length) sections.push({ title: title('DEVICES'), lines: devices, want: devices.length, min: Math.min(devices.length, 3), noun: 'devices' });
  return sections;
}

function tabBar(view: ViewState, cols: number): string {
  const tabs: Array<[ViewTab, string]> = [['sessions', 'Sessions'], ['usage', 'Usage'], ['activity', 'Activity'], ['devices', 'Devices']];
  const parts = tabs.map(([id, label]) => id === view.tab
    ? `${ink.accent}${BOLD}[${label}]${RESET}`
    : `${ink.faint} ${label} ${RESET}`);
  return truncText(` ${parts.join(' ')}`, cols);
}
