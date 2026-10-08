/** Exact source feature coverage over the canonical creature body. Black is
 * composited as paint, so arbitrary water/background cannot become its eyes. */
import { OFFICIAL_STANDARD_FEATURES, OFFICIAL_TIMEBOX_FEATURES, OFFICIAL_TC001_FEATURES, type OfficialDotGlyphName } from './official-dot-glyphs.generated.js';
export function paintOfficialFeatures(buf: Uint8Array, canvasSize: number, glyph: OfficialDotGlyphName,
  x0: number, y0: number, target: number, kind: 'standard' | 'timebox' | 'tc001' = 'standard', intensity = 1): void {
  const sourceSize = kind === 'standard' ? 24 : kind === 'timebox' ? 9 : 8;
  const layers = (kind === 'standard' ? OFFICIAL_STANDARD_FEATURES : kind === 'timebox' ? OFFICIAL_TIMEBOX_FEATURES : OFFICIAL_TC001_FEATURES)[glyph];
  for (const layer of layers) for (let dy = 0; dy < target; dy++) for (let dx = 0; dx < target; dx++) {
    const sx = Math.floor(dx * sourceSize / target) - layer.x, sy = Math.floor(dy * sourceSize / target) - layer.y;
    if (sx < 0 || sy < 0 || sx >= layer.width || sy >= layer.height) continue;
    const alpha = layer.alpha[sy * layer.width + sx] / 255;
    const x = x0 + dx, y = y0 + dy;
    if (!alpha || x < 0 || y < 0 || x >= canvasSize || y >= canvasSize) continue;
    const offset = (y * canvasSize + x) * 3;
    for (let c = 0; c < 3; c++) buf[offset + c] = Math.round(buf[offset + c] * (1 - alpha) + layer.rgb[c] * intensity * alpha);
  }
}
