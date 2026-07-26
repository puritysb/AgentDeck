/**
 * Daemon-side auto-discovery for iDotMatrix panels (BLE).
 *
 * Reuses `scan.py` (bleak) — the same scanner the CLI `idotmatrix scan` drives —
 * but runs it automatically at daemon start when no iDotMatrix is configured, so
 * a fresh install finds the panel without a manual `idotmatrix add`. Auto-add
 * only happens when zero devices are configured and `idotmatrixAutoDiscover`
 * isn't disabled in settings.
 *
 * Terminal-managed CLI daemon code (spawns Python); never runs in the App Store
 * Swift build, which discovers over CoreBluetooth natively.
 */

import { spawn } from '../proc.js';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  addIDotMatrixDevice,
  isIDotMatrixAutoDiscoverEnabled,
  loadIDotMatrixDevices,
} from './idotmatrix-settings.js';

interface ScanResult {
  name: string;
  address: string;
  is_idotmatrix?: boolean;
}

function log(msg: string): void {
  console.error(`[agentdeck] [idotmatrix] ${msg}`);
}

function resolvePaths(): { venvPython: string; scanScript: string } {
  const here = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(here, '..', '..', '..');
  return {
    venvPython: join(projectRoot, '.venv', 'bin', 'python'),
    scanScript: join(projectRoot, 'bridge', 'src', 'idotmatrix', 'scan.py'),
  };
}

/** Run scan.py and parse its JSON, with a hard outer timeout. */
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
 * BLE-scan for an iDotMatrix panel and add the first match to settings.
 * @returns number of devices added (0 or 1).
 */
export async function autoDiscoverIDotMatrix(): Promise<number> {
  if (!isIDotMatrixAutoDiscoverEnabled()) return 0;
  if (loadIDotMatrixDevices().length > 0) return 0; // only when nothing configured

  const { venvPython, scanScript } = resolvePaths();
  if (!existsSync(venvPython) || !existsSync(scanScript)) return 0;

  const results = await runScan(venvPython, scanScript, 8_000);
  const match = results.find((r) => r.is_idotmatrix && r.address);
  if (!match) return 0;

  const added = addIDotMatrixDevice({ address: match.address, name: match.name });
  if (added) log(`auto-discovered iDotMatrix ${match.address} (${match.name})`);
  return added ? 1 : 0;
}
