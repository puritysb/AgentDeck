// Elgato Marketplace media, per https://docs.elgato.com/guidelines/products/
//
//   - App icon   — 288x288 PNG
//   - Thumbnail  — 1920x960 PNG
//   - Gallery    — 1920x960 PNG, minimum 3, max 10
//
// Every key and every dial LCD is drawn by the plugin's own code: keys come
// from SessionSlotManager (which key shows what, on which page) through
// renderSlotConfig — the same function the Stream Deck action calls — and the
// Stream Deck+ strip from the dial renderers. Nothing is screenshotted or
// redrawn, so the gallery cannot drift from what the hardware shows (DESIGN.md
// R7: real renderer output, never hand-drawn application UI). The device shells
// follow the physical 5x3 Stream Deck and the 4x2 + strip + 4 dials Stream
// Deck+. The previous set composited 2026-07-20 captures of the 1.0.0 layout,
// which predated z.ai, the weekly usage keys and the shared state palette.
//
// Fixture sessions are fictional and use real wire states only.
//
//   pnpm exec tsx scripts/generate-elgato-marketplace-assets.mts
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { State, type SessionInfo } from '../shared/dist/index.js';
import { SessionSlotManager, type DeckLayout } from '../plugin/src/session-slot-manager.js';
import { renderSlotConfig } from '../plugin/src/renderers/slot-svg.js';
import { renderUsageEncoderBoth } from '../plugin/src/renderers/usage-gauge.js';
import { renderUtilityGeneric } from '../plugin/src/renderers/utility-renderer.js';
import { renderLauncher } from '../plugin/src/renderers/launcher-renderer.js';

const root = resolve(import.meta.dirname, '..');
const pluginVersion = JSON.parse(await readFile(resolve(root, 'plugin/package.json'), 'utf8')).version;
const out = resolve(root, `marketplace/elgato/${pluginVersion}`);
const brandIcon = resolve(root, 'design/brand/agentdeck-icon.png');
await mkdir(out, { recursive: true });

// design/tokens.css
const INK_900 = '#0e1f1f';
const INK_800 = '#15302f';
const TIDE_50 = '#f5f3ec';
const KELP_300 = '#6fb6a8';
const SHELL = '#101416';
const SHELL_EDGE = '#2a3236';
const FONT = 'IBM Plex Sans, -apple-system, BlinkMacSystemFont, sans-serif';
const W = 1920;
const H = 960;

// ---------------------------------------------------------------- fixture
const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const session = (id: string, agentType: string, projectName: string, state: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id, port: 9121, alive: true, agentType, projectName, state, startedAt: '2026-09-28T09:00:00Z', ...extra,
} as SessionInfo);
const SESSIONS: SessionInfo[] = [
  session('s1', 'claude-code', 'web-app', 'awaiting_permission', { modelName: 'claude-sonnet-4-5', question: 'Run the database migration?' }),
  session('s2', 'claude-code', 'api', 'processing', { modelName: 'claude-opus-4-1', activity: 'Refactoring the auth middleware' }),
  session('s3', 'codex-cli', 'mobile', 'processing', { modelName: 'gpt-5-codex', activity: 'Running the test suite' }),
  session('s4', 'openclaw', 'assistant', 'idle', { modelName: 'glm-5' }),
  session('s5', 'opencode', 'docs', 'processing', { modelName: 'qwen3-coder', activity: 'Drafting release notes' }),
  session('s6', 'codex-cli', 'infra', 'idle', { modelName: 'gpt-5-codex' }),
  session('s7', 'antigravity', 'design', 'idle', { modelName: 'gemini-2.5-pro' }),
  session('s8', 'kiro-cli', 'billing', 'processing', { modelName: 'claude-sonnet-4-5', activity: 'Writing the invoice export' }),
  session('s9', 'claude-code', 'search', 'idle', { modelName: 'claude-sonnet-4-5' }),
];
const USAGE = {
  fiveHourPercent: 46, fiveHourResetsAt: hours(2.3),
  sevenDayPercent: 72, sevenDayResetsAt: hours(3 * 24 + 5),
  usageStale: false,
  codexRateLimits: {
    planType: 'plus',
    primary: { usedPercent: 38, windowMinutes: 300, resetsAt: hours(3.6), stale: false },
    secondary: { usedPercent: 64, windowMinutes: 10_080, resetsAt: hours(5 * 24 + 9), stale: false },
  },
} as Parameters<SessionSlotManager['updateUsage']>[0];

// ------------------------------------------------------------- rendering
const CLASSIC: DeckLayout = { columns: 5, rows: 3, keyCount: 15, family: 'streamdeck' };
const PLUS: DeckLayout = { columns: 4, rows: 2, keyCount: 8, family: 'streamdeckplus' };

