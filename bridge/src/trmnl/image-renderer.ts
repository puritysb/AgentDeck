/**
 * TRMNL image renderer — rasterizes the shared 800×480 dashboard SVG to a
 * 1-bit (black/white) grayscale PNG sized for the TRMNL 7.5" e-ink panel.
 *
 * Pipeline: shared `renderTrmnlDashboard` SVG → resvg rasterize (800×480 RGBA)
 * → luminance threshold → packed 1-bit PNG (color type 0, bit depth 1) encoded
 * with Node's built-in `zlib` (no new dependency). A 1-bit PNG of mostly-white
 * line art deflates to a few KB, comfortably under TRMNL's 90 KB download cap.
 *
 * Falls back to a blank 1-bit PNG when resvg-js is unavailable (matches the
 * D200H renderer's optional-dependency pattern).
 */
import { deflateSync } from 'zlib';
import { createHash } from 'crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { renderTrmnlDashboard, TRMNL_WIDTH, TRMNL_HEIGHT } from '@agentdeck/shared';
import { debug } from '../logger.js';

const TAG = 'trmnl-render';

// --- Font supply for resvg (same trap/fix as the D200H renderer) ---
// resvg drops every <text> element unless given a font to shape glyphs with.
// Load the bundled OFL faces via `fontFiles` for crisp Latin/mono, AND enable
// `loadSystemFonts` so resvg can FALL BACK to the OS's CJK faces — session goals
// are user prompts, often Korean/Chinese, which the Latin-only bundled fonts
// render as boxes. Unlike the 14-tile-per-frame D200H renderer, TRMNL renders one
// frame only on real state change, so the per-`new Resvg()` system-font scan is an
// acceptable cost here.
const FONT_OPTS: { fontFiles?: string[]; loadSystemFonts: boolean; defaultFontFamily: string } = (() => {
  try {
    // bridge/{src,dist}/trmnl/image-renderer.{ts,js} → bridge/assets/fonts
    const here = dirname(fileURLToPath(import.meta.url));
    const fontsDir = join(here, '..', '..', 'assets', 'fonts');
    const files = [
      'IBMPlexSans-Regular.ttf',
      'IBMPlexSans-Bold.ttf',
      'JetBrainsMono-Regular.ttf',
      'JetBrainsMono-Bold.ttf',
    ]
      .map((n) => join(fontsDir, n))
      .filter((p) => existsSync(p));
    if (files.length > 0) {
      return { fontFiles: files, loadSystemFonts: true, defaultFontFamily: 'IBM Plex Sans' };
    }
    debug(TAG, `bundled fonts not found under ${fontsDir} — falling back to system fonts`);
  } catch (err) {
    debug(TAG, `font path resolution failed (${err}) — falling back to system fonts`);
  }
  return { loadSystemFonts: true, defaultFontFamily: 'Helvetica Neue' };
})();

// --- resvg-js loader (optional dependency) ---

interface RenderedImage {
  pixels: Buffer | Uint8Array;
  width: number;
  height: number;
}
type ResvgClass = new (svg: string, opts?: any) => { render(): RenderedImage };
let Resvg: ResvgClass | null = null;
let resvgLoaded = false;

async function loadResvg(): Promise<ResvgClass | null> {
  if (resvgLoaded) return Resvg;
  resvgLoaded = true;
  try {
    const mod = await import('@resvg/resvg-js');
    Resvg = (mod as any).Resvg ?? (mod as any).default?.Resvg;
    debug(TAG, 'resvg-js loaded — SVG rendering enabled');
    return Resvg;
  } catch {
    debug(TAG, 'resvg-js not available — falling back to blank 1-bit PNG');
    return null;
  }
}

/** Initialize the renderer (loads resvg-js if available). Call once at start. */
export async function initTrmnlRenderer(): Promise<void> {
  await loadResvg();
}

export function isTrmnlResvgLoaded(): boolean {
  return Resvg !== null;
}

