#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const markdownFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '*.md'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\0')
  .filter(Boolean);

const failures = [];
const anchorCache = new Map();

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, (block) => '\n'.repeat((block.match(/\n/g) || []).length))
    .replace(/`[^`\n]*`/g, '');
}

function githubSlug(raw) {
  return raw
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/g, '-');
}

function anchorsFor(relativeFile) {
  if (anchorCache.has(relativeFile)) return anchorCache.get(relativeFile);

  const text = stripCode(readFileSync(path.join(repoRoot, relativeFile), 'utf8'));
  const anchors = new Set();
  const duplicateCounts = new Map();

  for (const line of text.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (!heading) continue;

    const base = githubSlug(heading[1]);
    const duplicateIndex = duplicateCounts.get(base) || 0;
    duplicateCounts.set(base, duplicateIndex + 1);
    anchors.add(duplicateIndex === 0 ? base : `${base}-${duplicateIndex}`);
  }

  for (const match of text.matchAll(/<(?:a|div|span)[^>]+(?:id|name)=["']([^"']+)["']/gi)) {
    anchors.add(match[1]);
  }

  anchorCache.set(relativeFile, anchors);
  return anchors;
}

function decodeDestination(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function checkDestination(sourceFile, sourceText, rawDestination, index) {
  let destination = rawDestination.trim().replace(/^<|>$/g, '');
  if (!destination || /^(?:https?:|mailto:|data:|app:)/i.test(destination)) return;

  const line = lineNumber(sourceText, index);
  if (/^file:/i.test(destination) || /^\/Users\//.test(destination) || /^[A-Za-z]:\\/.test(destination)) {
    failures.push(`${sourceFile}:${line}: machine-local link is not portable: ${destination}`);
    return;
  }

  // A leading slash is a published-site route, not a repository file path.
  if (destination.startsWith('/')) return;

  const hashIndex = destination.indexOf('#');
  const rawPath = hashIndex === -1 ? destination : destination.slice(0, hashIndex);
  const rawAnchor = hashIndex === -1 ? '' : destination.slice(hashIndex + 1);
  const cleanPath = decodeDestination(rawPath.split('?')[0]);
  const target = cleanPath
    ? path.resolve(repoRoot, path.dirname(sourceFile), cleanPath)
    : path.resolve(repoRoot, sourceFile);
  const relativeTarget = path.relative(repoRoot, target);

  if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
    failures.push(`${sourceFile}:${line}: local target escapes the repository: ${rawPath}`);
    return;
  }

  if (!existsSync(target)) {
    failures.push(`${sourceFile}:${line}: missing local target: ${rawPath}`);
    return;
  }

  if (!rawAnchor || path.extname(target).toLowerCase() !== '.md') return;

  const expectedAnchor = decodeDestination(rawAnchor).toLowerCase();
  if (!anchorsFor(relativeTarget).has(expectedAnchor)) {
    failures.push(`${sourceFile}:${line}: missing Markdown anchor #${rawAnchor} in ${relativeTarget}`);
  }
}

// Development-log entries (docs/devlog/entries/*.md) are authored with links relative
// to the REPOSITORY ROOT, because they are only ever read through the generated
// aggregates (DEVELOPMENT_LOG.md at the root, docs/devlog/YYYY-MM.md two levels down),
// which scripts/devlog-build.mjs rewrites per depth and which this checker validates.
// Validating the same links against the entry's own directory would fail every one.
const ROOT_RELATIVE_LINK_DIRS = ['docs/devlog/entries/'];

for (const relativeFile of markdownFiles) {
  const source = readFileSync(path.join(repoRoot, relativeFile), 'utf8');
  const text = stripCode(source);

  if (relativeFile === 'README.md' || relativeFile.startsWith('docs/')) {
    const h1Count = text.split('\n').filter((line) => /^#\s+/.test(line)).length;
    if (h1Count !== 1) {
      failures.push(`${relativeFile}: expected exactly one H1 outside code blocks; found ${h1Count}`);
    }
  }

  if (ROOT_RELATIVE_LINK_DIRS.some((dir) => relativeFile.startsWith(dir))) continue;

  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    checkDestination(relativeFile, text, match[1], match.index);
  }
  for (const match of text.matchAll(/(?:href|src)=["']([^"']+)["']/g)) {
    checkDestination(relativeFile, text, match[1], match.index);
  }
}

// Instruction-file gates (docs/agent-harness.md § Why there is no Claude-specific root file).
//
// 1. Codex injects the root→cwd `AGENTS.md` chain and skips whole files once the
//    combined size reaches `project_doc_max_bytes` (32 KiB default), so every
//    chain — the root file plus each nested `AGENTS.md` on the way to a cwd —
//    must fit under that budget together. A file over the cap is dropped silently.
// 2. Claude Code loads `AGENTS.md` only while no `CLAUDE.md`, `.claude/CLAUDE.md`
//    or `CLAUDE.local.md` exists in the working directory or above it, so any such
//    file inside the checkout silently replaces the map for the sessions under it.
//    Parent directories are outside this checker's reach.
const AGENTS_MD_CHAIN_BUDGET_BYTES = 32 * 1024;
const CLAUDE_INSTRUCTION_FILES = /(?:^|\/)(?:CLAUDE\.md|CLAUDE\.local\.md|\.claude\/CLAUDE\.md)$/;

function checkInstructionFiles() {
  const agentsFiles = markdownFiles.filter((file) => file === 'AGENTS.md' || file.endsWith('/AGENTS.md'));
  const sizeOf = (file) => statSync(path.join(repoRoot, file)).size;
  const chains = agentsFiles.map((file) => {
    const chain = agentsFiles.filter((candidate) => {
      const dir = path.posix.dirname(candidate);
      return dir === '.' || file === candidate || file.startsWith(`${dir}/`);
    });
    return { file, chain, bytes: chain.reduce((sum, member) => sum + sizeOf(member), 0) };
  });
  for (const { file, chain, bytes } of chains) {
    if (bytes > AGENTS_MD_CHAIN_BUDGET_BYTES) {
      failures.push(
        `${file}: AGENTS.md chain [${chain.join(' + ')}] is ${bytes} bytes; Codex skips files past ${AGENTS_MD_CHAIN_BUDGET_BYTES} bytes (project_doc_max_bytes)`,
      );
    }
  }

  const shadowing = new Set(markdownFiles.filter((file) => CLAUDE_INSTRUCTION_FILES.test(file)));
  for (const candidate of ['CLAUDE.md', 'CLAUDE.local.md', '.claude/CLAUDE.md']) {
    if (existsSync(path.join(repoRoot, candidate))) shadowing.add(candidate);
  }
  for (const file of [...shadowing].sort()) {
    failures.push(`${file}: a CLAUDE.md-family file silently replaces AGENTS.md for Claude Code; delete it (AGENTS.md is the only root instruction file)`);
  }

  const widest = chains.reduce((max, entry) => (entry.bytes > max.bytes ? entry : max), { bytes: 0, chain: [] });
  return `AGENTS.md chain max ${widest.bytes}/${AGENTS_MD_CHAIN_BUDGET_BYTES} bytes (${AGENTS_MD_CHAIN_BUDGET_BYTES - widest.bytes} spare, ${widest.chain.join(' + ')})`;
}

const instructionSummary = checkInstructionFiles();

if (failures.length > 0) {
  console.error(`Documentation check failed with ${failures.length} issue(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Documentation check passed: ${markdownFiles.length} Markdown files, local targets/anchors, and H1 structure verified; ${instructionSummary}.`,
);