function deckManager(): SessionSlotManager {
  const manager = new SessionSlotManager();
  manager.updateSessions(SESSIONS);
  manager.updateUsage(USAGE);
  return manager;
}

/** Every key of one page, exactly as the action would draw it at this frame. */
async function keyImages(manager: SessionSlotManager, layout: DeckLayout, frame: number, px: number): Promise<Buffer[]> {
  const keys: Buffer[] = [];
  for (let slot = 0; slot < layout.keyCount; slot++) {
    const svg = renderSlotConfig(manager.getSlotConfig(slot, layout), {
      animFrame: frame,
      isStale: false,
      layout,
      detail: { state: manager.detailState, modelName: manager.detailModelName, effortLevel: manager.detailEffortLevel },
    });
    keys.push(await sharp(Buffer.from(svg), { density: 144 * (px / 144) }).resize(px, px).png().toBuffer());
  }
  return keys;
}

async function raster(svg: string, w: number, h: number): Promise<Buffer> {
  return sharp(Buffer.from(svg), { density: 192 }).resize(w, h, { fit: 'contain', background: '#000000' }).png().toBuffer();
}

/** A physical Stream Deck body with its key grid (and, for the Plus, the strip and dials). */
async function deckShell(layout: DeckLayout, keys: Buffer[], px: number, strip?: Buffer[]): Promise<Buffer> {
  const gap = Math.round(px * 0.22);
  const pad = Math.round(px * 0.42);
  const gridW = layout.columns * px + (layout.columns - 1) * gap;
  const gridH = layout.rows * px + (layout.rows - 1) * gap;
  const stripH = strip ? Math.round(gridW / 8) : 0;
  const dialsH = strip ? Math.round(px * 1.05) : 0;
  const bodyW = gridW + pad * 2;
  const bodyH = gridH + pad * 2 + (strip ? gap + stripH + gap + dialsH : 0);
  const dials = strip
    ? Array.from({ length: 4 }, (_, i) => {
        const cx = pad + (gridW / 4) * (i + 0.5);
        const cy = pad + gridH + gap + stripH + gap + dialsH / 2;
        return `<circle cx="${cx}" cy="${cy}" r="${dialsH * 0.4}" fill="#1b2124" stroke="${SHELL_EDGE}" stroke-width="3"/>
                <circle cx="${cx}" cy="${cy}" r="${dialsH * 0.3}" fill="#232a2e"/>`;
      }).join('')
    : '';
  const body = Buffer.from(`<svg width="${bodyW}" height="${bodyH}" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="1.5" width="${bodyW - 3}" height="${bodyH - 3}" rx="${pad * 0.7}" fill="${SHELL}" stroke="${SHELL_EDGE}" stroke-width="3"/>
      ${dials}
    </svg>`);
  const layers: sharp.OverlayOptions[] = keys.map((input, i) => ({
    input,
    left: pad + (i % layout.columns) * (px + gap),
    top: pad + Math.floor(i / layout.columns) * (px + gap),
  }));
  if (strip) {
    const cellW = Math.floor(gridW / 4);
    strip.forEach((input, i) => layers.push({ input, left: pad + i * cellW, top: pad + gridH + gap }));
  }
  return sharp(body).composite(layers).png().toBuffer();
}

