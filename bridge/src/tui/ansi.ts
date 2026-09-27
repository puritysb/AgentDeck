/**
 * ANSI escape code helpers for TUI dashboard rendering.
 * Raw terminal control — no external dependencies beyond the shared palette.
 */
import { Session, State, STATE_COLORS } from '@agentdeck/shared';

// ===== Cursor & Screen Control =====

export const ESC = '\x1b';
export const CSI = `${ESC}[`;

export const cursor = {
  hide: `${CSI}?25l`,
  show: `${CSI}?25h`,
  moveTo: (row: number, col: number) => `${CSI}${row};${col}H`,
  moveToCol: (col: number) => `${CSI}${col}G`,
  up: (n = 1) => `${CSI}${n}A`,
  down: (n = 1) => `${CSI}${n}B`,
  save: `${ESC}7`,
  restore: `${ESC}8`,
};

export const screen = {
  altEnter: `${CSI}?1049h`,
  altExit: `${CSI}?1049l`,
  clear: `${CSI}2J`,
  clearLine: `${CSI}2K`,
};

export const RESET = `${CSI}0m`;
export const BOLD = `${CSI}1m`;
export const DIM = `${CSI}2m`;

// ===== Terminal Capabilities =====

function isUtf8Locale(value: string | undefined): boolean {
  if (!value) return false;
  return /utf-?8/i.test(value);
}

function detectUnicodeSupport(): boolean {
  return isUtf8Locale(process.env.LC_ALL) ||
    isUtf8Locale(process.env.LC_CTYPE) ||
    isUtf8Locale(process.env.LANG);
}

function detectTrueColorSupport(): boolean {
  const colorTerm = process.env.COLORTERM || '';
  const term = process.env.TERM || '';
  const program = process.env.TERM_PROGRAM || '';
  return /truecolor|24bit/i.test(colorTerm) ||
    /direct/i.test(term) ||
    /iTerm|WezTerm|Apple_Terminal|vscode/i.test(program);
}

export const terminalCaps = {
  unicode: detectUnicodeSupport(),
  trueColor: detectTrueColorSupport(),
  emoji: detectUnicodeSupport(),
};

// ===== Color Helpers =====

/** 24-bit truecolor foreground */
export function fg(r: number, g: number, b: number): string {
  return `${CSI}38;2;${r};${g};${b}m`;
}

/** 24-bit truecolor background */
export function bg(r: number, g: number, b: number): string {
  return `${CSI}48;2;${r};${g};${b}m`;
}

/** Standard 16-color foreground */
export function sgr(code: number): string {
  return `${CSI}${code}m`;
}

