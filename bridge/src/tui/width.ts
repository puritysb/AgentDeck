/**
 * Terminal display width for the TUI.
 *
 * `String.length` counts UTF-16 code units, which is wrong in both directions
 * for a terminal: a Hangul syllable or CJK ideograph occupies two cells, an
 * astral emoji is two code units AND two cells, and a combining mark or
 * variation selector occupies none. Timeline text and session goals on this
 * desk are routinely Korean, so a length-based pad pushed every border past
 * the right edge. This is a compact wcwidth: zero-width marks, East Asian
 * Wide/Fullwidth ranges and emoji presentation, everything else one cell.
 */

const ZERO_WIDTH: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], [0x0483, 0x0489], [0x0591, 0x05bd], [0x0610, 0x061a],
  [0x064b, 0x065f], [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e],
  [0x1160, 0x11ff], // Hangul medial/final jamo (combine with a leading jamo)
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xfeff, 0xfeff],
  [0x1f3fb, 0x1f3ff], // emoji skin-tone modifiers
  [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];

const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec],
  [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a],
  [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

function inRanges(cp: number, ranges: ReadonlyArray<readonly [number, number]>): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b] = ranges[mid]!;
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Cells one code point occupies: 0, 1 or 2. */
export function codePointWidth(cp: number): number {
  if (cp === 0 || cp === 0x200d) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (inRanges(cp, ZERO_WIDTH)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Display width of plain text (no escape sequences). */
export function textWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += codePointWidth(ch.codePointAt(0)!);
  return w;
}

/** Display width of text that may contain SGR / cursor escapes. */
export function displayWidth(text: string): number {
  return textWidth(text.replace(ANSI, ''));
}

/**
 * Cut styled text to at most `max` cells, keeping its escapes and ending with
 * `ellipsis` when anything was dropped. Escapes after the cut are discarded and
 * a reset is appended, so a truncated colour never bleeds into the border.
 */
export function truncateWidth(text: string, max: number, ellipsis = '…'): string {
  if (max <= 0) return '';
  if (displayWidth(text) <= max) return text;
  const room = max - textWidth(ellipsis);
  let out = '';
  let used = 0;
  let i = 0;
  let styled = false;
  while (i < text.length) {
    if (text[i] === '\x1b') {
      ANSI.lastIndex = i;
      const m = ANSI.exec(text);
      if (m && m.index === i) {
        out += m[0];
        styled = true;
        i += m[0].length;
        continue;
      }
    }
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = codePointWidth(cp);
    if (used + w > room) break;
    out += ch;
    used += w;
    i += ch.length;
  }
  return out + ellipsis + (styled ? '\x1b[0m' : '');
}
