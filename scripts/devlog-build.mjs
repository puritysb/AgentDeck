#!/usr/bin/env node
/**
 * devlog-build — DEVELOPMENT_LOG.md and docs/devlog/YYYY-MM.md are GENERATED from
 * one file per entry under docs/devlog/entries/.
 *
 * Why one file per entry: every session used to prepend its entry to the top of
 * one file, so two parallel sessions conflicted on exactly the same lines every
 * time (measured 2026-09-10: 73 writes, 35 reads, most reads being conflict-marker
 * checks). A file per entry never conflicts; the aggregates are rebuilt, and a
 * conflict in an aggregate is resolved by rebuilding it — a generated value is
 * never a merge side (AGENTS.md, cross-platform SSOT rule).
 *
 *   node scripts/devlog-build.mjs            # rebuild DEVELOPMENT_LOG.md, docs/devlog/YYYY-MM.md, docs/devlog/README.md
 *   node scripts/devlog-build.mjs --check    # exit 1 if any entry is malformed or an aggregate is stale (CI)
 *   node scripts/devlog-build.mjs --keep 3   # active-log window in months (default 2 = current + previous)
 *
 * Entry file contract (docs/devlog/entries/YYYY-MM-DD-<slug>.md):
 *   - exactly one H1, on line 1: `# YYYY-MM-DD — <title>`; the date must equal the filename prefix
 *   - body uses `###` and deeper; links are written relative to the REPOSITORY ROOT
 *     (the aggregates rewrite them for their own depth; check-docs validates the aggregates)
 *   - ordering inside one date is by filename, descending — a later entry on the same
 *     day sorts above an earlier one when its slug sorts higher; migrated entries carry a
 *     two-digit position prefix so the historical order is preserved
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTIVE = 'DEVELOPMENT_LOG.md';
const ARCHIVE_DIR = 'docs/devlog';
const ENTRIES_DIR = 'docs/devlog/entries';
const README = `${ARCHIVE_DIR}/README.md`;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;
// Everything after the date is preserved verbatim: new entries write `# YYYY-MM-DD — title`; migrated ones
// also carry shapes like `2026-08-03 (3) — …`, `2026-04-25 → 27 — …` and `2026-04-11 - …`.
const H1_RE = /^# (\d{4}-\d{2}-\d{2})(.*)$/;

const args = process.argv.slice(2);
const check = args.includes('--check');
const keepIdx = args.indexOf('--keep');
const keepMonths = keepIdx >= 0 ? Number(args[keepIdx + 1]) : 2;
if (!Number.isInteger(keepMonths) || keepMonths < 1) {
  console.error('devlog-build: --keep must be a positive integer');
  process.exit(2);
}

const abs = (rel) => path.join(repoRoot, rel);
const problems = [];

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Read every entry file; a malformed file is a reported problem, never a guess. */
function loadEntries() {
  if (!existsSync(abs(ENTRIES_DIR))) {
    problems.push(`${ENTRIES_DIR}/ does not exist`);
    return [];
  }
  const entries = [];
  for (const name of readdirSync(abs(ENTRIES_DIR)).sort()) {
    if (!name.endsWith('.md')) continue;
    const m = FILE_RE.exec(name);
    if (!m) {
      problems.push(`${ENTRIES_DIR}/${name}: filename must be YYYY-MM-DD-<slug>.md`);
      continue;
    }
    const text = readFileSync(abs(`${ENTRIES_DIR}/${name}`), 'utf8');
    const lines = text.replace(/\s+$/, '').split('\n');
    const h1 = H1_RE.exec(lines[0] || '');
    if (!h1) {
      problems.push(`${ENTRIES_DIR}/${name}: line 1 must be '# YYYY-MM-DD — <title>' (date first)`);
      continue;
    }
    if (h1[1] !== m[1]) {
      problems.push(`${ENTRIES_DIR}/${name}: filename date ${m[1]} does not match heading date ${h1[1]}`);
      continue;
    }
    const extraH1 = lines.slice(1).filter((l) => /^# /.test(l));
    if (extraH1.length) {
      problems.push(`${ENTRIES_DIR}/${name}: more than one H1 (an entry's sections are ### or deeper)`);
      continue;
    }
    entries.push({ name, date: m[1], month: m[1].slice(0, 7), rest: h1[2], body: lines.slice(1).join('\n') });
  }
  // Newest date first; inside one date, filename descending.
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  return entries;
}

/**
 * Entry links are root-relative. An aggregate living under docs/devlog/ is two
 * directories deeper, so a root-relative target that exists on disk gets `../../`.
 * URLs, anchors, absolute and already-relative paths, and targets that never existed
 * are left alone (check-docs reports the last kind against the aggregate).
 */
function rewriteRootRelativeLinks(text, prefix) {
  if (!prefix) return text;
  return text.replace(/\]\(([^)\s]+)((?:\s[^)]*)?)\)/g, (whole, target, title) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|#|\.\.?\/|\/)/i.test(target)) return whole;
    const bare = target.split('#')[0];
    if (!bare) return whole;
    let decoded = bare;
    try { decoded = decodeURIComponent(bare); } catch { /* keep as-is */ }
    if (!existsSync(abs(decoded))) return whole;
    return `](${prefix}${target}${title})`;
  });
}

