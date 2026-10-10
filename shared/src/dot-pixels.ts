import type { DotDeckSnapshot } from './protocol.js';
import { defaultDotRGBA, validDotAppearance, DOT_STATUS_MARKS, DOT_PHASES, DOT_HABITAT_PHASES, DOT_APPEARANCE_RULES as R } from './dot-appearance.js';
import { dotDeckPresentation } from './dot-deck.js';
/** A separate screen-space companion; fleet/session accounting is never touched. */
export function paintDotPixels(rgb: Uint8Array, width: number, dot: DotDeckSnapshot | null | undefined, now = Date.now()): Uint8Array {
  if (![32, 64].includes(width) || !dot?.configured || rgb.length !== width * width * 3) return rgb;
  const code = DOT_PHASES.indexOf(dotDeckPresentation(dot, now).label as typeof DOT_PHASES[number]);
  if (!DOT_HABITAT_PHASES.includes(code)) return rgb;
  const size = Math.max(R.pixelMinSize, Math.floor(width / R.pixelSizeDivisor));
  const x0 = width - size - R.pixelMargin, y0 = Math.floor(width / R.pixelYDivisor);
  let source = size, rgba = defaultDotRGBA(size);
  if (validDotAppearance(dot.appearance)) {
    try { rgba = Uint8Array.from(atob(dot.appearance.rgba), c => c.charCodeAt(0)); source = 16; } catch { /* default */ }
  }
  const color = dotDeckPresentation(dot, now).color;
  const tint = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const pixel = (x: number, y: number, c: number[], a = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= width) return;
    const i = (y * width + x) * 3;
    for (let k = 0; k < 3; k++) rgb[i + k] = Math.round((c[k] * a + rgb[i + k] * (255 - a)) / 255);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (Math.floor(y * source / size) * source + Math.floor(x * source / size)) * 4;
    pixel(x0 + x, y0 + y, [rgba[i], rgba[i + 1], rgba[i + 2]], rgba[i + 3]);
  }
  DOT_STATUS_MARKS[code].forEach((row, y) => [...row].forEach((bit, x) => { if (bit === '1') pixel(x0 + size - 1 + x, y0 - 2 + y, tint); }));
  return rgb;
}
