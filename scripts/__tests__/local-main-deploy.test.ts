import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { realpathSync, readFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beforeSwap, detachedEnv, hasAppStoreReceipt, installMacApp, pruneAppBackups, validateCheckout, waitForDaemonHealth } from '../deploy-local-main.mjs';

const roots: string[] = [];
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'agentdeck-deploy-test-')));
  roots.push(root);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'master');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  const commit = (body: string) => {
    writeFileSync(join(root, 'source.txt'), body);
    git('add', 'source.txt');
    git('-c', 'commit.gpgsign=false', 'commit', '-m', body);
    return git('rev-parse', 'HEAD');
  };
  const sha = commit('initial');
  git('update-ref', 'refs/remotes/origin/master', sha);
  return { root, git, sha, commit };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('local deployment checkout ownership', () => {
  it('accepts an older queued event but deploys the newest main commit', () => {
    const f = fixture();
    const latest = f.commit('new main');
    f.git('update-ref', 'refs/remotes/origin/master', latest);
    expect(validateCheckout(f.root, f.sha)).toBe(latest);
  });
  it('refuses tracked edits without changing another session’s file', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'source.txt'), 'in progress');
    expect(() => validateCheckout(f.root, f.sha)).toThrow('Tracked changes');
    expect(f.git('diff')).toContain('in progress');
  });
  it('refuses a task branch or a local-only commit', () => {
    const f = fixture();
    f.git('checkout', '-b', 'codex/other-session');
    expect(() => validateCheckout(f.root, f.sha)).toThrow('requires master');
    f.git('checkout', 'master');
    f.commit('unmerged local work');
    expect(() => validateCheckout(f.root, f.sha)).toThrow('differs from origin/master');
  });
  it('rejects a trigger from an unmerged branch', () => {
    const f = fixture();
    f.git('checkout', '-b', 'codex/unmerged');
    const unmerged = f.commit('unmerged');
    f.git('checkout', 'master');
    expect(() => validateCheckout(f.root, unmerged)).toThrow();
  });
  it('permits untracked development diagnostics', () => {
    const f = fixture();
    writeFileSync(join(f.root, 'local-diagnostics.txt'), 'owned by another session');
    expect(validateCheckout(f.root, f.sha)).toBe(f.sha);
  });
});

describe('local deployment runtime handover', () => {
  it('launches the app outside the runner job so job cleanup cannot kill it', () => {
    const env = detachedEnv({ RUNNER_TRACKING_ID: 'github_1234', PATH: '/usr/bin' });
    expect(env.RUNNER_TRACKING_ID).toBe('');
    expect(env.PATH).toBe('/usr/bin');
  });

  const healthy = (body: Record<string, unknown>) => ({ ok: true, status: 200, json: async () => body });

  it('keeps probing a daemon that is still starting instead of failing the deployment', async () => {
    let clock = 0;
    const answers = [
      () => { throw new Error('The operation was aborted due to timeout'); },
      () => healthy({ pid: 41, build: 'old' }),
      () => healthy({ pid: 42, build: 'new' }),
    ];
    const registries = [{ port: 9120, pid: 41 }, { port: 9120, pid: 41 }, { port: 9120, pid: 42 }];
    let attempt = 0;
    const result = await waitForDaemonHealth({
      build: 'new',
      readRegistry: () => registries[Math.min(attempt, registries.length - 1)],
      fetchImpl: async () => answers[attempt++](),
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
    });
    expect(result.health).toEqual({ pid: 42, build: 'new' });
    expect(attempt).toBe(3);
  });

  it('fails with the last reason once the deadline passes', async () => {
    let clock = 0;
    await expect(waitForDaemonHealth({
      build: 'new',
      readRegistry: () => ({ port: 9120, pid: 7 }),
      fetchImpl: async () => healthy({ pid: 7, build: 'old' }),
      deadlineMs: 3_000,
      now: () => clock,
      sleep: async (ms: number) => { clock += ms; },
    })).rejects.toThrow('build old differs from installed new');
  });

  it('discards the staged app when a step before the swap fails, and keeps it otherwise', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentdeck-staged-')));
    roots.push(dir);
    const staged = join(dir, 'AgentDeck.deploy-staged.app');
    const stage = () => mkdirSync(join(staged, 'Contents'), { recursive: true });
    const quitTimeout = new Error('Installed app did not quit; preserving it');
    await expect(beforeSwap(staged, async () => { stage(); throw quitTimeout; })).rejects.toBe(quitTimeout);
    expect(existsSync(staged)).toBe(false);
    // A step that fails before anything was copied still reports its own error.
    const noSource = new Error('stage-app failed');
    await expect(beforeSwap(staged, async () => { throw noSource; })).rejects.toBe(noSource);
    await beforeSwap(staged, async () => { stage(); });
    expect(existsSync(staged)).toBe(true);
  });

  it('keeps the newest app backups and leaves unrelated files alone', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentdeck-backups-')));
    roots.push(dir);
    for (const stamp of [100, 400, 200, 300, 50]) mkdirSync(join(dir, `AgentDeck-${stamp}.app`, 'Contents'), { recursive: true });
    writeFileSync(join(dir, 'notes.txt'), 'keep');
    expect(pruneAppBackups(dir, 3).sort()).toEqual(['AgentDeck-100.app', 'AgentDeck-50.app']);
    expect(readdirSync(dir).sort()).toEqual(['AgentDeck-200.app', 'AgentDeck-300.app', 'AgentDeck-400.app', 'notes.txt']);
    expect(pruneAppBackups(join(dir, 'missing'))).toEqual([]);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
  });
});

