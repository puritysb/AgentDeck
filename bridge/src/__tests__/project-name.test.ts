import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  resolveProjectName,
  compactProjectName,
  resolveProjectNameFromCwdCached,
  gitToplevelBasename,
  gitToplevelBasenameFs,
  nearestPackageJsonName,
} from '../utils/project-name.js';

describe('resolveProjectName', () => {
  let tmpRoot: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `agentdeck-project-name-${randomUUID()}`);
    mkdirSync(tmpRoot, { recursive: true });
    prevEnv = process.env.AGENTDECK_PROJECT_NAME;
    delete process.env.AGENTDECK_PROJECT_NAME;
  });

  afterEach(() => {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevEnv === undefined) delete process.env.AGENTDECK_PROJECT_NAME;
    else process.env.AGENTDECK_PROJECT_NAME = prevEnv;
  });

  it('returns git toplevel basename from a nested subdir', () => {
    const repo = join(tmpRoot, 'MyRepo');
    const sub = join(repo, 'apple', 'deep');
    mkdirSync(sub, { recursive: true });
    execSync('git init -q', { cwd: repo });
    expect(resolveProjectName({ cwd: sub })).toBe('MyRepo');
  });

  it('labels real linked worktrees consistently without reading or changing their branch', () => {
    const repo = join(tmpRoot, 'Main Repo');
    const worktree = join(tmpRoot, 'task');
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
    git('init', '-q');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-qm', 'init');
    git('worktree', 'add', '-qb', 'different-branch-name', worktree);
    expect(resolveProjectName({ cwd: worktree })).toBe('Main Repo · task');
    expect(resolveProjectNameFromCwdCached(worktree)).toBe('Main Repo · task');
    expect(resolveProjectName({ cwd: worktree, envOverride: 'Explicit' })).toBe('Explicit');
    expect(resolveProjectName({ cwd: repo })).toBe('Main Repo');
  });

  it('falls back to nearest package.json name when no git', () => {
    const outer = join(tmpRoot, 'non-git');
    const inner = join(outer, 'pkg');
    const leaf = join(inner, 'src');
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'outer' }));
    writeFileSync(join(inner, 'package.json'), JSON.stringify({ name: '@scope/inner' }));
    expect(resolveProjectName({ cwd: leaf })).toBe('@scope/inner');
  });

  it('skips package.json with empty name and keeps walking', () => {
    const outer = join(tmpRoot, 'non-git');
    const inner = join(outer, 'pkg');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'outer' }));
    writeFileSync(join(inner, 'package.json'), JSON.stringify({ name: '' }));
    expect(resolveProjectName({ cwd: inner })).toBe('outer');
  });

  it('falls back to cwd basename when no git and no package.json', () => {
    const bare = join(tmpRoot, 'xyz');
    mkdirSync(bare, { recursive: true });
    expect(resolveProjectName({ cwd: bare })).toBe('xyz');
  });

  it("returns 'unknown' for a basename-less root", () => {
    expect(resolveProjectName({ cwd: '/' })).toBe('unknown');
  });

  it('AGENTDECK_PROJECT_NAME env var wins over everything', () => {
    const repo = join(tmpRoot, 'MyRepo');
    mkdirSync(repo, { recursive: true });
    execSync('git init -q', { cwd: repo });
    process.env.AGENTDECK_PROJECT_NAME = 'Override';
    expect(resolveProjectName({ cwd: repo })).toBe('Override');
  });

  it('envOverride option takes precedence over env var', () => {
    process.env.AGENTDECK_PROJECT_NAME = 'FromEnv';
    expect(resolveProjectName({ cwd: tmpRoot, envOverride: 'FromOption' })).toBe('FromOption');
  });

  it('preserves scoped package name verbatim', () => {
    const dir = join(tmpRoot, 'scoped');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@agentdeck/bridge' }));
    expect(resolveProjectName({ cwd: dir })).toBe('@agentdeck/bridge');
  });

  it('git subprocess error (non-repo) does not throw', () => {
    const bare = join(tmpRoot, 'non-repo');
    mkdirSync(bare, { recursive: true });
    expect(() => resolveProjectName({ cwd: bare })).not.toThrow();
  });

  it('malformed package.json is ignored (walks to parent)', () => {
    const outer = join(tmpRoot, 'non-git');
    const inner = join(outer, 'bad');
    mkdirSync(inner, { recursive: true });
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'outer' }));
    writeFileSync(join(inner, 'package.json'), '{not valid json');
    expect(resolveProjectName({ cwd: inner })).toBe('outer');
  });
});

