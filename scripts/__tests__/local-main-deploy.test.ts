import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validateCheckout } from '../deploy-local-main.mjs';

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
