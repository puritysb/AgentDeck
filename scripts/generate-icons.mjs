import sharp from 'sharp';
import { mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { renderAgentDeckMarkCompact } from '../shared/dist/svg-renderers/session-slot-renderer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputDir = resolve(__dirname, '../plugin/bound.serendipity.agentdeck.sdPlugin/static/imgs');
const keyOutputDir = resolve(outputDir, 'keys');

mkdirSync(outputDir, { recursive: true });
mkdirSync(keyOutputDir, { recursive: true });

// ---- Shared drawing language -------------------------------------------------
//
// Every icon is monochrome white on transparent (the Stream Deck convention) and
// is drawn on the same 40x40 grid with round caps, so the set reads as one
// family on a key row. Stroke weight matches the AgentDeck mark's 1.6/24 ratio.
const STROKE = 2.7;
const CAP = 'stroke-linecap="round" stroke-linejoin="round" fill="none"';

/**
 * Pull the single path out of an official brand SVG (24x24, fill=currentColor)
 * and scale it onto the 40x40 icon grid.
 *
 * DESIGN.md rule 6: brand marks are upstream — never redraw them. Using the real
 * file also means an upstream mark update flows into the icons for free.
 */
function brandGlyph(name, { scale = 1.34, dx = 0, dy = 0 } = {}) {
  const svg = readFileSync(resolve(__dirname, `../design/brand/${name}.svg`), 'utf-8');
  const paths = [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"[^>]*>/g)].map((m) => m[1]);
  if (paths.length === 0) throw new Error(`no path found in design/brand/${name}.svg`);
  // Centre the 24-unit artwork on the 40-unit grid, then apply the caller's scale.
  const offset = (40 - 24 * scale) / 2;
  const inner = paths
    .map((d) => `<path d="${d}" fill="white" fill-rule="evenodd" clip-rule="evenodd"/>`)
    .join('');
  return `<g transform="translate(${(offset + dx).toFixed(2)} ${(offset + dy).toFixed(2)}) scale(${scale})">${inner}</g>`;
}

// All SVGs designed at 40x40 viewBox, will be rendered at target sizes
const svgs = {
  // Plugin icon — rounded "C" with diamond accent (Claude-style)


  // Session Slot — the canonical AgentDeck dome-over-deck mark, from the shared
  // SSOT rather than redrawn. The compact reduction is used because Stream Deck
  // draws action-list icons at 20px, where the full mark's low-opacity waterline
  // and bubbles collapse into a blob.
  session: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    ${renderAgentDeckMarkCompact(20, 20, 37, 'white')}
  </svg>`,

  // Claude Usage (E2) — the official Claude Code mark. The action name supplies
  // "usage"; the mark supplies "whose", which is what you need at a glance.
  option: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    ${brandGlyph('claudecode', { scale: 1.28 })}
  </svg>`,

  // Codex Usage (E3) — official Codex mark, same treatment.
  usage: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    ${brandGlyph('codex', { scale: 1.22 })}
  </svg>`,

  // Claude Limit (keypad) — a tank filled near the top: the product's own
  // level-fill gauge language, reduced to a glyph. Deliberately NOT the Claude
  // mark, which E2 already owns; two actions sharing one icon are unpickable in
  // the Stream Deck action list. Reads at 20px because it's two solid shapes.
  limit: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    <rect x="11.5" y="7.5" width="17" height="25" rx="4.5" stroke="white" stroke-width="${STROKE}" fill="none"/>
    <rect x="14.6" y="16.4" width="10.8" height="13" rx="2.4" fill="white"/>
  </svg>`,

  // Volume (E1) — speaker + two arcs. Replaces a brightness sun that survived
  // the utility-dial reduction and no longer described the action.
  utility: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    <path d="M8 16.2h5.2L20 10.4v19.2l-6.8-5.8H8z" fill="white" stroke="white" stroke-width="${STROKE}" stroke-linejoin="round"/>
    <path d="M25.2 15.4a7.2 7.2 0 0 1 0 9.2" stroke="white" stroke-width="${STROKE}" ${CAP}/>
    <path d="M29.4 11.6a12.4 12.4 0 0 1 0 16.8" stroke="white" stroke-width="${STROKE}" ${CAP}/>
  </svg>`,

  // Launcher (E4) — an arrow leaving a rounded frame: "open this elsewhere".
  // Reads at 20px, unlike the rocket it replaces, and matches the stroke family.
  launcher: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    <path d="M18.5 10.5H12A3.5 3.5 0 0 0 8.5 14v14A3.5 3.5 0 0 0 12 31.5h14a3.5 3.5 0 0 0 3.5-3.5v-6.5" stroke="white" stroke-width="${STROKE}" ${CAP}/>
    <path d="M23 8.5h9v9" stroke="white" stroke-width="${STROKE}" ${CAP}/>
    <path d="M31.2 9.3 19.6 20.9" stroke="white" stroke-width="${STROKE}" ${CAP}/>
  </svg>`,

  // Response — chat bubble with reply arrow

  // Stop — octagon stop symbol

  // Mode — cycle arrows (toggle through Default/Plan/Accept)

  // Option — list/menu icon (three lines with bullets)

  // History — clock with circular arrow

  // Voice — microphone icon

  // Session — terminal window with prompt

  // Usage — bar chart icon

  // Command — slash in a rounded box (quick commands)

  // Context — eye icon (display/observe)

  // Utility — gear icon (system utilities)

  // Launcher — rocket (start a session). Pure geometry, no text.

  // Terminal — monitor with prompt cursor
};

// Size specs: plugin/category are 28/56, action icons are 20/40
// Action-list icons are 20 (@2x 40).
//
// The plugin icon (Marketplace / plugin manager) is the full-colour brand mark,
// resized from design/brand/agentdeck-icon.png. The category icon is NOT drawn
// from that PNG — see the white-category block below. Elgato requires the icons
// shown inside the Stream Deck app for the category and the actions to be white
// on transparent (they render on the app's dark sidebar), so the category uses
// the white AgentDeck mark and stays in the action-icon family. The colour PNG
// remains the plugin/Marketplace icon only.
const sizeMap = {
  option:   [20, 40],
  limit:    [20, 40],
  session:  [20, 40],
  usage:    [20, 40],
  utility:  [20, 40],
  launcher: [20, 40],
};

// Stream Deck key state images must be 72x72 (@1x) / 144x144 (@2x).
// Any icon referenced from an action's States[].Image needs a key-sized variant.
const KEY_SIZE_1X = 72;
const KEY_SIZE_2X = 144;
// Glyph is drawn inset on the key canvas so it doesn't bleed to the key edge.
const KEY_GLYPH_1X = 50; // 2x variant is exactly double, keeping the pair aligned
const KEY_GLYPH_2X = KEY_GLYPH_1X * 2;

const keyIcons = ['session', 'option', 'limit', 'utility', 'usage', 'launcher'];

async function renderKeyVariant(svgBuffer, name, keySize, glyphSize, suffix) {
  const pad = (keySize - glyphSize) / 2;
  const glyph = await sharp(svgBuffer, { density: 300 })
    .resize(glyphSize, glyphSize)
    .png()
    .toBuffer();

  await sharp(glyph)
    .extend({
      top: pad,
      bottom: pad,
      left: pad,
      right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(resolve(keyOutputDir, `${name}${suffix}.png`));
}

let count = 0;
for (const [name, svg] of Object.entries(svgs)) {
  const [size1x, size2x] = sizeMap[name];
  const buf = Buffer.from(svg);

  await sharp(buf, { density: 300 })
    .resize(size1x, size1x)
    .png()
    .toFile(resolve(outputDir, `${name}.png`));

  await sharp(buf, { density: 300 })
    .resize(size2x, size2x)
    .png()
    .toFile(resolve(outputDir, `${name}@2x.png`));

  count += 2;
  console.log(`  ${name}.png (${size1x}x${size1x}) + ${name}@2x.png (${size2x}x${size2x})`);
}

let keyCount = 0;
for (const name of keyIcons) {
  const svg = svgs[name];
  if (!svg) throw new Error(`keyIcons references unknown icon: ${name}`);
  const buf = Buffer.from(svg);

  await renderKeyVariant(buf, name, KEY_SIZE_1X, KEY_GLYPH_1X, '');
  await renderKeyVariant(buf, name, KEY_SIZE_2X, KEY_GLYPH_2X, '@2x');

  keyCount += 2;
  console.log(
    `  keys/${name}.png (${KEY_SIZE_1X}x${KEY_SIZE_1X}) + keys/${name}@2x.png (${KEY_SIZE_2X}x${KEY_SIZE_2X})`
  );
}

// ---- Brand icons from the canonical asset ----------------------------------
const brandSource = resolve(__dirname, '../design/brand/agentdeck-icon.png');
const brandIcons = [
  ['plugin', 256, 512],   // Marketplace listing / plugin manager — full-colour
];
for (const [name, s1x, s2x] of brandIcons) {
  for (const [size, suffix] of [[s1x, ''], [s2x, '@2x']]) {
    await sharp(brandSource)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(resolve(outputDir, `${name}${suffix}.png`));
    count++;
  }
  console.log(`  ${name}.png (${s1x}x${s1x}) + ${name}@2x.png (${s2x}x${s2x}) — from design/brand/agentdeck-icon.png`);
}

// ---- Category icon: white monochrome mark (Elgato in-app icon rule) ----------
//
// The actions-list category header renders on the Stream Deck app's dark
// sidebar, so Elgato requires it white on transparent — same as the action
// icons. It reuses the compact AgentDeck mark (as the Session action icon does),
// in white, so the whole in-app icon set reads as one family. This is
// deliberately NOT the colour brand PNG, which stays the plugin/Marketplace icon.
const categorySvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40">
    ${renderAgentDeckMarkCompact(20, 20, 37, 'white')}
  </svg>`;
for (const [size, suffix] of [[28, ''], [56, '@2x']]) {
  await sharp(Buffer.from(categorySvg), { density: 300 })
    .resize(size, size)
    .png()
    .toFile(resolve(outputDir, `category${suffix}.png`));
  count++;
}
console.log('  category.png (28x28) + category@2x.png (56x56) — white AgentDeck mark');

console.log(`\nGenerated ${count} icon files in ${outputDir}`);
console.log(`Generated ${keyCount} key state images in ${keyOutputDir}`);
