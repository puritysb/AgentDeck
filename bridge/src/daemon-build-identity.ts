/**
 * Which build of AgentDeck is actually running, and whether it is the newest
 * one on this disk.
 *
 * A dev checkout hands `agentdeck` to the shell as a shim that executes
 * `bridge/dist/cli.js` in the repo, so "the version I am running" is whatever
 * `tsc` last wrote there — a fact with no stamp on it anywhere. Two silent
 * failures follow from that, and both were live on this machine (2026-08-24: a
 * daemon started at 04:19 was still serving 9120 at 19:20, hours after the
 * source it was built from had been replaced):
 *
 *  - `daemon start` after an edit but before a build starts the PREVIOUS
 *    build, reports success, and nothing anywhere names the gap.
 *  - `daemon start` while a daemon is already up exits 0 with "already
 *    running" — correct when it is the same code, and a lie about what is
 *    serving the port when it is not. `dist/cli.js` is overwritten in place, so
 *    the running process keeps executing bytes that no longer exist on disk;
 *    no timestamp, pid or version string distinguishes the two.
 *
 * So the build gets an identity: a digest of the JavaScript the daemon would
 * actually load. It is CONTENT-based rather than mtime-based on purpose —
 * `tsc` rewrites every output on every run, so an mtime stamp would report a
 * rebuild that changed nothing as a different build and restart a healthy
 * daemon for it. The question being asked is "is the incumbent running the same
 * code I would run?", and only content answers that.
 *
 * The daemon reports the identity it CAPTURED AT STARTUP (see the memo below),
 * never one recomputed at request time: a daemon that recomputed would report
 * the new build the moment someone rebuilt, i.e. it would report exactly the
 * state this module exists to detect.
 */

import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';

/** Workspace packages whose `dist` the daemon actually loads, in build order. */
export const DAEMON_BUILD_PACKAGES = ['shared', 'hooks', 'bridge'] as const;
export type DaemonBuildPackage = (typeof DAEMON_BUILD_PACKAGES)[number];

export interface DistBuildIdentity {
  /** 12 hex chars, or null when no dist tree could be read at all. */
  id: string | null;
  /** The dist directories that went into it (realpaths, deduped). */
  trees: string[];
  files: number;
  bytes: number;
}

/**
 * `bridge/dist` — the directory this module was loaded from.
 *
 * With one deliberate exception: when this file is being executed straight from
 * `bridge/src` (vitest, tsx), the built tree it should describe is the sibling
 * `dist`. Reporting the source directory instead would digest a directory with
 * no `.js` in it and answer "no build at all", which is a wrong answer rather
 * than a missing one.
 */
function selfDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  if (here.split(sep).pop() === 'src') {
    const sibling = join(dirname(here), 'dist');
    if (existsSync(sibling)) return sibling;
  }
  return here;
}

/** `bridge/` — the package root of the running CLI. */
function selfPackageDir(): string {
  return dirname(selfDistDir());
}

/**
 * The workspace root of a source checkout, or null when this is an installed
 * package.
 *
 * Keyed on `pnpm-workspace.yaml` beside a `bridge/src`: an installed
 * `@agentdeck/bridge` has a `dist` and no `src`, and nothing else on the path
 * up from `bridge/dist` carries both markers.
 */
export function findSourceCheckout(startDir = selfPackageDir()): string | null {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')) && existsSync(join(dir, 'bridge', 'src'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Every dist tree the daemon loads code from.
 *
 * `shared` and `hooks` are separate packages reached through node_modules
 * symlinks, so hashing `bridge/dist` alone would call a daemon "current" while
 * it ran a stale `shared`. Both layouts resolve here: the workspace sibling
 * (`<root>/shared/dist`) and the installed copy
 * (`bridge/node_modules/@agentdeck/shared/dist`). In a pnpm workspace the two
 * are the same directory through a symlink, which `realpathSync` collapses.
 */
function distTrees(): string[] {
  const trees: string[] = [];
  const add = (dir: string): void => {
    if (!existsSync(dir)) return;
    let real = dir;
    try { real = realpathSync(dir); } catch { /* keep the literal path */ }
    if (!trees.includes(real)) trees.push(real);
  };
  add(selfDistDir());
  const root = findSourceCheckout();
  for (const pkg of DAEMON_BUILD_PACKAGES) {
    if (pkg === 'bridge') continue;
    if (root) add(join(root, pkg, 'dist'));
    add(join(selfPackageDir(), 'node_modules', '@agentdeck', pkg, 'dist'));
  }
  return trees.sort();
}

/** Every `.js` under `dir`, relative and sorted, skipping test output. */
function jsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && (entry.name.endsWith('.js') || entry.name.endsWith('.cjs'))) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

let memoized: DistBuildIdentity | null = null;

/**
 * Digest the built JavaScript this process would load, reading the files now.
 *
 * The uncached entry point exists for exactly one caller: the CLI, comparing
 * the tree before and after running the compiler. Everything else wants
 * `distBuildIdentity()`.
 */
export function computeDistBuildIdentity(): DistBuildIdentity {
  const trees = distTrees();
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  for (const tree of trees) {
    // The tree's own basename, not its absolute path: two checkouts of the same
    // commit must digest identically, or a worktree would always read as a
    // different build from the repo it was cut from.
    const label = tree.split(sep).slice(-2).join('/');
    for (const file of jsFilesUnder(tree)) {
      let content: Buffer;
      try { content = readFileSync(file); } catch { continue; }
      hash.update(`${label}/${relative(tree, file).split(sep).join('/')}\0${content.length}\0`);
      hash.update(content);
      files++;
      bytes += content.length;
    }
  }
  return {
    id: files > 0 ? hash.digest('hex').slice(0, 12) : null,
    trees,
    files,
    bytes,
  };
}

