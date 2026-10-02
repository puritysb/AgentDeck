#!/usr/bin/env node
// Hermes 2D mermaid — the terrarium creature for every surface without the 3D
// aquarium (Android 2D/e-ink terrarium, ESP32 LCD terrariums, Pixoo).
//
// The head is the official Nous girl mark (design/brand/hermes.svg), its paths
// unchanged; only its cropped bottom edge is faded so the bust melts into the
// tail. The tail, its shadow rim and the fluke are AgentDeck's adaptation,
// computed here from a centerline and a width profile — never hand-drawn per
// surface. Compact non-terrarium surfaces (deck keys, lists, cards, e-ink
// session rows) keep drawing the plain mark.
//
// Outputs (all generated; run `pnpm generate-hermes-mermaid-2d`, `--check` in CI):
//   assets/terrarium/hermes-mermaid-2d.svg                          canonical render
//   shared/src/svg-renderers/hermes-mermaid-2d.generated.ts          path data (TS)
//   android/.../terrarium/HermesMermaid2D.generated.kt               path data (Kotlin)
//   esp32/src/ui/terrarium/hermes_mermaid_generated.h                layer masks 42×60
//   bridge/src/pixoo/hermes-mermaid.generated.ts                     layer masks 28×40
//   apple/AgentDeck/Daemon/Modules/HermesMermaidSprite.generated.swift  same, Swift
//   apple/AgentDeck/Rendering/HermesMermaid2D.generated.swift        path data (Swift previews)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

// ── geometry SSOT ──────────────────────────────────────────────────────────
const VIEW_W = 28;
const VIEW_H = 40;
/** The mark's crop (y 24) fades out across this band. */
const FADE = [21.6, 24.0];
/** Tail centerline (cubic Bézier), starting behind the bust. */
const CENTERLINE = [[13.6, 19.5], [12.0, 29.5], [16.4, 33.8], [21.0, 33.6]];
/** Full tail width along the centerline: hips → narrowing → peduncle. */
const PROFILE = [[0.0, 10.4], [0.18, 9.4], [0.42, 6.4], [0.66, 4.0], [0.86, 2.5], [1.0, 1.8]];
const FLUKE = { length: 5.2, spreadDeg: 56, bulge: 2.6 };
const SAMPLES = 16;
/** Kelp tokens, read from design/tokens.css: body, shadow rim, fluke. */
const TOKENS = readFileSync(resolve(ROOT, 'design/tokens.css'), 'utf8');
const token = (name) => {
  const m = TOKENS.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`design/tokens.css has no --${name}`);
  return m[1].toLowerCase();
};
const COLORS = { body: token('kelp-500'), rim: token('kelp-700'), fluke: token('kelp-300') };

const f = (n) => Number(n.toFixed(2)).toString();
const bez = (t, [a, b, c, d]) => {
  const u = 1 - t;
  return [0, 1].map((k) => u ** 3 * a[k] + 3 * u * u * t * b[k] + 3 * u * t * t * c[k] + t ** 3 * d[k]);
};
function width(t) {
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const [t0, w0] = PROFILE[i];
    const [t1, w1] = PROFILE[i + 1];
    if (t <= t1) {
      let u = (t - t0) / (t1 - t0);
      u = u * u * (3 - 2 * u);
      return w0 + (w1 - w0) * u;
    }
  }
  return PROFILE.at(-1)[1];
}
/** Closed Catmull-Rom spline through `pts`, as cubic Bézier path data. */
function catmull(pts) {
  const n = pts.length;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + ' Z';
}
function geometry() {
  const L = [], R = [], C = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const p = bez(t, CENTERLINE);
    const q = bez(Math.min(1, t + 0.01), CENTERLINE);
    const r = bez(Math.max(0, t - 0.01), CENTERLINE);
    const tx = q[0] - r[0], ty = q[1] - r[1];
    const l = Math.hypot(tx, ty) || 1;
    const nx = -ty / l, ny = tx / l, w = width(t) / 2;
    L.push([p[0] + nx * w, p[1] + ny * w]);
    R.push([p[0] - nx * w, p[1] - ny * w]);
    C.push({ p, tan: [tx / l, ty / l], n: [nx, ny], w });
  }
  const tail = catmull([...L, ...R.slice().reverse()]);
  const rimInner = C.map(({ p, n, w }) => [p[0] - n[0] * w * 0.35, p[1] - n[1] * w * 0.35]);
  const rim = catmull([...rimInner.slice(3), ...R.slice(3).reverse()]);
  const { p: tip, tan } = C.at(-1);
  const ang = Math.atan2(tan[1], tan[0]);
  let fluke = '';
  for (const s of [-1, 1]) {
    const a = ang + (s * FLUKE.spreadDeg * Math.PI) / 180;
    const end = [tip[0] + Math.cos(a) * FLUKE.length, tip[1] + Math.sin(a) * FLUKE.length];
    const mx = (tip[0] + end[0]) / 2, my = (tip[1] + end[1]) / 2;
    const nx = -Math.sin(a) * s, ny = Math.cos(a) * s;
    const c1 = [mx - nx * FLUKE.bulge, my - ny * FLUKE.bulge];
    const c2 = [mx + nx * FLUKE.bulge * 0.25, my + ny * FLUKE.bulge * 0.25];
    fluke += `M${f(tip[0])} ${f(tip[1])} Q${f(c1[0])} ${f(c1[1])} ${f(end[0])} ${f(end[1])} Q${f(c2[0])} ${f(c2[1])} ${f(tip[0])} ${f(tip[1])} Z `;
  }
  return { tail, rim, fluke: fluke.trim() };
}

