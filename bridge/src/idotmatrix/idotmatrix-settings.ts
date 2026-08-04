/**
 * iDotMatrix device settings CRUD — reads/writes idotmatrixDevices[] in ~/.agentdeck/settings.json.
 * Preserves all other settings in the file.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface IDotMatrixDevice {
  address: string;
  name?: string;
  brightness?: number; // 5-100
}

const SETTINGS_DIR = join(homedir(), '.agentdeck');
const SETTINGS_PATH = join(SETTINGS_DIR, 'settings.json');

function readSettings(): Record<string, unknown> {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

export function loadIDotMatrixDevices(): IDotMatrixDevice[] {
  const settings = readSettings();
  return Array.isArray(settings.idotmatrixDevices) ? settings.idotmatrixDevices : [];
}

export function saveIDotMatrixDevices(devices: IDotMatrixDevice[]): void {
  const settings = readSettings();
  settings.idotmatrixDevices = devices;
  writeSettings(settings);
}

export function addIDotMatrixDevice(device: IDotMatrixDevice): boolean {
  const devices = loadIDotMatrixDevices();
  if (devices.some(d => d.address.toLowerCase() === device.address.toLowerCase())) return false;
  devices.push(device);
  saveIDotMatrixDevices(devices);
  return true;
}

export function removeIDotMatrixDevice(address: string): boolean {
  const devices = loadIDotMatrixDevices();
  const filtered = devices.filter(d => d.address.toLowerCase() !== address.toLowerCase());
  if (filtered.length === devices.length) return false;
  saveIDotMatrixDevices(filtered);
  return true;
}

/**
 * Whether the daemon may BLE-scan for an iDotMatrix panel when none is
 * configured. Defaults to true (zero-config plug-and-play); set
 * `idotmatrixAutoDiscover: false` in settings.json to opt out.
 */
export function isIDotMatrixAutoDiscoverEnabled(): boolean {
  return readSettings().idotmatrixAutoDiscover !== false;
}

/**
 * Extra advertised-name prefixes to treat as iDotMatrix panels, on top of the
 * families in the identity SSOT (`@agentdeck/shared` IDOTMATRIX_NAME_PREFIXES).
 * The scan already matches the advertised service UUID brand-independently;
 * this is the escape hatch for a rebranded panel that omits the service from
 * its advertisement, so the next `iPixel` does not need a release.
 */
export function loadIDotMatrixNamePrefixes(): string[] {
  return sanitizeNamePrefixes(readSettings().idotmatrixNamePrefixes);
}

/**
 * Keep only non-blank strings. The values become argv for the scanner, so a
 * hand-edited settings.json must not be able to feed it numbers, objects, or a
 * blank prefix (the shared predicate ignores blanks, but they would still ride
 * across the process boundary as empty arguments).
 */
export function sanitizeNamePrefixes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
}
