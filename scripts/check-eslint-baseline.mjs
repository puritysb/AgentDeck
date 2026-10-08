#!/usr/bin/env node
/**
 * ESLint error ratchet: fail when `eslint .` reports more errors than
 * scripts/eslint-baseline.json records. Warnings are not counted.
 *
 * ESLint was configured but ran in no workflow, so its count drifted to 181
 * errors (2026-10-07), 166 of them config noise: the vendored Ulanzi browser
 * SDK linted with Node globals, plus a gitignored generated file that only some
 * checkouts have. With those excluded in eslint.config.js the real count is
 * the baseline; this keeps it from growing while the remainder is fixed.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(readFileSync(resolve(root, 'scripts/eslint-baseline.json'), 'utf8')).errors;
const bin = resolve(root, 'node_modules/.bin', process.platform === 'win32' ? 'eslint.cmd' : 'eslint');
const run = spawnSync(bin, ['.', '--format', 'json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
let results;
try {
  results = JSON.parse(run.stdout);
} catch {
  console.error('check-eslint-baseline: eslint did not print JSON');
  console.error(run.stderr || run.error?.message);
  process.exit(1);
}

const errors = results.flatMap((r) => r.messages.filter((m) => m.severity === 2).map((m) => ({ file: relative(root, r.filePath), line: m.line, rule: m.ruleId })));
console.log(`ESLint: ${errors.length} errors (baseline ${baseline})`);
if (errors.length > baseline) {
  console.error(`ESLint regression: ${errors.length - baseline} over the baseline.`);
  for (const e of errors) console.error(`  ${e.file}:${e.line}  ${e.rule}`);
  process.exit(1);
}
if (errors.length < baseline) console.log(`Improved by ${baseline - errors.length}. Lower "errors" in scripts/eslint-baseline.json to lock in the gain.`);
