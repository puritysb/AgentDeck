import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectInstallation, verifyRuntime, digest, processExists, stopRuntime, waitForRuntime, waitForRuntimeExit } from '../../plugin/scripts/deployment-state.mjs';
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
    expect(verifyRuntime(good, { ...expected, previousPid: good.pid }, () => true)).toBe(false);
    expect(verifyRuntime(good, { ...expected, previousPid: 456 }, () => true)).toBe(true);
    expect(verifyRuntime(good, expected, () => false)).toBe(false);
    expect(verifyRuntime(null, expected, () => true)).toBe(false);
  });
});

it('waits for asynchronous SDK stop before allowing a restart and refuses a stuck runtime', async () => {
  let now = 0, probes = 0;
  const clock = { now: () => now, sleep: async (ms: number) => { now += ms; }, budgetMs: 500, intervalMs: 100 };
  await waitForRuntimeExit(123, () => ++probes <= 3, clock);
  expect(probes).toBe(4);
  expect(now).toBe(300);
  await expect(waitForRuntimeExit(123, () => true, clock)).rejects.toThrow('did not stop');
});


function fakeClock() {
  let elapsedMs = 0;
  const sleeps: number[] = [];
  return {
    elapsed: () => elapsedMs,
    sleeps,
    options: {
      now: () => elapsedMs,
      sleep: async (ms: number) => { sleeps.push(ms); elapsedMs += ms; },
    },
  };
}

const expectedRuntime = { bundlePath: '/stable/plugin.js', sha256: 'new', notBefore: 100 };
const freshRuntime = { ...expectedRuntime, pid: 123, startedAt: 101 };
const processError = (code: string) => Object.assign(new Error(`Process probe ${code}`), { code });

describe('plugin deployment process probes', () => {
  it('reports a process absent only when the operating system returns ESRCH', () => {
    const kill = vi.fn();
    expect(processExists(123, kill)).toBe(true);
    expect(kill).toHaveBeenCalledWith(123, 0);
    expect(processExists(123, () => { throw processError('ESRCH'); })).toBe(false);
  });

  it.each(['EPERM', 'EIO', 'UNKNOWN'])('does not mistake %s for a stopped process', code => {
    const error = processError(code);
    expect(() => processExists(123, () => { throw error; })).toThrow(error);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid pid %s without probing the OS', pid => {
    const kill = vi.fn();
    expect(() => processExists(pid, kill)).toThrow();
    expect(kill).not.toHaveBeenCalled();
  });
});

describe('plugin deployment stop handover', () => {
  it('waits for a 75-second asynchronous stop after sending exactly one stop request', async () => {
    const clock = fakeClock();
    const requestStop = vi.fn();
    const onRetry = vi.fn();
    await stopRuntime(123, requestStop, () => clock.elapsed() < 75_000, { ...clock.options, onRetry });
    expect(requestStop).toHaveBeenCalledTimes(1);
    expect(clock.elapsed()).toBe(75_000);
    expect(onRetry.mock.calls.map(([progress]) => progress)).toEqual([
      { elapsedMs: 20_000, budgetMs: 120_000 },
      { elapsedMs: 40_000, budgetMs: 120_000 },
      { elapsedMs: 60_000, budgetMs: 120_000 },
    ]);
  });

  it('bounds an acknowledged stop that never exits without sending duplicate stop requests', async () => {
    const clock = fakeClock();
    const requestStop = vi.fn();
    await expect(stopRuntime(123, requestStop, () => true, clock.options)).rejects.toThrow('did not stop');
    expect(requestStop).toHaveBeenCalledTimes(1);
    expect(clock.elapsed()).toBe(120_000);
  });

  it('skips the stop command and wait when the previous process is already gone', async () => {
    const clock = fakeClock();
    const requestStop = vi.fn();
    await stopRuntime(123, requestStop, () => false, clock.options);
    expect(requestStop).not.toHaveBeenCalled();
    expect(clock.sleeps).toEqual([]);
  });

  it('refuses an unknown process state before sending a stop request', async () => {
    const clock = fakeClock();
    const requestStop = vi.fn();
    const error = processError('EPERM');
    await expect(stopRuntime(123, requestStop, () => { throw error; }, clock.options)).rejects.toThrow(error);
    expect(requestStop).not.toHaveBeenCalled();
    expect(clock.sleeps).toEqual([]);
  });

  it('does not turn a later unknown process state into permission to restart', async () => {
    const clock = fakeClock();
    const error = processError('EPERM');
    const isAlive = vi.fn().mockReturnValueOnce(true).mockImplementation(() => { throw error; });
    await expect(waitForRuntimeExit(123, isAlive, clock.options)).rejects.toThrow(error);
    expect(clock.elapsed()).toBe(250);
  });

  it('rejects invalid stop identities before invoking commands or probes', async () => {
    const clock = fakeClock();
    const requestStop = vi.fn();
    const isAlive = vi.fn();
    await expect(stopRuntime(0, requestStop, isAlive, clock.options)).rejects.toThrow();
    await expect(waitForRuntimeExit(Number.NaN, isAlive, clock.options)).rejects.toThrow();
    expect(requestStop).not.toHaveBeenCalled();
    expect(isAlive).not.toHaveBeenCalled();
    expect(clock.sleeps).toEqual([]);
  });

  it('accepts exit at the deadline and never waits beyond a partial final interval', async () => {
    const clock = fakeClock();
    await waitForRuntimeExit(123, () => clock.elapsed() < 550, { ...clock.options, budgetMs: 550 });
    expect(clock.elapsed()).toBe(550);
    expect(clock.sleeps).toEqual([250, 250, 50]);
    const stuck = fakeClock();
    await expect(waitForRuntimeExit(123, () => true, { ...stuck.options, budgetMs: 550 })).rejects.toThrow('did not stop');
    expect(stuck.elapsed()).toBe(550);
  });
});

