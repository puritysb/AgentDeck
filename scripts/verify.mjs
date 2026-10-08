#!/usr/bin/env node
/**
 * Layered local verification: the three tiers of scripts/verification-catalog.json.
 *
 *   pnpm verify:changed   only the steps the diff since the merge base touches
 *   pnpm verify:quick     every fast, toolchain-free gate (the ubuntu PR jobs, locally)
 *   pnpm verify:full      pre-release: quick + coverage + every native toolchain on
 *                         this host + the lab gates a person attests
 *
 * The step list lives in the catalog, not here, so the GitHub Pages Test Report
 * renders exactly what this runs (scripts/generate-html-report.py, "Verification
 * tiers"). A step whose toolchain or platform is missing is SKIPPED with the
 * reason and never counted as passing; a lab step is MANUAL until --attest.
 *
 * Every run writes a receipt to coverage/verify/<tier>.json. `--record` (pre-release
 * tier, clean tree) also writes verification/receipts/<date>-<sha>.json, the file
 * the published report shows as the last pre-release check.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG = JSON.parse(readFileSync(join(ROOT, 'scripts/verification-catalog.json'), 'utf8'));
const REPORT_DIR = join(ROOT, 'coverage/test-report');
const RECEIPT_DIR = join(ROOT, 'coverage/verify');
const RECORD_DIR = join(ROOT, 'verification/receipts');

// ---------------------------------------------------------------- arguments

const USAGE = `Usage: node scripts/verify.mjs --tier changed|quick|full [options]

  --base <ref>        changed tier: compare against this ref (default: merge base with origin/master)
  --only <ids>        run only these step ids (comma-separated), within the tier
  --skip <ids>        leave these step ids out
  --list              print the tiers and their steps, run nothing
  --dry-run           print what this tier would run here, run nothing
  --fail-fast         stop at the first failing step
  --allow-keychain    run steps that are opt-in on macOS (the daemon E2E reads the login Keychain)
  --attest <id>=<pass|fail|skip>[:note]   record a lab step's outcome (repeatable)
  --report            render the Build Health page from this run (coverage/test-report/index.html)
  --record            pre-release tier only: also write verification/receipts/<date>-<sha>.json
  --allow-dirty       let --record run with uncommitted changes (the receipt says so)`;

function parseArgs(argv) {
  const opts = { tier: null, only: null, skip: new Set(), attest: new Map() };
  const take = (i) => {
    if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) die(`${argv[i]} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue; // `pnpm verify:quick -- --only x` forwards the separator
    if (a === '--tier') opts.tier = take(i++);
    else if (a === '--base') opts.base = take(i++);
    else if (a === '--only') opts.only = new Set(take(i++).split(',').filter(Boolean));
    else if (a === '--skip') for (const id of take(i++).split(',')) opts.skip.add(id);
    else if (a === '--attest') {
      const m = /^([\w-]+)=(pass|fail|skip)(?::(.*))?$/.exec(take(i++));
      if (!m) die('--attest expects <step>=<pass|fail|skip>[:note]');
      opts.attest.set(m[1], { status: m[2], note: m[3] ?? '' });
    } else if (['--list', '--dry-run', '--fail-fast', '--allow-keychain', '--report', '--record', '--allow-dirty'].includes(a)) {
      opts[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true;
    } else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else die(`unknown argument ${a}\n\n${USAGE}`);
  }
  return opts;
}

function die(message, code = 2) {
  console.error(`verify: ${message}`);
  process.exit(code);
}

// ---------------------------------------------------------------- helpers

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const MARK = { pass: paint('32', '✓ pass  '), fail: paint('31', '✗ fail  '), skip: paint('33', '○ skip  '), manual: paint('36', '? manual') };

function git(args, fallback = '') {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return fallback;
  }
}

/** Catalog path globs: `**` crosses directories (`**\/` may match nothing), `*` stays inside one segment. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function hasCommand(cmd) {
  const probe = process.platform === 'win32' ? spawnSync('where', [cmd], { stdio: 'ignore' }) : spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' });
  return probe.status === 0;
}

/** JAVA_HOME for a JDK of at least `major`, or null. Homebrew openjdk@17 first, as the Android build script does. */
function findJdk(major) {
  const candidates = [];
  if (process.platform === 'darwin') {
    const brew = spawnSync('brew', ['--prefix', `openjdk@${major}`], { encoding: 'utf8' });
    if (brew.status === 0) candidates.push(join(brew.stdout.trim(), 'libexec/openjdk.jdk/Contents/Home'));
  }
  if (process.env.JAVA_HOME) candidates.push(process.env.JAVA_HOME);
  for (const home of candidates) {
    const java = join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (!existsSync(java)) continue;
    const out = spawnSync(java, ['-version'], { encoding: 'utf8' });
    const v = Number(/version "(\d+)/.exec(`${out.stderr}${out.stdout}`)?.[1]);
    if (v >= major) return home;
  }
  return null;
}

function duration(ms) {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

// ---------------------------------------------------------------- selection

function changedFiles(base) {
  const lines = [
    git(['diff', '--name-only', `${base}...HEAD`]),
    git(['diff', '--name-only', '--cached']),
    git(['ls-files', '--others', '--modified', '--exclude-standard']),
  ].join('\n');
  return [...new Set(lines.split('\n').map((l) => l.trim()).filter(Boolean))].sort();
}

function resolveBase(explicit) {
  if (explicit) {
    const sha = git(['rev-parse', '--verify', `${explicit}^{commit}`]);
    if (!sha) die(`--base ${explicit} is not a commit`);
    return { ref: explicit, sha };
  }
  for (const ref of ['origin/master', 'master']) {
    const sha = git(['merge-base', 'HEAD', ref]);
    if (sha) return { ref: `merge-base(HEAD, ${ref})`, sha };
  }
  die('no origin/master or master to compare against; pass --base <ref>');
}

function stepTouched(step, files) {
  if (!step.paths) return true;
  const res = step.paths.map(globToRegExp);
  return files.some((f) => res.some((re) => re.test(f)));
}

/** Requirement check → null when runnable, else the reason it is skipped. */
function unmet(step, opts) {
  const req = step.requires ?? {};
  if (req.platform === 'posix' && process.platform === 'win32') return 'needs a POSIX host';
  if (req.platform && req.platform !== 'posix' && req.platform !== process.platform) {
    return `needs ${req.platform === 'darwin' ? 'macOS' : req.platform === 'win32' ? 'Windows' : req.platform}${step.hosted ? ` (${step.hosted})` : ''}`;
  }
  for (const cmd of req.commands ?? []) if (!hasCommand(cmd)) return `needs ${cmd} on PATH`;
  if (req.jdk && !findJdk(req.jdk)) return `needs JDK ${req.jdk} (brew install openjdk@${req.jdk}, or set JAVA_HOME)`;
  const optIn = step.opt_in;
  if (optIn && optIn.platform === process.platform && !process.env[optIn.env] && !opts.allowKeychain) {
    return `opt-in on this platform: ${optIn.why}`;
  }
  return null;
}

// ---------------------------------------------------------------- builtins

const ESCALATE_TO_WHOLE_SUITE = /^(?:[^/]+\/)?(?:package\.json|tsconfig[^/]*\.json)$|^(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|vitest\.config\.ts|vitest\.e2e\.config\.ts)$/;
const CODE = /\.(?:[cm]?[jt]sx?)$/;
// Basenames too generic to say which test reads them.
const GENERIC = new Set(['README.md', 'index.ts', 'index.js', 'index.html', 'types.ts', 'package.json', 'config.h', 'main.cpp']);

let testFileCache = null;
function trackedTestFiles() {
  testFileCache ??= git(['ls-files', '*.test.ts']).split('\n').filter((f) => f && !f.startsWith('android/') && !f.startsWith('apple/') && !f.startsWith('tests/e2e/'));
  return testFileCache;
}

/** The Vitest command for a change, or null when no change is visible to Vitest. */
export function vitestRelatedPlan(files, readTest = (f) => readFileSync(join(ROOT, f), 'utf8')) {
  if (files.some((f) => ESCALATE_TO_WHOLE_SUITE.test(f))) {
    return { args: ['vitest', 'run'], why: 'a package, lockfile, tsconfig or Vitest config changed: whole suite' };
  }
  const present = files.filter((f) => existsSync(join(ROOT, f)));
  const code = present.filter((f) => CODE.test(f) && !f.startsWith('android/') && !f.startsWith('apple/') && !f.startsWith('esp32/'));
  // A test that reads a changed vector, fixture, doc or generated mirror at
  // runtime is invisible to the import graph; find it by the file's name.
  const data = present.filter((f) => !CODE.test(f)).map((f) => basename(f)).filter((b) => b.length >= 6 && !GENERIC.has(b));
  const readers = data.length ? trackedTestFiles().filter((t) => { const src = readTest(t); return data.some((b) => src.includes(b)); }) : [];
  const targets = [...new Set([...code, ...readers])];
  if (!targets.length) return null;
  return { args: ['vitest', 'related', '--run', '--passWithNoTests', ...targets], why: `${code.length} changed source file(s), ${readers.length} test(s) that read a changed file` };
}

function hashFiles(paths) {
  const out = new Map();
  for (const p of paths) {
    const abs = join(ROOT, p);
    if (existsSync(abs) && statSync(abs).isFile()) out.set(p, createHash('sha256').update(readFileSync(abs)).digest('hex'));
  }
  return out;
}

function protocolArtifacts() {
  const listed = git(['ls-files', '--cached', '--others', '--exclude-standard', 'generated/protocol', 'shared/src/command-builders.ts']);
  return listed.split('\n').filter(Boolean);
}

// ---------------------------------------------------------------- running

function shell(command, env) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/d', '/s', '/c', command]] : ['sh', ['-c', command]];
  return spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env });
}

