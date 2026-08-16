#!/usr/bin/env node

import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const systemRoot = path.join(repoRoot, 'agentdeck-design-system');
const outputRoot = path.join(repoRoot, 'dist', 'design-system');
const checkOnly = process.argv.includes('--check');

/* Exact pin, not a floor: a silently dropped token is as much a regression as a
 * silently added one. Bump this deliberately when design/tokens.css changes. */
const EXPECTED_TOKEN_COUNT = 97;
const requiredFields = [
  'id',
  'title',
  'description',
  'category',
  'locale',
  'canonical',
  'status',
  'owner',
  'reviewed',
  'revision',
  'source_of_truth',
  'validators',
];

function fail(message) {
  throw new Error(`[design-system] ${message}`);
}

async function verifyViewerShell() {
  const [html, css] = await Promise.all([
    readFile(path.join(systemRoot, 'viewer', 'index.html'), 'utf8'),
    readFile(path.join(systemRoot, 'viewer', 'styles.css'), 'utf8'),
  ]);
  if (!html.includes('id="lightbox"') || !html.includes('aria-label="Asset preview" hidden')) {
    fail('asset lightbox must be hidden in the initial HTML');
  }
  if (!/\[hidden\]\s*\{[^}]*display:\s*none\s*!important\s*;/s.test(css)) {
    fail('viewer CSS must preserve the HTML hidden contract against author-level display rules');
  }
}

function verifyNavigationLabels(catalog, documentIds) {
  const labels = catalog.navigationLabels;
  if (!labels || typeof labels !== 'object') fail('catalog.json must declare navigationLabels');

  const labelIds = new Set(Object.keys(labels));
  for (const id of documentIds) {
    const localized = labels[id];
    if (!localized) fail(`navigationLabels is missing ${id}`);
    for (const locale of catalog.locales) {
      const label = localized[locale];
      if (typeof label !== 'string' || label.trim() !== label || label.length === 0) {
        fail(`navigationLabels.${id}.${locale} must be a non-empty trimmed string`);
      }
      if ([...label].length > 24) fail(`navigationLabels.${id}.${locale} exceeds 24 characters`);
    }
    labelIds.delete(id);
  }
  if (labelIds.size > 0) fail(`navigationLabels has unknown document ids: ${[...labelIds].join(', ')}`);
  return labels;
}

function parseScalar(raw) {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(',').map((item) => item.trim()) : [];
  }
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

function parseMarkdown(source, sourcePath) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') fail(`${sourcePath} must start with YAML frontmatter`);
  const end = lines.indexOf('---', 1);
  if (end < 0) fail(`${sourcePath} has no closing frontmatter delimiter`);

  const metadata = {};
  for (const line of lines.slice(1, end)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 1) fail(`${sourcePath} has unsupported frontmatter line: ${line}`);
    const key = line.slice(0, colon).trim();
    metadata[key] = parseScalar(line.slice(colon + 1));
  }

  for (const field of requiredFields) {
    if (metadata[field] === undefined || metadata[field] === '') {
      fail(`${sourcePath} is missing required frontmatter field ${field}`);
    }
  }
  if (!Array.isArray(metadata.validators) || metadata.validators.length === 0) {
    fail(`${sourcePath} validators must be a non-empty inline array`);
  }

  const body = lines
    .slice(end + 1)
    .join('\n')
    .trim();
  if (!body.startsWith('# ')) fail(`${sourcePath} body must start with one H1`);
  return { metadata, body, raw: source.trim() };
}

/* Every asset source must be committed, not merely present on this disk. A
 * gitignored source resolves fine locally and then ENOENTs on a clean CI
 * checkout — and even if the build survived, blobUrl() would hand the published
 * viewer a 404. Checking tracked-ness here, at the one path all three asset
 * loaders funnel through, turns that into a local failure. */
const trackedPaths = (() => {
  try {
    return new Set(
      execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        .split('\0')
        .filter(Boolean),
    );
  } catch {
    // Not a git checkout (tarball export, vendored copy) — skip the guard
    // rather than fail a build that has no way to answer the question.
    return null;
  }
})();

