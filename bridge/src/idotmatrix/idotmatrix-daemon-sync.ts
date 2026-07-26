/**
 * iDotMatrix daemon-managed BLE sync.
 *
 * The Node daemon cannot speak BLE in-process, so when an iDotMatrix device is
 * configured we auto-spawn the Python `sync.py` client (bleak) and manage its
 * lifecycle — start on daemon boot, respawn with backoff if it dies, kill on
 * shutdown. This is what lets the device run with **only the CLI daemon up**
 * (no separate `agentdeck idotmatrix sync`, no Swift app holding the BLE link).
 *
 * sync.py polls the daemon's `/pixoo/frame?size=32` and pushes over BLE, so it
 * tracks the same frames every other surface shows. Only the first configured
 * device is driven (BLE is single-connection; matches the CLI behaviour).
 *
 * This is daemon-only (terminal-managed / Homebrew) code — it never runs in the
 * App Store Swift build, so spawning a subprocess here does not touch the
 * Apple 2.5.2 sandbox invariants.
 */

import { type ChildProcess } from '../proc.js';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadIDotMatrixDevices, type IDotMatrixDevice } from './idotmatrix-settings.js';
import { createSyncCycleSquelch, spawnPythonSync, terminateSyncChild } from '../ble-sync-spawn.js';

let child: ChildProcess | null = null;
let stopping = false;
let respawnTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;
let startedAt = 0;
/** Address+brightness of the device the running child is driving (for reload-on-change). */
let runningKey: string | null = null;

/** Identity of the driven config — a change means the running child is stale. */
function deviceKey(d: IDotMatrixDevice): string {
  return `${d.address.toLowerCase()}@${d.brightness ?? 100}`;
}

const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 5_000;
/** If the process stayed up at least this long, treat the next exit as fresh. */
const HEALTHY_UPTIME_MS = 30_000;

function log(msg: string): void {
  // Match the daemon's `[agentdeck]` stderr prefix.
  console.error(`[agentdeck] [idotmatrix] ${msg}`);
}

// Repeated identical respawn cycles (panel off/out of range) collapse into an
// hourly summary instead of flooding the daemon log all night.
const squelch = createSyncCycleSquelch(log);

function resolvePaths(): { venvPython: string; syncScript: string } {
  // This file compiles to bridge/dist/idotmatrix/idotmatrix-daemon-sync.js, so
  // the repo root is three levels up.
  const here = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(here, '..', '..', '..');
  return {
    venvPython: join(projectRoot, '.venv', 'bin', 'python'),
    syncScript: join(projectRoot, 'bridge', 'src', 'idotmatrix', 'sync.py'),
  };
}

/**
 * Start (or no-op if already running) the managed BLE sync for the first
 * configured iDotMatrix device, fed by the daemon at `httpPort`.
 */
export function startIDotMatrixSync(httpPort: number): void {
  stopping = false;

  const devices = loadIDotMatrixDevices();
  if (devices.length === 0) return; // nothing configured → nothing to drive

  if (child) {
    // Already running. If the configured device/brightness is unchanged this is
    // a no-op; if it changed (re-pair, brightness edit), tear the stale child
    // down so the respawn below picks up the new config instead of silently
    // driving the old panel forever.
    if (runningKey === deviceKey(devices[0])) return;
    log('configured iDotMatrix changed; restarting BLE sync');
    // Fast stop on re-config (no farewell wait — we repaint immediately with the
    // new device). Runs synchronously up to the SIGTERM, so `stopping = false`
    // below still lands after the child is signalled.
    void stopIDotMatrixSync();
    stopping = false;
  }

  const { venvPython, syncScript } = resolvePaths();
  if (!existsSync(venvPython) || !existsSync(syncScript)) {
    log(
      `BLE sync unavailable (missing ${!existsSync(venvPython) ? 'Python venv (.venv)' : 'sync.py'}); ` +
        `iDotMatrix will not be driven by the daemon`,
    );
    return;
  }

  spawnSync(venvPython, syncScript, httpPort);
}

function spawnSync(venvPython: string, syncScript: string, httpPort: number): void {
  if (stopping) return;
  const devices = loadIDotMatrixDevices();
  if (devices.length === 0) return; // device removed while we were backing off
  const device = devices[0];
  const addr = device.address;
  const brightness = device.brightness ?? 100;
  const url = `http://127.0.0.1:${httpPort}`;

  squelch.logStart(`Starting BLE sync for ${device.name ?? addr} (bridge ${url}, brightness ${brightness}%)`);
  startedAt = Date.now();
  runningKey = deviceKey(device);
  // iDotMatrix software brightness boost canonical = 1.22 — keep in sync:
  // sync.py (run_sync boost default), IDotMatrixModule.swift (boostBrightnessContrast).
  // stdout/stderr are captured into small rings so clean exits and crashes both
  // leave enough context without flooding the daemon log while running.
  const { proc, stderrTail, outputTail } = spawnPythonSync(venvPython, [
    syncScript, '-a', addr, '-u', url, '-b', String(brightness), '--boost', '1.22',
  ]);
  child = proc;

  proc.on('error', (err: Error) => {
    log(`BLE sync failed to spawn: ${err.message}`);
  });

  proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (child === proc) child = null;
    if (stopping) return;
    // A long healthy run resets the backoff so a one-off crash recovers fast.
    // Clean code=0 exits are abnormal for daemon-managed sync children (normal
    // shutdown is gated by `stopping` above), so repeated BLE disconnect exits
    // must still escalate instead of flapping every 5 seconds forever.
    const uptimeMs = Date.now() - startedAt;
    if (code !== 0 && uptimeMs > HEALTHY_UPTIME_MS) consecutiveFailures = 0;
    consecutiveFailures += 1;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * consecutiveFailures);
    const tail = stderrTail() || outputTail();
    const why = tail ? `; output: ${tail}` : '';
    squelch.logExit(
      code,
      signal,
      uptimeMs,
      tail,
      `BLE sync exited (code=${code} signal=${signal})${why}; respawning in ${Math.round(delay / 1000)}s`,
    );
    respawnTimer = setTimeout(() => spawnSync(venvPython, syncScript, httpPort), delay);
    if (respawnTimer.unref) respawnTimer.unref();
  });
}

/**
 * Stop the managed BLE sync and cancel any pending respawn.
 *
 * When `awaitFarewell` is true (daemon shutdown), wait for the child to exit so
 * its OFFLINE-frame farewell finishes painting before the daemon process exits —
 * otherwise launchd tears the job down and SIGKILLs the orphaned child
 * mid-farewell, freezing the panel on its last dashboard frame. When false
 * (re-config restart), just signal the child and return synchronously.
 */
export async function stopIDotMatrixSync(awaitFarewell = false): Promise<void> {
  stopping = true;
  if (respawnTimer) {
    clearTimeout(respawnTimer);
    respawnTimer = null;
  }
  const proc = child;
  child = null;
  runningKey = null;
  if (!proc) return;
  if (awaitFarewell) {
    await terminateSyncChild(proc);
  } else {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}
