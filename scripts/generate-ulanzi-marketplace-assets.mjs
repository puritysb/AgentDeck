#!/usr/bin/env node

// Ulanzi Studio Marketplace media, per the asset requirements stated in the
// upload form at https://ugc.ulanzistudio.com (작품 업로드):
//
//   - Cover image  — REQUIRED, 1:1 for plugins (the form advertises 2:1 until it
//                    recognises the main file as a plugin, then flips the rule)
//   - Banner 01    — REQUIRED, 3:2   (detail-page carousel + featured slots)
//   - Banner 02/03 — optional, 3:2
//   - Main file    — .zip, max 50 MB per file
//
// RESOLUTION RULE: every raster source is DOWNscaled, never up. The earlier
// banner-01 composed docs/media/d200h-app.png (964x590) at 1020px — a 1.06x
// upscale that also filled only 53% of the 1920 canvas, so it read as the soft
// one in the carousel. The deck face is now rendered from the canonical
// renderers instead of screenshotted, which removes the ceiling entirely: the
// slots are viewBox SVG, so they rasterise crisp at any size (also DESIGN.md R7
// — real renderer output, never hand-drawn application UI). The device shell
// follows the D200H's physical 5 + 5 + 3 keys and wide clock widget instead of
// presenting the simulator's generic 5x3 grid as hardware.

import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { buildSessionDeck } from '../shared/dist/d200h-layout.js';

const root = resolve(import.meta.dirname, '..');
// One folder per plugin release, named from the version being shipped.
const pluginVersion = JSON.parse(await readFile(resolve(root, 'plugin-ulanzi/package.json'), 'utf8')).version;
const out = resolve(root, `marketplace/ulanzi/${pluginVersion}`);
const media = resolve(root, 'docs/media');
const brand = resolve(root, 'design/brand');

// design/tokens.css — ink-900 canvas, tide-50 type, kelp-300 accent.
const INK_900 = '#0e1f1f';
const INK_800 = '#15302f';
const TIDE_50 = '#f5f3ec';
const KELP_300 = '#6fb6a8';

await mkdir(out, { recursive: true });

const FONT = 'IBM Plex Sans, -apple-system, BlinkMacSystemFont, sans-serif';
const svg = (s) => Buffer.from(s);