/**
 * The digest, memoized for the life of the process.
 *
 * The memo is the point rather than an optimisation: the daemon calls this once
 * at startup and every later `/health` answers with that same value, so a
 * rebuild underneath a running daemon shows up as a MISMATCH instead of being
 * quietly absorbed. A CLI that has just rebuilt re-executes itself (a new
 * process, a fresh memo) rather than continuing in place — mixing a freshly
 * compiled `daemon-server.js` into a process that already loaded the old
 * `cli.js` is not a build anyone chose.
 */
export function distBuildIdentity(): DistBuildIdentity {
  if (!memoized) memoized = computeDistBuildIdentity();
  return memoized;
}

/** Convenience: just the digest. */
export function distBuildId(): string | null {
  return distBuildIdentity().id;
}

export interface StalePackage {
  pkg: DaemonBuildPackage;
  /** The newest source file that the build does not contain. */
  newestSource: string;
  sourceMtimeMs: number;
  /** 0 when the package has no dist at all — it has never been built. */
  distMtimeMs: number;
}

/** Newest mtime under `dir` among files `accept`s, with the file that set it. */
function newestFile(dir: string, accept: (name: string) => boolean): { path: string; mtimeMs: number } | null {
  let best: { path: string; mtimeMs: number } | null = null;
  const walk = (current: string): void => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '__tests__' || entry.name.startsWith('.')) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !accept(entry.name)) continue;
      let mtimeMs: number;
      try { mtimeMs = statSync(full).mtimeMs; } catch { continue; }
      if (!best || mtimeMs > best.mtimeMs) best = { path: full, mtimeMs };
    }
  };
  walk(dir);
  return best;
}

const isBuildableSource = (name: string): boolean =>
  name.endsWith('.ts')
  && !name.endsWith('.d.ts')
  && !name.endsWith('.test.ts')
  && !name.endsWith('.spec.ts');

const isBuildOutput = (name: string): boolean => name.endsWith('.js') || name.endsWith('.cjs');

/**
 * Packages whose `src` is newer than their `dist` — i.e. edits that no build
 * has picked up yet.
 *
 * Compared PER PACKAGE, not against one global build time: the three are built
 * by separate `tsc` invocations at separate moments, and a single newest-dist
 * timestamp would call `shared` current whenever `bridge` had been rebuilt
 * after it.
 *
 * Test sources are excluded deliberately — they compile to nothing the daemon
 * loads, and counting them would report a stale build for every test edit and
 * make the warning worth ignoring.
 *
 * Read this as a CONSERVATIVE pre-filter, not as proof: it is one-directional.
 * "No source is newer than its build" is reliable (nothing writes a source file
 * with a backdated mtime — git checkout stamps the current time), so a clean
 * answer safely skips the compiler. The other direction over-reports, and must:
 * `shared` is a composite project, so `tsc` keys on content hashes and rewrites
 * NOTHING — not even its `.tsbuildinfo` — when a `touch`, a rebase or a
 * worktree switch bumps an mtime without changing a byte. That is why the
 * caller settles the question by running the compiler and comparing build
 * digests rather than by trusting this.
 */
export function findStaleSources(root: string): StalePackage[] {
  const stale: StalePackage[] = [];
  for (const pkg of DAEMON_BUILD_PACKAGES) {
    const srcDir = join(root, pkg, 'src');
    const distDir = join(root, pkg, 'dist');
    if (!existsSync(srcDir)) continue;
    const newestSrc = newestFile(srcDir, isBuildableSource);
    if (!newestSrc) continue;
    const newestDist = existsSync(distDir) ? newestFile(distDir, isBuildOutput) : null;
    const distMtimeMs = newestDist?.mtimeMs ?? 0;
    if (newestSrc.mtimeMs > distMtimeMs) {
      stale.push({ pkg, newestSource: newestSrc.path, sourceMtimeMs: newestSrc.mtimeMs, distMtimeMs });
    }
  }
  return stale;
}

export interface BuildResult {
  ok: boolean;
  /** Why it could not run, when `ok` is false and no compiler ran at all. */
  reason?: string;
}

/**
 * Rebuild the stale packages, in dependency order.
 *
 * Only the stale ones: `bridge/dist` does not embed `shared`'s output (it
 * imports it at runtime through the workspace symlink), so a `shared` edit does
 * not invalidate a `bridge` build. Ordering still matters for the case where
 * more than one is stale — `bridge`'s `tsc` reads `shared/dist/*.d.ts`.
 *
 * stdio is inherited: a build that fails must show the compiler's own errors,
 * and a build that takes 30 seconds must show that it is running. Swallowing
 * either would leave "start" looking hung or looking successful.
 */
export function buildPackages(root: string, pkgs: readonly DaemonBuildPackage[], pnpmBin = 'pnpm'): BuildResult {
  const ordered = DAEMON_BUILD_PACKAGES.filter((p) => pkgs.includes(p));
  if (ordered.length === 0) return { ok: true };
  for (const pkg of ordered) {
    // windows-hide-exempt: a build runs only from a CLI invocation with a
    // terminal attached — never on the autostart path, which passes
    // `--no-build` — and the inherited stdio below is that terminal.
    const res = spawnSync(pnpmBin, ['--filter', `@agentdeck/${pkg}`, 'build'], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (res.error) {
      const err = res.error as NodeJS.ErrnoException;
      return { ok: false, reason: err.code === 'ENOENT' ? `\`${pnpmBin}\` is not on PATH` : String(err.message) };
    }
    if (res.status !== 0) return { ok: false };
  }
  return { ok: true };
}
