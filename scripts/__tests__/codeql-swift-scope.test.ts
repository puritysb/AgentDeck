import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';

it('only omits Swift for an entirely regular prose diff', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codeql-scope-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  const decision = (base: string) => execFileSync('python3', [
    resolve('scripts/codeql-swift-scope.py'), base, 'HEAD',
  ], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = () => {
    git('add', '-A');
    git('-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false',
      'commit', '-qm', 'fixture');
  };
  try {
    git('init', '-q');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'README.md'), 'original');
    commit();
    expect(decision('HEAD')).toBe('docs_only=false');
    expect(decision('unknown-revision')).toBe('docs_only=false');
    writeFileSync(join(dir, 'README.md'), 'updated');
    commit();
    expect(decision('HEAD^')).toBe('docs_only=true');
    writeFileSync(join(dir, 'docs/appstore-metadata-draft.md'), 'release input');
    commit();
    expect(decision('HEAD~2')).toBe('docs_only=false');
    git('mv', 'docs/appstore-metadata-draft.md', 'SECURITY.md');
    commit();
    expect(decision('HEAD^')).toBe('docs_only=false');
    chmodSync(join(dir, 'SECURITY.md'), 0o755);
    git('update-index', '--chmod=+x', 'SECURITY.md');
    commit();
    expect(decision('HEAD^')).toBe('docs_only=false');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
