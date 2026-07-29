/**
 * Daemon-side auto-discovery for the Divoom Timebox Mini (BLE).
 *
 * Reuses the existing `scan_ble.py` (bleak) scanner the CLI `timebox scan`
 * command already drives, but runs it automatically at daemon start when no
 * Timebox is configured yet — so a fresh install "just finds" the device
 * instead of requiring a manual `timebox add`. Auto-add only happens when zero
 * devices are configured (avoid grabbing a neighbour's panel on a shared LAN),
 * and only when `timeboxAutoDiscover` isn't disabled in settings.
 *
 * This is terminal-managed CLI daemon code (spawns Python); it never runs in
 * the App Store Swift build, which does BLE discovery natively via CoreBluetooth.
 */

import { spawn } from 'child_process';
import {
  addTimeboxDevice,
  isTimeboxAutoDiscoverEnabled,
  loadTimeboxDevices,
} from './timebox-settings.js';
import { getBleRuntimeStatus } from '../python-ble-runtime.js';

interface ScanResult {
  name: string;
  address: string;
  rssi?: number | null;
  is_timebox?: boolean;
}

function log(msg: string): void {
  console.error(`[agentdeck] [timebox] ${msg}`);
}

/** Run scan_ble.py and parse its JSON, with a hard outer timeout. */
function runScan(venvPython: string, scanScript: string, timeoutMs: number): Promise<ScanResult[]> {
  return new Promise((resolve) => {
    const proc = spawn(venvPython, [scanScript], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    const timer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      resolve([]);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve([]);
    });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(out);
        resolve(Array.isArray(parsed) ? (parsed as ScanResult[]) : []);
      } catch {
        resolve([]);
      }
    });
  });
}

/**
 * BLE-scan for a Timebox Mini and add the first match to settings.
 * @returns number of devices added (0 or 1).
 */
export async function autoDiscoverTimebox(): Promise<number> {
  if (!isTimeboxAutoDiscoverEnabled()) return 0;
  if (loadTimeboxDevices().length > 0) return 0; // only when nothing configured

  const runtime = getBleRuntimeStatus();
  if (!runtime.ready || !runtime.python) {
    log(`auto-discovery unavailable (${runtime.reason}); run \`agentdeck ble setup\``);
    return 0;
  }

  const results = await runScan(runtime.python, runtime.paths.scripts.timeboxScan, 8_000);
  const match = results.find((r) => r.is_timebox && r.address);
  if (!match) return 0;

  const added = addTimeboxDevice({ address: match.address, name: match.name });
  if (added) log(`auto-discovered Timebox Mini ${match.address} (${match.name})`);
  return added ? 1 : 0;
}
