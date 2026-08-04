/**
 * Glance Frame — daemon-side pixel rendering of the sleep/ambient dashboard
 * (M8). The device-side glance (fork `renderGlance`) is the offline fallback;
 * this is the rich face: the daemon lays the glance out as SVG (real
 * typography, vector weather icons, gauge bars), rasterizes it with sharp,
 * ordered-dithers to 1-bit, and packs it in the e-ink framebuffer format
 * (1bpp, MSB-first rows, 1 = white — matching `clearScreen(0xFF)` semantics).
 *
 * tesserae-inspired (concepts only — tesserae is AGPL): server renders pixels,
 * the panel is a display driver, and the browser preview shows the *exact*
 * frame the panel will hold (`?format=png` returns the dithered pixels, so
 * "looked fine in the preview, broke on the panel" cannot happen).
 *
 * Ordered (Bayer) dithering, not error diffusion: deterministic output means
 * the frame bytes — and therefore the frame sig — are stable for stable input.
 */

import sharp from 'sharp';
import type { CardFeedGlance, GlanceWeather } from '@agentdeck/shared';

// ===== Board presets (logical orientation the UI renders in) =====

export interface FrameGeometry {
  /** Logical layout space the SVG is authored in. */
  width: number;
  height: number;
  /** Landscape boards get a two-column layout. */
  landscape: boolean;
  /**
   * The panel's native framebuffer is landscape while the layout is portrait:
   * rotate the raster into physical space before packing, mirroring the
   * device's GfxRenderer Portrait mapping (phyX = y, phyY = panelH - 1 - x).
   * A blit consumer writes the packed bytes straight into the physical
   * framebuffer, bypassing that mapping — and a no-PSRAM C3 cannot afford a
   * per-pixel rotate on device, so the daemon does it once here. The packed
   * frame (and X-Frame-Width/Height) then report the PHYSICAL geometry.
   */
  rotateToPhysical?: boolean;
}

export const GLANCE_FRAME_BOARDS: Record<string, FrameGeometry> = {
  // X3 panel: physical 792×528 (stride 99); layout stays portrait 528×792.
  xteink_x3: { width: 528, height: 792, landscape: false, rotateToPhysical: true },
  xteink_x4: { width: 800, height: 480, landscape: true },
  inkdeck: { width: 800, height: 480, landscape: true },
};

// ===== Weather icons (vector, 1-bit friendly) =====

