#!/usr/bin/env node
// Static device-preview baker for the public Devices catalog (/hardware/).
//
// Emits one representative frame per renderer-driven surface as a
// self-contained SVG under tools/creature-simulator/previews/, copied into
// dist/demo/previews/ by `pnpm demo:build`. The catalog page references them
// with <img onerror> hatch fallback, so a missing or failed preview degrades
// to the design-system placeholder instead of breaking the page.
//
// Fidelity rule (DESIGN.md R7): everything here comes from the canonical
// renderers — the same renderFrame / renderSessionSlot the devices use.
// Fixtures mirror scripts/render-creature-simulator.mjs (claude/working).
// ESP32 boards are NOT rendered here: their previews are the pixel-exact
// firmware frames from scripts/render-esp32-sim-frames.mjs. App surfaces use
// real screenshots from assets/ and docs/media/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFrame, resetDirector } from '../bridge/dist/pixoo/pixoo-renderer.js';
import { renderSessionSlot } from '../shared/dist/svg-renderers/session-slot-renderer.js';
import { renderUsageWideSlot } from '../shared/dist/d200h-layout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(__dirname, '../tools/creature-simulator/previews');
fs.mkdirSync(outDir, { recursive: true });

const NOW = Date.UTC(2026, 2, 28, 12, 0, 0);

function buildSessions() {
  return [
    { id: 's-claude', alive: true, agentType: 'claude-code', state: 'processing', projectName: 'Claude', modelName: 'opus-4' },
    { id: 's-codex', alive: true, agentType: 'codex-cli', state: 'idle', projectName: 'Codex', modelName: 'gpt-5-codex' },
    { id: 's-open', alive: true, agentType: 'opencode', state: 'idle', projectName: 'OpenCode', modelName: 'opencode' },
    { id: 's-claw', alive: true, agentType: 'openclaw', state: 'idle', projectName: 'OpenClaw', modelName: 'OPENCLAW' },
    { id: 's-antigravity', alive: true, agentType: 'antigravity', state: 'idle', projectName: 'Antigravity', modelName: 'gemini' },
    { id: 's-kiro', alive: true, agentType: 'kiro-cli', state: 'idle', projectName: 'Kiro', modelName: 'auto' },
  ];
}

function buildUsage() {
  const now = Date.now();
  return {
    fiveHourPercent: 46,
    sevenDayPercent: 72,
    fiveHourResetsAt: new Date(now + 1000 * 60 * 90).toISOString(),
    sevenDayResetsAt: new Date(now + 1000 * 60 * 60 * 28).toISOString(),
    codexRateLimits: {
      primary: { usedPercent: 38, windowMinutes: 300, resetsAt: new Date(now + 1000 * 60 * 150).toISOString() },
      secondary: { usedPercent: 64, windowMinutes: 10080, resetsAt: new Date(now + 1000 * 60 * 60 * 52).toISOString() },
    },
  };
}

const STATE_EVENT = { state: 'processing', agentType: 'claude-code', gatewayAvailable: true, gatewayHasError: false };

// RGB frame buffer → crisp pixel-grid SVG. Skips near-black pixels so the SVG
// stays small; the page supplies the dark backing via the frame background.
function pixelsToSvg(frame, size) {
  const bytesPerPixel = frame.length === size * size * 4 ? 4 : 3;
  const rects = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * bytesPerPixel;
      const r = frame[i], g = frame[i + 1], b = frame[i + 2];
      if (r < 8 && g < 8 && b < 8) continue;
      rects.push(`<rect x="${x}" y="${y}" width="1" height="1" fill="rgb(${r},${g},${b})"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#000"/>${rects.join('')}</svg>`;
}

function bake(name, fn) {
  try {
    const svg = fn();
    fs.writeFileSync(path.join(outDir, `${name}.svg`), svg);
    console.log(`[device-previews] ${name}.svg`);
  } catch (error) {
    // Per-item tolerance: the catalog card falls back to the hatch placeholder.
    console.warn(`[device-previews] WARNING: ${name} failed (${error.message}) — card will show the hatch placeholder.`);
  }
}

function matrixPreview(size, layout) {
  resetDirector();
  const frame = renderFrame(STATE_EVENT, buildUsage(), buildSessions(), NOW, size, layout);
  return pixelsToSvg(frame, size);
}

bake('pixoo64', () => matrixPreview(64, 'standard'));
bake('idotmatrix', () => matrixPreview(32, 'standard'));
bake('timebox', () => matrixPreview(11, 'micro'));
bake('streamdeck-key', () => renderSessionSlot(buildSessions()[0], true, 36, 'Claude'));
bake('d200h-usage', () => {
  const usage = buildUsage();
  return renderUsageWideSlot(usage.fiveHourPercent, usage.sevenDayPercent, true);
});

console.log(`[device-previews] done → ${outDir}`);
