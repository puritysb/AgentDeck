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
import {
  createBleLinkTracker,
  mergeBleLinkSnapshots,
  type BleLinkSnapshot,
  type BleLinkTracker,
} from '../ble-sync-status.js';
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
  /** Live BLE link state, fed by the child's `AGENTDECK_STATUS` lines. */
  link: BleLinkTracker;
}

const entries = new Map<string, SyncEntry>();

/** Set when no child could be spawned at all (missing BLE runtime). */
let unavailableReason: string | null = null;

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
    // Register the reason so /health can say *why* the panel is dark instead of
    // reporting a bare `connected:false` with no explanation.
    unavailableReason = `BLE sync unavailable: ${runtime.reason}`;
    return;
  }
  unavailableReason = null;

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
      link: createBleLinkTracker(),
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
  entry.link.noteSpawn();

  // stdout/stderr are captured into small rings so clean exits and crashes both
  // leave enough context without flooding the daemon log while running.
  const { proc, stderrTail, outputTail } = spawnPythonSync(venvPython, args, {
    onStatus: (payload) => entry.link.applyStatusLine(payload),
  });
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
    entry.link.noteExit(tail || `sync exited (code=${code} signal=${signal})`, Date.now() + delay);
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
  unavailableReason = null;
  if (procs.length) await Promise.all(procs.map((p) => terminateSyncChild(p)));
}

/**
 * Live link state for the configured Timebox panels, in the `BLEMatrixHealth`
 * wire shape. Called by `TimeboxModule.statusSnapshot()` so `/health` reports
 * whether the panel is actually being driven — the configured-device list alone
 * left every dashboard drawing a streaming panel as disconnected.
 */
export function timeboxLinkSnapshot(configuredDeviceCount: number): BleLinkSnapshot {
  const merged = mergeBleLinkSnapshots(
    [...entries.values()].map((e) => e.link.snapshot(configuredDeviceCount)),
    configuredDeviceCount,
  );
  // A configured device with no entry at all means the supervisor never got to
  // spawn anything — surface that instead of an unexplained `connected:false`.
  if (unavailableReason && configuredDeviceCount > 0 && !merged.connected) {
    return { ...merged, statusReason: unavailableReason };
  }
  return merged;
}
