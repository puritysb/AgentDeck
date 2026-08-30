import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNodePtySpawnHelperExecutable } from '../pty-manager.js';

const roots: string[] = [];

function fixture(mode: number, location: 'prebuild' | 'source' = 'prebuild'): {
  root: string;
  helper: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'agentdeck-node-pty-'));
  roots.push(root);
  const helper = location === 'prebuild'
    ? join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper')
    : join(root, 'build', 'Release', 'spawn-helper');
  mkdirSync(join(helper, '..'), { recursive: true });
  writeFileSync(helper, 'helper');
  chmodSync(helper, mode);
  return { root, helper };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ensureNodePtySpawnHelperExecutable', () => {
  it('repairs the 0644 mode shipped by node-pty 1.1.0 on macOS', () => {
    const { root, helper } = fixture(0o644);

    expect(ensureNodePtySpawnHelperExecutable(root, 'darwin', 'arm64')).toBe(helper);
    expect(lstatSync(helper).mode & 0o777).toBe(0o755);
  });

  it('leaves an already executable helper unchanged', () => {
    const { root, helper } = fixture(0o750);

    expect(ensureNodePtySpawnHelperExecutable(root, 'darwin', 'arm64')).toBeNull();
    expect(lstatSync(helper).mode & 0o777).toBe(0o750);
  });

  it('repairs a source-built helper when no prebuild is present', () => {
    const { root, helper } = fixture(0o600, 'source');

    expect(ensureNodePtySpawnHelperExecutable(root, 'darwin', 'arm64')).toBe(helper);
    expect(lstatSync(helper).mode & 0o777).toBe(0o700);
  });

  it('is a no-op outside macOS', () => {
    const { root, helper } = fixture(0o644);

    expect(ensureNodePtySpawnHelperExecutable(root, 'linux', 'arm64')).toBeNull();
    expect(lstatSync(helper).mode & 0o777).toBe(0o644);
  });

  it('does not chmod a symlink in place of the package helper', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentdeck-node-pty-'));
    roots.push(root);
    const target = join(root, 'target');
    const helper = join(root, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    mkdirSync(join(helper, '..'), { recursive: true });
    writeFileSync(target, 'target');
    chmodSync(target, 0o644);
    symlinkSync(target, helper);

    expect(ensureNodePtySpawnHelperExecutable(root, 'darwin', 'arm64')).toBeNull();
    expect(lstatSync(target).mode & 0o777).toBe(0o644);
  });
});
