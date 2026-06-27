/**
 * Daemon-managed Divoom Timebox Mini sync.
 *
 * Timebox Mini BLE devices (`device.address`) are driven by `sync_ble.py`
 * (bleak/GATT). Node has no built-in BLE support, so we spawn the small Python
 * writer. This code is terminal-managed CLI daemon only.
 */

import { type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { deviceId, loadTimeboxDevices, type TimeboxDevice } from './timebox-settings.js';
import { spawnPythonSync } from '../ble-sync-spawn.js';

interface SyncEntry {
  device: TimeboxDevice;
  child: ChildProcess | null;
  stopping: boolean;
  respawnTimer: ReturnType<typeof setTimeout> | null;
  consecutiveFailures: number;
  startedAt: number;
}

const entries = new Map<string, SyncEntry>();

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const HEALTHY_UPTIME_MS = 30_000;

function log(msg: string): void {
  console.error(`[agentdeck] [timebox] ${msg}`);
}

function resolvePaths(): { venvPython: string; bleScript: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(here, '..', '..', '..');
  const timeboxDir = join(projectRoot, 'bridge', 'src', 'timebox');
  return {
    venvPython: join(projectRoot, '.venv', 'bin', 'python'),
    bleScript: join(timeboxDir, 'sync_ble.py'),
  };
}

export function startTimeboxSync(httpPort: number): void {
  const devices = loadTimeboxDevices();
  if (devices.length === 0) return;

  const { venvPython, bleScript } = resolvePaths();
  if (!existsSync(venvPython)) {
    log('sync unavailable (missing Python venv (.venv)); Timebox Mini will not be driven by the daemon');
    return;
  }

  for (const device of devices) {
    const id = deviceId(device);
    if (!id || entries.has(id)) continue;
    if (!existsSync(bleScript)) {
      log(`sync unavailable (missing sync_ble.py) for ${id}`);
      continue;
    }
    const entry: SyncEntry = {
      device,
      child: null,
      stopping: false,
      respawnTimer: null,
      consecutiveFailures: 0,
      startedAt: 0,
    };
    entries.set(id, entry);
    spawnSync(entry, venvPython, bleScript, httpPort);
  }
}

function spawnSync(entry: SyncEntry, venvPython: string, syncScript: string, httpPort: number): void {
  if (entry.stopping) return;
  const device = entry.device;
  const id = deviceId(device);
  const url = `http://127.0.0.1:${httpPort}`;
  const brightness = Math.max(0, Math.min(100, Math.round(device.brightness ?? 100)));
  const args = [syncScript, '--address', device.address, '--url', url, '--brightness', String(brightness)];

  log(
    `Starting BLE sync for ${device.name ?? 'Timebox Mini'} (${id}, bridge ${url}, brightness ${brightness}%)`,
  );
  entry.startedAt = Date.now();

  // stdout muted (debug flood); stderr captured so a Python crash (missing bleak,
  // stale venv, bad address) lands in the daemon log instead of vanishing.
  const { proc, stderrTail } = spawnPythonSync(venvPython, args);
  entry.child = proc;

  proc.on('error', (err: Error) => {
    log(`sync failed to spawn for ${id}: ${err.message}`);
  });

  proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (entry.child === proc) entry.child = null;
    if (entry.stopping) return;
    if (Date.now() - entry.startedAt > HEALTHY_UPTIME_MS) entry.consecutiveFailures = 0;
    entry.consecutiveFailures += 1;
    const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * entry.consecutiveFailures);
    const tail = stderrTail();
    const why = code && tail ? `; stderr: ${tail}` : '';
    log(`sync for ${id} exited (code=${code} signal=${signal})${why}; respawning in ${Math.round(delay / 1000)}s`);
    entry.respawnTimer = setTimeout(() => spawnSync(entry, venvPython, syncScript, httpPort), delay);
    if (entry.respawnTimer.unref) entry.respawnTimer.unref();
  });
}

export function stopTimeboxSync(): void {
  for (const entry of entries.values()) {
    entry.stopping = true;
    if (entry.respawnTimer) {
      clearTimeout(entry.respawnTimer);
      entry.respawnTimer = null;
    }
    if (entry.child) {
      try {
        entry.child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      entry.child = null;
    }
  }
  entries.clear();
}
