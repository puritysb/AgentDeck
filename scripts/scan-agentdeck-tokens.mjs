#!/usr/bin/env node
import { readFileSync, fstatSync, mkdirSync, writeFileSync, openSync, readSync, closeSync, constants } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const policy = JSON.parse(readFileSync(join(ROOT, 'security/agentdeck-token-patterns.json'), 'utf8'));
const translate = source => source.replaceAll('\\A', '^').replaceAll('\\z', '(?![\\s\\S])');

/** Never return the credential, a source excerpt or a token fingerprint. */
export function detectTokens(text, path = 'fixture') {
  const findings = [];
  const lines = [0];
  for (let pos = text.indexOf('\n'); pos >= 0; pos = text.indexOf('\n', pos + 1)) lines.push(pos + 1);
  const lineAt = pos => { let lo = 0, hi = lines.length; while (lo < hi) { const mid = (lo + hi) >>> 1; if (lines[mid] <= pos) lo = mid + 1; else hi = mid; } return lo; };
  for (const pattern of policy.patterns) {
    const expression = new RegExp(`${translate(pattern.start_delimiter)}(?<secret>${pattern.pattern})${translate(pattern.end_delimiter)}`, 'gd');
    let match;
    while ((match = expression.exec(text))) {
      const [start, end] = match.indices.groups.secret;
      if (findings.length >= 1000) throw new Error('Too many contextual matches; values withheld');
      findings.push({ path, line: lineAt(start), pattern: pattern.id });
      expression.lastIndex = end; // A delimiter can also precede the next credential.
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.pattern.localeCompare(b.pattern));
}

export function scanPaths(root, paths, operations = {}) {
  const findings = [], skipped = [];
  let scanned = 0;
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('Safe scanning requires O_NOFOLLOW support');
  const open = operations.open ?? openSync, read = operations.read ?? readSync;
  for (const path of paths) {
    const full = resolve(root, path);
    const rel = relative(resolve(root), full);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep) || path.includes('\0')) throw new Error('Invalid tracked path');
    let fd;
    try { fd = open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (error.code !== 'ELOOP') throw error;
      skipped.push({ path, reason: 'symlink; not followed' }); continue;
    }
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile()) { skipped.push({ path, reason: 'non-regular file' }); continue; }
      const stable = () => {
        const after = fstatSync(fd, { bigint: true });
        if (['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].some(key => before[key] !== after[key])) throw new Error('Tracked file changed while scanning');
      };
      const prefix = Buffer.alloc(Number(before.size < 8192n ? before.size : 8192n));
      const used = read(fd, prefix, 0, prefix.length, 0);
      if (prefix.subarray(0, used).includes(0)) { stable(); skipped.push({ path, reason: 'binary' }); continue; }
      const limit = 32 * 1024 * 1024;
      if (before.size > BigInt(limit)) throw new Error('Tracked text file exceeds scan limit; no clean scan is claimed');
      const chunks = []; let position = 0;
      for (;;) {
        const chunk = Buffer.alloc(64 * 1024), count = read(fd, chunk, 0, chunk.length, position);
        if (!count) break;
        position += count;
        if (position > limit) throw new Error('Tracked text file exceeds scan limit; no clean scan is claimed');
        chunks.push(chunk.subarray(0, count));
      }
      stable();
      const bytes = Buffer.concat(chunks);
      if (bytes.includes(0)) { skipped.push({ path, reason: 'binary' }); continue; }
      findings.push(...detectTokens(bytes.toString('utf8'), path)); scanned++;
    } finally { closeSync(fd); }
  }
  return { scanned, skipped, findings };
}

export function reviewFixtures(root, result, exceptions) {
  if (exceptions.schema !== 1 || !Array.isArray(exceptions.fixtures)) throw new Error('Invalid fixture policy');
  const reviewed = [];
  for (const fixture of exceptions.fixtures) {
    const matches = result.findings.filter(f => f.path === fixture.path && f.pattern === fixture.pattern);
    if (!fixture.path.startsWith('android/app/src/test/') && !fixture.path.startsWith('apple/AgentDeckTests/')) throw new Error('Fixture must be a native test');
    if (!Number.isInteger(fixture.count) || fixture.count < 1 || !fixture.reason ||
        createHash('sha256').update(readFileSync(join(root, fixture.path))).digest('hex') !== fixture.sha256 || matches.length !== fixture.count) throw new Error('Synthetic fixture changed; renew exact review');
    reviewed.push(...matches.map(f => ({ ...f, reason: fixture.reason })));
  }
  return { ...result, reviewedFixtures: reviewed, findings: result.findings.filter(f => !reviewed.some(r => r.path === f.path && r.line === f.line && r.pattern === f.pattern)) };
}

export function runScan(output) {
  mkdirSync(output, { recursive: true });
  const receipt = { schema: 1, capturedAt: new Date().toISOString(), status: 'unknown', coverageLimits: policy.limits };
  const save = () => writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  save();
  try {
    const git = args => {
      const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 * 1024 });
      if (r.error || r.status !== 0) throw new Error('Tracked source inventory unavailable');
      return r.stdout;
    };
    const result = reviewFixtures(ROOT, scanPaths(ROOT, git(['ls-files', '-z']).split('\0').filter(Boolean)),
      JSON.parse(readFileSync(join(ROOT, 'security/token-fixture-exceptions.json'), 'utf8')));
    Object.assign(receipt, result, { commit: git(['rev-parse', 'HEAD']).trim(),
      dirty: git(['status', '--porcelain']).trim() !== '',
      policySha256: createHash('sha256').update(readFileSync(join(ROOT, 'security/agentdeck-token-patterns.json'))).digest('hex'),
      fixturePolicySha256: createHash('sha256').update(readFileSync(join(ROOT, 'security/token-fixture-exceptions.json'))).digest('hex'),
      status: result.findings.length ? 'blocked' : 'pass' });
    return receipt;
  } catch (error) { receipt.status = 'error'; receipt.error = error.message; throw error; }
  finally { save(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3) throw new Error('Usage: node scripts/scan-agentdeck-tokens.mjs [output-directory]');
    const receipt = runScan(resolve(process.argv[2] ?? join(ROOT, 'diagnostics/token-scan')));
    console.log(`Token scan: ${receipt.status}; ${receipt.scanned} text files; ${receipt.findings.length} contextual matches (values withheld)`);
    for (const finding of receipt.findings) console.log(`${JSON.stringify(finding.path)}:${finding.line} ${finding.pattern}`);
    if (receipt.status !== 'pass') process.exitCode = 1;
  } catch (error) { console.error(`Token scan failed: ${error.message}`); process.exitCode = 1; }
}