/** Ink-tide backdrop with a soft radial lift behind the subject. */
const backdrop = (w, h, cx = 0.5, cy = 0.55, r = 0.72) =>
  svg(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs><radialGradient id="lift" cx="${cx}" cy="${cy}" r="${r}">
      <stop offset="0" stop-color="${INK_800}"/><stop offset="1" stop-color="${INK_900}"/>
    </radialGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#lift)"/>
  </svg>`);

// ---------------------------------------------------------------- deck render
// A representative live deck: one agent working, one waiting on the user, two
// idle, plus the pinned 5H/7D quota gauges on the bottom-left strip. Mirrors the
// fixture shape used by scripts/render-device-previews.mjs.
// Ten sessions fill every key the usage strip leaves free — one page, no MORE
// key — and the set spans all six agents the plugin renders, so the marks row
// below the deck and the deck itself describe the same product.
const SESSIONS = [
  { id: 's01', alive: true, agentType: 'openclaw', state: 'idle', projectName: 'gateway', modelName: 'OPENCLAW' },
  { id: 's02', alive: true, agentType: 'claude-code', state: 'processing', projectName: 'AgentDeck', modelName: 'opus-4' },
  { id: 's03', alive: true, agentType: 'claude-code', state: 'awaiting_permission', projectName: 'shared', modelName: 'opus-4' },
  { id: 's04', alive: true, agentType: 'codex-cli', state: 'processing', projectName: 'bridge', modelName: 'gpt-5-codex' },
  { id: 's05', alive: true, agentType: 'codex-cli', state: 'idle', projectName: 'plugin', modelName: 'gpt-5-codex' },
  { id: 's06', alive: true, agentType: 'opencode', state: 'processing', projectName: 'esp32', modelName: 'opencode' },
  { id: 's07', alive: true, agentType: 'antigravity', state: 'idle', projectName: 'android', modelName: 'gemini' },
  { id: 's08', alive: true, agentType: 'antigravity', state: 'processing', projectName: 'docs', modelName: 'gemini' },
  { id: 's09', alive: true, agentType: 'kiro-cli', state: 'awaiting_option', projectName: 'apple', modelName: 'kiro' },
  { id: 's10', alive: true, agentType: 'kiro-cli', state: 'idle', projectName: 'setup', modelName: 'kiro' },
];

// parseState reads the quota fields off the event ROOT, not a nested `usage`
// object — nesting them silently yielded zero tiles and three blank keys.
const STATE_EVENT = {
  state: 'processing',
  agentType: 'claude-code',
  sessions: SESSIONS,
  allSessions: SESSIONS,
  fiveHourPercent: 46,
  sevenDayPercent: 72,
  fiveHourResetsAt: new Date(Date.UTC(2026, 6, 20, 15, 30)).toISOString(),
  sevenDayResetsAt: new Date(Date.UTC(2026, 6, 22, 9, 0)).toISOString(),
  codexRateLimits: {
    primary: { usedPercent: 38, windowMinutes: 300 },
    secondary: { usedPercent: 64, windowMinutes: 10080 },
  },
};

/**
 * An accurate D200H face as a single PNG, rasterised at `key` px per square
 * slot. The upper rows contain five keys each; the bottom row contains three
 * AgentDeck keys followed by the device-owned wide clock widget.
 * `density` is scaled off the slots' intrinsic 144px viewBox so the vector art
 * is rendered at target size rather than resampled up from 144.
 */
async function deckFace(key, gap, pad) {
  const positions = [];
  for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) positions.push(`${c}_${r}`);
  for (let c = 0; c < 3; c++) positions.push(`${c}_2`);
  const deck = buildSessionDeck(STATE_EVENT, { mode: 'list', showUsage: true, animFrame: 0 }, positions);

  const labelH = Math.round(key * 0.22);
  const W = 5 * key + 4 * gap + 2 * pad;
  const H = labelH + 3 * key + 2 * gap + 2 * pad;
  const density = Math.round(72 * (key / 144));

  const body = svg(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" rx="${Math.round(pad * 0.9)}" fill="#0a1616"
          stroke="${KELP_300}" stroke-opacity="0.22" stroke-width="2"/>
    <text x="${W / 2}" y="${pad + Math.round(labelH * 0.55)}" fill="${TIDE_50}"
          font-family="${FONT}" font-size="${Math.round(key * 0.12)}" font-weight="700"
          letter-spacing="${Math.max(1, Math.round(key * 0.012))}" text-anchor="middle" opacity="0.78">U·STUDIO</text>
  </svg>`);

  const tiles = [];
  for (const [pos, cell] of deck) {
    const [c, r] = pos.split('_').map(Number);
    tiles.push({
      input: await sharp(Buffer.from(cell.svg), { density })
        .resize(key, key)
        .png()
        .toBuffer(),
      left: pad + c * (key + gap),
      top: pad + labelH + r * (key + gap),
    });
  }

  const clockW = 2 * key + gap;
  const clock = svg(`<svg width="${clockW}" height="${key}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${clockW}" height="${key}" rx="${Math.round(key * 0.09)}" fill="#050909"
          stroke="#334746" stroke-width="${Math.max(2, Math.round(key * 0.012))}"/>
    <text x="${clockW * 0.47}" y="${key * 0.66}" fill="${TIDE_50}" font-family="${FONT}"
          font-size="${Math.round(key * 0.42)}" font-weight="500" text-anchor="middle">02:12</text>
    <text x="${clockW * 0.83}" y="${key * 0.66}" fill="${TIDE_50}" font-family="${FONT}"
          font-size="${Math.round(key * 0.12)}" font-weight="600">PM</text>
  </svg>`);
  tiles.push({
    input: clock,
    left: pad + 3 * (key + gap),
    top: pad + labelH + 2 * (key + gap),
  });
  return { buf: await sharp(body).composite(tiles).png().toBuffer(), W, H };
}

/**
 * Upstream agent marks (DESIGN.md R6 — never redrawn, only recoloured).
 * Every mark paints with `fill="currentColor"`, which resolves to BLACK when the
 * SVG is rasterised standalone — invisible on the ink canvas. Setting `color` on
 * the root element is the intended way to tint them; opencode's own #3a3a3a
 * would be just as invisible here, so the row is monochrome tide instead.
 */