function assertTracked(relativePath) {
  if (!trackedPaths) return;
  const normalized = relativePath.replace(/\/$/, '');
  if (trackedPaths.has(normalized)) return;
  const asDir = `${normalized}/`;
  for (const tracked of trackedPaths) {
    if (tracked.startsWith(asDir)) return;
  }
  fail(`source is not tracked by git (gitignored or never added): ${relativePath}`);
}

function safeSourcePath(relativePath) {
  const absolute = path.resolve(repoRoot, relativePath);
  if (!absolute.startsWith(`${repoRoot}${path.sep}`)) fail(`source escapes repository: ${relativePath}`);
  assertTracked(relativePath);
  return absolute;
}

function tokenGroup(name) {
  if (name.startsWith('tide-')) return 'Tide';
  if (name.startsWith('ink-')) return 'Ink';
  if (name.startsWith('kelp-')) return 'Kelp';
  if (name.startsWith('coral-')) return 'Coral';
  if (name.startsWith('amber-')) return 'Amber';
  if (name.startsWith('brand-')) return 'Brand';
  if (name.startsWith('status-')) return 'Status';
  if (name.startsWith('ui-')) return 'Product UI';
  if (name.startsWith('font-') || name.startsWith('t-') || name.startsWith('tr-')) return 'Type';
  if (name.startsWith('s-') || name.startsWith('container-') || name === 'section-y') return 'Layout';
  if (name.startsWith('r-')) return 'Radius';
  if (name.startsWith('sh-')) return 'Shadow';
  if (name.startsWith('d-') || name.startsWith('ease-')) return 'Motion';
  return 'Other';
}

async function loadTokens() {
  const css = await readFile(path.join(repoRoot, 'design', 'tokens.css'), 'utf8');
  const tokens = [];
  for (const match of css.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)) {
    tokens.push({ name: `--${match[1]}`, value: match[2].trim(), group: tokenGroup(match[1]) });
  }
  if (tokens.length !== EXPECTED_TOKEN_COUNT) {
    fail(
      `expected exactly ${EXPECTED_TOKEN_COUNT} design tokens, found ${tokens.length}. ` +
        'If you intentionally added or removed a token in design/tokens.css, update EXPECTED_TOKEN_COUNT ' +
        'in scripts/build-design-system-viewer.mjs (and the token mirrors listed in DESIGN.md §11).',
    );
  }
  return tokens;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.svg', '.jpg', '.jpeg', '.webp']);

/* Real captures are the point (DESIGN.md R7), but the published Pages artifact
 * is not an image host: assets/ and docs/media/ together are ~80 MB. Anything
 * over this cap becomes a pointer card instead of a shipped copy, so the viewer
 * stays honest about what exists without carrying it. */
const RENDERED_IMAGE_MAX_BYTES = 1024 * 1024;

/* Filled by the asset loaders, drained by main(). Keeping the copy list next to
 * the item that needs it prevents a card whose <img> points at a file the build
 * never staged. */
const pendingCopies = [];

async function imageAsset({ source, destination, name, note }) {
  const absolute = safeSourcePath(source);
  const info = await stat(absolute);
  const file = path.basename(source);
  const type = path.extname(file).slice(1).toUpperCase();
  if (info.size > RENDERED_IMAGE_MAX_BYTES) {
    return {
      kind: 'spec',
      name: name || file.replace(/\.[^.]+$/, ''),
      file,
      type,
      bytes: info.size,
      url: blobUrl(source),
      source,
      note: `${note ? `${note} ` : ''}Too large to ship in the viewer (${Math.round(info.size / 1024)} KB); opens at source.`,
    };
  }
  pendingCopies.push({ from: absolute, to: destination });
  return {
    kind: 'image',
    name: name || file.replace(/\.[^.]+$/, ''),
    file,
    type,
    bytes: info.size,
    url: destination,
    source,
    note,
  };
}

async function directoryPointer({ source, name, note, extensions }) {
  const absolute = safeSourcePath(source);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = entries.filter(
    (entry) => entry.isFile() && (!extensions || extensions.has(path.extname(entry.name).toLowerCase())),
  );
  if (files.length === 0) fail(`${source} contains no matching files`);
  let bytes = 0;
  for (const entry of files) bytes += (await stat(path.join(absolute, entry.name))).size;
  return {
    kind: 'spec',
    name,
    file: path.basename(source),
    type: 'DIR',
    bytes,
    url: blobUrl(source),
    source: `${source} · ${files.length} files`,
    note,
  };
}

