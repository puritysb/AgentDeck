import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectInstallation, verifyRuntime, digest, waitForRuntimeExit } from '../../plugin/scripts/deployment-state.mjs';
import { captureRuntimeIdentity } from '../../plugin/src/runtime-identity.js';

describe('plugin deployment identity', () => {
  it('distinguishes Marketplace directories, missing installs, wrong and correct source links', () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-install-'));
    try {
      const source = join(root, 'source'), other = join(root, 'other'), installed = join(root, 'installed');
      mkdirSync(source); mkdirSync(other);
      expect(inspectInstallation(source, installed)).toContain('unavailable');
      mkdirSync(installed);
      expect(inspectInstallation(source, installed)).toContain('packaged');
      rmSync(installed, { recursive: true });
      symlinkSync(other, installed, 'junction');
      expect(inspectInstallation(source, installed)).toContain('another checkout');
      rmSync(installed); symlinkSync(source, installed, 'junction');
      expect(inspectInstallation(source, installed)).toBeNull();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('keeps startup identity when disk bytes are rebuilt', () => {
    const root = mkdtempSync(join(tmpdir(), 'plugin-runtime-'));
    try {
      const file = join(root, 'plugin.js'); writeFileSync(file, 'old');
      const running = captureRuntimeIdentity(pathToFileURL(file).href);
      writeFileSync(file, 'new');
      expect(running.sha256).not.toBe(digest(file));
      expect(verifyRuntime(running, { bundlePath: file, sha256: digest(file), notBefore: 0 }, () => true)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('requires matching bytes, path, fresh startup and a live process', () => {
    const expected = { bundlePath: '/stable/plugin.js', sha256: 'new', notBefore: 100 };
    const good = { ...expected, pid: 123, startedAt: 101 };
    expect(verifyRuntime(good, expected, () => true)).toBe(true);
    for (const change of [{ sha256: 'old' }, { bundlePath: '/worktree/plugin.js' }, { startedAt: 99 }, { startedAt: undefined }, { pid: 0 }]) {
      expect(verifyRuntime({ ...good, ...change }, expected, () => true)).toBe(false);
    }
    expect(verifyRuntime(good, expected, () => false)).toBe(false);
    expect(verifyRuntime(null, expected, () => true)).toBe(false);
  });
});

it('waits for asynchronous SDK stop before allowing a restart and refuses a stuck runtime', async () => {
  let now = 0, probes = 0;
  const clock = { now: () => now, sleep: async (ms: number) => { now += ms; }, budgetMs: 500 };
  await waitForRuntimeExit(123, () => ++probes <= 3, clock);
  expect(probes).toBe(4);
  expect(now).toBe(300);
  await expect(waitForRuntimeExit(123, () => true, clock)).rejects.toThrow('did not stop');
});
