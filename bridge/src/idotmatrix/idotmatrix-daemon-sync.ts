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

import { type ChildProcess } from 'child_process';
import { loadIDotMatrixDevices, readIDotMatrixDevicesStrict, type IDotMatrixDevice } from './idotmatrix-settings.js';
import {
  createSigabrtCircuitBreaker,
  createSyncCycleSquelch,
  spawnPythonSync,
  terminateSyncChild,
  type SigabrtCircuitBreaker,
} from '../ble-sync-spawn.js';
import { createBleLinkTracker, type BleLinkSnapshot } from '../ble-sync-status.js';
import { getBleRuntimeStatus } from '../python-ble-runtime.js';

let child: ChildProcess | null = null;
let stopping = false;
let respawnTimer: ReturnType<typeof setTimeout> | null = null;
let consecutiveFailures = 0;
let startedAt = 0;
/** Live BLE link state, fed by the child's `AGENTDECK_STATUS` lines. */
const link = createBleLinkTracker();
/** Address+brightness of the device the running child is driving (for reload-on-change). */
let runningKey: string | null = null;
let configRecheckTimer: ReturnType<typeof setInterval> | null = null;

/** Identity of the driven config — a change means the running child is stale. */
function deviceKey(d: IDotMatrixDevice): string {
  return `${d.address.toLowerCase()}@${d.brightness ?? 100}`;
}

const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 5_000;
/** If the process stayed up at least this long, treat the next exit as fresh. */
const HEALTHY_UPTIME_MS = 30_000;
/**
 * How often a child that has not reached its panel re-reads the configured
 * device. The device is read when the child spawns, and a client that could not
 * find its panel used to exit and be respawned every minute or two, re-reading
 * it on the way: a panel re-paired to a new address was picked up without a
 * daemon restart. The client now keeps retrying in-process (sync.py), so the
 * supervisor re-reads the settings itself. A connected panel keeps the config
 * it started with until the daemon restarts, as before.
 */
const CONFIG_RECHECK_MS = 30_000;

function log(msg: string): void {
  // Match the daemon's `[agentdeck]` stderr prefix.
  console.error(`[agentdeck] [idotmatrix] ${msg}`);
}

// Repeated identical respawn cycles (panel off/out of range) collapse into an
// hourly summary instead of flooding the daemon log all night.
const squelch = createSyncCycleSquelch(log);
// Recreated on every startIDotMatrixSync so a daemon restart re-arms the loop.
let abortBreaker: SigabrtCircuitBreaker = createSigabrtCircuitBreaker('iDotMatrix BLE sync');

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

  const runtime = getBleRuntimeStatus();
  if (!runtime.ready || !runtime.python) {
    log(`BLE sync unavailable (${runtime.reason}); run \`agentdeck ble setup\``);
    // Record *why* nothing is driving the panel so /health can say so instead
    // of reporting an unexplained `connected:false`.
    link.noteUnavailable(`BLE sync unavailable: ${runtime.reason}`);
    return;
  }

  abortBreaker = createSigabrtCircuitBreaker('iDotMatrix BLE sync');
  spawnSync(runtime.python, runtime.paths.scripts.idotmatrixSync, httpPort);
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
  link.noteSpawn();
  // iDotMatrix software brightness boost canonical = 1.22 — keep in sync:
  // sync.py (run_sync boost default), IDotMatrixModule.swift (boostBrightnessContrast).
  // stdout/stderr are captured into small rings so clean exits and crashes both
  // leave enough context without flooding the daemon log while running.
  const { proc, stderrTail, outputTail } = spawnPythonSync(
    venvPython,
    [syncScript, '-a', addr, '-u', url, '-b', String(brightness), '--boost', '1.22'],
    { onStatus: (payload) => link.applyStatusLine(payload) },
  );
  child = proc;
  armConfigRecheck(httpPort);

  proc.on('error', (err: Error) => {
    log(`BLE sync failed to spawn: ${err.message}`);
  });

  proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    // A child that was stopped, or replaced by a re-config restart, is not ours
    // to respawn. The restart clears `stopping` before the old child's exit
    // arrives, so without this check that exit would schedule a spawn that
    // orphans the replacement.
    if (child !== proc) return;
    child = null;
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
    // A streak of SIGABRT kills means the OS is refusing the client (TCC on
    // macOS) — respawning can only produce another crash dialog, so halt and
    // say why instead of looping forever.
    const halt = abortBreaker.noteExit(signal);
    if (halt) {
      log(halt);
      link.noteUnavailable(halt);
      return;
    }
    link.noteExit(tail || `BLE sync exited (code=${code} signal=${signal})`, Date.now() + delay);
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

function armConfigRecheck(httpPort: number): void {
  if (configRecheckTimer) return;
  configRecheckTimer = setInterval(() => {
    // The count passed to snapshot() only shapes its reason text.
    if (stopping || !child || link.snapshot(1).connected) return;
    const devices = readIDotMatrixDevicesStrict();
    // Unreadable settings say nothing about the device: keep the running client.
    if (devices === null) return;
    if (devices.length === 0) {
      log('iDotMatrix removed from settings; stopping BLE sync');
      void stopIDotMatrixSync();
      return;
    }
    // startIDotMatrixSync restarts the child when the configured device changed.
    if (deviceKey(devices[0]) !== runningKey) startIDotMatrixSync(httpPort);
  }, CONFIG_RECHECK_MS);
  if (configRecheckTimer.unref) configRecheckTimer.unref();
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
  if (configRecheckTimer) {
    clearInterval(configRecheckTimer);
    configRecheckTimer = null;
  }
  const proc = child;
  child = null;
  runningKey = null;
  link.noteUnavailable('BLE sync stopped');
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

/**
 * Live link state for the configured iDotMatrix panel, in the `BLEMatrixHealth`
 * wire shape. Called by `IDotMatrixModule.statusSnapshot()` so `/health` reports
 * whether the panel is actually being driven — the configured-device list alone
 * left every dashboard drawing a streaming panel as disconnected.
 */
export function idotMatrixLinkSnapshot(configuredDeviceCount: number): BleLinkSnapshot {
  return link.snapshot(configuredDeviceCount);
}