// --- PNG (1-bit grayscale) encoding ---

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([len, typeBytes, data, crc]);
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Encode a 1-bit grayscale PNG from a packed bitmap.
 * `bits` holds one bit per pixel, MSB-first, `bytesPerRow` bytes per scanline,
 * where 1 = white and 0 = black (PNG grayscale convention).
 */
function encode1BitPng(bits: Uint8Array, width: number, height: number, bytesPerRow: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw image data: each scanline prefixed with filter byte 0 (None).
  const raw = Buffer.alloc((bytesPerRow + 1) * height);
  for (let y = 0; y < height; y++) {
    const dst = y * (bytesPerRow + 1);
    raw[dst] = 0; // filter: None
    for (let x = 0; x < bytesPerRow; x++) raw[dst + 1 + x] = bits[y * bytesPerRow + x];
  }

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Threshold RGBA pixels to a packed 1-bit bitmap (1 = white, 0 = black). */
function rgbaToPacked1Bit(
  pixels: Buffer | Uint8Array,
  width: number,
  height: number,
): { bits: Uint8Array; bytesPerRow: number } {
  const bytesPerRow = (width + 7) >> 3;
  const bits = new Uint8Array(bytesPerRow * height);
  bits.fill(0xff); // default white
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const r = pixels[p];
      const g = pixels[p + 1];
      const b = pixels[p + 2];
      // Rec.601 luma; transparent pixels (alpha 0) read as white since our SVG
      // paints a full white background, so alpha is effectively always 255.
      const luma = (r * 299 + g * 587 + b * 114) / 1000;
      if (luma < 128) {
        // black pixel → clear the bit
        const byteIdx = y * bytesPerRow + (x >> 3);
        bits[byteIdx] &= ~(0x80 >> (x & 7));
      }
    }
  }
  return { bits, bytesPerRow };
}

/** A fully-white 1-bit PNG (fallback when resvg is unavailable). */
function blankPng(width: number, height: number): Buffer {
  const bytesPerRow = (width + 7) >> 3;
  const bits = new Uint8Array(bytesPerRow * height).fill(0xff);
  return encode1BitPng(bits, width, height, bytesPerRow);
}

export interface TrmnlFrame {
  buffer: Buffer;
  /** Short stable hash of the image bytes — used as the BYOS `filename`. */
  contentHash: string;
  width: number;
  height: number;
  contentType: 'image/png';
}

function hashBuffer(buf: Buffer): string {
  return createHash('sha1').update(buf).digest('hex').slice(0, 16);
}

/**
 * Render the AgentDeck dashboard for the given broadcast state into a 1-bit PNG.
 * Accepts a raw state event or a pre-parsed DashState (passed through to the
 * shared layout). `now` may be supplied for deterministic tests.
 */
export function renderTrmnlFrame(
  stateEvt: any,
  now?: Date,
  size?: { width: number; height: number },
): TrmnlFrame {
  const width = size?.width && size.width > 0 ? Math.round(size.width) : TRMNL_WIDTH;
  const height = size?.height && size.height > 0 ? Math.round(size.height) : TRMNL_HEIGHT;
  let buffer: Buffer;
  if (Resvg) {
    try {
      const svg = renderTrmnlDashboard(stateEvt, { ...(now ? { now } : {}), width, height });
      const resvg = new Resvg(svg, {
        fitTo: { mode: 'width' as const, value: width },
        font: FONT_OPTS,
        background: '#ffffff',
      });
      const rendered = resvg.render();
      const { bits, bytesPerRow } = rgbaToPacked1Bit(rendered.pixels, rendered.width, rendered.height);
      buffer = encode1BitPng(bits, rendered.width, rendered.height, bytesPerRow);
    } catch (err) {
      debug(TAG, `render failed (${err}) — emitting blank frame`);
      buffer = blankPng(width, height);
    }
  } else {
    buffer = blankPng(width, height);
  }
  return {
    buffer,
    contentHash: hashBuffer(buffer),
    width,
    height,
    contentType: 'image/png',
  };
}
