/**
 * TUI Dashboard renderer — layout calculation + panel rendering.
 *
 * Width invariant: every output line is exactly `cols` characters wide (visually).
 * Box structure:
 *   Wide:     ┌─leftW─┬─rightW─┐  where leftW + rightW + 3 = cols
 *   Std/Nar:  ┌──w────┐         where w + 2 = cols
 *   Split:    │ lh │ rh │       where lh + rh + 3 = cols
 */

import {
  cursor, screen as screenCodes, RESET, BOLD, DIM,
  colors, box, hLine, sgr, stateColor, stateIcon,
  truncText, padRight, visLen, terminalCaps, centerText,
  fg,
} from './ansi.js';
import { blockGauge, resetTimeStr, formatTokens } from './gauge.js';
import type { DashboardState, LayoutMode } from './dashboard.js';
import type { ModelCatalogEntry, OllamaStatus, SessionInfo, TimelineEntry, TimelineEntryType } from '@agentdeck/shared';
import { stateRank, sortSessions, assignDisplayNames } from '@agentdeck/shared';

// ===== Layout Breakpoints =====

export function getLayout(cols: number, rows: number): LayoutMode {
  if (cols >= 120) return 'wide';
  if (cols >= 80) return 'standard';
  return 'narrow';
}

export function shouldShowTerrarium(cols: number, rows: number): boolean {
  if (cols < 60) return false;
  if (rows < 16) return false;
  return true;
}

// ===== Border Line Builder =====

function borderFill(prefix: string, suffix: string, targetWidth: number): string {
  const fillLen = Math.max(0, targetWidth - visLen(prefix) - visLen(suffix));
  return prefix + `${colors.border}${hLine(fillLen)}${RESET}` + suffix;
}

// ===== Pixel Font (4 wide × 6 tall → 4×3 half-block) =====

const FONT: Record<string, string[]> = {
  A: ['.##.', '#..#', '####', '#..#', '#..#', '....'],
  G: ['.###', '#...', '#.##', '#..#', '.##.', '....'],
  E: ['####', '#...', '###.', '#...', '####', '....'],
  N: ['#..#', '##.#', '#.##', '#..#', '#..#', '....'],
  T: ['####', '.##.', '.##.', '.##.', '.##.', '....'],
  D: ['###.', '#..#', '#..#', '#..#', '###.', '....'],
  C: ['.###', '#...', '#...', '#...', '.###', '....'],
  K: ['#..#', '#.#.', '##..', '#.#.', '#..#', '....'],
};

/** Render a word in half-block pixel font. Returns 3 terminal lines. */
function renderPixelFont(word: string): string[] {
  const result = ['', '', ''];
  for (let li = 0; li < word.length; li++) {
    if (li > 0) { result[0] += ' '; result[1] += ' '; result[2] += ' '; }
    const pixels = FONT[word[li]];
    if (!pixels) continue;
    for (let hr = 0; hr < 3; hr++) {
      const topRow = pixels[hr * 2];
      const botRow = pixels[hr * 2 + 1];
      for (let col = 0; col < 4; col++) {
        const top = topRow[col] === '#';
        const bot = botRow[col] === '#';
        if (top && bot) result[hr] += '\u2588';      // █
        else if (top) result[hr] += '\u2580';          // ▀
        else if (bot) result[hr] += '\u2584';          // ▄
        else result[hr] += ' ';
      }
    }
  }
  return result;
}

// Pre-render logo lines — "AGENT" + "DECK" stacked, sky blue
const LOGO_AGENT = renderPixelFont('AGENT'); // 3 lines, 24 chars wide
const LOGO_DECK = renderPixelFont('DECK');   // 3 lines, 19 chars wide

// ===== Timeline Icons =====

