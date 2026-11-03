/**
 * Timebox Mini device settings CRUD.
 *
 * The Timebox Mini is driven over **BLE** — BLE GATT (ISSC transparent-UART
 * `49535343-…`), advertised as "TimeBox-mini-light". Driven over CoreBluetooth,
 * so the App Store Swift daemon can drive it; the Node daemon spawns
 * `sync_ble.py` (bleak).
 *
 * (The legacy Bluetooth Classic SPP variant was removed — poor macOS
 * compatibility and no App Store path; BLE supersedes it.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { getDataDir } from '../session-registry.js';
import { join } from 'path';

export interface TimeboxDevice {
  /** BLE address/UUID of the TimeBox-mini-light peripheral. */
  address: string;
  name?: string;
  /** Software brightness scale applied while encoding pixels. */
  brightness?: number;
}

/** Stable identity for a device — its BLE address. */
export function deviceId(device: TimeboxDevice): string {
  return device.address ?? '';
}

const getSettingsPath = () => join(getDataDir(), 'settings.json');

function readSettings(): Record<string, unknown> {
  try {
    if (!existsSync(getSettingsPath())) return {};
    return JSON.parse(readFileSync(getSettingsPath(), 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2) + '\n');
}

export function loadTimeboxDevices(): TimeboxDevice[] {
  const settings = readSettings();
  if (!Array.isArray(settings.timeboxDevices)) return [];
  return settings.timeboxDevices
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object')
    // Keep a device only if it has a BLE address.
    .filter((d) => typeof d.address === 'string')
    .map((d) => ({
      address: d.address as string,
      name: typeof d.name === 'string' ? d.name : undefined,
      brightness: typeof d.brightness === 'number' ? d.brightness : undefined,
    }));
}

export function saveTimeboxDevices(devices: TimeboxDevice[]): void {
  const settings = readSettings();
  settings.timeboxDevices = devices;
  writeSettings(settings);
}

export function addTimeboxDevice(device: TimeboxDevice): boolean {
  const devices = loadTimeboxDevices();
  const id = deviceId(device);
  if (!id || devices.some((d) => deviceId(d) === id)) return false;
  devices.push(device);
  saveTimeboxDevices(devices);
  return true;
}

/** Remove a device by its BLE address. */
export function removeTimeboxDevice(id: string): boolean {
  const devices = loadTimeboxDevices();
  const filtered = devices.filter((d) => deviceId(d) !== id);
  if (filtered.length === devices.length) return false;
  saveTimeboxDevices(filtered);
  return true;
}

/**
 * Whether the daemon may BLE-scan for a Timebox Mini when none is configured.
 * Defaults to true (zero-config plug-and-play); set `timeboxAutoDiscover: false`
 * in settings.json to opt out.
 */
export function isTimeboxAutoDiscoverEnabled(): boolean {
  return readSettings().timeboxAutoDiscover !== false;
}
