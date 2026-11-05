/**
 * SVG → PNG rasterization for Ulanzi key icons.
 *
 * WASM, not native. resvg ships two builds of one Rust core: `@resvg/resvg-js`
 * (a per-platform `.node` binary) and `@resvg/resvg-wasm`. We shipped the native
 * one until 1.0.4, which meant five unsigned `.node` files in the Marketplace
 * bundle — 18.5 MB of a 20 MB plugin — and macOS Gatekeeper raising "Apple could
 * not verify this file" on Apple Silicon for `resvgjs.darwin-arm64.node`
 * (reported by the Ulanzi Studio team, 2026-08-25). A loose native module inside
 * a folder Studio downloads and unpacks has no owner who can sign it: we do not
 * build Studio, and Studio does not build our dependency. The WASM build removes
 * the question rather than answering it — no per-architecture artifacts, nothing
 * for Gatekeeper to adjudicate, one file for every OS in the manifest.
 *
 * It is the SAME resvg version (2.6.2, pinned in lockstep), so this is not a
 * renderer swap: measured over our own tiles at both raster sizes, native and
 * WASM produce BYTE-IDENTICAL RGBA and PNG output, feGaussianBlur included. The
 * cost is ~3.6-3.9x per uncached render (2.2ms → 7.9ms at 144, 3.1ms → 12.0ms at
 * 196, plus 15.6ms once at init) which sits behind `pngCache` and is far under
 * the Studio→device link's own budget.
 *
 * Fonts are EXPLICIT bundled buffers, never the OS font tree — same rule as
 * before (`fontFiles` → `fontBuffers`; the WASM build cannot reach the
 * filesystem, so buffers are the only form it takes). `defaultFontFamily` makes
 * the shared renderers' `Inter`/`Arial`/`monospace` families fall back to a
 * design face instead of dropping all <text>.
 *
 * Ulanzi Studio scales the icon to the key, so we render a fixed square.
 */
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { derr, dinfo } from './log.js';

export const ICON_SIZE = 196;

/**
 * Animated tiles rasterize at the renderers' native 144 canvas instead of
 * ICON_SIZE. A GIF carries every frame, so its pixel count is multiplied by the
 * frame count and it is the only payload big enough to congest the Studio→device
 * link; 144 is 1:1 with the SVG viewBox (no upsampling, so no real detail is
 * lost — the plugin's own action icons ship at 96) and cuts an awaiting tile from
 * 73 KB to 47 KB. The brief sharpness difference while a cache-miss key shows its
 * static PNG before the GIF lands is the trade.
 */
export const GIF_ICON_SIZE = 144;

/** `<plugin>/plugin/*.js` → resources at `<plugin>/resources`. */
function resourceDirs(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [join(here, '..', 'resources'), join(here, '..', '..', 'resources'),
    join(here, '..', 'com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin', 'resources')];
}

const FONT_FILES = [
  'IBMPlexSans-Regular.ttf',
  'IBMPlexSans-Bold.ttf',
  'JetBrainsMono-Regular.ttf',
  'JetBrainsMono-Bold.ttf',
  'IBMPlexSansKR-Regular.ttf',
  'IBMPlexSansKR-Bold.ttf',
];