function blobUrl(relativePath) {
  // Several reference surfaces have spaces in their filenames.
  return `https://github.com/puritysb/AgentDeck/blob/master/${encodeURI(relativePath)}`;
}

async function specPointer({ source, name, note, type, renderUrl }) {
  const absolute = safeSourcePath(source);
  const info = await stat(absolute);
  return {
    kind: 'spec',
    name,
    file: path.basename(source.replace(/\/$/, '')),
    type: type || path.extname(source).slice(1).toUpperCase() || 'DIR',
    bytes: info.isDirectory() ? 0 : info.size,
    // renderUrl points at the rendered copy the build ships under reference/;
    // without it the card falls back to the GitHub blob (source view).
    url: renderUrl || blobUrl(source.replace(/\/$/, '')),
    source,
    note,
  };
}

/* === Generated dot-matrix masks ===
 * `pnpm generate-micro-glyphs` renders design/brand/*.svg down to alpha masks
 * for the LED surfaces. Parsing the generated file (rather than restating the
 * pixels here) is the whole point: the viewer must show what actually ships, so
 * a regenerated mask changes this page without anyone editing it.
 */
const GLYPH_SOURCE = 'bridge/src/pixoo/official-dot-glyphs.generated.ts';
const GLYPH_BLOCKS = [
  { constant: 'OFFICIAL_DOT_GLYPHS', size: 24, surface: 'Pixoo64 · iDotMatrix' },
  { constant: 'OFFICIAL_TIMEBOX_GLYPHS', size: 9, surface: 'Timebox Mini' },
  { constant: 'OFFICIAL_TC001_GLYPHS', size: 8, surface: 'TC001' },
];
const AGENT_LABELS = {
  claudeCode: 'Claude Code',
  codex: 'Codex',
  openCode: 'OpenCode',
  openClaw: 'OpenClaw',
  antigravity: 'Antigravity',
  kiro: 'Kiro',
};

function parseGlyphBlock(source, constant, size) {
  const start = source.indexOf(`export const ${constant}`);
  if (start < 0) fail(`${GLYPH_SOURCE} has no ${constant} export`);
  const end = source.indexOf('\n};', start);
  if (end < 0) fail(`${GLYPH_SOURCE} ${constant} block is not terminated`);
  const block = source.slice(start, end);

  const glyphs = {};
  for (const match of block.matchAll(/(\w+):\s*new Uint8Array\(\[([\s\S]*?)\]\)/g)) {
    const values = match[2]
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '')
      .map(Number);
    if (values.length !== size * size) {
      fail(`${GLYPH_SOURCE} ${constant}.${match[1]} has ${values.length} cells, expected ${size * size}`);
    }
    if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
      fail(`${GLYPH_SOURCE} ${constant}.${match[1]} has a cell outside 0-255`);
    }
    glyphs[match[1]] = values;
  }
  if (Object.keys(glyphs).length === 0) fail(`${GLYPH_SOURCE} ${constant} yielded no glyphs`);
  return glyphs;
}

/* Horizontal run-merge keeps the inline SVG small — a 24×24 mask collapses from
 * ~500 single-cell rects to a few dozen spans without changing a pixel. */
function maskToSvg(cells, size) {
  const rects = [];
  for (let y = 0; y < size; y += 1) {
    let x = 0;
    while (x < size) {
      const alpha = cells[y * size + x];
      let run = 1;
      while (x + run < size && cells[y * size + x + run] === alpha) run += 1;
      if (alpha > 0) {
        const opacity = Math.round((alpha / 255) * 100) / 100;
        rects.push(`<rect x="${x}" y="${y}" width="${run}" height="1" opacity="${opacity}"/>`);
      }
      x += run;
    }
  }
  return `<svg viewBox="0 0 ${size} ${size}" role="img" fill="currentColor" shape-rendering="crispEdges">${rects.join('')}</svg>`;
}

