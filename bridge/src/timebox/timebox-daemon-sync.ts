/**
 * Daemon-managed Divoom Timebox Mini sync.
 *
 * Timebox Mini BLE devices (`device.address`) are driven by `sync_ble.py`
 * (bleak/GATT). Node has no built-in BLE support, so we spawn the small Python
 * writer. This code is terminal-managed CLI daemon only.
 */

import { type ChildProcess } from 'child_process';
import { deviceId, loadTimeboxDevices, type TimeboxDevice } from './timebox-settings.js';
import { createSyncCycleSquelch, spawnPythonSync, terminateSyncChild, type SyncCycleSquelch } from '../ble-sync-spawn.js';
import { getBleRuntimeStatus } from '../python-ble-runtime.js';

interface SyncEntry {
  device: TimeboxDevice;
  child: ChildProcess | null;
  stopping: boolean;
  respawnTimer: ReturnType<typeof setTimeout> | null;
  consecutiveFailures: number;
  startedAt: number;
  /** Collapses repeated identical respawn cycles into an hourly summary. */
  squelch: SyncCycleSquelch;
}

const entries = new Map<string, SyncEntry>();

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const HEALTHY_UPTIME_MS = 30_000;

function log(msg: string): void {
  console.error(`[agentdeck] [timebox] ${msg}`);
}

export function startTimeboxSync(httpPort: number): void {
  const devices = loadTimeboxDevices();
  if (devices.length === 0) return;

  const runtime = getBleRuntimeStatus();
  if (!runtime.ready || !runtime.python) {
    log(`sync unavailable (${runtime.reason}); run \`agentdeck ble setup\``);
    return;
  }

  for (const device of devices) {
    const id = deviceId(device);
    if (!id || entries.has(id)) continue;
    const entry: SyncEntry = {
      device,
      child: null,
      stopping: false,
      respawnTimer: null,
      consecutiveFailures: 0,
      startedAt: 0,
      squelch: createSyncCycleSquelch(log),
    };
    entries.set(id, entry);
    spawnSync(entry, runtime.python, runtime.paths.scripts.timeboxSync, httpPort);
  }
}

function spawnSync(entry: SyncEntry, venvPython: string, syncScript: string, httpPort: number): void {
  if (entry.stopping) return;
  const device = entry.device;
  const id = deviceId(device);
  const url = `http://127.0.0.1:${httpPort}`;
  const brightness = Math.max(0, Math.min(100, Math.round(device.brightness ?? 100)));
  const args = [syncScript, '--address', device.address, '--url', url, '--brightness', String(brightness)];

  entry.squelch.logStart(
    `Starting BLE sync for ${device.name ?? 'Timebox Mini'} (${id}, bridge ${url}, brightness ${brightness}%)`,
  );
  entry.startedAt = Date.now();

  // stdout/stderr are captured into small rings so clean exits and crashes both
  // leave enough context without flooding the daemon log while running.
  const { proc, stderrTail, outputTail } = spawnPythonSync(venvPython, args);
  entry.child = proc;

  proc.on('error', (err: Error) => {
    log(`sync failed to spawn for ${id}: ${err.message}`);
  });

  proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (entry.child === proc) entry.child = null;
    if (entry.stopping) return;
    // A clean code=0 exit is still abnormal here; normal daemon shutdown is
    // gated by `entry.stopping` above. Do not reset backoff for repeated
    // "device not found" / BLE disconnect exits just because they lasted long
    // enough to cross the healthy-uptime threshold.
    const uptimeMs = Date.now() - entry.startedAt;
    if (code !== 0 && uptimeMs > HEALTHY_UPTIME_MS) entry.consecutiveFailures = 0;
    entry.consecutiveFailures += 1;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * entry.consecutiveFailures);
    const tail = stderrTail() || outputTail();
    const why = tail ? `; output: ${tail}` : '';
    entry.squelch.logExit(
      code,
      signal,
      uptimeMs,
      tail,
      `sync for ${id} exited (code=${code} signal=${signal})${why}; respawning in ${Math.round(delay / 1000)}s`,
    );
    entry.respawnTimer = setTimeout(() => spawnSync(entry, venvPython, syncScript, httpPort), delay);
    if (entry.respawnTimer.unref) entry.respawnTimer.unref();
  });
}

/**
 * Stop all managed Timebox BLE syncs and cancel pending respawns.
 *
 * When `awaitFarewell` is true (daemon shutdown), wait for each child to exit so
 * its blank-panel farewell finishes painting before the daemon process exits —
 * otherwise launchd tears the job down and SIGKILLs the orphaned children
 * mid-farewell, freezing each panel on its last dashboard frame. Children are
 * awaited in parallel (BLE is per-device, so farewells don't serialize).
 */
export async function stopTimeboxSync(awaitFarewell = false): Promise<void> {
  const procs: ChildProcess[] = [];
  for (const entry of entries.values()) {
    entry.stopping = true;
    if (entry.respawnTimer) {
      clearTimeout(entry.respawnTimer);
      entry.respawnTimer = null;
    }
    if (entry.child) {
      const proc = entry.child;
      entry.child = null;
      if (awaitFarewell) {
        procs.push(proc);
      } else {
        try {
          proc.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    }
  }
  entries.clear();
  if (procs.length) await Promise.all(procs.map((p) => terminateSyncChild(p)));
}