const FONT_OPTS: { fontBuffers: Uint8Array[]; loadSystemFonts: boolean; defaultFontFamily: string } =
  (() => {
    try {
      for (const dir of resourceDirs()) {
        const buffers = FONT_FILES.map((n) => join(dir, 'fonts', n))
          .filter((p) => existsSync(p))
          .map((p) => new Uint8Array(readFileSync(p)));
        if (buffers.length > 0) {
          return { fontBuffers: buffers, loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' };
        }
      }
    } catch {
      /* fall through */
    }
    // No system-font fallback exists here, unlike the native build: the WASM
    // module has no filesystem. Every <text> would drop, so say so once rather
    // than shipping silently blank tiles — the packaging script's verify step
    // refuses to build a bundle without these files for the same reason.
    derr('raster', 'bundled fonts not found — text will not render');
    return { fontBuffers: [], loadSystemFonts: false, defaultFontFamily: 'IBM Plex Sans' };
  })();

/** Locate `resvg.wasm`: packaged next to the fonts, else the dev node_modules copy. */
function wasmPath(): string | null {
  for (const dir of resourceDirs()) {
    const p = join(dir, 'resvg.wasm');
    if (existsSync(p)) return p;
  }
  try {
    return createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm');
  } catch {
    return null;
  }
}

let ready: Promise<void> | null = null;
let initialized = false;
/** Rasters that fell back to the blank tile since load — the app's repaint trigger. */
let failures = 0;

function readBundledWasm(): Uint8Array {
  const path = wasmPath();
  if (!path) throw new Error('resvg.wasm not found');
  return readFileSync(path);
}

/**
 * Load the WASM module. MUST be awaited before the first raster — `initWasm` is
 * async and may be called only once, so the promise is memoized rather than the
 * boolean checked (two concurrent callers would otherwise both call it and the
 * second would throw "Already initialized").
 *
 * A FAILED load is not memoized (#730). It used to resolve the shared promise
 * with `initialized` still false, so the service ran on with every tile blank
 * and nothing ever tried again. Now the next call retries; `rasterReady()` says
 * whether one has succeeded. "Already initialized" means an earlier load did
 * succeed in this process, so it counts as ready.
 */
export function initRaster(loadWasm: () => Uint8Array = readBundledWasm): Promise<void> {
  if (initialized) return Promise.resolve();
  if (!ready) {
    const attempt = (async () => {
      try {
        await initWasm(loadWasm());
        initialized = true;
        dinfo('raster', 'resvg wasm ready');
      } catch (err) {
        if (/already initialized/i.test(String(err))) {
          initialized = true;
          return;
        }
        derr('raster', `initWasm failed: ${err} — key images stay blank until a retry succeeds`);
      }
    })();
    ready = attempt;
    // Registered before any caller's continuation, so a caller that awaited a
    // failed attempt already sees the slot cleared when it retries.
    void attempt.then(() => { if (!initialized && ready === attempt) ready = null; });
  }
  return ready;
}

/** True once the WASM module has loaded; until then every raster is the blank tile. */
export function rasterReady(): boolean {
  return initialized;
}

/** Rasters that produced the blank fallback tile since load. */
export function rasterFailureCount(): number {
  return failures;
}

/** 1×1 transparent PNG — the tile a failed raster falls back to. */
const BLANK_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function wrap(svg144: string, size: number): string {
  const inner = svg144.replace(/<\/?svg[^>]*>/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 144 144">${inner}</svg>`;
}

/** Render to PNG, or null when resvg is not loaded or the SVG fails. */
function renderPng(svg144: string, size: number): Buffer | null {
  try {
    if (!initialized) throw new Error('resvg wasm not initialized');
    const resvg = new Resvg(wrap(svg144, size), {
      fitTo: { mode: 'width', value: size },
      font: FONT_OPTS,
    });
    return Buffer.from(resvg.render().asPng());
  } catch (err) {
    failures++;
    derr('raster', `svgToPng failed: ${err}`);
    return null;
  }
}

/** Rasterize a 144×144 shared-renderer SVG into a square PNG Buffer (blank on failure). */
export function svgToPng(svg144: string, size = ICON_SIZE): Buffer {
  return renderPng(svg144, size) ?? Buffer.from(BLANK_PNG, 'base64');
}

// Cache rasterized PNGs by SVG so toggling list↔detail (and recurring session
// tiles) doesn't re-run resvg every time — resvg raster is the per-render cost.
const pngCache = new Map<string, string>();
const PNG_CACHE_MAX = 256;

/** Rasterize to base64 (no `data:` prefix) for `setBaseDataIcon`, cached by SVG. */
export function svgToBase64Png(svg144: string, size = ICON_SIZE): string {
  const key = `${size}|${svg144}`;
  const hit = pngCache.get(key);
  if (hit !== undefined) return hit;
  const png = renderPng(svg144, size);
  // A failure placeholder is never cached as this SVG's image (#730): the next
  // render of the same tile must try again rather than serve a blank forever.
  if (!png) return BLANK_PNG;
  const b64 = png.toString('base64');
  if (pngCache.size >= PNG_CACHE_MAX) {
    // Evict oldest (Map preserves insertion order).
    const first = pngCache.keys().next().value;
    if (first !== undefined) pngCache.delete(first);
  }
  pngCache.set(key, b64);
  return b64;
}

export interface RgbaImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Rasterize a 144×144 SVG to raw RGBA pixels (for the GIF encoder). */
export function svgToRgba(svg144: string, size = ICON_SIZE): RgbaImage {
  if (!initialized) throw new Error('resvg wasm not initialized');
  const resvg = new Resvg(wrap(svg144, size), {
    fitTo: { mode: 'width', value: size },
    font: FONT_OPTS,
  });
  const rendered = resvg.render();
  return {
    data: new Uint8Array(rendered.pixels),
    width: rendered.width,
    height: rendered.height,
  };
}