async function loadGlyphMasks() {
  const source = await readFile(safeSourcePath(GLYPH_SOURCE), 'utf8');
  const items = [];
  for (const block of GLYPH_BLOCKS) {
    const glyphs = parseGlyphBlock(source, block.constant, block.size);
    for (const [agent, cells] of Object.entries(glyphs)) {
      items.push({
        kind: 'mask',
        name: `${AGENT_LABELS[agent] || agent} ${block.size}×${block.size}`,
        agent,
        size: block.size,
        surface: block.surface,
        lit: cells.filter((value) => value > 0).length,
        svg: maskToSvg(cells, block.size),
        source: `${GLYPH_SOURCE} · ${block.constant}`,
        url: blobUrl(GLYPH_SOURCE),
      });
    }
  }
  return items;
}

async function loadBrandMarks() {
  const brandDir = path.join(repoRoot, 'design', 'brand');
  const entries = await readdir(brandDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (files.length === 0) fail('design/brand contains no brand assets');

  const marks = [];
  for (const file of files) {
    const info = await stat(path.join(brandDir, file));
    marks.push({
      kind: 'image',
      name: file.replace(/\.[^.]+$/, ''),
      file,
      type: path.extname(file).slice(1).toUpperCase(),
      bytes: info.size,
      url: `assets/brand/${file}`,
      source: `design/brand/${file}`,
    });
  }
  return marks;
}

async function loadCreatures() {
  const items = Object.entries(AGENT_LABELS).map(([agent, label]) => ({
    kind: 'link',
    name: label,
    agent,
    url: '../demo/',
    note: `Canonical ${label} creature. Rendered live — with state, motion, and the terrarium — on the Live Preview surface.`,
  }));
  items.push(
    await specPointer({
      source: 'shared/src/terrarium-rules.ts',
      name: 'terrarium-rules.ts',
      note: 'Terrarium behaviour SSOT — generated outward to Swift/Kotlin/C++ behind a vitest drift gate. New creature rules land here first.',
    }),
    await specPointer({
      source: 'android/app/src/main/kotlin/dev/agentdeck/terrarium/CreatureGeometry.kt',
      name: 'CreatureGeometry.kt',
      note: 'Canonical creature geometry. ESP32 alpha masks are generated from the same shapes by `pnpm generate-creature-glyphs`.',
    }),
    await specPointer({
      source: 'docs/design/creatures.jsx',
      name: 'creatures.jsx',
      note: 'Creature reference drawings used by the legacy Design System page. Reference only — the geometry SSOT above wins.',
    }),
  );
  return items;
}

async function loadReferenceSurfaces() {
  return Promise.all([
    specPointer({
      source: 'docs/design/Design System.html',
      name: 'Design System.html',
      renderUrl: encodeURI('reference/docs/design/Design System.html'),
      note: 'Legacy visual style guide. Superseded by this viewer for anything it covers; kept for the mockups it still hosts.',
    }),
    specPointer({
      source: 'docs/design/Design Audit.html',
      name: 'Design Audit.html',
      renderUrl: encodeURI('reference/docs/design/Design Audit.html'),
      note: 'Coverage matrix and the R1–R8 lint rules in narrative form. The enforced version is `bash design/lint.sh`.',
    }),
    specPointer({
      source: 'docs/design/AgentDeck Tide Bento (D1).html',
      name: 'Tide Bento (D1).html',
      renderUrl: encodeURI('reference/docs/design/AgentDeck Tide Bento (D1).html'),
      note: 'Bento landing exploration that set the current tide palette direction. Historical.',
    }),
    specPointer({
      source: 'docs/design/tenin',
      name: 'tenin/',
      type: 'DIR',
      note: 'Mockup application built on the tide system. Design provenance, not a shipped surface.',
    }),
    specPointer({
      source: 'docs/design-mockups',
      name: 'design-mockups/',
      type: 'DIR',
      note: 'Interactive React explorations (menubar popup, e-ink screens, options A–D). Non-production per DESIGN.md §11.',
    }),
  ]);
}

/* Two font locations, one rule: the first consumer owns the file. Latin ships
 * with the bridge renderers, CJK with the design system. Neither is a mirror of
 * the other, so both are listed rather than one pointing at the other. */
/* The Latin faces ship with the viewer. Without them a visitor who does not
 * happen to have IBM Plex installed reads the design system in a system font —
 * the one surface that cannot afford to violate R3. The CJK cut stays a pointer:
 * ~10 MB is too much to push at every visitor for a specimen. */
const SHIPPED_FACES = [
  {
    name: 'IBM Plex Sans',
    family: 'IBM Plex Sans',
    role: 'Text',
    files: ['IBMPlexSans-Regular.ttf', 'IBMPlexSans-Bold.ttf'],
    sample: 'Stop chatting. Start steering.',
    note: 'Text face for every surface, Regular and Bold. Set here in the shipped file itself, not in whatever the reader happens to have installed.',
  },
  {
    name: 'JetBrains Mono',
    family: 'JetBrains Mono',
    role: 'Code · kickers · badges',
    files: ['JetBrainsMono-Regular.ttf', 'JetBrainsMono-Bold.ttf'],
    sample: 'agentdeck daemon start',
    note: 'Mono face for code, kickers, mono badges, and every numeric readout on the device surfaces.',
  },
];

async function loadTypeSpecimens() {
  const items = [];
  for (const face of SHIPPED_FACES) {
    let bytes = 0;
    for (const file of face.files) {
      const source = `bridge/assets/fonts/${file}`;
      bytes += (await stat(safeSourcePath(source))).size;
      pendingCopies.push({ from: safeSourcePath(source), to: `assets/fonts/${file}` });
    }
    items.push({
      kind: 'type',
      name: face.name,
      family: face.family,
      role: face.role,
      sample: face.sample,
      bytes,
      source: `bridge/assets/fonts/ · ${face.files.length} weights`,
      url: blobUrl('bridge/assets/fonts'),
      note: face.note,
    });
  }
  return items;
}

async function loadTypography() {
  return Promise.all([
    ...(await loadTypeSpecimens()),
    directoryPointer({
      source: 'design/fonts',
      name: 'IBM Plex Sans KR · JP',
      extensions: new Set(['.ttf']),
      note: 'CJK brand type under the OFL. Same family as the Latin face, so Korean and Japanese surfaces stay in the system instead of falling back to a system font.',
    }),
    specPointer({
      source: 'bridge/assets/fonts/LICENSES.md',
      name: 'LICENSES.md',
      note: 'Font licensing of record for the shipped Latin faces.',
    }),
    specPointer({
      source: 'design/fonts/README.md',
      name: 'fonts/README.md',
      note: 'Origin and version provenance for the CJK faces.',
    }),
  ]);
}

/* The product mark, as opposed to the agent marks in the brand group. Both are
 * upstream-only under R6; separating them keeps "which mark is ours" answerable
 * at a glance. */
async function loadProductMarks() {
  return Promise.all([
    imageAsset({
      source: 'assets/logo/agentdeck-shield.png',
      destination: 'assets/product/agentdeck-shield.png',
      note: 'Primary product mark — the dome-and-deck silhouette. Never re-drawn; see the offline mark renderer for the device-side vector form.',
    }),
    imageAsset({
      source: 'assets/logo/agentdeck-banner.png',
      destination: 'assets/product/agentdeck-banner.png',
      note: 'Horizontal lockup for README and listing headers.',
    }),
    imageAsset({
      source: 'assets/logo/agentdeck-original.png',
      destination: 'assets/product/agentdeck-original.png',
      note: 'Full-resolution master.',
    }),
    /* docs/media/, not assets/screenshots/ — the latter is gitignored scratch
     * space, so sourcing it here passed locally and ENOENT'd in CI. Both copies
     * are byte-identical; this is the tracked one. */
    imageAsset({
      source: 'docs/media/macos-dashboard.png',
      destination: 'assets/product/macos-dashboard.png',
      note: 'macOS dashboard capture — the reference for how the tokens resolve in the shipped app.',
    }),
  ]);
}

/* R7: hardware is photographed, never illustrated. These are pointers rather
 * than copies — the sources are ~15 MB and the published crops ~65 MB. */
async function loadPhotography() {
  return Promise.all([
    directoryPointer({
      source: 'assets/hardware-photos',
      name: 'hardware-photos/',
      extensions: new Set(['.jpg', '.jpeg', '.png']),
      note: 'Committed capture sources with EXIF rotation baked in, re-encoded at quality 78. The crop table addresses these in plain display-space pixels.',
    }),
    directoryPointer({
      source: 'docs/media',
      name: 'media/',
      extensions: IMAGE_EXTENSIONS,
      note: 'Published crops and captures consumed by the Pages surfaces and README. Regenerated output — fixes go to the source photo or the crop table, never here.',
    }),
    specPointer({
      source: 'scripts/crop-hardware-images.mjs',
      name: 'crop-hardware-images.mjs',
      note: 'The crop table itself: STANDARD 1.75:1 card, WIDE 3.73:1, HERO 3:2. `.rotate()` must be called with no argument so the EXIF orientation is applied.',
    }),
    specPointer({
      source: 'assets/hardware-photos/README.md',
      name: 'hardware-photos/README.md',
      note: 'Which capture belongs to which device, and the framing rule — show the device body with margin, not just its screen.',
    }),
  ]);
}

async function loadAssets() {
  const groups = [
    { id: 'brand', items: await loadBrandMarks() },
    { id: 'masks', items: await loadGlyphMasks() },
    { id: 'creatures', items: await loadCreatures() },
    {
      id: 'icons',
      items: [
        await specPointer({
          source: 'design/icons.jsx',
          name: 'icons.jsx',
          note: 'Canonical UI icon set — 22px marks on a 24px viewbox, 1.6px stroke (DESIGN.md §6.3). JSX source, not rendered here.',
        }),
      ],
    },
    { id: 'typography', items: await loadTypography() },
    { id: 'product', items: await loadProductMarks() },
    { id: 'photography', items: await loadPhotography() },
    { id: 'reference', items: await loadReferenceSurfaces() },
  ];
  return { groups, total: groups.reduce((sum, group) => sum + group.items.length, 0) };
}

/* The consolidation gate. Fragmentation is not usually a decision — it is a doc
 * that got written next to the code and never surfaced anywhere. So every
 * Markdown file in a scanned directory must be either cataloged or excluded
 * *with a stated reason*: a new doc cannot quietly become invisible, and an
 * exclusion has to be argued for in the same commit that adds the file.
 */
async function verifyCoverage(catalog, cataloged) {
  const coverage = catalog.coverage;
  if (!coverage?.scan?.length) fail('catalog.json must declare coverage.scan');
  const exclusions = coverage.exclusions || {};

  const uncovered = [];
  for (const directory of coverage.scan) {
    const entries = await readdir(safeSourcePath(directory), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name) !== '.md') continue;
      const relativePath = `${directory}/${entry.name}`;
      if (cataloged.has(relativePath)) {
        if (exclusions[relativePath]) fail(`${relativePath} is both cataloged and excluded`);
        continue;
      }
      if (!exclusions[relativePath]) uncovered.push(relativePath);
    }
  }
  if (uncovered.length > 0) {
    fail(
      `these documents are neither cataloged nor excluded:\n  ${uncovered.join('\n  ')}\n` +
        'Add a catalog.json entry (with frontmatter on the file), or add a coverage.exclusions ' +
        'entry stating why the document is not part of the design system.',
    );
  }

  for (const [relativePath, reason] of Object.entries(exclusions)) {
    if (!reason || reason.length < 20) fail(`coverage.exclusions["${relativePath}"] needs a real reason`);
    await stat(safeSourcePath(relativePath)).catch(() => fail(`excluded document no longer exists: ${relativePath}`));
  }

  return { scanned: coverage.scan, excluded: Object.keys(exclusions).length };
}

