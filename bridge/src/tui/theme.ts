/**
 * TUI theme — the product palette (DESIGN.md §2.6 `--ui-*`, §2.7 session tones,
 * §2.8 quota severity) bound to terminal escapes. Every colour here comes from
 * a shared token or shared presentation helper; the TUI owns no state→colour
 * or percent→colour switch of its own. The numbers are 16-colour fallbacks for
 * terminals without truecolor.
 */
import {
  UI, agentBrandColor, sessionTone, sessionStateWords, usageSeverity,
  USAGE_COLORS, USAGE_INACTIVE_COLORS, type SessionTone,
} from '@agentdeck/shared';
import { BOLD, DIM, RESET, fg, sgr, terminalCaps } from './ansi.js';

export function hex(color: string, fallback: number): string {
  if (!terminalCaps.trueColor || !/^#[0-9a-fA-F]{6}$/.test(color)) return sgr(fallback);
  return fg(parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16));
}

/** Product chrome. Cyan is the AgentDeck accent and "an agent is working". */
export const ink = {
  accent: hex(UI.cyan, 36),
  text: hex(UI.hudText, 37),
  sub: hex(UI.hudSubtext, 37),
  faint: hex(UI.hudFaint, 90),
  rule: hex(UI.ttyFaint, 90),
  ok: hex(UI.ok, 32),
  attn: hex(UI.attn, 33),
  error: hex(UI.error, 31),
  idle: hex(UI.idle, 37),
  offline: hex(UI.idleDark, 90),
  bold: BOLD,
  dim: DIM,
  reset: RESET,
};

const TONE_COLOR: Record<SessionTone, string> = {
  idle: ink.idle,
  working: ink.accent,
  awaiting: ink.attn,
  offline: ink.offline,
};

/**
 * Session tone colour. `frame` drives the only pulse the system allows —
 * amber "needs you" breathes between bold and dim (DESIGN.md §2.7, §8).
 */
export function toneColor(state: string | undefined, frame = 0): string {
  const tone = sessionTone(state);
  const base = TONE_COLOR[tone];
  if (tone !== 'awaiting') return base;
  return Math.floor(frame / 4) % 2 === 0 ? BOLD + base : DIM + base;
}

/** Shape redundant with colour (DESIGN.md §2.7): rows survive a mono panel. */
export function stateGlyph(state: string | undefined): string {
  const uni = terminalCaps.unicode;
  switch (sessionTone(state)) {
    case 'working': return uni ? '◉' : '*';      // ◉
    case 'awaiting': return uni ? '⚠' : '!';     // ⚠
    case 'offline': return uni ? '□' : 'x';      // □
    default: return uni ? '○' : 'o';             // ○
  }
}

/** `◉ WORKING` chip in the session tone. */
export function stateChip(state: string | undefined, frame = 0, size: 'short' | 'tiny' = 'short'): string {
  const words = sessionStateWords(state);
  return `${toneColor(state, frame)}${stateGlyph(state)} ${size === 'tiny' ? words.tiny : words.short}${RESET}`;
}

/** Quota colour by consumed percent; stale/aged → grey, inactive cap → cyan. */
export function quotaColor(used: number | undefined, opts: { muted?: boolean; inactive?: boolean } = {}): string {
  if (opts.muted || usageSeverity(used) === 'unknown') return hex(USAGE_COLORS.unknown, 90);
  if (opts.inactive) return hex(USAGE_INACTIVE_COLORS.bright, 36);
  const sev = usageSeverity(used);
  return hex(USAGE_COLORS[sev], sev === 'critical' ? 31 : sev === 'warning' ? 33 : 32);
}

/** Brand hue for an agent mark; unknown agents stay a neutral HUD grey. */
export function brandColor(agentType: string | undefined): string {
  return hex(agentBrandColor(agentType), 37);
}

/**
 * One-cell agent mark for rows. Unknown agents get a neutral ring, never
 * another agent's mark (AGENTS.md wire semantics).
 */
export function agentMark(agentType: string | undefined): string {
  if (!terminalCaps.unicode) {
    switch (agentType) {
      case 'claude-code': return 'C';
      case 'codex-cli': case 'codex-app': return 'X';
      case 'openclaw': return 'W';
      case 'opencode': return 'O';
      case 'antigravity': return 'A';
      case 'kiro-cli': case 'kiro-ide': return 'K';
      case 'hermes': return 'H';
      default: return '*';
    }
  }
  switch (agentType) {
    case 'claude-code': return '✻';                 // ✻ Claude sparkle
    case 'codex-cli': case 'codex-app': return '☁'; // ☁ Codex cloud
    case 'openclaw': return terminalCaps.emoji ? '🦞' : 'W'; // 🦞 crayfish (2 cells)
    case 'opencode': return '▣';                    // ▣ nested square
    case 'antigravity': return '▲';                 // ▲ peak
    case 'kiro-cli': case 'kiro-ide': return terminalCaps.emoji ? '👻' : 'K'; // 👻 Kiro ghost (2 cells)
    case 'hermes': return '☤';                      // ☤ caduceus
    default: return '○';                            // ○ neutral
  }
}

/** Full product names; single-letter aliases are never user-facing (§5.11). */
export function agentName(agentType: string | undefined): string {
  switch (agentType) {
    case 'claude-code': return 'Claude Code';
    case 'codex-cli': return 'Codex CLI';
    case 'codex-app': return 'Codex';
    case 'openclaw': return 'OpenClaw';
    case 'opencode': return 'OpenCode';
    case 'antigravity': return 'Antigravity';
    case 'kiro-cli': return 'Kiro CLI';
    case 'kiro-ide': return 'Kiro';
    case 'hermes': return 'Hermes';
    default: return 'Agent';
  }
}