async function agentMarks(size, gap) {
  const names = ['claudecode', 'codex', 'opencode', 'openclaw', 'kiro', 'antigravity'];
  const marks = [];
  for (const n of names) {
    const raw = await readFile(resolve(brand, `${n}.svg`), 'utf8');
    const tinted = raw.replace(/<svg\b/, `<svg color="${TIDE_50}"`);
    marks.push(await sharp(Buffer.from(tinted), { density: 300 })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer());
  }
  const W = names.length * size + (names.length - 1) * gap;
  const row = await sharp({ create: { width: W, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(marks.map((input, i) => ({ input, left: i * (size + gap), top: 0 })))
    .png().toBuffer();
  return { buf: row, W, H: size };
}

// ------------------------------------------------------- cover square (1:1)
// Composed from three canonical sources rather than one photo: the brand mark,
// a live deck face straight out of the renderers, and the upstream agent marks.
{
  const S = 1024;
  const deck = await deckFace(132, 10, 24);
  const marks = await agentMarks(46, 44);
  const deckX = Math.round((S - deck.W) / 2);
  const deckY = 366;

  const icon = await sharp(resolve(brand, 'agentdeck-icon.png')).resize(112, 112).png().toBuffer();

  const text = svg(`<svg width="${S}" height="${S}" xmlns="http://www.w3.org/2000/svg">
    <text x="${S / 2}" y="256" fill="${TIDE_50}" font-family="${FONT}" font-size="82" font-weight="700" text-anchor="middle">AgentDeck</text>
    <text x="${S / 2}" y="312" fill="${KELP_300}" font-family="${FONT}" font-size="30" font-weight="500" text-anchor="middle">Stop Chatting. Start Steering.</text>
  </svg>`);

  await sharp(backdrop(S, S, 0.5, 0.58, 0.75))
    .composite([
      { input: icon, left: Math.round((S - 112) / 2), top: 78 },
      { input: text },
      { input: deck.buf, left: deckX, top: deckY },
      { input: marks.buf, left: Math.round((S - marks.W) / 2), top: deckY + deck.H + 42 },
    ])
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(resolve(out, 'cover-1024x1024.jpg'));
  console.log(`cover     deck ${deck.W}x${deck.H} @132px/key (vector, no upscale)`);
}

// ------------------------------------------------------------ banner 01 (3:2)
// The deck face at full size — the asset that used to be a 964px screenshot.
{
  const W = 1920;
  const H = 1280;
  const deck = await deckFace(250, 15, 36);
  const dx = Math.round((W - deck.W) / 2);
  const dy = 284;

  const text = svg(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <text x="${W / 2}" y="168" fill="${TIDE_50}" font-family="${FONT}" font-size="76" font-weight="700" text-anchor="middle">Your agents, on the D200H</text>
    <text x="${W / 2}" y="238" fill="${KELP_300}" font-family="${FONT}" font-size="35" font-weight="500" text-anchor="middle">Live session keys that reflow by agent state</text>
    <text x="${W / 2}" y="${dy + deck.H + 58}" fill="${TIDE_50}" font-family="${FONT}" font-size="27" opacity="0.72" text-anchor="middle">Working · waiting on you · idle — plus 5H and 7D quota gauges</text>
  </svg>`);

  await sharp(backdrop(W, H, 0.5, 0.52, 0.78))
    .composite([{ input: deck.buf, left: dx, top: dy }, { input: text }])
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(resolve(out, 'banner-01-1920x1280.jpg'));
  console.log(`banner-01 deck ${deck.W}x${deck.H} @250px/key = ${Math.round((deck.W / W) * 100)}% of canvas width`);
}

// ------------------------------------------------------------ banner 02 (3:2)
// The one asset that proves this is a real device doing real work — so it stays
// a photograph. What changed for 1.0.4 is WHICH part of the photograph: the
// published banner framed the whole face, and nine of the fourteen keys were
// unassigned on the day of the shoot, so the storefront's hardware shot read as
// a mostly-dark deck with visible lint on the empty keys. The lit top row is the
// same photograph with nothing invented — five live session keys and the
// device's own wordmark — so it is cropped to that band and set on the ink
// canvas, which also leaves the type on a surface it can actually be read on.
// Tone is corrected (the shoot was under warm room light at 01:26), never
// composited: no key content here comes from a renderer.
{
  const W = 1920;
  const H = 1280;
  const bandW = 1768;

  const band = await sharp(resolve(media, 'd200h-hero.jpg'))
    .extract({ left: 520, top: 400, width: 3060, height: 748 })
    .resize(bandW, null)
    // Lift contrast and colour rather than exposure: the shoot was under warm
    // room light at 01:26, and a brightness lift on a dark, noisy frame raises
    // the sensor grain with it — which is what made the deck body read grey.
    .modulate({ brightness: 1.03, saturation: 1.14 })
    .linear(1.2, -20)
    .sharpen()
    .png()
    .toBuffer();
  const bandH = (await sharp(band).metadata()).height;
  const bx = Math.round((W - bandW) / 2);
  const by = 452;

  // Feather the cut edges so the band reads as a framed detail, not a torn crop.
  const feather = svg(`<svg width="${bandW}" height="${bandH}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="fx" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="${INK_900}" stop-opacity="0.95"/>
        <stop offset="0.06" stop-color="${INK_900}" stop-opacity="0"/>
        <stop offset="0.94" stop-color="${INK_900}" stop-opacity="0"/>
        <stop offset="1" stop-color="${INK_900}" stop-opacity="0.95"/>
      </linearGradient>
      <linearGradient id="fy" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${INK_900}" stop-opacity="0.9"/>
        <stop offset="0.14" stop-color="${INK_900}" stop-opacity="0"/>
        <stop offset="0.86" stop-color="${INK_900}" stop-opacity="0"/>
        <stop offset="1" stop-color="${INK_900}" stop-opacity="0.9"/>
      </linearGradient>
    </defs>
    <rect width="${bandW}" height="${bandH}" fill="url(#fx)"/>
    <rect width="${bandW}" height="${bandH}" fill="url(#fy)"/>
  </svg>`);

  const text = svg(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <text x="${W / 2}" y="196" fill="${TIDE_50}" font-family="${FONT}" font-size="86" font-weight="700" text-anchor="middle">On your desk, not in a tab</text>
    <text x="${W / 2}" y="272" fill="${KELP_300}" font-family="${FONT}" font-size="37" font-weight="500" text-anchor="middle">A real D200H, mid-session — photographed, not mocked up</text>
    <text x="${W / 2}" y="${by + bandH + 92}" fill="${TIDE_50}" font-family="${FONT}" font-size="32" opacity="0.78" text-anchor="middle">Each key names its project and shows what that agent is doing right now</text>
    <text x="${W / 2}" y="${by + bandH + 168}" fill="${KELP_300}" font-family="${FONT}" font-size="28" font-weight="500" opacity="0.85" text-anchor="middle">Ulanzi Studio plugin · macOS &amp; Windows · connects to the AgentDeck daemon on your computer</text>
  </svg>`);

  await sharp(backdrop(W, H, 0.5, 0.46, 0.8))
    .composite([
      { input: await sharp(band).composite([{ input: feather }]).png().toBuffer(), left: bx, top: by },
      { input: text },
    ])
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(resolve(out, 'banner-02-1920x1280.jpg'));
  console.log(`banner-02 photo band 3060x800 -> ${bandW}x${bandH} (0.56x downscale), tone-corrected, no composite`);
}

// ------------------------------------------------------------ banner 03 (3:2)
// Fills the previously-empty optional slot, and answers the question the other
// two raise: where does the deck get its data? macos-dashboard.png is 2362x1430,
// so it lands as a downscale at the 1560px placement.
//
// PRIVACY: the capture's bottom quarter is the live TIMELINE pane, and at this
// placement its rows are legible — real project chatter from the machine the
// screenshot was taken on. The source already ships on GitHub Pages, but a
// storefront banner renders it far larger, so crop above the timeline and fade
// the cut. What remains (terrarium, session list, TANK STATUS quota gauges) is
// the part that actually sells the deck anyway.
{
  const W = 1920;
  const H = 1280;
  const aw = 1680;
  const CROP_H = 1010; // of 1430 — stops just above the timeline pane

  const cropped = await sharp(resolve(media, 'macos-dashboard.png'))
    .extract({ left: 0, top: 0, width: 2362, height: CROP_H })
    .resize(aw, null)
    .png()
    .toBuffer();
  const ah = (await sharp(cropped).metadata()).height;
  const ax = Math.round((W - aw) / 2);
  const ay = 404;

  // Soften the crop edge so it reads as a deliberate vignette, not a truncation.
  const fade = svg(`<svg width="${aw}" height="${ah}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="f" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="${INK_900}" stop-opacity="1"/>
      <stop offset="0.16" stop-color="${INK_900}" stop-opacity="0"/>
    </linearGradient></defs>
    <rect width="${aw}" height="${ah}" fill="url(#f)"/>
  </svg>`);

  const text = svg(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <text x="${W / 2}" y="168" fill="${TIDE_50}" font-family="${FONT}" font-size="76" font-weight="700" text-anchor="middle">One local daemon, every surface</text>
    <text x="${W / 2}" y="238" fill="${KELP_300}" font-family="${FONT}" font-size="35" font-weight="500" text-anchor="middle">The Ulanzi Studio plugin connects locally to AgentDeck</text>
    <text x="${W / 2}" y="308" fill="${TIDE_50}" font-family="${FONT}" font-size="27" opacity="0.72" text-anchor="middle">macOS &amp; Windows · local connection · no analytics</text>
  </svg>`);

  await sharp(backdrop(W, H, 0.5, 0.5, 0.8))
    .composite([
      { input: await sharp(cropped).composite([{ input: fade }]).png().toBuffer(), left: ax, top: ay },
      { input: text },
    ])
    .jpeg({ quality: 92, mozjpeg: true })
    .toFile(resolve(out, 'banner-03-1920x1280.jpg'));
  console.log(`banner-03 app 2362x${CROP_H} (timeline cropped) -> ${aw} (${(aw / 2362).toFixed(2)}x downscale), ${ah}px tall`);
}

console.log(`\nGenerated Ulanzi Marketplace media in ${out}`);
