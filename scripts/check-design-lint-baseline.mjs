#!/usr/bin/env node
/**
 * Design-lint ratchet: fail when `design/lint.sh` finds more violations than
 * docs/design-lint-baseline.md records.
 *
 * Only violations in TRACKED files count. The CI runner never builds before
 * linting, so it sees tracked files only; a local checkout that has run
 * `pnpm build` also holds gitignored outputs (plugin-ulanzi/.../plugin/app.js,
 * …) that the same grep picks up. Counting them made a clean branch look like a
 * regression on every built checkout (see .claude/rules/design-system.md, "The
 * lint count is only meaningful in a clean checkout"). Filtering to `git
 * ls-files` makes the local answer equal the CI answer.
 *
 * Used by .github/workflows/design-system.yml and the verification tiers
 * (scripts/verify.mjs).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselineText = readFileSync(resolve(root, 'docs/design-lint-baseline.md'), 'utf8');
const baseline = Number(/Total: \*\*(\d+) violations\*\*/.exec(baselineText)?.[1]);
if (!Number.isInteger(baseline)) {
  console.error('check-design-lint-baseline: could not parse "Total: **N violations**" from docs/design-lint-baseline.md');
  process.exit(1);
}

// lint.sh exits with the violation count, so a non-zero status is expected.
const run = spawnSync('bash', ['design/lint.sh', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error('check-design-lint-baseline: design/lint.sh --json did not print JSON');
  console.error(run.stderr);
  process.exit(1);
}

const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean));
const records = report.records ?? [];
const counted = records.filter((r) => tracked.has(String(r.file).replace(/^\.\//, '')));
const ignored = records.length - counted.length;
const current = counted.length;

console.log(`Design lint: ${current} violations in tracked files (baseline ${baseline})${ignored ? `; ${ignored} more in untracked build output, not counted` : ''}`);
if (current > baseline) {
  const byRule = {};
  for (const r of counted) byRule[r.rule] = (byRule[r.rule] ?? 0) + 1;
  console.error(`Design-lint regression: ${current - baseline} over the baseline. By rule: ${JSON.stringify(byRule)}`);
  console.error('Run `bash design/lint.sh` to see each violation; fix them rather than raising the baseline.');
  process.exit(1);
}
if (current < baseline) {
  console.log(`Improved by ${baseline - current}. Update docs/design-lint-baseline.md to lock in the gain.`);
}
