import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detachedEnv, pruneAppBackups, validateCheckout, waitForDaemonHealth } from '../deploy-local-main.mjs';

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