describe('plugin deployment startup handover', () => {
  it('waits for a fresh matching live receipt arriving after 75 seconds', async () => {
    const clock = fakeClock();
    const onRetry = vi.fn();
    const isAlive = vi.fn(() => true);
    await waitForRuntime(() => clock.elapsed() >= 75_000 ? freshRuntime : null,
      expectedRuntime, isAlive, { ...clock.options, onRetry });
    expect(clock.elapsed()).toBe(75_000);
    expect(isAlive).toHaveBeenCalledWith(123);
    expect(onRetry.mock.calls.map(([progress]) => progress)).toEqual([
      { elapsedMs: 20_000, budgetMs: 120_000 },
      { elapsedMs: 40_000, budgetMs: 120_000 },
      { elapsedMs: 60_000, budgetMs: 120_000 },
    ]);
  });

  it('rejects stale, different and dead receipts until a matching live runtime starts', async () => {
    const clock = fakeClock();
    const receipts = [
      null,
      { ...freshRuntime, startedAt: 99 },
      { ...freshRuntime, sha256: 'old' },
      { ...freshRuntime, bundlePath: '/worktree/plugin.js' },
      { ...freshRuntime, pid: 456 },
      freshRuntime,
    ];
    const isAlive = vi.fn((pid: number) => pid === 123);
    await waitForRuntime(() => receipts[Math.min(clock.elapsed() / 250, receipts.length - 1)],
      expectedRuntime, isAlive, clock.options);
    expect(clock.elapsed()).toBe(1250);
    expect(isAlive.mock.calls.map(([pid]) => pid)).toEqual([456, 123]);
  });

  it('waits for a replacement PID even when the previous process advertises a fresh matching receipt', async () => {
    const clock = fakeClock();
    const isAlive = vi.fn(() => true);
    await waitForRuntime(() => clock.elapsed() >= 750 ? { ...freshRuntime, pid: 456 } : freshRuntime,
      { ...expectedRuntime, previousPid: freshRuntime.pid }, isAlive, clock.options);
    expect(clock.elapsed()).toBe(750);
    expect(isAlive.mock.calls).toEqual([[456]]);
  });

  it('does not accept or silently retry an unreadable process behind a matching receipt', async () => {
    const clock = fakeClock();
    const error = processError('EPERM');
    await expect(waitForRuntime(() => freshRuntime, expectedRuntime,
      () => { throw error; }, clock.options)).rejects.toThrow(error);
    expect(clock.sleeps).toEqual([]);
  });

  it('fails at the bounded deadline if startup never produces a fresh receipt', async () => {
    const clock = fakeClock();
    await expect(waitForRuntime(() => ({ ...freshRuntime, startedAt: 99 }), expectedRuntime,
      () => true, clock.options)).rejects.toThrow(/receipt/i);
    expect(clock.elapsed()).toBe(120_000);
  });

  it('accepts a matching receipt on the final deadline probe without oversleeping', async () => {
    const clock = fakeClock();
    await waitForRuntime(() => clock.elapsed() >= 550 ? freshRuntime : null,
      expectedRuntime, () => true, { ...clock.options, budgetMs: 550 });
    expect(clock.elapsed()).toBe(550);
    expect(clock.sleeps).toEqual([250, 250, 50]);
    const missing = fakeClock();
    await expect(waitForRuntime(() => null, expectedRuntime, () => true,
      { ...missing.options, budgetMs: 550 })).rejects.toThrow(/receipt/i);
    expect(missing.elapsed()).toBe(550);
  });
});