/** Stream Deck keys are rounded LCD windows; mask the square render to match. */
async function roundKey(key: Buffer, px: number): Promise<Buffer> {
  const mask = Buffer.from(`<svg width="${px}" height="${px}"><rect width="${px}" height="${px}" rx="${px * 0.12}" fill="#fff"/></svg>`);
  return sharp(key).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

// ------------------------------------------------------------- composition
const backdrop = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs><radialGradient id="lift" cx="0.66" cy="0.5" r="0.66">
    <stop offset="0" stop-color="${INK_800}"/><stop offset="1" stop-color="${INK_900}"/>
  </radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#lift)"/></svg>`);

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function caption(title: string[], sub: string[], x = 104, top = 330): Buffer {
  const lines = title.map((t, i) => `<text x="${x}" y="${top + i * 74}" fill="${TIDE_50}" font-family="${FONT}" font-size="62" font-weight="700">${escape(t)}</text>`);
  const subTop = top + title.length * 74 + 16;
  const subs = sub.map((s, i) => `<text x="${x + 3}" y="${subTop + i * 42}" fill="${KELP_300}" font-family="${FONT}" font-size="30" font-weight="500">${escape(s)}</text>`);
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${lines.join('')}${subs.join('')}</svg>`);
}

async function place(deck: Buffer, maxW: number, maxH: number): Promise<{ input: Buffer; left: number; top: number }> {
  const meta = await sharp(deck).metadata();
  const scale = Math.min(maxW / meta.width!, maxH / meta.height!, 1);
  const input = scale < 1 ? await sharp(deck).resize(Math.round(meta.width! * scale)).png().toBuffer() : deck;
  const m = await sharp(input).metadata();
  return { input, left: W - m.width! - 90, top: Math.round((H - m.height!) / 2) };
}

async function slide(file: string, deck: Buffer, title: string[], sub: string[]): Promise<void> {
  await sharp(backdrop).composite([await place(deck, 1020, 860), { input: caption(title, sub) }]).png().toFile(resolve(out, file));
  console.log(`${file}`);
}

const KEY_PX = 176;
// A frame near a pulse crest, so the needs-you border reads at full strength.
const FRAME = 8;

// ---- icon
await sharp(brandIcon).resize(288, 288).png().toFile(resolve(out, 'app-icon-288.png'));

// ---- gallery 01: the live session page on a Stream Deck
const classic = deckManager();
const listKeys = await Promise.all((await keyImages(classic, CLASSIC, FRAME, KEY_PX)).map((k) => roundKey(k, KEY_PX)));
const classicDeck = await deckShell(CLASSIC, listKeys, KEY_PX);
await slide('gallery-01-session-keys.png', classicDeck,
  ['Every agent,', 'one key each'],
  ['Working · waiting on you · idle', 'Usage and reset times on the bottom row']);

// ---- gallery 02: answer a question from the deck
const detail = deckManager();
detail.enterDetailView('s1');
detail.updateDetailState(State.AWAITING_PERMISSION, [
  { index: 1, label: 'Yes', recommended: true },
  { index: 2, label: 'Yes, don’t ask again' },
  { index: 3, label: 'No, and tell Claude' },
], 'Bash', 'npm run db:migrate', 'Run the database migration?', 'claude-sonnet-4-5');
const detailKeys = await Promise.all((await keyImages(detail, CLASSIC, FRAME, KEY_PX)).map((k) => roundKey(k, KEY_PX)));
await slide('gallery-02-answer.png', await deckShell(CLASSIC, detailKeys, KEY_PX),
  ['Answer without', 'switching windows'],
  ['Press a key to approve, choose or stop', 'The question waits on the deck']);

// ---- gallery 03: Stream Deck+ keys, strip and dials
const plus = deckManager();
const plusKeys = await Promise.all((await keyImages(plus, PLUS, FRAME, KEY_PX)).map((k) => roundKey(k, KEY_PX)));
const gridW = PLUS.columns * KEY_PX + (PLUS.columns - 1) * Math.round(KEY_PX * 0.22);
const cellW = Math.floor(gridW / 4);
const cellH = Math.round(gridW / 8);
const strip = await Promise.all([
  raster(renderUtilityGeneric({ title: 'VOLUME', value: '42%', indicator: { value: 42, bar_fill_c: KELP_300 } }), cellW, cellH),
  raster(renderUsageEncoderBoth({
    agent: 'claude', title: 'CLAUDE',
    fiveHour: { label: '5H', usedPercent: 46, resetsAt: hours(2.3), known: true },
    sevenDay: { label: '7D', usedPercent: 72, resetsAt: hours(3 * 24 + 5), known: true },
  }), cellW, cellH),
  raster(renderUsageEncoderBoth({
    agent: 'codex', title: 'CODEX',
    fiveHour: { label: '5H', usedPercent: 38, resetsAt: hours(3.6), known: true },
    sevenDay: { label: '7D', usedPercent: 64, resetsAt: hours(5 * 24 + 9), known: true },
  }), cellW, cellH),
  raster(renderLauncher({ label: 'Claude Code', detail: 'Open a new session', position: 1, total: 4 }), cellW, cellH),
]);
await slide('gallery-03-dials.png', await deckShell(PLUS, plusKeys, KEY_PX, strip),
  ['Four dials,', 'four jobs'],
  ['Volume · Claude usage · Codex usage · Launcher', 'Turn to switch, press to act']);

// ---- thumbnail
{
  const text = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <text x="110" y="452" fill="${TIDE_50}" font-family="${FONT}" font-size="94" font-weight="700">AgentDeck</text>
    <text x="114" y="528" fill="${KELP_300}" font-family="${FONT}" font-size="37" font-weight="500">AI agent control for Stream Deck</text>
    <text x="114" y="592" fill="${TIDE_50}" font-family="${FONT}" font-size="27" opacity="0.82">Claude Code · Codex · OpenCode · OpenClaw · Antigravity</text>
  </svg>`);
  await sharp(backdrop)
    .composite([
      await place(classicDeck, 980, 820),
      { input: text },
      { input: await sharp(brandIcon).resize(146, 146).png().toBuffer(), left: 110, top: 212 },
    ])
    .png()
    .toFile(resolve(out, 'thumbnail-1920x960.png'));
  console.log('thumbnail-1920x960.png');
}

console.log(`Generated Elgato Marketplace media in ${out}`);