function typeIcon(type: TimelineEntryType): string {
  if (!terminalCaps.unicode) {
    switch (type) {
      case 'chat_start': return '>';
      case 'chat_end': return '=';
      case 'chat_response': return ':';
      case 'tool_request': case 'tool_exec': return '*';
      case 'tool_resolved': return '+';
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
    case 'chat_start': case 'user_action': return '\u25B6';
    case 'chat_end': return '\u25A0';
    case 'chat_response': return '\u25A1';
    case 'tool_request': case 'tool_exec': return '\u25C6';
    case 'tool_resolved': return '\u2713';
    case 'error': return '\u2717';
    case 'model_call': case 'model_response': return '\u25C8';
    case 'memory_recall': return '\u25CC';
    case 'scheduled': return '\u25D1';
    case 'eval_result': return '\u2605';  // ★
    default: return '\u25C6';
  }
}

function typeColor(type: TimelineEntryType): string {
  switch (type) {
    case 'chat_start': case 'user_action': return colors.chat;
    case 'chat_end': case 'chat_response': return colors.end;
    case 'tool_request': case 'tool_exec': case 'tool_resolved': return colors.tool;
    case 'error': return colors.errorTl;
    case 'model_call': case 'model_response': return sgr(35);
    case 'memory_recall': return sgr(33);
    case 'eval_result': return sgr(33);  // yellow/amber
    default: return colors.dim;
  }
}

const SPINNER_FRAMES = ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'];

export function spinner(frame: number): string {
  return SPINNER_FRAMES[Math.floor(frame / 2) % SPINNER_FRAMES.length];
}

// ===== Creature Icon Helper =====

function creatureEmoji(agentType?: string): string {
  if (!terminalCaps.emoji) {
    if ((agentType as string) === 'daemon') return 'D';
    if ((agentType as string) === 'openclaw') return 'C';
    if ((agentType as string) === 'codex-cli' || (agentType as string) === 'codex-app') return 'X';
    if ((agentType as string) === 'opencode') return 'O';
    return '*';
  }
  if ((agentType as string) === 'daemon') return '\u2699\uFE0F';      // ⚙️
  if ((agentType as string) === 'openclaw') return '\uD83E\uDD9E';    // 🦞
  if ((agentType as string) === 'codex-cli' || (agentType as string) === 'codex-app') return '\u2601';          // ☁ (cloud — matches creature)
  if ((agentType as string) === 'opencode') return '\u25A3';           // ▣ (nested square — matches creature)
  return '\u273B';  // ✻ (teardrop-spoked asterisk — Claude sparkle)
}

function creatureBrandColor(agentType?: string): string {
  if (!terminalCaps.trueColor) return '';
  switch (agentType as string) {
    case 'claude-code': return fg(192, 112, 88);    // terracotta
    case 'openclaw': return fg(255, 77, 77);         // red
    case 'codex-cli':
    case 'codex-app': return fg(177, 167, 255);      // indigo
    case 'opencode': return fg(241, 236, 236);       // warm gray (#F1ECEC)
    default: return '';
  }
}

function compactStateLabel(state: string): string {
  switch (state) {
    case 'processing': return 'PROC';
    case 'awaiting_permission': return 'PERM';
    case 'awaiting_option': return 'OPT';
    case 'awaiting_diff': return 'DIFF';
    case 'disconnected': return 'DISC';
    case 'idle':
    default:
      return 'IDLE';
  }
}

function currentSessionSummary(state: DashboardState, width: number): string {
  const parts: string[] = [];
  if (state.projectName) parts.push(state.projectName);
  if (state.modelName) parts.push(state.modelName);
  if (state.state) parts.push(compactStateLabel(state.state));
  if (parts.length === 0) return 'No session';
  return truncText(parts.join(' · '), width);
}

// stateRank, sortSessions imported from @agentdeck/shared

function sessionHotkeyLabel(index: number | null): string {
  if (index === null || index > 8) return '·';
  return String(index + 1);
}

type SessionRenderInfo = {
  port?: number;
  controlMode?: 'managed' | 'observed';
  currentTask?: string;
  contextPercent?: number;
  totalTokens?: number;
};

// ===== HUD Entry Builder (shared with macOS / iOS / Android) =====

export interface HudEntry {
  id: string;
  /** projectName + optional " #N" suffix from assignDisplayNames */
  displayName: string;
  projectName: string;
  agentType: string | undefined;
  state: string;
  modelName: string | undefined;
  startedAt: string | undefined;
  port: number | undefined;
  controlMode: 'managed' | 'observed' | undefined;
  currentTask: string | undefined;
  contextPercent: number | undefined;
  totalTokens: number | undefined;
  /** Self entry promoted from a sibling, or appended synthetic primary. */
  isPrimary: boolean;
  /** Gateway placeholder when sessions list lacks an OpenClaw entry. */
  isVirtualOpenClaw: boolean;
}

/**
 * Build the unified left-HUD entry list shared with macOS / iOS / Android.
 *
 * Collapses primary + siblings + virtual OpenClaw into one array, sorts via
 * the shared sortSessions (agentType → projectName → startedAt → id), and
 * applies #N suffix via assignDisplayNames so the display order and #N
 * numbering match every other surface.
 *
 * Primary handling mirrors apple/AgentDeck/UI/Monitor/SessionListPanel.swift:
 *   - if a sibling matches our connected port, that sibling becomes the
 *     primary anchor (its startedAt anchors the sort position)
 *   - otherwise primary is appended only when no sibling shares its
 *     agentType (duplicatePrimaryWithoutId guard)
 *   - daemon / openclaw primaries are never appended (they're virtual)
 */
export function buildHudEntries(state: DashboardState): HudEntry[] {
  type Item = {
    id: string;
    projectName: string;
    agentType: string | undefined;
    state: string;
    modelName: string | undefined;
    startedAt: string | undefined;
    port: number | undefined;
    controlMode: 'managed' | 'observed' | undefined;
    currentTask: string | undefined;
    contextPercent: number | undefined;
    totalTokens: number | undefined;
    isPrimary: boolean;
    isVirtualOpenClaw: boolean;
  };

  const items: Item[] = [];
  const portToItem = new Map<number, Item>();

  for (const s of state.sessions) {
    const ri = s as SessionInfo & SessionRenderInfo;
    const item: Item = {
      id: s.id,
      projectName: s.projectName ?? 'unknown',
      agentType: s.agentType ?? undefined,
      state: s.state ?? 'idle',
      modelName: s.modelName ?? undefined,
      startedAt: s.startedAt ?? undefined,
      port: s.port ?? undefined,
      controlMode: ri.controlMode,
      currentTask: ri.currentTask,
      contextPercent: ri.contextPercent,
      totalTokens: ri.totalTokens,
      isPrimary: false,
      isVirtualOpenClaw: false,
    };
    items.push(item);
    if (item.port !== undefined) portToItem.set(item.port, item);
  }

  if (state.agentType && state.agentType !== 'daemon' && state.agentType !== 'openclaw' && state.state) {
    const anchor = state.currentPort != null ? portToItem.get(state.currentPort) : undefined;
    if (anchor) {
      // Patch anchor with primary's live fields. macOS / Android compose
      // SessionEntry from primary state and only borrow the anchor sibling's
      // startedAt; if we left the sibling's snapshot in place the row would
      // render stale modelName / state / currentTask whenever the sibling
      // payload lagged the primary state_update. startedAt, port, id, and
      // controlMode stay with the anchor so sort position and hotkey
      // identity match every other surface.
      anchor.isPrimary = true;
      anchor.projectName = state.projectName ?? anchor.projectName;
      anchor.agentType = state.agentType;
      anchor.state = state.state;
      anchor.modelName = state.modelName ?? undefined;
      anchor.currentTask = state.currentTool ?? undefined;
    } else {
      const duplicateAgentType = state.sessions.some(s => s.agentType === state.agentType);
      if (!duplicateAgentType) {
        items.push({
          id: '__self__',
          projectName: state.projectName ?? 'unknown',
          agentType: state.agentType,
          state: state.state,
          modelName: state.modelName ?? undefined,
          startedAt: undefined,
          port: state.currentPort ?? undefined,
          controlMode: undefined,
          currentTask: state.currentTool ?? undefined,
          contextPercent: undefined,
          totalTokens: undefined,
          isPrimary: true,
          isVirtualOpenClaw: false,
        });
      }
    }
  }

  const hasOpenClaw = items.some(it => it.agentType === 'openclaw' || it.agentType === 'gateway');
  if (state.gatewayAvailable && !hasOpenClaw) {
    items.push({
      id: '__virtual_openclaw__',
      projectName: 'OpenClaw',
      agentType: 'openclaw',
      state: state.crayfishRouting ? 'processing' : 'idle',
      modelName: undefined,
      startedAt: undefined,
      port: undefined,
      controlMode: undefined,
      currentTask: undefined,
      contextPercent: undefined,
      totalTokens: undefined,
      isPrimary: false,
      isVirtualOpenClaw: true,
    });
  }

  const sorted = sortSessions(items);
  const named = assignDisplayNames(sorted.map(it => ({
    id: it.id,
    projectName: it.projectName,
    agentType: it.agentType,
    state: it.state,
  })));

  return sorted.map((it, i) => ({
    id: it.id,
    displayName: named[i]!.displayName,
    projectName: it.projectName,
    agentType: it.agentType,
    state: it.state,
    modelName: it.modelName,
    startedAt: it.startedAt,
    port: it.port,
    controlMode: it.controlMode,
    currentTask: it.currentTask,
    contextPercent: it.contextPercent,
    totalTokens: it.totalTokens,
    isPrimary: it.isPrimary,
    isVirtualOpenClaw: it.isVirtualOpenClaw,
  }));
}

function hudHotkeyIndex(entry: HudEntry, nextIndex: number): number | null {
  if (entry.isPrimary || entry.isVirtualOpenClaw) return null;
  if (!entry.port || entry.controlMode === 'observed') return null;
  return nextIndex;
}

function observedDetailParts(session?: SessionRenderInfo): string[] {
  if (!session) return [];
  const parts: string[] = [];
  if (session.controlMode === 'observed') parts.push('observed');
  if (typeof session.contextPercent === 'number') parts.push(`${Math.round(session.contextPercent)}% ctx`);
  if (session.currentTask) parts.push(session.currentTask);
  return parts;
}

type ModuleMap = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function moduleStatusIcon(ok: boolean, warning = false): string {
  if (!terminalCaps.unicode) return ok ? 'o' : warning ? '!' : 'x';
  return ok ? '\u25CF' : warning ? '\u25C6' : '\u25CB';
}

function renderModuleHealthLines(moduleHealth: ModuleMap, width: number): string[] {
  const lines: string[] = [];
  const push = (label: string, detail: string, ok: boolean, warning = false) => {
    const color = ok ? colors.idle : warning ? colors.awaiting : colors.dim;
    lines.push(` ${color}${moduleStatusIcon(ok, warning)}${RESET} ${truncText(`${label} ${detail}`.trim(), width - 4)}`);
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
    const more = boards.length > 3 ? ` +${boards.length - 3}` : '';
    const detail = count > 0 ? `${count}${shown ? `: ${shown}${more}` : ''}` : 'none';
    push('Serial', detail, count > 0, Boolean(serial.lastError));
  }

  const pixoo = asRecord(moduleHealth.pixoo);
  if (pixoo) {
    const devices = asArray(pixoo.devices).map(asRecord).filter(Boolean) as Record<string, unknown>[];
    const configured = asNumber(pixoo.configuredDeviceCount) ?? devices.length;
    const online = devices.filter((d) => d.online === true && d.backedOff !== true).length;
    const dimmed = pixoo.displayDimmed === true ? ' dim' : '';
    push('Pixoo', `${online}/${configured}${dimmed}`, configured > 0 && online > 0, configured > 0);
  }

  const d200h = asRecord(moduleHealth.d200h);
  if (d200h) {
    const connected = d200h.connected === true || d200h.managerOpened === true;
    const owner = d200h.externalOwner === true ? ' plugin' : '';
    const detail = connected ? `ready${owner}` : 'offline';
    push('D200H', detail, connected, Boolean(d200h.lastOpenError || d200h.lastWriteError));
  }

  const adb = asRecord(moduleHealth.adb);
  if (adb) {
    const devices = asArray(adb.devices);
    const reverse = asNumber(adb.reverseReadyCount) ?? devices.length;
    const available = adb.available === true;
    push('ADB', available ? `${reverse} reverse` : 'missing', available && reverse > 0, available);
  }

  return lines;
}

// ===== Panel Renderers =====

function renderAgentLines(state: DashboardState, maxWidth: number, useLogo: boolean): string[] {
  const lines: string[] = [];

  // Big pixel-font logo (AGENT + DECK stacked, sky blue)
  const logoColor = terminalCaps.trueColor ? fg(100, 180, 255) : colors.header; // sky blue
  if (useLogo && maxWidth >= 24) {
    for (const l of LOGO_AGENT) lines.push(`${logoColor}${l}${RESET}`);
    for (const l of LOGO_DECK) lines.push(`${logoColor} ${l}${RESET}`);
  } else if (useLogo && maxWidth >= 10) {
    lines.push(`${logoColor} AgentDeck${RESET}`);
  }
  lines.push('');

  // Session list
  const renderSession = (
    proj: string, model: string | undefined, sessState: string, agentType: string | undefined,
    hotkeyIndex: number | null, session?: SessionRenderInfo,
  ) => {
    const col = stateColor(sessState);
    const hotkey = `${colors.dim}[${sessionHotkeyLabel(hotkeyIndex)}]${RESET}`;
    const name = truncText(proj, maxWidth - 16);
    const emoji = `${creatureBrandColor(agentType)}${creatureEmoji(agentType)}${RESET}`;
    const secondary = [model, ...observedDetailParts(session), compactStateLabel(sessState)]
      .filter(Boolean)
      .join(' - ');
    lines.push(` ${hotkey} ${emoji} ${col}${name}${RESET}`);
    lines.push(`${colors.dim}    ${truncText(secondary, maxWidth - 4)}${RESET}`);
  };

  // Unified entry list (primary + siblings + virtual OpenClaw). Order and #N
  // suffix matches macOS / iOS / Android via the shared sortSessions +
  // assignDisplayNames pipeline inside buildHudEntries.
  const entries = buildHudEntries(state);
  let focusableIndex = 0;
  for (const e of entries) {
    const hotkeyIndex = hudHotkeyIndex(e, focusableIndex);
    if (hotkeyIndex !== null) focusableIndex += 1;
    renderSession(e.displayName, e.modelName, e.state, e.agentType, hotkeyIndex, {
      port: e.port,
      controlMode: e.controlMode,
      currentTask: e.currentTask,
      contextPercent: e.contextPercent,
      totalTokens: e.totalTokens,
    });
  }

  // Gateway error warning
  if (state.gatewayHasError) {
    lines.push(`${colors.error} \u26A0 Gateway Error${RESET}`);
  }

  const moduleLines = renderModuleHealthLines(state.moduleHealth, maxWidth);
  if (moduleLines.length > 0) {
    lines.push('');
    lines.push(`${colors.header} DOWNSTREAM${RESET}`);
    lines.push(...moduleLines);
  }

  // Voice assistant indicator
  if (state.voiceAssistantState && state.voiceAssistantState !== 'disabled' && state.voiceAssistantState !== 'idle') {
    lines.push('');
    if (state.voiceAssistantState === 'listening') {
      lines.push(` ${colors.idle}\uD83C\uDFA4 Listening...${RESET}`);
    } else if (state.voiceAssistantState === 'processing') {
      const text = state.voiceAssistantText ? truncText(state.voiceAssistantText, maxWidth - 6) : '...';
      lines.push(` ${colors.processing}\uD83C\uDFA4 ${text}${RESET}`);
    } else if (state.voiceAssistantState === 'speaking') {
      lines.push(` ${sgr(32)}\uD83D\uDD0A Speaking...${RESET}`);
    }
  }

  lines.push('');

  if (state.usage) {
    const u = state.usage;
    if (u.inputTokens || u.outputTokens) {
      lines.push(`${colors.dim} Tokens: ${formatTokens(u.inputTokens)}/${formatTokens(u.outputTokens)}${RESET}`);
    }
    if (u.estimatedCostUsd) {
      lines.push(`${colors.dim} Cost: $${u.estimatedCostUsd.toFixed(2)}${RESET}`);
    }
  }

  return lines;
}

// ===== Status Panel: LIMITS | MODELS =====

function renderStatusLimitsLines(state: DashboardState, width: number): string[] {
  const lines: string[] = [];
  const u = state.usage;
  if (!u) return lines;
  const gaugeW = Math.min(10, Math.floor(width * 0.3));
  if (u.fiveHourPercent !== undefined) {
    const pct = Math.round(u.fiveHourPercent);
    lines.push(` 5h [${blockGauge(pct, gaugeW)}] ${pct}%`);
    const reset = resetTimeStr(u.fiveHourResetsAt);
    if (reset) lines.push(`${colors.dim}    ${reset}${RESET}`);
  }
  if (u.sevenDayPercent !== undefined) {
    const pct = Math.round(u.sevenDayPercent);
    lines.push(` 7d [${blockGauge(pct, gaugeW)}] ${pct}%`);
    const reset = resetTimeStr(u.sevenDayResetsAt);
    if (reset) lines.push(`${colors.dim}    ${reset}${RESET}`);
  }
  if (state.currentTool) {
    lines.push(` ${colors.tool}${truncText(state.currentTool, width - 2)}${RESET}`);
  }
  return lines;
}

function renderStatusModelsLines(state: DashboardState, width: number): string[] {
  const lines: string[] = [];
  const u = state.usage;
  if (state.modelName) {
    const dot = u?.oauthConnected ? `${colors.idle}\u25CF${RESET}` : `${colors.dim}\u25CB${RESET}`;
    lines.push(` ${dot} ${truncText(state.modelName, width - 4)}`);
  }
  lines.push(...renderOauthCatalogLines(state.modelCatalog, u?.oauthConnected, width));
  lines.push(...renderOllamaSummaryLines(u?.ollamaStatus, width));
  return lines;
}

function renderStatusLines(state: DashboardState, width: number): string[] {
  const lines: string[] = [];
  const u = state.usage;
  if (u) {
    const gaugeW = Math.min(12, Math.floor(width * 0.15));
    if (u.fiveHourPercent !== undefined) {
      const pct = Math.round(u.fiveHourPercent);
      lines.push(` 5h [${blockGauge(pct, gaugeW)}] ${pct}% ${colors.dim}${resetTimeStr(u.fiveHourResetsAt)}${RESET}`);
    }
    if (u.sevenDayPercent !== undefined) {
      const pct = Math.round(u.sevenDayPercent);
      lines.push(` 7d [${blockGauge(pct, gaugeW)}] ${pct}% ${colors.dim}${resetTimeStr(u.sevenDayResetsAt)}${RESET}`);
    }
  }
  if (state.currentTool) lines.push(` ${colors.tool}Tool: ${truncText(state.currentTool, width - 8)}${RESET}`);
  if (state.modelName) lines.push(`${colors.dim} Model: ${state.modelName}${RESET}`);
  lines.push(...renderOauthCatalogLines(state.modelCatalog, u?.oauthConnected, width));
  const ollamaLines = renderOllamaSummaryLines(u?.ollamaStatus, width);
  lines.push(...ollamaLines);
  return lines;
}

function renderOauthCatalogLines(
  modelCatalog: ModelCatalogEntry[], oauthConnected: boolean | undefined,
  width: number,
): string[] {
  const lines: string[] = [];
  const models = (modelCatalog ?? []).filter((m) => m.available).map((m) => m.name);

  if (models.length > 0) {
    return wrapCommaList(' OAuth: ', models, width, 4);
  }
  if (oauthConnected === true) {
    lines.push(`${colors.dim}${truncText(' OAuth: connected', width)}${RESET}`);
  } else if (oauthConnected === false) {
    lines.push(`${colors.dim}${truncText(' OAuth: disconnected', width)}${RESET}`);
  }
  return lines;
}

function wrapCommaList(prefix: string, items: string[], width: number, maxLines = Number.POSITIVE_INFINITY): string[] {
  const lines: string[] = [];
  const indent = ' '.repeat(prefix.length);
  let current = prefix;
  let consumed = 0;

  for (let i = 0; i < items.length; i++) {
    const chunk = i === 0 ? items[i] : `, ${items[i]}`;
    if (visLen(current) + visLen(chunk) <= width) {
      current += chunk;
      consumed = i + 1;
      continue;
    }

    if (visLen(current) > visLen(prefix)) {
      lines.push(`${colors.dim}${padRight(current, width)}${RESET}`.trimEnd());
      if (lines.length >= maxLines) {
        const hidden = items.length - consumed;
        if (hidden > 0) lines.push(`${colors.dim}${truncText(` ${hidden} more models`, width)}${RESET}`);
        return lines;
      }
      current = indent + items[i];
      consumed = i + 1;
      continue;
    }

    lines.push(`${colors.dim}${truncText(current + chunk, width)}${RESET}`);
    consumed = i + 1;
    if (lines.length >= maxLines) {
      const hidden = items.length - consumed;
      if (hidden > 0) lines.push(`${colors.dim}${truncText(` ${hidden} more models`, width)}${RESET}`);
      return lines;
    }
    current = indent;
  }

  if (visLen(current.trim()) > 0) {
    lines.push(`${colors.dim}${truncText(current, width)}${RESET}`);
  }
  return lines;
}

function renderOllamaSummaryLines(ollamaStatus: OllamaStatus | undefined, width: number): string[] {
  if (!ollamaStatus) return [];
  if (!ollamaStatus.available || ollamaStatus.models.length === 0) {
    return [`${colors.dim}${truncText(' Ollama: stopped', width)}${RESET}`];
  }

  return ollamaStatus.models.map((m) => {
    const size = m.sizeVram > 0 ? m.sizeVram : m.size;
    const sizeText = size > 0 ? ` ${(size / 1e9).toFixed(1)}G` : '';
    return `${colors.dim}${truncText(` Ollama: ${m.name}${sizeText}`, width)}${RESET}`;
  });
}

function renderTimelineLines(
  state: DashboardState, width: number, maxLines: number, scrollOffset: number,
): string[] {
  const lines: string[] = [];
  const entries = state.timeline;
  if (entries.length === 0) {
    lines.push(`${colors.dim} No events yet${RESET}`);
    return lines;
  }
  const start = Math.max(0, entries.length - maxLines - scrollOffset);
  const end = Math.min(entries.length, start + maxLines);
  for (let i = start; i < end; i++) {
    const e = entries[i];
    const time = new Date(e.ts);
    const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`;
    // task_end rows append a score+outcome suffix once the LLM judge resolves
    // (5–30 s after the boundary itself). Until then the `taskOutcome` field
    // is undefined and we render only the boundary label.
    const evalSuffix = (e.type === 'task_end' && e.taskOutcome)
      ? formatTaskEvalSuffix(e.taskScore, e.taskOutcome)
      : '';
    const raw = truncText(`${e.raw}${evalSuffix}`, width - 10);
    const pending = e.status === 'pending' ? `${colors.dim} [PENDING]${RESET}` : '';
    lines.push(` ${colors.dim}${timeStr}${RESET} ${typeColor(e.type)}${typeIcon(e.type)}${RESET} ${raw}${pending}`);
  }
  return lines;
}

export function formatTaskEvalSuffix(score: number | undefined, outcome: string | undefined): string {
  // `abandoned` flows from the manual `agentdeck task cancel` path and
  // must render as its own glyph — not fall through to '' (which would
  // make the task look pending) and not borrow the fail glyph (which
  // would read as agent failure rather than user-initiated stop).
  const glyph = outcome === 'success' ? '✓'
    : outcome === 'fail' ? '✗'
    : outcome === 'partial' ? '△'
    : outcome === 'abandoned' ? '⊘'
    : '';
  if (!glyph) return '';
  const scoreText = typeof score === 'number' ? score.toFixed(2) : '?';
  return ` · ${scoreText} ${glyph}`;
}

function timelineHeader(state: DashboardState, width: number, maxLines: number, scrollOffset: number): string {
  const total = state.timeline.length;
  if (total === 0) return `${colors.header} TIMELINE${RESET}`;
  const shown = Math.min(total, maxLines);
  const offset = scrollOffset > 0 ? ` · -${scrollOffset}` : '';
  return truncText(`${colors.header} TIMELINE${RESET}${colors.dim} ${shown}/${total}${offset}${RESET}`, width);
}

function renderHelpOverlay(state: DashboardState, cols: number, rows: number): string {
  const boxW = Math.min(cols - 4, 78);
  const boxH = Math.min(rows - 4, 18);
  const left = Math.max(1, Math.floor((cols - boxW) / 2));
  const top = Math.max(1, Math.floor((rows - boxH) / 2));
  const lines = [
    `${colors.header}AgentDeck TUI Help${RESET}`,
    '',
    `${colors.bold}Navigation${RESET}`,
    ' q        quit dashboard',
    ' ? / h    toggle help',
    ' ↑ ↓      scroll timeline',
    ' j / k    vim-style timeline scroll',
    ' 1-9      connect to listed session',
    ' Esc      close help',
    '',
    `${colors.bold}Reading The UI${RESET}`,
    ' Header   current project, model, and state',
    ' Sessions busiest first, numbered for switching',
    ' STATUS   limits, models, OAuth, Ollama',
    ' TIMELINE shown/total and scroll offset',
    '',
    `${colors.bold}Terminal${RESET}`,
    ` Unicode: ${terminalCaps.unicode ? 'on' : 'fallback'}  Color: ${terminalCaps.trueColor ? 'truecolor' : '16-color'}  Emoji: ${terminalCaps.emoji ? 'on' : 'fallback'}`,
  ];

  let output = cursor.moveTo(1, 1) + screenCodes.clear;
  output += cursor.moveTo(top, left) + `${colors.border}${box.tl}${hLine(boxW - 2)}${box.tr}${RESET}`;
  for (let i = 0; i < boxH - 2; i++) {
    const content = lines[i] ?? '';
    output += cursor.moveTo(top + 1 + i, left) +
      `${colors.border}${box.v}${RESET}` +
      padRight(i === 0 ? centerText(content, boxW - 2) : content, boxW - 2) +
      `${colors.border}${box.v}${RESET}`;
  }
  output += cursor.moveTo(top + boxH - 1, left) + `${colors.border}${box.bl}${hLine(boxW - 2)}${box.br}${RESET}`;
  output += cursor.moveTo(Math.min(rows, top + boxH), left) +
    `${colors.dim}Press ? or Esc to return${RESET}`;
  return output;
}

// ===== Output Helper =====

/** Write buf lines to screen. Last row reserved for q quit hint. */
function flushBuf(buf: string[], cols: number, rows: number, footerHint: string): string {
  const maxBoxRows = rows - 1;
  let output = cursor.moveTo(1, 1);
  const limit = Math.min(buf.length, maxBoxRows);
  for (let i = 0; i < limit; i++) {
    output += cursor.moveTo(i + 1, 1) + screenCodes.clearLine + buf[i];
  }
  for (let i = limit; i < maxBoxRows; i++) {
    output += cursor.moveTo(i + 1, 1) + screenCodes.clearLine;
  }
  // q quit on last row
  output += cursor.moveTo(rows, 1) + screenCodes.clearLine +
    ` ${colors.dimCyan}${truncText(footerHint, cols - 2)}${RESET}`;
  return output;
}

// ===== Main Render =====

export function renderDashboard(
  state: DashboardState, cols: number, rows: number,
  terrariumLines: string[], frame: number, scrollOffset: number,
): string {
  if (state.helpVisible) {
    return renderHelpOverlay(state, cols, rows);
  }
  const layout = getLayout(cols, rows);
  if (cols < 40 || rows < 10) {
    return cursor.moveTo(1, 1) + screenCodes.clear +
      `Resize terminal to at least 60\u00D716 (current: ${cols}\u00D7${rows})`;
  }
  const connIcon = state.connectionStatus === 'connected' ? `${colors.idle}\u25CF` :
    state.connectionStatus === 'reconnecting' ? `${colors.processing}\u25D4` :
    `${colors.disconnected}\u25CB`;
  const staleTag = state.isStale ? ` ${colors.error}[STALE]${RESET}` : '';
  const spinnerStr = state.state === 'processing'
    ? ` ${colors.processing}${spinner(frame)}${RESET}` : '';
  const footerHint = state.sessions.length > 0
    ? 'q quit  ↑↓/j k scroll  1-9 switch session'
    : 'q quit  ↑↓/j k scroll';

  if (layout === 'wide') return renderWideLayout(state, cols, rows, terrariumLines, frame, scrollOffset, connIcon, staleTag, spinnerStr, footerHint);
  if (layout === 'standard') return renderStandardLayout(state, cols, rows, terrariumLines, frame, scrollOffset, connIcon, staleTag, spinnerStr, footerHint);
  return renderNarrowLayout(state, cols, rows, frame, scrollOffset, connIcon, staleTag, spinnerStr, footerHint);
}

// ===== Wide Layout =====

function renderWideLayout(
  state: DashboardState, cols: number, rows: number,
  terrariumLines: string[], frame: number, scrollOffset: number,
  connIcon: string, staleTag: string, spinnerStr: string, footerHint: string,
): string {
  const leftW = Math.max(20, Math.floor(cols * 0.22));
  const rightW = cols - leftW - 3;
  const buf: string[] = [];
  const summary = currentSessionSummary(state, Math.max(16, rightW - 16));

  // Top border
  const topLeft = `${colors.border}${box.tl}${RESET}`;
  const topMid = `${colors.border}${box.tee}${box.h} ${summary} ${RESET}${connIcon}${RESET}${spinnerStr}${staleTag} `;
  const topRight = `${colors.border}${box.tr}${RESET}`;
  const leftFillLen = Math.max(0, leftW + 1 - visLen(topLeft));
  const rightFillLen = Math.max(0, rightW + 2 - visLen(topMid) - visLen(topRight));
  buf.push(topLeft + `${colors.border}${hLine(leftFillLen)}${RESET}` + topMid + `${colors.border}${hLine(rightFillLen)}${RESET}` + topRight);

  const agentLines = renderAgentLines(state, leftW - 2, true);

  // Status: LIMITS | MODELS
  const tH = terrariumLines.length;
  const statusLimitW = Math.floor(rightW * 0.4);
  const statusModelW = rightW - statusLimitW - 1;
  const limitsLines = renderStatusLimitsLines(state, statusLimitW);
  const modelsLines = renderStatusModelsLines(state, statusModelW);
  const statusH = Math.max(3, Math.max(limitsLines.length, modelsLines.length) + 1);

  const boxContentRows = rows - 3; // top border + bottom border + q quit row
  const timelineH = Math.max(3, boxContentRows - tH - statusH - 2);
  const tlLines = renderTimelineLines(state, rightW - 2, timelineH - 1, scrollOffset);

  for (let r = 0; r < boxContentRows; r++) {
    const leftContent = padRight(r < agentLines.length ? agentLines[r] : '', leftW);

    let rightContent = '';
    if (r < tH) {
      rightContent = terrariumLines[r] || '';
    } else if (r === tH) {
      rightContent = `${colors.border}${hLine(statusLimitW)}${RESET}` +
        `${colors.border}\u252C${RESET}` +
        `${colors.border}${hLine(statusModelW)}${RESET}`;
    } else if (r < tH + 1 + statusH) {
      const si = r - tH - 1;
      if (si === 0) {
        rightContent = padRight(`${colors.header} LIMITS${RESET}`, statusLimitW) +
          `${colors.border}${box.v}${RESET}` +
          padRight(`${colors.header} MODELS${RESET}`, statusModelW);
      } else {
        const li = si - 1;
        rightContent = padRight(li < limitsLines.length ? limitsLines[li] : '', statusLimitW) +
          `${colors.border}${box.v}${RESET}` +
          padRight(li < modelsLines.length ? modelsLines[li] : '', statusModelW);
      }
    } else if (r === tH + 1 + statusH) {
      rightContent = `${colors.border}${hLine(rightW)}${RESET}`;
    } else {
      const ti = r - tH - statusH - 2;
      if (ti === 0) rightContent = timelineHeader(state, rightW, timelineH - 1, scrollOffset);
      else rightContent = ti - 1 < tlLines.length ? tlLines[ti - 1] : '';
    }

    buf.push(
      `${colors.border}${box.v}${RESET}${padRight(leftContent, leftW)}` +
      `${colors.border}${box.v}${RESET}${padRight(rightContent, rightW)}` +
      `${colors.border}${box.v}${RESET}`
    );
  }

  buf.push(`${colors.border}${box.bl}${hLine(leftW)}${box.bTee}${hLine(rightW)}${box.br}${RESET}`);
  return flushBuf(buf, cols, rows, footerHint);
}

// ===== Standard Layout =====

function renderStandardLayout(
  state: DashboardState, cols: number, rows: number,
  terrariumLines: string[], frame: number, scrollOffset: number,
  connIcon: string, staleTag: string, spinnerStr: string, footerHint: string,
): string {
  const w = cols - 2;
  const buf: string[] = [];
  const summary = currentSessionSummary(state, Math.max(16, w - 18));

  buf.push(borderFill(
    `${colors.border}${box.tl}${box.h} ${summary} ${RESET}${connIcon}${RESET}${spinnerStr}${staleTag} `,
    `${colors.border}${box.tr}${RESET}`, cols));

  for (const tl of terrariumLines) {
    buf.push(`${colors.border}${box.v}${RESET}${padRight(tl, w)}${colors.border}${box.v}${RESET}`);
  }

  const leftHalf = Math.floor(w / 2);
  const rightHalf = w - leftHalf - 1;

  const splitPrefix = `${colors.border}${box.lTee}${box.h} STATUS ${RESET}`;
  const splitMid = `${colors.border}${box.tee}${RESET}`;
  const splitSuffix = `${colors.border}${box.rTee}${RESET}`;
  buf.push(
    splitPrefix + `${colors.border}${hLine(Math.max(0, leftHalf + 1 - visLen(splitPrefix)))}${RESET}` +
    splitMid + `${colors.border}${hLine(Math.max(0, rightHalf + 2 - visLen(splitMid) - visLen(splitSuffix)))}${RESET}` + splitSuffix
  );

  const statusLines = renderStatusLines(state, leftHalf - 1);
  const agentCompact = renderAgentCompactLines(state, rightHalf - 1);
  const pairRows = Math.max(statusLines.length, agentCompact.length, 3);

  for (let r = 0; r < pairRows; r++) {
    buf.push(
      `${colors.border}${box.v}${RESET}${padRight(r < statusLines.length ? statusLines[r] : '', leftHalf)}` +
      `${colors.border}${box.v}${RESET}${padRight(r < agentCompact.length ? agentCompact[r] : '', rightHalf)}` +
      `${colors.border}${box.v}${RESET}`
    );
  }

  buf.push(`${colors.border}${box.lTee}${hLine(leftHalf)}${box.bTee}${hLine(rightHalf)}${box.rTee}${RESET}`);
  const tlAvailable = Math.max(2, rows - buf.length - 2);
  buf.push(
    `${colors.border}${box.v}${RESET}${padRight(timelineHeader(state, w, tlAvailable, scrollOffset), w)}` +
    `${colors.border}${box.v}${RESET}`
  );

  const tlLines = renderTimelineLines(state, w - 1, tlAvailable, scrollOffset);
  for (const tl of tlLines) {
    buf.push(`${colors.border}${box.v}${RESET}${padRight(tl, w)}${colors.border}${box.v}${RESET}`);
  }

  buf.push(`${colors.border}${box.bl}${hLine(w)}${box.br}${RESET}`);
  return flushBuf(buf, cols, rows, footerHint);
}

function renderAgentCompactLines(state: DashboardState, width: number): string[] {
  const lines: string[] = [];
  // Unified entry list — same ordering and #N suffix as macOS / iOS / Android.
  const entries = buildHudEntries(state);
  let focusableIndex = 0;
  for (const e of entries) {
    const hotkeyIndex = hudHotkeyIndex(e, focusableIndex);
    if (hotkeyIndex !== null) focusableIndex += 1;
    const col = stateColor(e.state);
    const emoji = `${creatureBrandColor(e.agentType)}${creatureEmoji(e.agentType)}${RESET}`;
    const status = `${col}${stateIcon(e.state)} ${compactStateLabel(e.state)}${RESET}`;
    const detail = e.currentTask || e.modelName;
    const model = detail ? `${colors.dim} · ${truncText(detail, Math.max(8, width - 24))}${RESET}` : '';
    const marker = e.controlMode === 'observed' ? `${colors.dim} · obs${RESET}` : '';
    const project = truncText(e.displayName, Math.max(8, width - 20));
    lines.push(` ${colors.dim}[${sessionHotkeyLabel(hotkeyIndex)}]${RESET} ${emoji} ${project} ${status}${marker}${model}`);
  }
  // Gateway error warning
  if (state.gatewayHasError) {
    lines.push(`${colors.error} \u26A0 Gateway Error${RESET}`);
  }
  const moduleLines = renderModuleHealthLines(state.moduleHealth, width);
  if (moduleLines.length > 0) {
    lines.push(`${colors.header} DOWNSTREAM${RESET}`);
    lines.push(...moduleLines);
  }
  // Voice assistant indicator (compact)
  if (state.voiceAssistantState && state.voiceAssistantState !== 'disabled' && state.voiceAssistantState !== 'idle') {
    if (state.voiceAssistantState === 'listening') {
      lines.push(` ${colors.idle}\uD83C\uDFA4 Listening...${RESET}`);
    } else if (state.voiceAssistantState === 'processing') {
      const text = state.voiceAssistantText ? truncText(state.voiceAssistantText, width - 6) : '...';
      lines.push(` ${colors.processing}\uD83C\uDFA4 ${text}${RESET}`);
    } else if (state.voiceAssistantState === 'speaking') {
      lines.push(` ${sgr(32)}\uD83D\uDD0A Speaking...${RESET}`);
    }
  }
  if (state.usage) {
    const u = state.usage;
    const parts: string[] = [];
    if (u.inputTokens || u.outputTokens) parts.push(`${formatTokens(u.inputTokens)}/${formatTokens(u.outputTokens)}`);
    if (u.estimatedCostUsd) parts.push(`$${u.estimatedCostUsd.toFixed(2)}`);
    if (parts.length > 0) lines.push(`${colors.dim} ${parts.join('  ')}${RESET}`);
  }
  return lines;
}

// ===== Narrow Layout =====

function renderNarrowLayout(
  state: DashboardState, cols: number, rows: number,
  frame: number, scrollOffset: number,
  connIcon: string, staleTag: string, spinnerStr: string, footerHint: string,
): string {
  const w = cols - 2;
  const buf: string[] = [];
  const summary = currentSessionSummary(state, Math.max(12, w - 18));

  buf.push(borderFill(
    `${colors.border}${box.tl}${box.h} ${summary} ${RESET}${connIcon}${RESET}${spinnerStr}${staleTag} `,
    `${colors.border}${box.tr}${RESET}`, cols));

  for (const al of renderAgentCompactLines(state, w - 1)) {
    buf.push(`${colors.border}${box.v}${RESET}${padRight(al, w)}${colors.border}${box.v}${RESET}`);
  }

  buf.push(`${colors.border}${box.lTee}${hLine(w)}${box.rTee}${RESET}`);

  for (const sl of renderStatusLines(state, w - 1)) {
    buf.push(`${colors.border}${box.v}${RESET}${padRight(sl, w)}${colors.border}${box.v}${RESET}`);
  }

  const tlAvailable = Math.max(2, rows - buf.length - 2);
  buf.push(`${colors.border}${box.lTee}${hLine(w)}${box.rTee}${RESET}`);
  buf.push(`${colors.border}${box.v}${RESET}${padRight(timelineHeader(state, w, tlAvailable, scrollOffset), w)}${colors.border}${box.v}${RESET}`);
  const tlLines = renderTimelineLines(state, w - 1, tlAvailable, scrollOffset);
  for (const tl of tlLines) {
    buf.push(`${colors.border}${box.v}${RESET}${padRight(tl, w)}${colors.border}${box.v}${RESET}`);
  }

  buf.push(`${colors.border}${box.bl}${hLine(w)}${box.br}${RESET}`);
  return flushBuf(buf, cols, rows, footerHint);
}