/** Canonical `#rrggbb` → truecolor fg, with a 16-color SGR fallback. */
function hexFg(hex: string, fallback: number): string {
  if (!terminalCaps.trueColor) return sgr(fallback);
  return fg(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
}

// ===== Named Colors =====

export const colors = {
  // State colors — the shared session-state palette (DESIGN.md §2.7); the
  // numbers are the 16-colour fallbacks for terminals without truecolor.
  idle: hexFg(STATE_COLORS[State.IDLE], 37),                        // neutral
  processing: hexFg(STATE_COLORS[State.PROCESSING], 36),            // working cyan
  awaiting: hexFg(STATE_COLORS[State.AWAITING_PERMISSION], 33),     // amber
  disconnected: hexFg(STATE_COLORS[State.DISCONNECTED], 90),        // offline grey
  error: hexFg(Session.error, 31),                                   // red

  // UI colors
  header: `${BOLD}${sgr(36)}`,   // bold cyan
  dim: sgr(90),                   // dim gray
  dimCyan: `${DIM}${sgr(36)}`,   // dim cyan (keybindings)
  border: sgr(90),                // dim white
  white: sgr(37),
  bold: BOLD,

  // Timeline type colors
  chat: sgr(32),        // green
  tool: sgr(36),        // cyan
  end: sgr(34),         // blue
  errorTl: sgr(31),     // red

  // Terrarium truecolors
  octopus: terminalCaps.trueColor ? fg(192, 112, 88) : sgr(33),
  crayfish: terminalCaps.trueColor ? fg(255, 77, 77) : sgr(31),
  tetraNeon: terminalCaps.trueColor ? fg(0, 191, 255) : sgr(36),
  tetraStripe: terminalCaps.trueColor ? fg(255, 99, 71) : sgr(33),
  water: terminalCaps.trueColor ? fg(30, 58, 95) : sgr(34),
  waterDark: terminalCaps.trueColor ? fg(10, 22, 40) : sgr(34),
  sand: terminalCaps.trueColor ? fg(194, 168, 120) : sgr(33),
  seaweed: terminalCaps.trueColor ? fg(34, 139, 34) : sgr(32),
  bubble: terminalCaps.trueColor ? fg(135, 206, 250) : sgr(37),
  crayfishGlow: terminalCaps.trueColor ? fg(255, 107, 107) : sgr(31),
  jellyfish: terminalCaps.trueColor ? fg(99, 102, 241) : sgr(35),
  jellyfishGlow: terminalCaps.trueColor ? fg(165, 180, 252) : sgr(37),
};

// ===== State to color mapping =====

export function stateColor(state: string): string {
  switch (state) {
    case 'idle': return colors.idle;
    case 'processing': return colors.processing;
    case 'awaiting_permission':
    case 'awaiting_option':
    case 'awaiting_diff': return colors.awaiting;
    case 'disconnected': return colors.disconnected;
    default: return colors.white;
  }
}

export function stateIcon(state: string): string {
  if (!terminalCaps.unicode) {
    switch (state) {
      case 'processing': return '*';
      case 'awaiting_permission':
      case 'awaiting_option':
      case 'awaiting_diff': return '!';
      case 'disconnected': return 'x';
      case 'idle':
      default: return 'o';
    }
  }
  switch (state) {
    case 'idle': return '\u25CB'; // ○
    case 'processing': return '\u25CF'; // ●
    case 'awaiting_permission':
    case 'awaiting_option':
    case 'awaiting_diff': return '\u25C6'; // ◆
    case 'disconnected': return '\u2717'; // ✗
    default: return '\u25CB';
  }
}

// ===== Box Drawing =====

export const box = {
  tl: terminalCaps.unicode ? '\u250C' : '+',
  tr: terminalCaps.unicode ? '\u2510' : '+',
  bl: terminalCaps.unicode ? '\u2514' : '+',
  br: terminalCaps.unicode ? '\u2518' : '+',
  h: terminalCaps.unicode ? '\u2500' : '-',
  v: terminalCaps.unicode ? '\u2502' : '|',
  tee: terminalCaps.unicode ? '\u252C' : '+',
  bTee: terminalCaps.unicode ? '\u2534' : '+',
  lTee: terminalCaps.unicode ? '\u251C' : '+',
  rTee: terminalCaps.unicode ? '\u2524' : '+',
  cross: terminalCaps.unicode ? '\u253C' : '+',
};

export function hLine(width: number, char = box.h): string {
  return char.repeat(width);
}

// ===== Text Utilities =====

/** Strip ANSI escape sequences for length calculation */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Visual length of a string (stripping ANSI) */
export function visLen(str: string): number {
  return stripAnsi(str).length;
}

/** Truncate text to fit width, preserving ANSI codes at boundaries */
export function truncText(text: string, maxWidth: number, ellipsis = '\u2026'): string {
  const plain = stripAnsi(text);
  if (plain.length <= maxWidth) return text;
  // Simple approach: strip ANSI, truncate, lose color (safe for most uses)
  return plain.slice(0, maxWidth - 1) + ellipsis;
}

/** Pad string to width (visual) with spaces */
export function padRight(text: string, width: number): string {
  const len = visLen(text);
  if (len >= width) return text;
  return text + ' '.repeat(width - len);
}

/** Center text in width */
export function centerText(text: string, width: number): string {
  const len = visLen(text);
  if (len >= width) return text;
  const left = Math.floor((width - len) / 2);
  return ' '.repeat(left) + text + ' '.repeat(width - len - left);
}
