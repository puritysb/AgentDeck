#!/usr/bin/env node
// Verify the public surface-count mirrors against the canonical compatibility
// matrix (docs/hardware-compatibility.md).
//
//   node scripts/check-surface-mirrors.mjs
//
// The matrix is the SSOT: its rows minus the protocol rows are the counted
// surfaces, and the "Counted surfaces: N" line states that number. Three public
// surfaces repeat it — the landing page's headline, its stat tile, and its chip
// grid — and the chip grid is the one that drifts, because adding a matrix row
// is a one-line edit while adding a chip is a separate file. That is exactly how
// T-Embed, T-Display-S3-Pro, Stream Deck XL and Stream Deck + XL ended up
// counted but unlisted: the landing page said "26 surfaces" over 22 chips.
//
// This checks arithmetic, not naming — chip labels are marketing copy
// ("ESP32 86 Box 4\"") and matrix rows are catalog names ("86 Box 4.0"). A
// count mismatch is the failure mode that actually happened and it is
// unambiguous; deciding two names mean the same device is not.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(projectDir, rel), 'utf8');

const MATRIX = 'docs/hardware-compatibility.md';
const LANDING = 'scripts/pages-index.html';

/** Rows of the `## Surface matrix` table, excluding the header and separator. */
function matrixRows(md) {
  const section = md.split('## Surface matrix')[1];
  if (!section) throw new Error(`${MATRIX}: no "## Surface matrix" heading`);
  const table = section.split('\n\n').find((block) => block.trim().startsWith('| Surface |'));
  if (!table) throw new Error(`${MATRIX}: no surface table under the heading`);
  return table
    .trim()
    .split('\n')
    .slice(2) // header + separator
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((c) => c.trim()))
    .map(([surface, klass]) => ({ surface, klass }));
}

const md = read(MATRIX);
const rows = matrixRows(md);
// "every row above except the protocol rows (SSE stream) counts"
const counted = rows.filter((r) => r.klass.toLowerCase() !== 'protocol');

const declared = md.match(/\*\*Counted surfaces:\s*(\d+)\.\*\*/);
if (!declared) throw new Error(`${MATRIX}: no "**Counted surfaces: N.**" line`);
const declaredCount = Number(declared[1]);

const landing = read(LANDING);
const chips = landing.match(/<div class="chip"><b>/g)?.length ?? 0;
const headline = landing.match(/data-i18n="surf\.h">(\d+) surfaces/);
const statTile = landing.match(/<div class="n">(\d+)<\/div><div class="l" data-i18n="stat\.surfaces">/);

const problems = [];
if (declaredCount !== counted.length) {
  problems.push(
    `${MATRIX}: declares ${declaredCount} counted surfaces but the table has ${counted.length} non-protocol rows`,
  );
}
if (chips !== declaredCount) {
  problems.push(
    `${LANDING}: ${chips} surface chips vs ${declaredCount} counted surfaces — add or remove the chip alongside the matrix row`,
  );
}
if (!headline) problems.push(`${LANDING}: no "N surfaces, one bridge" headline to check`);
else if (Number(headline[1]) !== declaredCount) {
  problems.push(`${LANDING}: headline says ${headline[1]} surfaces, matrix counts ${declaredCount}`);
}
if (!statTile) problems.push(`${LANDING}: no surface-count stat tile to check`);
else if (Number(statTile[1]) !== declaredCount) {
  problems.push(`${LANDING}: stat tile says ${statTile[1]}, matrix counts ${declaredCount}`);
}

if (problems.length) {
  for (const p of problems) console.error(`ERROR: ${p}`);
  console.error('Surface-count mirrors are out of sync with the compatibility matrix.');
  process.exit(1);
}

console.log(
  `Surface mirrors in sync: ${declaredCount} counted surfaces (${rows.length - counted.length} protocol row(s) excluded), ${chips} landing chips.`,
);