function withReporter(command, suite) {
  // Vitest's JSON reporter feeds the Build Health generator; the default one keeps the console readable.
  if (suite !== 'vitest' && suite !== 'e2e') return command;
  return `${command} --reporter=default --reporter=json --outputFile=${JSON.stringify(join('coverage/test-report', `${suite}.json`))}`;
}

function runStep(step, ctx) {
  const env = { ...process.env, FORCE_COLOR: process.env.FORCE_COLOR ?? (color ? '1' : '0') };
  if (step.requires?.jdk) env.JAVA_HOME = findJdk(step.requires.jdk);
  if (step.opt_in && ctx.opts.allowKeychain) env[step.opt_in.env] = '1';

  if (step.builtin === 'vitest-related') {
    const plan = vitestRelatedPlan(ctx.files);
    if (!plan) return { status: 'skip', reason: 'no change Vitest can see' };
    console.log(paint('2', `  ${plan.why}`));
    const cmd = withReporter(`npx ${plan.args.map((a) => (/^[\w./@:=-]+$/.test(a) ? a : JSON.stringify(a))).join(' ')}`, 'vitest');
    const r = shell(cmd, env);
    return r.status === 0 ? { status: 'pass', note: plan.why } : { status: 'fail', reason: `exit ${r.status ?? r.signal}`, note: plan.why };
  }

  if (step.builtin === 'protocol-drift') {
    const before = hashFiles(protocolArtifacts());
    const r = shell('pnpm -s generate-protocol', env);
    if (r.status !== 0) return { status: 'fail', reason: `generate-protocol exited ${r.status ?? r.signal}` };
    const after = hashFiles(protocolArtifacts());
    const drift = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p));
    if (!drift.length) return { status: 'pass' };
    console.error(paint('31', `  Protocol artifacts were stale and have now been regenerated:\n    ${drift.join('\n    ')}\n  Review and commit them.`));
    return { status: 'fail', reason: `${drift.length} generated file(s) were out of date` };
  }

  const r = shell(withReporter(step.run, step.report_suite), env);
  if (r.signal === 'SIGINT') return { status: 'fail', reason: 'interrupted', interrupted: true };
  return r.status === 0 ? { status: 'pass' } : { status: 'fail', reason: `exit ${r.status ?? r.signal}` };
}

