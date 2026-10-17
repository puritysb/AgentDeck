import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const { execFileMock, spawnMock } = vi.hoisted(() => ({ execFileMock: vi.fn(), spawnMock: vi.fn() }));
vi.mock('child_process', () => ({ execFile: execFileMock, spawn: spawnMock }));
import { DisplayMonitor } from '../display-monitor.js';

type ProbeError = Error & { code?: number | string; killed?: boolean; signal?: string };
type Probe = { file: string; callback: (error: ProbeError | null, stdout: string) => void; kill: ReturnType<typeof vi.fn> };
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let probes: Probe[];
let monitor: DisplayMonitor;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  probes = [];
  execFileMock.mockReset().mockImplementation((file, _args, _options, callback) => {
    const kill = vi.fn();
    probes.push({ file, callback, kill });
    return { kill };
  });
  spawnMock.mockReset().mockImplementation(() => Object.assign(new EventEmitter(), { stdout: null, kill: vi.fn() }));
  monitor = new DisplayMonitor();
});

afterEach(async () => {
  monitor.stop();
  await vi.advanceTimersByTimeAsync(2_000);
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', platform);
});

function answer(round: Probe[], screensaver: number | string, asleep = false) {
  for (const probe of round) {
    if (probe.file === 'pmset') probe.callback(null, `state: ${asleep ? 1 : 4}`);
    else if (probe.file === 'ioreg') probe.callback(null, 'IOConsoleUsers "kCGSSessionOnConsoleKey"=Yes');
    else probe.callback(screensaver === 0 ? null : Object.assign(new Error('pgrep'), { code: screensaver }), '');
  }
}

describe('asynchronous display fallback probes', () => {
  it('leaves timers free while probes are pending, then applies presence and no-match results', async () => {
    monitor.start();
    expect(probes.map(p => p.file)).toEqual(['pmset', 'ioreg', 'pgrep']);
    let timerRan = false;
    setTimeout(() => { timerRan = true; }, 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(timerRan).toBe(true);
    expect(monitor.isDisplayOn()).toBe(true);
    answer(probes.slice(0, 3), 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.isDisplayOn()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    answer(probes.slice(3, 6), 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.isDisplayOn()).toBe(true);
  });

  it('bounds a silent child and retains the last known state on timeout or probe errors', async () => {
    monitor.start();
    answer(probes.slice(0, 3), 0);
    await vi.advanceTimersByTimeAsync(5_000);
    const silent = probes.slice(3, 6);
    expect(silent).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(2_000);
    for (const probe of silent) expect(probe.kill).toHaveBeenCalledWith('SIGKILL');
    expect(monitor.isDisplayOn()).toBe(false);
    await vi.advanceTimersByTimeAsync(18_000);
    expect(probes, 'A silent native child must not cause a process-spawn storm').toHaveLength(6);
    answer(silent, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.isDisplayOn(), 'A late successful result was already timed out').toBe(false);
    // Failure to inspect must not become a false "no screensaver" result.
    await vi.advanceTimersByTimeAsync(5_000);
    answer(probes.slice(6, 9), 'EACCES');
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.isDisplayOn()).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    answer(probes.slice(9, 12), 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.isDisplayOn()).toBe(true);
  });

  it('ignores completions from a previous lifecycle after stop and restart', async () => {
    const changed = vi.fn();
    monitor.on('display_state_changed', changed);
    monitor.start();
    const old = probes.slice();
    monitor.stop();
    monitor.start();
    expect(probes, 'Restart cannot replace an unreaped probe').toHaveLength(3);
    answer(old, 0, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.isDisplayOn()).toBe(true);
    expect(changed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    answer(probes.slice(3, 6), 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.isDisplayOn()).toBe(true);
  });
});
