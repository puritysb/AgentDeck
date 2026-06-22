/**
 * D200H Image Renderer — Renders AgentDeck state as 196×196 PNG key icons
 * using the shared SVG renderers (same visual output as Stream Deck plugin).
 *
 * Pipeline: state → shared SVG generators (144×144) → resvg rasterize (196×196 PNG) → ZIP
 *
 * Falls back to solid-color PNGs if resvg-js is not available.
 */

import { deflateSync } from 'zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
// Layout/command engine is shared with the Ulanzi Studio plugin (single source
// of truth for the reflowing 5×3 grid). Rasterization + ZIP packing stay here.
import {
  computeLayout,
  parseState,
  buildButtonCommandMap,
  renderUsageWideSlot,
} from '@agentdeck/shared';
import { debug } from '../logger.js';

// Re-export the engine bits the D200H module + tests import from here.
export { parseState, buildButtonCommandMap };
export type { DashState, ButtonCommand, KeySlot } from '@agentdeck/shared';
import { validateZipBoundaries } from './hid-protocol.js';

const TAG = 'd200h-render';

const ICON_SIZE = 196;

// --- Font supply for resvg ---
// resvg drops every <text> element unless it has a font to shape glyphs with.
// We load a small set of bundled OFL fonts explicitly via `fontFiles` (NOT
// `loadSystemFonts`, which re-scans the whole OS font tree on every `new Resvg()`
// — i.e. 14× per frame — and is the reason the original code set it to `false`).
// `defaultFontFamily` makes unresolved families in the shared SVG renderers
// (e.g. `Inter`, `Arial`, `monospace`) fall back to a design-system face
// instead of rendering nothing. Computed once at module load.
const FONT_OPTS: { fontFiles?: string[]; loadSystemFonts: boolean; defaultFontFamily: string } = (() => {
  try {
    // bridge/{src,dist}/d200h/image-renderer.{ts,js} → bridge/assets/fonts
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
      return { fontFiles: files, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' };
    }
    debug(TAG, `bundled fonts not found under ${fontsDir} — falling back to system fonts`);
  } catch (err) {
    debug(TAG, `font path resolution failed (${err}) — falling back to system fonts`);
  }
  // Defense-in-depth: if bundled fonts are missing, still render text via the OS.
  return { loadSystemFonts: true, defaultFontFamily: 'Helvetica Neue' };
})();

// --- resvg-js loader (optional dependency) ---

type ResvgClass = new (svg: string, opts?: any) => { render(): { asPng(): Uint8Array } };
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
    debug(TAG, 'resvg-js not available — falling back to solid-color PNGs');
    return null;
  }
}

/** Initialize the renderer (call once at module start). */
export async function initRenderer(): Promise<void> {
  await loadResvg();
}

export function isResvgLoaded(): boolean {
  return Resvg !== null;
}

// --- SVG → 196×196 PNG rasterization ---

function svgToPng(svg144: string): Buffer {
  if (!Resvg) return fallbackSolidPng(20, 20, 25); // dark fallback

  // Wrap 144×144 SVG content into 196×196 viewport with auto-scaling
  const inner = svg144.replace(/<\/?svg[^>]*>/g, '');
  const wrapped = `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="0 0 144 144">${inner}</svg>`;

  try {
    const resvg = new Resvg(wrapped, {
      fitTo: { mode: 'width' as const, value: ICON_SIZE },
      font: FONT_OPTS,
    });
    return Buffer.from(resvg.render().asPng());
  } catch (err) {
    debug(TAG, `SVG rasterization failed: ${err}`);
    return fallbackSolidPng(20, 20, 25);
  }
}

/** Rasterize custom-sized SVG (e.g. 288×144 → 392×196 for merged slot). */
function svgToPngWide(svg: string, width: number, height: number): Buffer {
  if (!Resvg) return fallbackSolidPng(20, 20, 25);

  try {
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width' as const, value: width },
      font: FONT_OPTS,
    });
    return Buffer.from(resvg.render().asPng());
  } catch (err) {
    debug(TAG, `Wide SVG rasterization failed: ${err}`);
    return fallbackSolidPng(20, 20, 25);
  }
}

// --- ZIP creation (reused from original, with boundary validation) ---

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}

function normalizeExtraLength(length: number): number {
  if (length <= 0) return 0;
  return Math.max(4, length);
}

function makeZipExtraField(length: number): Buffer {
  const normalized = normalizeExtraLength(length);
  if (normalized === 0) return Buffer.alloc(0);
  const extra = Buffer.alloc(normalized, 0x41);
  extra.writeUInt16LE(0x4141, 0);
  extra.writeUInt16LE(Math.max(0, normalized - 4), 2);
  return extra;
}

function firstInvalidZipBoundaryOffset(zipData: Buffer): number | null {
  for (let i = 1016; i < zipData.length; i += 1024) {
    if (zipData[i] === 0x00 || zipData[i] === 0x7c) return i;
  }
  return null;
}

interface ZipLayoutEntry { extraInsertOffset: number; }
interface ZipBuildArtifact { zip: Buffer; layouts: ZipLayoutEntry[]; }

