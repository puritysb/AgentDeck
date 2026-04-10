/**
 * CJK-aware text measurement utilities.
 * Extracted from voice-renderer.ts for shared use across renderers.
 */

const COMBINING_RE = /\p{M}/u;

/** True for CJK / fullwidth characters (Hangul, Kanji, Kana, CJK symbols). */
export function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x11FF) ||   // Hangul Jamo
    (code >= 0x2E80 && code <= 0x9FFF) ||   // CJK radicals, symbols, ideographs
    (code >= 0xAC00 && code <= 0xD7AF) ||   // Hangul Syllables
    (code >= 0xF900 && code <= 0xFAFF) ||   // CJK Compatibility Ideographs
    (code >= 0xFF00 && code <= 0xFF60) ||   // Fullwidth forms
    (code >= 0xFFE0 && code <= 0xFFE6)      // Fullwidth signs
  );
}

/** Pixel width of a single character at given font size (Arial approximation). */
export function charPx(ch: string, fontSize: number): number {
  if (COMBINING_RE.test(ch)) return 0;              // combining marks: zero width
  if (isWide(ch.charCodeAt(0))) return fontSize;     // CJK: ~1em
  return fontSize * 0.55;                            // Latin, etc.: ~0.55em
}

/** Estimate pixel width of a string at given font size (Arial). */
export function measureTextWidth(text: string, fontSize: number): number {
  let px = 0;
  for (const ch of text) px += charPx(ch, fontSize);
  return px;
}

/** Slice string so first part fits within maxPx. */
export function sliceByPx(s: string, maxPx: number, fontSize: number): [string, string] {
  let px = 0;
  let i = 0;
  for (const ch of s) {
    const cw = charPx(ch, fontSize);
    if (cw > 0 && px + cw > maxPx) break;
    px += cw;
    i += ch.length;
  }
  return [s.slice(0, i), s.slice(i)];
}

/** Word-wrap text by estimated pixel width (works for all scripts). */
export function wrapTextByWidth(text: string, maxWidthPx: number, fontSize: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  let currentPx = 0;
  const spacePx = fontSize * 0.28;

  for (const word of words) {
    const wordPx = measureTextWidth(word, fontSize);

    if (current && currentPx + spacePx + wordPx > maxWidthPx) {
      lines.push(current);
      current = '';
      currentPx = 0;
    }

    if (wordPx > maxWidthPx) {
      if (current) { lines.push(current); current = ''; currentPx = 0; }
      let rem = word;
      while (measureTextWidth(rem, fontSize) > maxWidthPx) {
        const [chunk, rest] = sliceByPx(rem, maxWidthPx, fontSize);
        lines.push(chunk);
        rem = rest;
      }
      current = rem;
      currentPx = measureTextWidth(rem, fontSize);
    } else {
      if (current) {
        current += ' ' + word;
        currentPx += spacePx + wordPx;
      } else {
        current = word;
        currentPx = wordPx;
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}
