/**
 * Resolve a stable project label for a working directory.
 *
 * Order:
 *   1. AGENTDECK_PROJECT_NAME env var (explicit opt-out)
 *   2. Git root → repository label (linked worktrees include their folder name)
 *   3. Nearest ancestor `package.json` with a non-empty `name` field
 *   4. basename(cwd)
 *   5. 'unknown'
 *
 * The monorepo-root case is handled by (2); (3) only fires outside git, where
 * the user almost certainly cares about cwd-local identity, so nearest-match
 * (not outermost) is the right semantics.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const MAX_WALK_DEPTH = 32;

export interface ResolveProjectNameOptions {
  cwd?: string;
  envOverride?: string;
}

export function resolveProjectName(opts: ResolveProjectNameOptions = {}): string {
  const cwd = opts.cwd ?? process.cwd();
  const envValue = opts.envOverride ?? process.env.AGENTDECK_PROJECT_NAME;
  if (typeof envValue === 'string' && envValue.trim() !== '') return envValue.trim();

  const gitName = gitToplevelBasename(cwd);
  if (gitName) return gitName;

  const pkgName = nearestPackageJsonName(cwd);
  if (pkgName) return pkgName;

  const base = basename(cwd);
  if (base) return base;

  return 'unknown';
}

export function gitToplevelBasename(cwd: string): string | null {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      windowsHide: true,
    }).trim();
    if (!out) return null;
    return gitProjectLabel(out);
  } catch {
    return null;
  }
}

/**
 * Subprocess-free variant for hot paths (the passive observer resolves names
 * inside a periodic process scan, where spawning `git` per session would
 * reintroduce the event-loop stalls that scan was made async to avoid).
 *
 * Same order as `resolveProjectName` but detects the git root by walking
 * ancestors for a `.git` entry (dir OR file — submodule/worktree layouts) —
 * the exact algorithm of the Swift mirror
 * (apple/AgentDeck/Daemon/Core/ProjectNameResolver.swift), so both daemons
 * label the same cwd identically. Results are memoized per cwd.
 */
const cwdNameCache = new Map<string, string>();

export function resolveProjectNameFromCwdCached(cwd: string): string {
  const key = resolve(cwd);
  const hit = cwdNameCache.get(key);
  if (hit) return hit;

  const name =
    gitToplevelBasenameFs(key) ??
    nearestPackageJsonName(key) ??
    (basename(key) || 'unknown');
  // Bound the memo — cwds are few in practice, but a long-lived daemon
  // observing many short-lived sessions shouldn't grow without limit.
  if (cwdNameCache.size >= 256) cwdNameCache.clear();
  cwdNameCache.set(key, name);
  return name;
}

/** Ancestor walk for a `.git` entry; preserves linked-worktree context. */
export function gitToplevelBasenameFs(cwd: string, compact = false): string | null {
  let dir = cwd;
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    if (existsSync(join(dir, '.git'))) {
      return gitProjectLabel(dir, compact);
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * A linked worktree points to an admin directory containing `commondir`.
 * Only a readable common .git directory proves the original checkout name.
 * Submodules (no commondir), bare repos and broken/sandbox-denied metadata keep
 * the local name. Keep the worktree suffix: display folding must not collapse
 * independently steerable tasks. Shared project-name-vectors.json pins Swift parity.
 */
function gitProjectLabel(root: string, compact = false): string | null {
  const localName = basename(root);
  try {
    const marker = readFileSync(join(root, '.git'), 'utf-8').trim();
    if (!marker.startsWith('gitdir:')) return localName || null;
    const pointer = marker.slice('gitdir:'.length).trim();
    if (!pointer) return localName || null;
    const gitDir = resolve(root, pointer);
    const commonPointer = readFileSync(join(gitDir, 'commondir'), 'utf-8').trim();
    if (!commonPointer) return localName || null;
    const commonDir = resolve(gitDir, commonPointer);
    if (basename(commonDir) !== '.git' || !existsSync(join(commonDir, 'HEAD'))) {
      return localName || null;
    }
    const repositoryName = basename(dirname(commonDir));
    if (repositoryName) return compact ? repositoryName : `${repositoryName} · ${localName}`;
  } catch {
    // Directory marker, submodule, missing metadata, or access denied.
  }
  return localName || null;
}

export function nearestPackageJsonName(cwd: string): string | null {
  let dir = cwd;
  for (let i = 0; i < MAX_WALK_DEPTH; i++) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);
      if (pkg && typeof pkg.name === 'string' && pkg.name.trim() !== '') {
        return pkg.name.trim();
      }
    } catch {
      // no package.json here or parse failed — keep walking
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const compactNameCache = new Map<string, string>();
/** Shorten only a verified auto-generated label; explicit names are untouched. */
export function compactProjectName(projectName: string, cwd?: string): string {
  if (!cwd || resolveProjectNameFromCwdCached(cwd) !== projectName) return projectName;
  const key = resolve(cwd);
  let name = compactNameCache.get(key);
  if (name === undefined) {
    name = gitToplevelBasenameFs(key, true) ?? projectName;
    if (compactNameCache.size >= 256) compactNameCache.clear();
    compactNameCache.set(key, name);
  }
  return name;
}
