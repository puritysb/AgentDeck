import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The supervisor reads the configured iDotMatrix when it spawns the Python
 * client. A client that cannot find its panel no longer exits to be respawned,
 * so the supervisor re-reads the settings itself while the panel is not
 * connected: a re-paired address is still picked up without a daemon restart.
 */

class FakeChild extends EventEmitter {
  kill = vi.fn(() => true);
}

interface Spawned {
  args: string[];
  proc: FakeChild;
  onStatus?: (payload: Record<string, unknown>) => void;
}

const settings = vi.hoisted(() => ({ devices: [] as Array<{ address: string; brightness?: number }> | null }));
const spawned = vi.hoisted(() => [] as Spawned[]);

vi.mock('../idotmatrix/idotmatrix-settings.js', () => ({
  loadIDotMatrixDevices: () => settings.devices ?? [],
  readIDotMatrixDevicesStrict: () => settings.devices,
}));

vi.mock('../python-ble-runtime.js', () => ({
  getBleRuntimeStatus: () => ({
    ready: true,
    python: '/venv/bin/python',
    paths: { scripts: { idotmatrixSync: '/pkg/idotmatrix/sync.py' } },
  }),
}));

vi.mock('../ble-sync-spawn.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ble-sync-spawn.js')>()),
  spawnPythonSync: (_python: string, args: string[], options: { onStatus?: Spawned['onStatus'] }) => {
    const proc = new FakeChild();
    spawned.push({ args, proc, onStatus: options.onStatus });
    return { proc, stderrTail: () => '', outputTail: () => '' };
  },
}));

const addressOf = (s: Spawned): string => s.args[s.args.indexOf('-a') + 1];
const RECHECK_MS = 30_000;

let sync: typeof import('../idotmatrix/idotmatrix-daemon-sync.js');

beforeEach(async () => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  settings.devices = [{ address: 'AA:AA' }];
  spawned.length = 0;
  // The supervisor keeps its state at module level; give each test its own.
  vi.resetModules();
  sync = await import('../idotmatrix/idotmatrix-daemon-sync.js');
});

afterEach(async () => {
  await sync.stopIDotMatrixSync();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('iDotMatrix supervisor with a panel it has not reached', () => {
  it('restarts the client when the configured address changes', () => {
    sync.startIDotMatrixSync(9120);
    expect(spawned.map(addressOf)).toEqual(['AA:AA']);

    settings.devices = [{ address: 'BB:BB' }];
    vi.advanceTimersByTime(RECHECK_MS);

    expect(spawned[0].proc.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawned.map(addressOf)).toEqual(['AA:AA', 'BB:BB']);
  });

  it('does not respawn from the exit of the client it replaced', () => {
    sync.startIDotMatrixSync(9120);
    settings.devices = [{ address: 'BB:BB' }];
    vi.advanceTimersByTime(RECHECK_MS);

    spawned[0].proc.emit('exit', null, 'SIGTERM');
    vi.advanceTimersByTime(4 * RECHECK_MS);

    expect(spawned.map(addressOf)).toEqual(['AA:AA', 'BB:BB']);
    expect(spawned[1].proc.kill).not.toHaveBeenCalled();
  });

  it('leaves a connected client on the config it started with', () => {
    sync.startIDotMatrixSync(9120);
    spawned[0].onStatus?.({ connected: true, phase: 'connected', hasFrame: false, dimmed: false, error: null });

    settings.devices = [{ address: 'BB:BB' }];
    vi.advanceTimersByTime(3 * RECHECK_MS);

    expect(spawned).toHaveLength(1);
    expect(spawned[0].proc.kill).not.toHaveBeenCalled();
  });

  it('stops the client once its device is removed, but not on unreadable settings', () => {
    sync.startIDotMatrixSync(9120);

    settings.devices = null;
    vi.advanceTimersByTime(3 * RECHECK_MS);
    expect(spawned[0].proc.kill).not.toHaveBeenCalled();

    settings.devices = [];
    vi.advanceTimersByTime(RECHECK_MS);
    expect(spawned[0].proc.kill).toHaveBeenCalledWith('SIGTERM');

    spawned[0].proc.emit('exit', null, 'SIGTERM');
    vi.advanceTimersByTime(4 * RECHECK_MS);
    expect(spawned).toHaveLength(1);
  });
});