async function buildManifest() {
  const catalog = JSON.parse(await readFile(path.join(systemRoot, 'catalog.json'), 'utf8'));
  if (catalog.defaultLocale !== 'en') fail('English must remain the default locale');
  if (JSON.stringify(catalog.locales) !== JSON.stringify(['en', 'ko', 'ja'])) {
    fail('locale order must be en, ko, ja');
  }

  const seen = new Set();
  const catalogedPaths = new Set();
  const documents = [];
  for (const entry of catalog.documents) {
    if (seen.has(entry.id)) fail(`duplicate catalog id ${entry.id}`);
    seen.add(entry.id);
    if (!entry.sources?.en) fail(`${entry.id} has no English canonical source`);

    const localized = {};
    for (const [locale, relativePath] of Object.entries(entry.sources)) {
      if (!catalog.locales.includes(locale)) fail(`${entry.id} uses unsupported locale ${locale}`);
      catalogedPaths.add(relativePath);
      const source = await readFile(safeSourcePath(relativePath), 'utf8');
      const parsed = parseMarkdown(source, relativePath);
      if (parsed.metadata.id !== entry.id) fail(`${relativePath} id must be ${entry.id}`);
      if (parsed.metadata.locale !== locale) fail(`${relativePath} locale must be ${locale}`);
      localized[locale] = { ...parsed, path: relativePath };
    }

    const canonical = localized.en.metadata;
    if (canonical.canonical !== true) fail(`${entry.sources.en} must set canonical: true`);
    for (const locale of ['ko', 'ja']) {
      const translation = localized[locale];
      if (!translation) continue;
      const meta = translation.metadata;
      if (meta.canonical !== false) fail(`${translation.path} must set canonical: false`);
      if (meta.translation_of !== entry.id) fail(`${translation.path} translation_of must be ${entry.id}`);
      if (meta.source_revision !== canonical.revision) {
        fail(`${translation.path} source_revision ${meta.source_revision} does not match ${canonical.revision}`);
      }
    }

    documents.push({ id: entry.id, locales: localized });
  }

  const coverage = await verifyCoverage(catalog, catalogedPaths);
  const navigationLabels = verifyNavigationLabels(catalog, seen);

  return {
    generatedAt: new Date().toISOString(),
    defaultLocale: catalog.defaultLocale,
    locales: catalog.locales,
    documents,
    navigationLabels,
    coverage,
    tokens: await loadTokens(),
    assets: await loadAssets(),
  };
}