/** WMO code → icon key. Kept alongside `wmoSummary` in weather.ts semantics. */
export function wmoIconKey(code: number | undefined): string {
  if (code === undefined || !Number.isFinite(code)) return 'cloud';
  if (code === 0) return 'sun';
  if (code <= 2) return 'partly';
  if (code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloud';
}

/** Icon drawn in a 100×100 viewbox, stroke-based so it reads at 1 bit. */
function iconSvg(key: string): string {
  const cloud =
    '<path d="M28 62 a16 16 0 0 1 4 -31 a22 22 0 0 1 42 -4 a15 15 0 0 1 2 30 z" fill="none" stroke="black" stroke-width="7" stroke-linejoin="round"/>';
  switch (key) {
    case 'sun': {
      const rays = Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        const x1 = 50 + Math.cos(a) * 34, y1 = 50 + Math.sin(a) * 34;
        const x2 = 50 + Math.cos(a) * 46, y2 = 50 + Math.sin(a) * 46;
        return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="black" stroke-width="7" stroke-linecap="round"/>`;
      }).join('');
      return `<circle cx="50" cy="50" r="21" fill="none" stroke="black" stroke-width="7"/>${rays}`;
    }
    case 'partly':
      return (
        '<circle cx="66" cy="34" r="16" fill="none" stroke="black" stroke-width="6"/>' +
        '<path d="M20 74 a13 13 0 0 1 3 -25 a18 18 0 0 1 34 -3 a12 12 0 0 1 2 28 z" fill="white" stroke="black" stroke-width="6" stroke-linejoin="round"/>'
      );
    case 'fog':
      return [30, 46, 62, 78]
        .map((y) => `<line x1="18" y1="${y}" x2="82" y2="${y}" stroke="black" stroke-width="7" stroke-linecap="round"/>`)
        .join('');
    case 'rain':
      return (
        cloud +
        [34, 52, 70]
          .map((x) => `<line x1="${x}" y1="72" x2="${x - 6}" y2="88" stroke="black" stroke-width="6" stroke-linecap="round"/>`)
          .join('')
      );
    case 'snow':
      return (
        cloud +
        [34, 52, 70]
          .map((x) => `<circle cx="${x}" cy="80" r="4" fill="black"/>`)
          .join('')
      );
    case 'storm':
      return cloud + '<path d="M52 64 L40 84 h10 L44 100 L62 76 h-10 L58 64 z" fill="black"/>';
    case 'cloud':
    default:
      return cloud;
  }
}

// ===== SVG layout =====

const SANS = 'IBM Plex Sans, Helvetica, Arial, sans-serif';
const MONO = 'JetBrains Mono, Menlo, monospace';
/** 50% gray — the Bayer pass turns it into a clean checker; used for
 *  secondary fills so the frame has depth without real grayscale. */
const GRAY = '#808080';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Conservative SVG text-width estimate used only to add an honest ellipsis
 * before the hard clip. The production renderer cannot ask librsvg for text
 * metrics before composing the SVG, and emitting the full string lets e-ink
 * crop a word mid-letter. Count CJK/full-width glyphs as one em and bucket the
 * common Latin widths; the clipPath remains the final safety boundary. */
function fitText(s: string, maxWidth: number, fontSize: number): string {
  const glyphEm = (ch: string): number => {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 0x2e80) return 1;
    if (/\s/.test(ch)) return 0.33;
    if (/[ilI1.,'`|!:;]/.test(ch)) return 0.28;
    if (/[mwMW@#%&]/.test(ch)) return 0.82;
    return 0.56;
  };
  const width = (value: string): number => [...value].reduce((sum, ch) => sum + glyphEm(ch) * fontSize, 0);
  if (width(s) <= maxWidth) return s;

  const suffix = '…';
  const suffixWidth = width(suffix);
  let used = 0;
  let out = '';
  for (const ch of s) {
    const next = glyphEm(ch) * fontSize;
    if (used + next + suffixWidth > maxWidth) break;
    out += ch;
    used += next;
  }
  return `${out.trimEnd()}${suffix}`;
}

export interface GlanceFrameInput {
  glance?: CardFeedGlance;
  /** Daemon-local "HH:MM" at render — the frame's absolute "Synced" stamp. */
  serverHm: string;
  geometry: FrameGeometry;
}

interface Ctx {
  parts: string[];
  w: number;
}

function text(c: Ctx, x: number, y: number, size: number, s: string, opts: {
  weight?: number; mono?: boolean; anchor?: 'start' | 'end' | 'middle'; fill?: string; spacing?: string;
} = {}): void {
  if (!s) return;
  c.parts.push(
    `<text x="${x}" y="${y}" font-family="${opts.mono ? MONO : SANS}" font-size="${size}"` +
      (opts.weight ? ` font-weight="${opts.weight}"` : '') +
      (opts.anchor ? ` text-anchor="${opts.anchor}"` : '') +
      (opts.spacing ? ` letter-spacing="${opts.spacing}"` : '') +
      ` fill="${opts.fill ?? 'black'}">${esc(s)}</text>`,
  );
}

function rule(c: Ctx, x1: number, y: number, x2: number, thick = 2): void {
  c.parts.push(`<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="black" stroke-width="${thick}"/>`);
}

function sectionLabel(c: Ctx, x: number, y: number, label: string): void {
  text(c, x, y, 17, label, { weight: 700, spacing: '3' });
  rule(c, x, y + 10, c.w - 36, 2);
}

/** One provider quota row: name + 5H/7D bars with the reset time. Returns the
 *  y consumed. */
function quotaRow(
  c: Ctx, x: number, y: number, width: number,
  row: { label: string; primaryPercent?: number; primaryResetHm?: string; secondaryPercent?: number; stale: boolean },
): number {
  text(c, x, y + 20, 22, row.label + (row.stale ? ' *' : ''), { weight: 600 });
  const barX = x + 118;
  const barW = width - 118;
  const drawBar = (by: number, tag: string, pct: number | undefined, extra?: string) => {
    if (pct === undefined) return;
    const h = 18;
    text(c, barX - 8, by + h - 3, 15, tag, { weight: 700, anchor: 'end', mono: true });
    c.parts.push(`<rect x="${barX}" y="${by}" width="${barW}" height="${h}" fill="white" stroke="black" stroke-width="2"/>`);
    const fw = Math.round(((barW - 4) * Math.min(100, Math.max(0, pct))) / 100);
    if (fw > 0) c.parts.push(`<rect x="${barX + 2}" y="${by + 2}" width="${fw}" height="${h - 4}" fill="black"/>`);
    const label = `${Math.round(pct)}%${extra ? ` ${extra}` : ''}`;
    // Percent label sits inside the empty end of the bar when it fits, else
    // just past the fill — always readable at 1 bit.
    text(c, barX + barW - 6, by + h - 4, 14, label, { anchor: 'end', mono: true, fill: fw > barW - 90 ? 'white' : 'black' });
  };
  drawBar(y + 4, '5H', row.primaryPercent, row.primaryResetHm ? `→${row.primaryResetHm}` : undefined);
  drawBar(y + 30, '7D', row.secondaryPercent);
  return 62;
}

function weatherBlock(c: Ctx, x: number, y: number, width: number, w: GlanceWeather): number {
  const startY = y;
  // Hero: icon + big temperature.
  const iconSize = 96;
  c.parts.push(`<g transform="translate(${x},${y}) scale(${iconSize / 100})">${iconSvg(wmoIconKey(w.code))}</g>`);
  const tx = x + iconSize + 26;
  if (w.tempC !== undefined) text(c, tx, y + 78, 88, `${w.tempC}°`, { weight: 700 });
  const rx = x + width;
  if (w.summary) text(c, rx, y + 34, 26, w.summary, { weight: 600, anchor: 'end' });
  if (w.todayMinC !== undefined && w.todayMaxC !== undefined) {
    text(c, rx, y + 66, 21, `${w.todayMinC}–${w.todayMaxC}°`, { anchor: 'end' });
  }
  y += 112;
  if (w.rain) {
    const range = w.rain.endHm ? `${w.rain.startHm}–${w.rain.endHm}` : `~${w.rain.startHm}`;
    text(c, x, y + 8, 22, `☂ Rain ${range} · ${w.rain.probability}%`, { weight: 600 });
    y += 34;
  }
  if (w.tomorrow && (w.tomorrow.summary || w.tomorrow.minC !== undefined)) {
    const t = w.tomorrow;
    const bits: string[] = ['Tomorrow'];
    if (t.summary) bits.push(t.summary);
    if (t.minC !== undefined && t.maxC !== undefined) bits.push(`${t.minC}–${t.maxC}°`);
    if (t.rainProbability !== undefined && t.rainProbability > 0) bits.push(`rain ${t.rainProbability}%`);
    text(c, x, y + 6, 19, bits.join('  ·  '), { fill: 'black' });
    // A quiet gray underline separates the outlook from the sections below.
    c.parts.push(`<rect x="${x}" y="${y + 16}" width="${width}" height="4" fill="${GRAY}"/>`);
    y += 34;
  }
  return y - startY;
}

export function renderGlanceFrameSvg(input: GlanceFrameInput): string {
  const { width: W, height: H, landscape } = input.geometry;
  const g = input.glance ?? {};
  const c: Ctx = { parts: [], w: W };
  const M = 36; // outer margin

  c.parts.push(`<rect width="${W}" height="${H}" fill="white"/>`);

  // ── Masthead ──
  text(c, M, 46, 24, 'AgentDeck', { weight: 700, spacing: '1' });
  const mastRight = [g.weather?.place, input.serverHm ? `Synced ${input.serverHm}` : ''].filter(Boolean).join('  ·  ');
  text(c, W - M, 46, 19, mastRight, { anchor: 'end' });
  rule(c, M, 62, W - M, 3);

  const colX = M;
  const colW = landscape ? Math.floor((W - M * 2 - 40) / 2) : W - M * 2;
  const rightX = M + colW + 40;
  let yL = 96;
  let yR = 96;

  // ── Weather (left column / top block) ──
  if (g.weather && (g.weather.tempC !== undefined || g.weather.summary)) {
    yL += weatherBlock(c, colX, yL, colW, g.weather) + 18;
  }

  // ── Today's schedule (left column, under weather) ──
  const events = g.events ?? [];
  if (events.length > 0) {
    sectionLabel(c, colX, yL, 'TODAY');
    yL += 34;
    for (const e of events) {
      const time = e.startHm ? (e.endHm ? `${e.startHm}–${e.endHm}` : e.startHm) : 'All day';
      text(c, colX, yL, 20, fitText(`${time}  ·  ${e.title}`, colW, 20));
      yL += 32;
    }
    yL += 10;
  }

  // ── Quota ──
  let qx = colX, qy = yL, qw = colW;
  if (landscape) { qx = rightX; qy = yR; qw = W - M - rightX; }
  if (g.usage && g.usage.length > 0) {
    sectionLabel(c, qx, qy, 'AI BUDGET');
    qy += 26;
    for (const row of g.usage) qy += quotaRow(c, qx, qy, qw, row) + 8;
    qy += 10;
  }
  if (landscape) yR = qy; else yL = qy;

  // ── Work wrap-up ──
  let wx = colX, wy = yL, ww = colW;
  if (landscape) { wx = rightX; wy = yR; ww = W - M - rightX; }
  const wrapup = g.wrapup ?? [];
  sectionLabel(c, wx, wy, 'WORK');
  wy += 34;
  if (wrapup.length === 0) {
    text(c, wx, wy, 20, 'No active sessions', { fill: GRAY });
    wy += 30;
  }
  // Clip the work lines to their column — a long CJK line must never bleed
  // into the margin or the other column.
  c.parts.push(`<clipPath id="work"><rect x="${wx}" y="${wy - 30}" width="${ww}" height="${H - wy - 30}"/></clipPath>`);
  c.parts.push(`<g clip-path="url(#work)">`);
  for (const line of wrapup) {
    if (wy > H - 60) break;
    c.parts.push(`<circle cx="${wx + 5}" cy="${wy - 6}" r="4" fill="black"/>`);
    text(c, wx + 20, wy, 20, fitText(line, ww - 20, 20));
    wy += 32;
  }
  c.parts.push('</g>');

  // ── Footer status ──
  rule(c, M, H - 44, W - M, 2);
  text(c, M, H - 18, 17, 'AGENTDECK · GLANCE', { weight: 700, spacing: '2', fill: GRAY });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${c.parts.join('')}</svg>`;
}

// ===== Rasterize → dither → pack =====

/** 4×4 Bayer matrix, thresholds spread over 0..255. Ordered dithering is
 *  deterministic, so identical input yields identical bytes (stable sig). */
const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => Math.round(((v + 0.5) * 255) / 16)));

/** Rotate a logical-space grayscale raster (w×h) into physical panel space
 *  (h×w), using the device GfxRenderer Portrait mapping: phyX = y,
 *  phyY = physH − 1 − x (with physH = logical width). Kept exactly in sync
 *  with `rotateCoordinates` in the XTeink fork's GfxRenderer.cpp. */
export function rotateGrayToPhysical(gray: Buffer, width: number, height: number): Buffer {
  const physW = height;
  const physH = width;
  const out = Buffer.alloc(physW * physH);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[(physH - 1 - x) * physW + y] = gray[y * width + x];
    }
  }
  return out;
}

/** Pack 8-bit grayscale into the e-ink framebuffer format: 1bpp, MSB-first
 *  within each byte, row-major, bit 1 = white (clearScreen(0xFF) = white). */
export function packMono(gray: Buffer, width: number, height: number): Buffer {
  const rowBytes = Math.ceil(width / 8);
  const out = Buffer.alloc(rowBytes * height, 0x00);
  for (let y = 0; y < height; y++) {
    const bay = BAYER4[y & 3];
    for (let x = 0; x < width; x++) {
      if (gray[y * width + x] > bay[x & 3]) {
        out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return out;
}

/** FNV-1a over a byte buffer (frame sig / content sig). */
export function frameSig(packed: Buffer): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < packed.length; i++) {
    h ^= packed[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export interface RenderedGlanceFrame {
  packed: Buffer;
  sig: string;
  width: number;
  height: number;
  /** The exact panel pixels as a PNG — the preview IS the production frame. */
  png(): Promise<Buffer>;
}

export async function renderGlanceFrame(input: GlanceFrameInput): Promise<RenderedGlanceFrame> {
  const svg = Buffer.from(renderGlanceFrameSvg(input));
  let gray = await sharp(svg, { density: 72 }).flatten({ background: 'white' }).greyscale().raw().toBuffer();
  let { width, height } = input.geometry;
  if (input.geometry.rotateToPhysical) {
    gray = rotateGrayToPhysical(gray, width, height);
    [width, height] = [height, width];
  }
  const packed = packMono(gray, width, height);
  // The sig hashes the frame's CONTENT, not its pixels: the masthead bakes the
  // "Synced HH:MM" clock stamp into the raster, so a pixel hash would change
  // every minute and silently void the ?sig= conditional (a device would
  // re-download ~50KB on every poll past a minute boundary). Hashing the SVG
  // with the clock stamp blanked keeps the sig stable across clock ticks while
  // still covering everything else that moves pixels — glance data, geometry,
  // and layout-code changes all flow through the SVG string.
  const sig = frameSig(Buffer.from(renderGlanceFrameSvg({ ...input, serverHm: '' })));
  return {
    packed,
    sig,
    width,
    height,
    png: async () => {
      // Re-expand the packed bits so the PNG shows the dithered result, not
      // the smooth grayscale — what you preview is what the panel holds.
      const rowBytes = Math.ceil(width / 8);
      const px = Buffer.alloc(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          px[y * width + x] = packed[y * rowBytes + (x >> 3)] & (0x80 >> (x & 7)) ? 255 : 0;
        }
      }
      return sharp(px, { raw: { width, height, channels: 1 } }).png().toBuffer();
    },
  };
}
