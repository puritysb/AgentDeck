#!/usr/bin/env node
/**
 * devlog-build — the development log is one file per entry under docs/devlog/entries/,
 * and those files are the ONLY tracked form of it.
 *
 * Why one file per entry: every session used to prepend its entry to the top of
 * one file, so two parallel sessions conflicted on exactly the same lines every
 * time (measured 2026-09-10: 73 writes, 35 reads, most reads being conflict-marker
 * checks).
 *
 * Why the aggregates are no longer committed (2026-10-15): splitting the entries
 * removed the conflict at write time, but the generated DEVELOPMENT_LOG.md and month
 * files were still tracked, so every PR that added an entry rewrote the same
 * aggregate and conflicted with every other such PR (18 of the 40 PRs merged
 * 2026-10-01..15). It also made the gate depend on the calendar: the active window
 * moves on the 1st, so master itself went stale at each month rollover and failed
 * every open PR. Agents never read the aggregate (they grep the entries), so it now
 * exists only as a local, git-ignored reading view.
 *
 *   node scripts/devlog-build.mjs            # write the reading view to docs/devlog/view/ (git-ignored)
 *   node scripts/devlog-build.mjs --check    # exit 1 if any entry is malformed (CI); links are checked by check-docs
 *   node scripts/devlog-build.mjs --keep 3   # months in the view's recent.md (default 2 = current + previous)
 *
 * Entry file contract (docs/devlog/entries/YYYY-MM-DD-<slug>.md):
 *   - exactly one H1, on line 1: `# YYYY-MM-DD — <title>`; the date must equal the filename prefix
 *   - body uses `###` and deeper; links are written relative to the REPOSITORY ROOT
 *     (the view rewrites them for its own depth; check-docs validates them from the root)
 *   - ordering inside one date is by filename, descending — a later entry on the same
 *     day sorts above an earlier one when its slug sorts higher; migrated entries carry a
 *     two-digit position prefix so the historical order is preserved
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES_DIR = 'docs/devlog/entries';
/** Git-ignored reading view; three directories below the root. */
const VIEW_DIR = 'docs/devlog/view';
const VIEW_PREFIX = '../../../';
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
 * Entry links are root-relative. The view lives three directories down, so a
 * root-relative target that exists on disk gets `../../../`. URLs, anchors, absolute
 * and already-relative paths, and targets that never existed are left alone.
 */
function rewriteRootRelativeLinks(text, prefix) {
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

function renderView(title, entries) {
  const header = [
    `# ${title}`,
    '',
    `<!-- Local reading view generated by \`pnpm devlog:build\` from ${ENTRIES_DIR}/ — git-ignored, never committed. Edit the entry files instead. -->`,
    '',
    '',
  ].join('\n');
  return header + rewriteRootRelativeLinks(entries.map(renderEntry).join('\n'), VIEW_PREFIX);
}

const entries = loadEntries();
if (problems.length) {
  console.error(`devlog-build: ${problems.length} malformed entr${problems.length === 1 ? 'y' : 'ies'}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

if (check) {
  console.log(`devlog-build: ${entries.length} entries, all well-formed.`);
  process.exit(0);
}

const now = new Date();
const windowStart = monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (keepMonths - 1), 1)));
const byMonth = {};
for (const e of entries) (byMonth[e.month] ||= []).push(e);

rmSync(abs(VIEW_DIR), { recursive: true, force: true });
mkdirSync(abs(VIEW_DIR), { recursive: true });
const recent = entries.filter((e) => e.month >= windowStart);
writeFileSync(abs(`${VIEW_DIR}/recent.md`), renderView(`AgentDeck Development Log — since ${windowStart}`, recent));
for (const [month, list] of Object.entries(byMonth)) {
  writeFileSync(abs(`${VIEW_DIR}/${month}.md`), renderView(`AgentDeck Development Log — ${monthLabel(month)}`, list));
}
console.log(`devlog-build: ${entries.length} entries → ${VIEW_DIR}/recent.md (${recent.length}, since ${windowStart}) + ${Object.keys(byMonth).length} month files (git-ignored)`);