// ---------------------------------------------------------------- report

function suiteFromSteps(results, suite) {
  const ran = results.filter((r) => r.report_suite === suite && (r.status === 'pass' || r.status === 'fail'));
  if (!ran.length) {
    const skipped = results.find((r) => r.report_suite === suite);
    return { status: 'not-run', executed: false, note: skipped ? `Skipped by verify: ${skipped.reason ?? 'not selected'}` : 'Not part of this tier' };
  }
  const failed = ran.some((r) => r.status === 'fail');
  return { status: failed ? 'fail' : 'pass', executed: true, note: `verify ${ran.map((r) => r.id).join(', ')}` };
}

function renderReport(receipt, results, receiptPath) {
  const robot = results.find((r) => r.id === 'esp32-robot');
  const metadata = {
    run_profile: `local-${receipt.tier}`,
    suites: {
      vitest: suiteFromSteps(results, 'vitest'),
      e2e: suiteFromSteps(results, 'e2e'),
      android: suiteFromSteps(results, 'android'),
      apple: suiteFromSteps(results, 'apple'),
      robot: { status: 'not-run', executed: false, note: robot?.status === 'manual' ? 'Lab gate: not attested in this run' : robot ? `Attested ${robot.status}${robot.note ? `: ${robot.note}` : ''}` : 'Not part of this tier' },
    },
  };
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(join(REPORT_DIR, 'run-metadata.json'), JSON.stringify(metadata, null, 2));
  const coverageRan = results.some((r) => r.id === 'vitest-coverage' && (r.status === 'pass' || r.status === 'fail'));
  const androidRan = metadata.suites.android.executed;
  const env = {
    ...process.env,
    BUILD_HEALTH_RECEIPT: receiptPath,
    GITHUB_SHA: receipt.commit,
    // Only this run's artifacts: an older coverage summary or JUnit directory would be reported as today's.
    ...(coverageRan ? {} : { BUILD_HEALTH_COVERAGE_JSON: join(RECEIPT_DIR, 'no-coverage-this-run.json') }),
    ...(androidRan ? {} : { BUILD_HEALTH_ANDROID_DIR: join(RECEIPT_DIR, 'no-android-this-run') }),
  };
  const r = spawnSync('python3', ['scripts/generate-html-report.py'], { cwd: ROOT, stdio: 'inherit', env });
  if (r.status !== 0) console.error(paint('31', 'verify: the Build Health page could not be generated'));
}