describe('macOS installation provenance and recovery', () => {
  function appFixture() {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'agentdeck-store-deploy-')));
    roots.push(dir);
    const target = join(dir, 'AgentDeck.app');
    const staged = join(dir, 'AgentDeck.deploy-staged.app');
    const backup = join(dir, 'AgentDeck-123.app');
    mkdirSync(target);
    writeFileSync(join(target, 'build'), '9401');
    const receipt = () => {
      mkdirSync(join(target, 'Contents/_MASReceipt'), { recursive: true });
      writeFileSync(join(target, 'Contents/_MASReceipt/receipt'), 'store receipt');
    };
    const prepare = vi.fn(async () => { mkdirSync(staged); writeFileSync(join(staged, 'build'), 'development'); });
    const quit = vi.fn(async () => {});
    const launch = vi.fn(async () => {});
    return { target, staged, backup, receipt, prepare, quit, launch };
  }

  it('never stages, quits or replaces a Store app, including when an old stage is present', async () => {
    const f = appFixture(); f.receipt(); mkdirSync(f.staged);
    const rename = vi.fn();
    expect(await installMacApp({ ...f, rename })).toEqual({ action: 'preserved-app-store', backup: null });
    for (const action of [f.prepare, f.quit, f.launch, rename]) expect(action).not.toHaveBeenCalled();
    expect(readFileSync(join(f.target, 'build'), 'utf8')).toBe('9401');
    expect(readFileSync(join(f.target, 'Contents/_MASReceipt/receipt'), 'utf8')).toBe('store receipt');
    expect(existsSync(f.staged)).toBe(true); // Does not remove an interrupted deployment's evidence.
  });

  it('does not treat a failed receipt probe as a development installation', () => {
    const denied = Object.assign(new Error('receipt denied'), { code: 'EACCES' });
    expect(() => hasAppStoreReceipt('/unused', () => { throw denied; })).toThrow(denied);
    expect(hasAppStoreReceipt('/unused', () => { throw Object.assign(new Error(), { code: 'ENOENT' }); })).toBe(false);
  });

  it('protects a Store install that appears while preparing the development build', async () => {
    const f = appFixture();
    const prepare = async () => { await f.prepare(); f.receipt(); };
    await expect(installMacApp({ ...f, prepare })).rejects.toThrow('App Store installation appeared');
    expect(f.quit).not.toHaveBeenCalled(); expect(f.launch).not.toHaveBeenCalled();
    expect(existsSync(f.staged)).toBe(false);
    expect(readFileSync(join(f.target, 'build'), 'utf8')).toBe('9401');
  });

  it('cleans its stage and relaunches the original when moving the backup is denied', async () => {
    const f = appFixture();
    const denied = Object.assign(new Error('rename denied'), { code: 'EACCES' });
    await expect(installMacApp({ ...f, rename: () => { throw denied; } })).rejects.toThrow(denied);
    expect(f.quit).toHaveBeenCalledOnce(); expect(f.launch).toHaveBeenCalledOnce();
    expect(readFileSync(join(f.target, 'build'), 'utf8')).toBe('9401');
    expect(existsSync(f.staged)).toBe(false); expect(existsSync(f.backup)).toBe(false);
  });

  it('restores the backup and cleans its stage when installing the staged app fails', async () => {
    const f = appFixture();
    const rename = (from: string, to: string) => {
      if (from === f.staged) throw new Error('swap denied');
      renameSync(from, to);
    };
    await expect(installMacApp({ ...f, rename })).rejects.toThrow('swap denied');
    expect(f.launch).toHaveBeenCalledOnce();
    expect(readFileSync(join(f.target, 'build'), 'utf8')).toBe('9401');
    expect(existsSync(f.staged)).toBe(false); expect(existsSync(f.backup)).toBe(false);
  });

  it('still replaces a development app and retains the previous build', async () => {
    const f = appFixture();
    expect(await installMacApp(f)).toEqual({ action: 'replaced-development', backup: f.backup });
    expect(readFileSync(join(f.target, 'build'), 'utf8')).toBe('development');
    expect(readFileSync(join(f.backup, 'build'), 'utf8')).toBe('9401');
    expect(f.quit).toHaveBeenCalledOnce(); expect(f.launch).toHaveBeenCalledOnce();
    expect(existsSync(f.staged)).toBe(false);
  });

  it('rolls back a new build that fails to launch', async () => {
    const f = appFixture();
    const launch = vi.fn().mockRejectedValueOnce(new Error('launch failed')).mockResolvedValueOnce(undefined);
    await expect(installMacApp({ ...f, launch })).rejects.toThrow('launch failed');
    expect(launch).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(f.target, 'build'), 'utf8')).toBe('9401');
    expect(existsSync(f.staged)).toBe(false);
  });

  it('keeps both recovery copies when restoring the backup fails', async () => {
    const f = appFixture();
    const rename = (from: string, to: string) => {
      if (from === f.staged || from === f.backup) throw new Error('recovery denied');
      renameSync(from, to);
    };
    await expect(installMacApp({ ...f, rename })).rejects.toThrow('recovery denied');
    expect(readFileSync(join(f.backup, 'build'), 'utf8')).toBe('9401');
    expect(readFileSync(join(f.staged, 'build'), 'utf8')).toBe('development');
    expect(f.launch).not.toHaveBeenCalled();
  });
});