function renderEntry(entry) {
  const body = entry.body.replace(/\s+$/, '');
  return `## ${entry.date}${entry.rest}\n${body ? `${body}\n` : ''}`;
}

function renderActive(entries, windowStart, windowEnd) {
  const header = [
    '# AgentDeck Development Log',
    '',
    `<!-- GENERATED by \`pnpm devlog:build\` from ${ENTRIES_DIR}/ — do not edit here. To add an entry, create ${ENTRIES_DIR}/YYYY-MM-DD-<slug>.md (first line \`# YYYY-MM-DD — title\`, links relative to the repo root) and run \`pnpm devlog:build\`. This file holds ${windowStart}..${windowEnd}; older months are in ${ARCHIVE_DIR}/YYYY-MM.md. -->`,
    '',
    '',
  ].join('\n');
  return header + entries.map(renderEntry).join('\n');
}

function renderMonth(month, entries) {
  const header = [
    `# AgentDeck Development Log — ${month}`,
    '',
    `<!-- GENERATED by \`pnpm devlog:build\` from ../../${ENTRIES_DIR}/ — do not edit here. -->`,
    '',
    `Archived from the active [DEVELOPMENT_LOG.md](../../DEVELOPMENT_LOG.md). Entries are ordered newest date first; search this file directly when investigating ${monthLabel(month)} work.`,
    '',
    '---',
    '',
  ].join('\n');
  return header + rewriteRootRelativeLinks(entries.map(renderEntry).join('\n'), '../../');
}

function renderReadme(counts, windowStart, windowEnd) {
  const months = Object.keys(counts).sort().reverse();
  return [
    '# Development Log Archive',
    '',
    `<!-- GENERATED by \`pnpm devlog:build\` — do not edit here. -->`,
    '',
    `Every entry is one file under [\`entries/\`](entries/) (\`YYYY-MM-DD-<slug>.md\`, first line \`# YYYY-MM-DD — title\`). \`pnpm devlog:build\` regenerates the active [DEVELOPMENT_LOG.md](../../DEVELOPMENT_LOG.md) (${windowStart}..${windowEnd}) and one file per older month below; \`pnpm devlog:check\` fails CI when an aggregate is stale or an entry is malformed. A merge conflict in a generated file is resolved by rebuilding it, never by picking a side. Search one month file at a time — never load the whole directory.`,
    '',
    '| Month | Entries | File |',
    '|---|---|---|',
    ...months.map((m) => `| ${m} | ${counts[m]} | [${m}.md](${m}.md) |`),
    '',
  ].join('\n');
}

const now = new Date();
const windowStart = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (keepMonths - 1), 1)));
const windowEnd = monthKey(now);

const entries = loadEntries();
if (problems.length) {
  console.error(`devlog-build: ${problems.length} malformed entr${problems.length === 1 ? 'y' : 'ies'}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const active = entries.filter((e) => e.month >= windowStart);
const archived = entries.filter((e) => e.month < windowStart);
const byMonth = {};
for (const e of archived) (byMonth[e.month] ||= []).push(e);

const outputs = new Map();
outputs.set(ACTIVE, renderActive(active, windowStart, windowEnd));
for (const [month, list] of Object.entries(byMonth)) outputs.set(`${ARCHIVE_DIR}/${month}.md`, renderMonth(month, list));
const counts = Object.fromEntries(Object.entries(byMonth).map(([m, l]) => [m, l.length]));
outputs.set(README, renderReadme(counts, windowStart, windowEnd));

// A month file with no entries behind it is stale output, not history.
const orphanMonthFiles = readdirSync(abs(ARCHIVE_DIR))
  .filter((n) => /^\d{4}-\d{2}\.md$/.test(n) && !outputs.has(`${ARCHIVE_DIR}/${n}`))
  .map((n) => `${ARCHIVE_DIR}/${n}`);

if (check) {
  const stale = [];
  for (const [rel, text] of outputs) {
    if (!existsSync(abs(rel)) || readFileSync(abs(rel), 'utf8') !== text) stale.push(rel);
  }
  stale.push(...orphanMonthFiles);
  if (stale.length) {
    console.error(`devlog-build: ${stale.length} generated file(s) do not match ${ENTRIES_DIR}/:`);
    for (const s of stale) console.error(`  - ${s}`);
    console.error('  Run `pnpm devlog:build` and commit the result.');
    process.exit(1);
  }
  console.log(`devlog-build: ${entries.length} entries; ${active.length} in ${ACTIVE} (${windowStart}..${windowEnd}), ${archived.length} across ${Object.keys(byMonth).length} month files — all up to date.`);
  process.exit(0);
}

for (const [rel, text] of outputs) writeFileSync(abs(rel), text);
for (const rel of orphanMonthFiles) unlinkSync(abs(rel));
console.log(`devlog-build: ${entries.length} entries → ${ACTIVE} (${active.length}, ${windowStart}..${windowEnd}) + ${Object.keys(byMonth).length} month files${orphanMonthFiles.length ? ` (removed ${orphanMonthFiles.length} orphan month file(s))` : ''}`);