function headPaths() {
  const svg = readFileSync(resolve(ROOT, 'design/brand/hermes.svg'), 'utf8');
  const paths = [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map((m) => m[1]);
  if (paths.length !== 3) throw new Error(`expected 3 Nous girl paths, found ${paths.length}`);
  return paths;
}

/** One SVG; `only` limits it to one layer (for the per-layer masks). */
function svgDoc(geo, head, { only = null, headFill = '#ffffff', scale = 1 } = {}) {
  const show = (k) => only === null || only === k;
  const layers = [
    show('tail') ? `<path id="tail" d="${geo.tail}" fill="${only ? '#fff' : COLORS.body}"/>` : '',
    show('rim') ? `<path id="rim" d="${geo.rim}" fill="${only ? '#fff' : COLORS.rim}"/>` : '',
    show('fluke') ? `<path id="fluke" d="${geo.fluke}" fill="${only ? '#fff' : COLORS.fluke}"/>` : '',
    show('head') ? `<g id="head" fill="${only ? '#fff' : headFill}" fill-rule="evenodd" mask="url(#crop)">${head.map((d) => `<path d="${d}"/>`).join('')}</g>` : '',
  ].join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" width="${VIEW_W * scale}" height="${VIEW_H * scale}">`
    + `<defs><linearGradient id="fade" x1="0" y1="0" x2="0" y2="${VIEW_H}" gradientUnits="userSpaceOnUse">`
    + `<stop offset="${(FADE[0] / VIEW_H).toFixed(4)}" stop-color="#fff"/><stop offset="${(FADE[1] / VIEW_H).toFixed(4)}" stop-color="#000"/></linearGradient>`
    + `<mask id="crop" maskUnits="userSpaceOnUse" x="0" y="0" width="${VIEW_W}" height="${VIEW_H}"><rect width="${VIEW_W}" height="${VIEW_H}" fill="url(#fade)"/></mask></defs>`
    + layers + '</svg>';
}

async function layerMask(geo, head, layer, w, h) {
  const { data, info } = await sharp(Buffer.from(svgDoc(geo, head, { only: layer, scale: 16 })))
    .resize(w, h, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = data[i * info.channels + info.channels - 1];
  return out;
}

const LAYERS = ['tail', 'rim', 'fluke', 'head'];
const HEADER = '// GENERATED by scripts/generate-hermes-mermaid-2d.mjs — do not edit.\n';

async function main() {
  const geo = geometry();
  const head = headPaths();
  const outputs = {};

  outputs['assets/terrarium/hermes-mermaid-2d.svg'] = svgDoc(geo, head, { scale: 10 }) + '\n';

  outputs['shared/src/svg-renderers/hermes-mermaid-2d.generated.ts'] = HEADER
    + '// Hermes 2D mermaid: the tail layers drawn under the official Nous girl head\n'
    + '// (HERMES_BRAND_PATHS), whose crop fades out across `fade`.\n'
    + `export const HERMES_MERMAID_2D = {\n  viewBox: [${VIEW_W}, ${VIEW_H}] as const,\n  fade: [${FADE[0]}, ${FADE[1]}] as const,\n`
    + `  colors: ${JSON.stringify(COLORS)} as const,\n  tail: ${JSON.stringify(geo.tail)},\n  rim: ${JSON.stringify(geo.rim)},\n  fluke: ${JSON.stringify(geo.fluke)},\n} as const;\n`;

  outputs['android/app/src/main/kotlin/dev/agentdeck/terrarium/HermesMermaid2D.generated.kt'] = HEADER
    + 'package dev.agentdeck.terrarium\n\n'
    + '/** Hermes 2D mermaid: tail layers under the official Nous girl head\n * ([CreatureGeometry.HERMES_PATH_DATA]), whose crop fades out across FADE. */\n'
    + 'object HermesMermaid2D {\n'
    + `    const val VIEW_W = ${VIEW_W}f\n    const val VIEW_H = ${VIEW_H}f\n    const val FADE_START = ${FADE[0]}f\n    const val FADE_END = ${FADE[1]}f\n`
    + `    const val TAIL = "${geo.tail}"\n    const val RIM = "${geo.rim}"\n    const val FLUKE = "${geo.fluke}"\n}\n`;

  outputs['apple/AgentDeck/Rendering/HermesMermaid2D.generated.swift'] = HEADER
    + '// Hermes 2D mermaid path data — the macOS/iOS device previews draw the same\n'
    + '// terrarium creature as the boards (tail layers under HermesBrandPaths).\n'
    + 'import CoreGraphics\n\n'
    + `enum HermesMermaid2D {\n    static let viewWidth: CGFloat = ${VIEW_W}\n    static let viewHeight: CGFloat = ${VIEW_H}\n`
    + `    static let fadeStart: CGFloat = ${FADE[0]}\n    static let fadeEnd: CGFloat = ${FADE[1]}\n`
    + `    static let tail = "${geo.tail}"\n    static let rim = "${geo.rim}"\n    static let fluke = "${geo.fluke}"\n}\n`;

  const masks = async (w, h) => Object.fromEntries(await Promise.all(LAYERS.map(async (k) => [k, await layerMask(geo, head, k, w, h)])));
  const [MW, MH] = [42, 60];
  const esp = await masks(MW, MH);
  const row = (a, w, y) => Array.from(a.slice(y * w, (y + 1) * w)).join(',');
  outputs['esp32/src/ui/terrarium/hermes_mermaid_generated.h'] = HEADER
    + '// Hermes 2D mermaid layer masks (8-bit alpha), drawn tail → rim → fluke → head.\n#pragma once\n#include <cstdint>\n\nnamespace HermesMermaid {\n'
    + `constexpr int W = ${MW};\nconstexpr int H = ${MH};\n`
    + Object.entries(COLORS).map(([k, v]) => `constexpr uint32_t ${k.toUpperCase()}_COLOR = 0x${v.slice(1).toUpperCase()};  // design/tokens.css\n`).join('')
    + LAYERS.map((k) => `static const uint8_t ${k.toUpperCase()}_A8[W * H] = {\n${Array.from({ length: MH }, (_, y) => '    ' + row(esp[k], MW, y) + ',').join('\n')}\n};`).join('\n')
    + '\n}  // namespace HermesMermaid\n';

  const [PW, PH] = [28, 40];
  const px = await masks(PW, PH);
  outputs['bridge/src/pixoo/hermes-mermaid.generated.ts'] = HEADER
    + '// Hermes 2D mermaid layer masks for dot-matrix terrariums (Pixoo 64).\n'
    + `export const HERMES_MERMAID_W = ${PW};\nexport const HERMES_MERMAID_H = ${PH};\n`
    + `export const HERMES_MERMAID_COLORS = { ${Object.entries(COLORS).map(([k, v]) => `${k}: [${[1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)).join(', ')}] as const`).join(', ')} };\n`
    + 'export const HERMES_MERMAID_LAYERS = {\n'
    + LAYERS.map((k) => `  ${k}: new Uint8Array([${Array.from(px[k]).join(',')}]),`).join('\n') + '\n} as const;\n';
  outputs['apple/AgentDeck/Daemon/Modules/HermesMermaidSprite.generated.swift'] = HEADER
    + '// Hermes 2D mermaid layer masks for dot-matrix terrariums — mirror of\n// bridge/src/pixoo/hermes-mermaid.generated.ts.\n'
    + `enum HermesMermaidSprite {\n    static let width = ${PW}\n    static let height = ${PH}\n`
    + Object.entries(COLORS).map(([k, v]) => `    static let ${k}Color: (Int, Int, Int) = (${[1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)).join(', ')})\n`).join('')
    + LAYERS.map((k) => `    static let ${k}: [UInt8] = [${Array.from(px[k]).join(',')}]`).join('\n') + '\n}\n';

  let stale = 0;
  for (const [rel, content] of Object.entries(outputs)) {
    const abs = resolve(ROOT, rel);
    let current = null;
    try { current = readFileSync(abs, 'utf8'); } catch {}
    if (current === content) continue;
    if (CHECK) { console.error(`stale: ${rel}`); stale++; continue; }
    writeFileSync(abs, content);
    console.log(`wrote ${rel}`);
  }
  if (CHECK && stale) process.exit(1);
}
await main();
