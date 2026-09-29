import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateRoot, privateOutput, safeName, claimAttempt } from '../apme-serving-evidence.mjs';

const temporary: string[] = [];
const temp = () => {
  const path = mkdtempSync(join(tmpdir(), 'apme-evidence-'));
  temporary.push(path);
  return path;
};
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('private replay evidence boundaries', () => {
  it('preserves interrupted attempts instead of silently rerunning them', () => {
    const output = privateOutput(privateRoot(temp(), []), 'attempts');
    claimAttempt(output, 'AD01-1');
    expect(() => claimAttempt(output, 'AD01-1')).toThrow();
    expect(() => claimAttempt(output, 'AD01-2')).not.toThrow();
  });
  it('requires an explicit fixture root', () => expect(() => privateRoot(undefined)).toThrow(/explicit/));
  it.each(['../live', '/tmp/escape', '..', '.', 'settings', 'a/b', 'a\\b', ''])(
    'rejects unsafe profile/case %j',
    (name) => {
      expect(() => safeName(name)).toThrow();
    },
  );
  it('rejects live data directories, descendants and symlink aliases', () => {
    const root = temp();
    const live = join(root, 'live');
    mkdirSync(live);
    const nested = join(live, 'nested');
    mkdirSync(nested);
    const alias = join(root, 'alias');
    symlinkSync(live, alias, 'junction');
    for (const input of [live, nested, alias]) expect(() => privateRoot(input, [live])).toThrow(/outside/);
    expect(privateRoot(root, [live])).toBeTruthy();
  });
  it('rejects output symlinks and accepts an isolated profile', () => {
    const root = privateRoot(temp(), []);
    const outside = temp();
    symlinkSync(outside, join(root, 'redirect'), 'junction');
    expect(() => privateOutput(root, 'redirect')).toThrow(/symlinks/);
    expect(privateOutput(root, 'mlx-baseline')).toBe(join(root, 'mlx-baseline'));
  });
});