async function main() {
  await verifyViewerShell();
  const manifest = await buildManifest();
  if (checkOnly) {
    console.log(
      `[design-system] ${manifest.documents.length} documents, ${manifest.tokens.length} tokens, ` +
        `${manifest.assets.total} assets in ${manifest.assets.groups.length} groups verified; ` +
        `coverage: ${manifest.coverage.scanned.join(', ')} (${manifest.coverage.excluded} documented exclusions)`,
    );
    return;
  }

  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(path.join(outputRoot, 'assets'), { recursive: true });
  await cp(path.join(systemRoot, 'viewer'), outputRoot, { recursive: true });
  await cp(path.join(repoRoot, 'design', 'brand'), path.join(outputRoot, 'assets', 'brand'), { recursive: true });
  await cp(path.join(repoRoot, 'design', 'tokens.css'), path.join(outputRoot, 'assets', 'tokens.css'));
  await cp(path.join(repoRoot, 'design', 'components.css'), path.join(outputRoot, 'assets', 'components.css'));
  await cp(path.join(repoRoot, 'design', 'patterns.css'), path.join(outputRoot, 'assets', 'patterns.css'));
  // Rendered copies of the reference HTML surfaces (asset cards open real
  // pages, not GitHub source). docs/design/*.html reference ../../design/*,
  // so mirroring both directory levels under reference/ keeps them working.
  const referenceRoot = path.join(outputRoot, 'reference');
  await mkdir(path.join(referenceRoot, 'design'), { recursive: true });
  for (const file of ['tokens.css', 'components.css', 'patterns.css', 'tokens.js', 'icons.jsx']) {
    await cp(path.join(repoRoot, 'design', file), path.join(referenceRoot, 'design', file));
  }
  await cp(path.join(repoRoot, 'design', 'brand'), path.join(referenceRoot, 'design', 'brand'), { recursive: true });
  await cp(path.join(repoRoot, 'docs', 'design'), path.join(referenceRoot, 'docs', 'design'), { recursive: true });
  // Real captures the asset cards render inline (everything under the size cap).
  for (const { from, to } of pendingCopies) {
    const destination = path.join(outputRoot, to);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(from, destination);
  }
  await writeFile(
    path.join(outputRoot, 'manifest.js'),
    `window.AGENTDECK_DESIGN_SYSTEM = ${JSON.stringify(manifest)};\n`,
    'utf8',
  );
  console.log(
    `[design-system] built ${path.relative(repoRoot, outputRoot)} with ${manifest.documents.length} documents`,
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
