import { Tide, Ink, UI } from './design-tokens.js';
/** Host-authored, bounded assets; never a URL to fetch or executable SVG/model. */
export const DOT_APPEARANCE_RULES = Object.freeze({
  version: 1, portraitSize: 64, glyphSize: 16, sourceBytes: 2 * 1024 * 1024,
  sourcePixels: 4 * 1024 * 1024, portraitBytes: 24 * 1024,
  glyphBytes: 16 * 16 * 4, glyphBase64: 1368, relationBytes: 96,
  panelGlyphSize: 32, paperGlyphSize: 24, matrixGlyphSize: 7, panelMargin: 8,
});
export interface DotAppearance {
  version: number;
  id: string;
  /** Canonical static PNG, authored by the importing host; optional on compact transport. */
  png?: string;
  /** Exactly 16×16 row-major, straight-alpha RGBA8, base64 encoded. */
  rgba: string;
}
export interface DotSurfaceRelation {
  kind: string;
  direction: string;
  stage: string;
  target: string | null;
  receivedAt: number;
  evidence: 'dot_report';
}
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
export function validDotAppearance(value: unknown): value is DotAppearance {
  if (!value || typeof value !== 'object') return false;
  const a = value as DotAppearance;
  return a.version === DOT_APPEARANCE_RULES.version && /^[a-f0-9]{64}$/.test(a.id)
    && typeof a.rgba === 'string' && a.rgba.length === DOT_APPEARANCE_RULES.glyphBase64 && base64.test(a.rgba) && a.rgba.endsWith('==')
    && (a.png === undefined || (typeof a.png === 'string' && a.png.startsWith('iVBORw0KGgo') && base64.test(a.png)
      && a.png.length <= Math.ceil(DOT_APPEARANCE_RULES.portraitBytes / 3) * 4));
}
export function compactDotAppearance(value: unknown): DotAppearance | null {
  return validDotAppearance(value) ? { version: value.version, id: value.id, rgba: value.rgba } : null;
}
export const DOT_PHASES = ['NO REPORT', 'HOST STOPPED', 'WORKING', 'NEEDS YOU', 'COMPLETED', 'FAILED', 'OLD REPORT', 'UNKNOWN'] as const;
/** Original default geometry, shared by generated firmware and tiny host previews. */
export const DOT_ORB_GEOMETRY = Object.freeze({ center: 7.5, radius: 7, eyeLeft: 5, eyeRight: 10, eyeTop: 5, eyeBottom: 9 });
export function defaultDotRGBA(size = DOT_APPEARANCE_RULES.glyphSize): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const g = DOT_ORB_GEOMETRY;
  const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const body = rgb(Tide.s300), eyes = rgb(Ink.s900);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if ((x - (size - 1) / 2) ** 2 + (y - (size - 1) / 2) ** 2 > (g.radius * size / DOT_APPEARANCE_RULES.glyphSize) ** 2) continue;
    const eye = (x === Math.round(g.eyeLeft * (size - 1) / 15) || x === Math.round(g.eyeRight * (size - 1) / 15)) && y >= Math.round(g.eyeTop * (size - 1) / 15) && y <= Math.round(g.eyeBottom * (size - 1) / 15);
    const i = (y * size + x) * 4;
    out.set([...(eye ? eyes : body), 255], i);
  }
  return out;
}

export const DOT_PHASE_COLORS = [Ink.s300, Ink.s300, UI.cyan, UI.attn, UI.ok, UI.error, Ink.s300, Ink.s300] as const;
export const DOT_STATUS_MARKS = [
  ['101','111','111','111','101'], ['111','100','111','001','111'],
  ['101','101','101','111','010'], ['010','010','010','000','010'],
  ['111','100','100','100','111'], ['111','100','110','100','100'],
  ['110','001','010','000','010'], ['110','001','010','000','010'],
] as const;
