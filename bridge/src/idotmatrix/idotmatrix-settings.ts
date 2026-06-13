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