// ---------------------------------------------------------------- main

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const tiers = CATALOG.tiers.map((t) => t.id);

  if (opts.list) {
    for (const tier of CATALOG.tiers) {
      console.log(`\n${paint('1', tier.name)}  ${paint('2', tier.command)}\n  ${tier.when}. ${tier.budget}.`);
      for (const s of CATALOG.steps.filter((x) => x.tiers.includes(tier.id))) {
        const scope = tier.id === 'changed' && s.paths ? paint('2', `  when ${s.paths.slice(0, 3).join(', ')}${s.paths.length > 3 ? ', …' : ''}`) : '';
        console.log(`  ${s.manual ? '?' : '·'} ${s.id.padEnd(17)} ${s.name}${scope}`);
      }
    }
    return 0;
  }

  if (!tiers.includes(opts.tier)) die(`--tier must be one of ${tiers.join(', ')}\n\n${USAGE}`);
  if (opts.record && opts.tier !== 'full') die('--record is only for the pre-release tier (--tier full)');
  const dirty = git(['status', '--porcelain']) !== '';
  if (opts.record && dirty && !opts.allowDirty) die('--record needs a clean tree, so the receipt describes a commit; commit first or pass --allow-dirty');
  const known = new Set(CATALOG.steps.map((s) => s.id));
  for (const id of [...(opts.only ?? []), ...opts.skip, ...opts.attest.keys()]) if (!known.has(id)) die(`unknown step id ${id}`);

  const tier = CATALOG.tiers.find((t) => t.id === opts.tier);
  let steps = CATALOG.steps.filter((s) => s.tiers.includes(tier.id));
  let base = null;
  let files = [];
  const notAffected = [];
  if (tier.id === 'changed') {
    base = resolveBase(opts.base);
    files = changedFiles(base.sha);
    const touched = new Set(steps.filter((s) => stepTouched(s, files)).map((s) => s.id));
    // A selected step's prerequisites run too (pages-parity reads the built shared package).
    for (const s of steps) if (touched.has(s.id)) for (const n of s.needs ?? []) touched.add(n);
    for (const s of steps) if (!touched.has(s.id)) notAffected.push(s.id);
    steps = steps.filter((s) => touched.has(s.id));
  }
  if (opts.only) steps = steps.filter((s) => opts.only.has(s.id));
  steps = steps.filter((s) => !opts.skip.has(s.id));

  const commit = git(['rev-parse', 'HEAD'], 'unknown');
  console.log(`${paint('1', tier.name)} · ${commit.slice(0, 7)}${dirty ? ' (uncommitted changes)' : ''}`);
  if (base) console.log(paint('2', `  ${files.length} file(s) changed since ${base.ref} = ${base.sha.slice(0, 7)}`));
  if (tier.id === 'changed' && !files.length) console.log('  Nothing changed: nothing to verify.');

  if (opts.dryRun) {
    for (const s of steps) {
      const why = s.manual ? 'manual (lab)' : unmet(s, opts);
      console.log(`  ${why ? MARK[s.manual ? 'manual' : 'skip'] : '· run    '} ${s.id.padEnd(17)} ${why ?? s.run ?? s.builtin}`);
    }
    if (notAffected.length) console.log(paint('2', `  Not affected: ${notAffected.join(', ')}`));
    return 0;
  }

  if (opts.report) for (const f of ['vitest.json', 'e2e.json']) rmSync(join(REPORT_DIR, f), { force: true });
  const started = Date.now();
  const results = [];
  for (const step of steps) {
    const row = { id: step.id, gate: step.gate, name: step.name, report_suite: step.report_suite };
    if (step.manual) {
      const a = opts.attest.get(step.id);
      results.push({ ...row, status: a ? a.status : 'manual', attested: Boolean(a), note: a?.note || undefined, reason: a ? undefined : 'lab gate, not attested' });
      continue;
    }
    const failedNeed = (step.needs ?? []).find((n) => results.some((r) => r.id === n && r.status === 'fail'));
    const reason = failedNeed ? `needs ${failedNeed}, which failed` : unmet(step, opts);
    if (reason) {
      console.log(`\n${MARK.skip} ${paint('1', step.name)} ${paint('2', `(${step.id}): ${reason}`)}`);
      results.push({ ...row, status: 'skip', reason });
      continue;
    }
    console.log(`\n${paint('1', `▶ ${step.name}`)} ${paint('2', `(${step.id})`)}`);
    const t0 = Date.now();
    const out = runStep(step, { opts, files });
    results.push({ ...row, ...out, interrupted: undefined, duration_ms: Date.now() - t0 });
    if (out.interrupted) break;
    if (out.status === 'fail' && opts.failFast) break;
  }

  const failed = results.filter((r) => r.status === 'fail');
  const manual = results.filter((r) => r.status === 'manual');
  const receipt = {
    schema: 1,
    tier: tier.id,
    started_at: new Date(started).toISOString(),
    finished_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    commit,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirty,
    ...(base ? { base: base.sha, changed_files: files.length, not_affected: notAffected } : {}),
    host: { platform: platform(), arch: arch(), node: process.version },
    result: failed.length ? 'fail' : 'pass',
    steps: results.map(({ report_suite, ...r }) => r),
  };
  mkdirSync(RECEIPT_DIR, { recursive: true });
  const receiptPath = join(RECEIPT_DIR, `${tier.id}.json`);
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);

  console.log(`\n${paint('1', `${tier.name}: ${failed.length ? 'FAILED' : 'passed'}`)} in ${duration(receipt.duration_ms)}`);
  for (const r of results) {
    console.log(`  ${MARK[r.status]} ${r.id.padEnd(17)} ${r.duration_ms !== undefined ? duration(r.duration_ms).padStart(9) : ''.padStart(9)}  ${paint('2', r.reason ?? r.note ?? '')}`);
  }
  if (notAffected.length) console.log(paint('2', `  Not affected by this change: ${notAffected.join(', ')}`));
  if (manual.length) console.log(paint('36', `  Lab gates not attested: ${manual.map((r) => r.id).join(', ')}. See pnpm verify:full --list.`));
  console.log(paint('2', `  Receipt: ${receiptPath.replace(`${ROOT}/`, '')}`));

  if (opts.report) renderReport(receipt, results, receiptPath);
  if (opts.record) {
    mkdirSync(RECORD_DIR, { recursive: true });
    const recorded = join(RECORD_DIR, `${receipt.finished_at.slice(0, 10)}-${commit.slice(0, 7)}.json`);
    writeFileSync(recorded, `${JSON.stringify({ ...receipt, branch: undefined }, null, 2)}\n`);
    console.log(paint('1', `  Recorded ${recorded.replace(`${ROOT}/`, '')}. Commit it so the Test Report shows this pre-release check.`));
  }
  return failed.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}

