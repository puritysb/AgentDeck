import type { DotDeckSnapshot } from './protocol.js';
import { defaultDotRGBA, validDotAppearance, DOT_STATUS_MARKS, DOT_PHASES } from './dot-appearance.js';
import { dotDeckPresentation } from './dot-deck.js';
/** A separate screen-space companion; fleet/session accounting is never touched. */
export function paintDotPixels(rgb: Uint8Array, width: number, dot: DotDeckSnapshot | null | undefined, now = Date.now()): Uint8Array {
  if (width < 32 || !dot?.configured || rgb.length !== width * width * 3) return rgb;
  const size = Math.floor(width / 4), x0 = width - size - 2, y0 = 12;
  let rgba = defaultDotRGBA();
  if (validDotAppearance(dot.appearance)) {
    try { rgba = Uint8Array.from(atob(dot.appearance.rgba), c => c.charCodeAt(0)); } catch { /* default */ }
  }
  const color = dotDeckPresentation(dot, now).color;
  const tint = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16));
  const pixel = (x: number, y: number, c: number[], a = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= width) return;
    const i = (y * width + x) * 3;
    for (let k = 0; k < 3; k++) rgb[i + k] = Math.round((c[k] * a + rgb[i + k] * (255 - a)) / 255);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (Math.floor(y * 16 / size) * 16 + Math.floor(x * 16 / size)) * 4;
    pixel(x0 + x, y0 + y, [rgba[i], rgba[i + 1], rgba[i + 2]], rgba[i + 3]);
  }
  for (let i = -1; i <= size; i++) { pixel(x0 + i, y0 - 1, tint); pixel(x0 + i, y0 + size, tint); }
  // D marker distinguishes this report companion from provider/session marks.
  for (let y = 0; y < 5; y++) { pixel(x0, y0 + size + 2 + y, tint); pixel(x0 + 3, y0 + size + 2 + y, tint); }
  for (let x = 0; x < 3; x++) { pixel(x0 + x, y0 + size + 2, tint); pixel(x0 + x, y0 + size + 6, tint); }
  const code = Math.max(0, DOT_PHASES.indexOf(dotDeckPresentation(dot, now).label as typeof DOT_PHASES[number]));
  DOT_STATUS_MARKS[code].forEach((row, y) => [...row].forEach((bit, x) => { if (bit === '1') pixel(x0 + size - 3 + x, y0 + size + 2 + y, tint); }));
  return rgb;
}
