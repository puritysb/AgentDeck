import { Tide, Ink, UI } from './design-tokens.js';
/** Host-authored, bounded assets; never a URL to fetch or executable SVG/model. */
export const DOT_APPEARANCE_RULES = Object.freeze({
  version: 1, portraitSize: 64, glyphSize: 16, sourceBytes: 2 * 1024 * 1024,
  sourcePixels: 4 * 1024 * 1024, portraitBytes: 24 * 1024,
  glyphBytes: 16 * 16 * 4, glyphBase64: 1368, relationBytes: 96,
  pixelSizeDivisor: 6, pixelMinSize: 7, pixelMargin: 3, pixelYDivisor: 4,
  panelGlyphSize: 32, paperGlyphSize: 24, matrixGlyphSize: 7, panelMargin: 8,
});
/** Pearl-home layout for ordinary habitat residents. Activity remains evidence-based. */
export const DOT_HABITAT_RULES = Object.freeze({
  homeX: 0.43, homeY: 0.72, travelX: 0.045, travelY: 0.020,
  periodSeconds: 12, sizeFraction: 0.055, minSize: 28, maxSize: 44,
  nativeX: -0.9, nativeY: 1.30, nativeZ: 1.4,
  pixelPeerTurnMs: 4000, microGlyphSize: 9,
  nativeTravelX: 0.35, nativeTravelY: 0.12,
  // Authored pearl geometry, consumed by RealityKit and the Blender glTF export.
  pearlRadius: 0.28, pearlEyeX: 0.09, pearlEyeY: 0.025, pearlEyeZ: 0.265,
  pearlEyeRadius: 0.025, pearlEyeAspect: 1.6, pearlEyeDepth: 0.6,
  pearlShineRadius: 0.036, pearlShineX: -0.10, pearlShineY: 0.13, pearlShineZ: 0.23,
  pearlShineWidth: 1.4, pearlShineHeight: 0.7, pearlShineDepth: 0.4,
  pearlDecalSize: 0.38, pearlDecalZ: 0.282,
});
export function dotHabitatOffset(seconds: number, working: boolean, motion: boolean): { x: number; y: number } {
  if (!working || !motion || !Number.isFinite(seconds)) return { x: 0, y: 0 };
  const angle = seconds * Math.PI * 2 / DOT_HABITAT_RULES.periodSeconds;
  return { x: Math.sin(angle), y: Math.sin(angle * 2) };
}
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
export const DOT_PHASES = ['AWAITING ACTIVITY', 'HOST STOPPED', 'WORKING', 'NEEDS YOU', 'COMPLETED', 'FAILED', 'OLD REPORT', 'UNKNOWN', 'NOT LINKED'] as const;
/** A ready endpoint is an idle resident; working still requires an explicit fresh report. */
export const DOT_HABITAT_PHASES: readonly number[] = [0, 2, 3, 4, 5];
export const DOT_COMPACT_LABELS = ['Dot', 'Stopped', 'Working', 'Help', 'Done', 'Failed', 'Old', 'Unknown', 'Unlinked'] as const;
/** Original default geometry, shared by generated firmware and tiny host previews. */
export const DOT_ORB_GEOMETRY = Object.freeze({ center: 7.5, radius: 7, eyeLeft: 5, eyeRight: 10, eyeTop: 5, eyeBottom: 9 });
export function defaultDotRGBA(size: number = DOT_APPEARANCE_RULES.glyphSize): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const g = DOT_ORB_GEOMETRY;
  const rgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const body = rgb(Tide.s100), shade = rgb(Tide.s300), shine = rgb(Tide.s50), eyes = rgb(Ink.s900);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if ((x - (size - 1) / 2) ** 2 + (y - (size - 1) / 2) ** 2 > (g.radius * size / DOT_APPEARANCE_RULES.glyphSize) ** 2) continue;
    const eye = (x === Math.round(g.eyeLeft * (size - 1) / 15) || x === Math.round(g.eyeRight * (size - 1) / 15)) && y >= Math.round(g.eyeTop * (size - 1) / 15) && y <= Math.round(g.eyeBottom * (size - 1) / 15);
    const i = (y * size + x) * 4;
    const edge=Math.hypot(x-(size-1)/2,y-(size-1)/2)/(size/2);
    const t=Math.min(1,y/Math.max(1,size-1)*0.65+edge*0.35);
    const pearl=body.map((c,k)=>Math.round(c+(shade[k]-c)*t));
    const glint=(x-size*0.32)**2+(y-size*0.24)**2 < (size*0.09)**2;
    out.set([...(eye ? eyes : glint ? shine : pearl),255],i);
  }
  return out;
}

export const DOT_PHASE_COLORS = [Ink.s300, Ink.s300, UI.cyan, UI.attn, UI.ok, UI.error, Ink.s300, Ink.s300, Ink.s300] as const;
// Tiny matrices use recognizable punctuation, never provider/status initials.
// Quiet states retain the unobstructed face; detail lives on the host.
export const DOT_STATUS_MARKS = [
  [], [], ['010','101','010'], ['010','010','010','000','010'],
  ['000','001','101','010','000'], ['101','010','101'],
  ['110','001','010','000','010'], ['110','001','010','000','010'], [],
] as const;