function createZipInMemory(files: Map<string, Buffer>, extraLengths: number[] = []): ZipBuildArtifact {
  const centralDir: Buffer[] = [];
  const localParts: Buffer[] = [];
  const layouts: ZipLayoutEntry[] = [];
  let offset = 0;
  let index = 0;

  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, 'utf-8');
    const crc = crc32(data);
    const extraLen = normalizeExtraLength(extraLengths[index] ?? 0);
    const extra = makeZipExtraField(extraLen);

    const localExtraOffset = offset + 30 + nameBytes.length;
    const local = Buffer.alloc(30 + nameBytes.length + extra.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(extra.length, 28);
    nameBytes.copy(local, 30);
    extra.copy(local, 30 + nameBytes.length);

    const central = Buffer.alloc(46 + nameBytes.length + extra.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    extra.copy(central, 46 + nameBytes.length);

    localParts.push(local, data);
    centralDir.push(central);
    layouts.push({ extraInsertOffset: localExtraOffset });
    offset += local.length + data.length;
    index += 1;
  }

  const centralDirData = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.size, 8);
  eocd.writeUInt16LE(files.size, 10);
  eocd.writeUInt32LE(centralDirData.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return { zip: Buffer.concat([...localParts, centralDirData, eocd]), layouts };
}

// --- Fallback solid-color PNG (when resvg-js unavailable) ---

function fallbackSolidPng(r: number, g: number, b: number): Buffer {
  const w = ICON_SIZE, h = ICON_SIZE;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  const rowLen = 1 + w * 3;
  const raw = Buffer.alloc(rowLen * h);
  for (let y = 0; y < h; y++) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      const px = off + 1 + x * 3;
      raw[px] = r; raw[px + 1] = g; raw[px + 2] = b;
    }
  }

  const compressed = deflateSync(raw);
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  function pngChunk(type: string, data: Buffer): Buffer {
    const typeBytes = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcData = Buffer.concat([typeBytes, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcData), 0);
    return Buffer.concat([len, typeBytes, data, crc]);
  }

  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', compressed), pngChunk('IEND', Buffer.alloc(0))]);
}

// --- Public API ---

/**
 * Render the full AgentDeck dashboard as a ZIP ready for SET_BUTTONS.
 * Uses shared SVG renderers → resvg rasterization for SD+-quality output.
 */
export function renderDashboardZip(stateEvt: any): Buffer {
  const state = parseState(stateEvt);
  const layout = computeLayout(state);

  const manifest: Record<string, any> = {};
  const files = new Map<string, Buffer>();

  for (let i = 0; i < layout.length; i++) {
    const slot = layout[i];
    const iconPath = `icons/btn${i}.png`;
    const colRow = `${slot.col}_${slot.row}`;

    const png = svgToPng(slot.svg);
    files.set(iconPath, png);

    manifest[colRow] = {
      State: 0,
      ViewParam: [{ Text: slot.label, Icon: iconPath }],
    };
  }

  // Merged hardware slot (3_2) — 392×196 PNG with StreamDeck-style usage display
  // No Action = device firmware clock overlay suppressed (solves clock overlap)
  const wideUsageSvg = renderUsageWideSlot(state.fiveHourPercent, state.sevenDayPercent, state.usageKnown !== false);
  const wideUsagePng = svgToPngWide(wideUsageSvg, 392, 196);
  files.set('icons/usage-wide.png', wideUsagePng);
  manifest['3_2'] = {
    State: 0,
    ViewParam: [{ Icon: 'icons/usage-wide.png', Text: '' }],
  };

  files.set('manifest.json', Buffer.from(JSON.stringify(manifest), 'utf-8'));

  // Build ZIP with boundary validation
  const orderedEntries = [...files.entries()];
  const extraLengths = new Array<number>(orderedEntries.length).fill(0);

  for (let attempt = 0; attempt < 256; attempt++) {
    const artifact = createZipInMemory(new Map(orderedEntries), extraLengths);
    const invalidOffset = firstInvalidZipBoundaryOffset(artifact.zip);
    if (invalidOffset == null) return artifact.zip;

    let targetIndex = -1;
    for (let i = artifact.layouts.length - 1; i >= 0; i--) {
      if (artifact.layouts[i].extraInsertOffset <= invalidOffset) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex < 0) return artifact.zip;

    const currentExtra = extraLengths[targetIndex];
    const extraInsertOffset = artifact.layouts[targetIndex].extraInsertOffset;
    let shift = 1;
    while (shift <= 512) {
      if (invalidOffset < extraInsertOffset + currentExtra + shift) break;
      const candidate = artifact.zip[invalidOffset - shift];
      if (candidate !== 0x00 && candidate !== 0x7c) break;
      shift += 1;
    }
    extraLengths[targetIndex] = normalizeExtraLength(extraLengths[targetIndex] + shift);
    debug(TAG, `ZIP boundary invalid at ${invalidOffset}, shifting entry ${targetIndex} by ${shift} byte(s)`);
  }

  const fallback = createZipInMemory(new Map(orderedEntries), extraLengths).zip;
  debug(TAG, `WARNING: ZIP boundary validation failed after search; stillValid=${validateZipBoundaries(fallback)}`);
  return fallback;
}

/**
 * Create a simple hash of the visual state for change detection.
 */
export function stateHash(stateEvt: any): string {
  const s = parseState(stateEvt);
  const sessIds = s.allSessions.map(sess => sess.id).join(',');
  return `${s.state}|${s.mode}|${s.projectName}|${s.modelName}|${s.fiveHourPercent}|${s.sevenDayPercent}|${s.totalTokens}|${s.totalCost}|${s.options.map(o => o.label).join(',')}|${s.currentTool}|${sessIds}`;
}
