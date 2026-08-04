#!/usr/bin/env node
// Renders the creature-simulator demo's ESP32 panels from the esp32/sim host
// simulator — real firmware render surfaces compiled to native, so every frame
// is pixel-exact with the physical board (see esp32/sim/README.md). The demo
// page consumes these PNGs instead of hand-drawn SVG approximations.
//
// Output: tools/creature-simulator/sim-frames/<board>-<agent>-<state>[-<page>].png
//         plus manifest.json listing every emitted frame (the demo probes this
//         to decide real-frame vs hatch-placeholder rendering).
//
// Requires PlatformIO (`pio`). When pio is unavailable the script warns and
// exits 0 so `demo:build` still succeeds — the demo then shows the design
// system's hatch placeholder for these panels (DESIGN.md §10 rule 7).

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

// The sim's self-contained PNG writer emits stored (uncompressed) DEFLATE
// blocks — fine for local golden tests, far too big for the Pages demo
// (1280×800 ≈ 3 MB each). Re-deflate the IDAT stream at max level; pixel-art
// frames compress 50–100×. Chunk-level rewrite only — pixels are untouched.
function recompressPng(file) {
  const buf = fs.readFileSync(file);
  let off = 8;
  const head = [];
  const idat = [];
  const tail = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const chunk = buf.subarray(off, off + 12 + len);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    else (idat.length ? tail : head).push(chunk);
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const data = zlib.deflateSync(raw, { level: 9 });
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write('IDAT', 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(zlib.crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  fs.writeFileSync(file, Buffer.concat([buf.subarray(0, 8), ...head, out, ...tail]));
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const simDir = path.resolve(__dirname, '../esp32/sim');
const outDir = path.resolve(__dirname, '../tools/creature-simulator/sim-frames');

const AGENTS = ['claude', 'codex', 'opencode', 'openclaw', 'antigravity'];
const STATES = ['idle', 'working', 'asking', 'sleeping'];

// env name → demo board slug. LCD envs render the composed LVGL screen (the
// terrarium boards plus the two companion render trees — t_embed's knob and
// t_display_pro's focus strip); the led8x32 env renders the TC001 pages at
// native 32×8 (the demo draws its own LED dots from the pixels); inkdeck
// renders the 1-bit e-ink dashboard.
const BOARDS = [
  { env: 'box_86', slug: 'box86' },
  { env: 'ips35', slug: 'ips35' },
  { env: 'amoled', slug: 'round' },
  { env: 'ttgo', slug: 'ttgo' },
  { env: 'ips10', slug: 'ips10' },
  { env: 't_embed', slug: 'tembed' },
  { env: 't_display_pro', slug: 'tdisplaypro' },
  { env: 'inkdeck', slug: 'inkdeck' },
  { env: 'led8x32', slug: 'tc001', pages: ['usage', 'agents'], extraArgs: ['--scale', '1'] },
];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const pioCheck = spawnSync('pio', ['--version'], { stdio: 'ignore' });
if (pioCheck.error || pioCheck.status !== 0) {
  // Empty manifest → the demo shows hatch placeholders instead of stale frames.
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ frames: [] }));
  console.warn('[esp32-sim-frames] PlatformIO (pio) not found — skipping. Demo ESP32 panels will show hatch placeholders.');
  process.exit(0);
}

// Per-board isolation: one board failing to build/render must not take down
// the whole demo (Pages) build — its panels degrade to the hatch placeholder
// via the manifest, and the warning below makes the gap loud in CI logs.
const frames = [];
let failedBoards = 0;
for (const board of BOARDS) {
  try {
    console.log(`[esp32-sim-frames] building ${board.env}…`);
    execFileSync('pio', ['run', '-e', board.env], { cwd: simDir, stdio: ['ignore', 'ignore', 'inherit'] });
    const program = path.join(simDir, '.pio/build', board.env, 'program');
    const boardFrames = [];
    for (const agent of AGENTS) {
      for (const state of STATES) {
        const scene = `demo:${agent}:${state}`;
        for (const page of board.pages ?? [null]) {
          const name = page
            ? `${board.slug}-${agent}-${state}-${page}.png`
            : `${board.slug}-${agent}-${state}.png`;
          const args = ['--scene', scene, '--out', path.join(outDir, name), ...(board.extraArgs ?? [])];
          if (page) args.push('--page', page);
          execFileSync(program, args, { cwd: simDir, stdio: ['ignore', 'ignore', 'pipe'] });
          recompressPng(path.join(outDir, name));
          boardFrames.push(name);
        }
      }
    }
    frames.push(...boardFrames);
    console.log(`[esp32-sim-frames] ${board.env}: ${boardFrames.length} frames`);
  } catch (err) {
    failedBoards++;
    console.warn(`[esp32-sim-frames] WARNING: ${board.env} failed (${err.message}) — its demo panels will show hatch placeholders.`);
  }
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({ frames }, null, 0));
console.log(`[esp32-sim-frames] ${frames.length} frames → ${outDir}${failedBoards ? ` (${failedBoards} board(s) FAILED)` : ''}`);