describe('gitToplevelBasename', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `agentdeck-git-toplevel-${randomUUID()}`);
    mkdirSync(tmpRoot, { recursive: true });
  });
  afterEach(() => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('returns null outside a git worktree', () => {
    expect(gitToplevelBasename(tmpRoot)).toBeNull();
  });

  it('returns repo basename from nested subdir', () => {
    const repo = join(tmpRoot, 'ReporNamed');
    const sub = join(repo, 'a', 'b');
    mkdirSync(sub, { recursive: true });
    execSync('git init -q', { cwd: repo });
    expect(gitToplevelBasename(sub)).toBe('ReporNamed');
  });
});

describe('resolveProjectNameFromCwdCached (passive-observer resolver)', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `agentdeck-cwd-cached-${randomUUID()}`);
    mkdirSync(tmpRoot, { recursive: true });
  });
  afterEach(() => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('matches the PTY resolver for a git repo subdir (launch-path parity)', () => {
    const repo = join(tmpRoot, 'MyRepo');
    const sub = join(repo, 'bridge', 'src');
    mkdirSync(sub, { recursive: true });
    execSync('git init -q', { cwd: repo });
    expect(resolveProjectNameFromCwdCached(sub)).toBe('MyRepo');
    expect(resolveProjectNameFromCwdCached(sub)).toBe(resolveProjectName({ cwd: sub }));
  });

  it('detects a .git FILE (worktree/submodule layout)', () => {
    const wt = join(tmpRoot, 'MyWorktree');
    const sub = join(wt, 'deep');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere/.git/worktrees/MyWorktree\n');
    expect(gitToplevelBasenameFs(sub)).toBe('MyWorktree');
    expect(resolveProjectNameFromCwdCached(sub)).toBe('MyWorktree');
  });

  it('falls back to package.json name, then basename', () => {
    const pkgDir = join(tmpRoot, 'pkgd');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@scope/thing' }));
    expect(resolveProjectNameFromCwdCached(pkgDir)).toBe('@scope/thing');

    const bare = join(tmpRoot, 'barename');
    mkdirSync(bare, { recursive: true });
    expect(resolveProjectNameFromCwdCached(bare)).toBe('barename');
  });

  it('memoizes per cwd (stale after dir changes are acceptable)', () => {
    const dir = join(tmpRoot, 'memo');
    mkdirSync(dir, { recursive: true });
    expect(resolveProjectNameFromCwdCached(dir)).toBe('memo');
    // Turning the dir into a git repo later does not change the cached label.
    execSync('git init -q', { cwd: dir });
    expect(resolveProjectNameFromCwdCached(dir)).toBe('memo');
  });
});

describe('nearestPackageJsonName', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = join(tmpdir(), `agentdeck-pkg-walk-${randomUUID()}`);
    mkdirSync(tmpRoot, { recursive: true });
  });
  afterEach(() => { try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('returns null when no ancestor has package.json', () => {
    const bare = join(tmpRoot, 'alone');
    mkdirSync(bare, { recursive: true });
    expect(nearestPackageJsonName(bare)).toBeNull();
  });

  it('returns nearest ancestor name', () => {
    const outer = join(tmpRoot, 'o');
    const inner = join(outer, 'i');
    const leaf = join(inner, 'l');
    mkdirSync(leaf, { recursive: true });
    writeFileSync(join(outer, 'package.json'), JSON.stringify({ name: 'outer' }));
    writeFileSync(join(inner, 'package.json'), JSON.stringify({ name: 'inner' }));
    expect(nearestPackageJsonName(leaf)).toBe('inner');
  });
});

// This fixture is also replayed by ProjectNameResolverTests.swift.
const projectVectors = JSON.parse(readFileSync(new URL('../../../shared/project-name-vectors.json', import.meta.url), 'utf8')) as {
  name: string; cwd: string; files: Record<string, string>; expected: string; compactExpected: string;
}[];
describe('shared worktree project-label contract', () => {
  for (const vector of projectVectors) {
    it(vector.name, () => {
      const root = join(tmpdir(), `agentdeck-project-vector-${randomUUID()}`);
      try {
        const cwd = join(root, vector.cwd);
        mkdirSync(cwd, { recursive: true });
        for (const [path, content] of Object.entries(vector.files)) {
          const destination = join(root, path);
          mkdirSync(dirname(destination), { recursive: true });
          writeFileSync(destination, content.replaceAll('$ROOT', root));
        }
        expect(gitToplevelBasenameFs(cwd)).toBe(vector.expected);
        expect(resolveProjectNameFromCwdCached(cwd)).toBe(vector.expected);
        expect(compactProjectName(vector.expected, cwd)).toBe(vector.compactExpected);
        expect(compactProjectName("Explicit · literal", cwd)).toBe("Explicit · literal");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
