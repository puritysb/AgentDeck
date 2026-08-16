/**
 * Pixoo device settings CRUD — reads/writes pixooDevices[] in ~/.agentdeck/settings.json.
 * Preserves all other settings in the file.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { PixooDevice } from './pixoo-bridge.js';

const SETTINGS_DIR = join(homedir(), '.agentdeck');
const SETTINGS_PATH = join(SETTINGS_DIR, 'settings.json');

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(SETTINGS_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
}

export function loadPixooDevices(): PixooDevice[] {
  const settings = readSettings();
  return Array.isArray(settings.pixooDevices) ? settings.pixooDevices : [];
}

export function savePixooDevices(devices: PixooDevice[]): void {
  const settings = readSettings();
  settings.pixooDevices = devices;
  writeSettings(settings);
}

export function addDevice(device: PixooDevice): boolean {
  const devices = loadPixooDevices();
  if (devices.some(d => d.ip === device.ip)) return false;
  devices.push(device);
  savePixooDevices(devices);
  return true;
}

export function removeDevice(ip: string): boolean {
  const devices = loadPixooDevices();
  const filtered = devices.filter(d => d.ip !== ip);
  if (filtered.length === devices.length) return false;
  savePixooDevices(filtered);
  return true;
}

/**
 * Whether the daemon may auto-discover Pixoo devices on the LAN when none are
 * configured. **Defaults to false** — set `pixooAutoDiscover: true` in
 * settings.json (or run `agentdeck pixoo scan`) to opt in.
 *
 * It used to default to true for zero-config plug-and-play, which meant every
 * daemon start on a machine with no Pixoo configured did two things nobody
 * asked for: a POST to a third-party cloud endpoint (`app.divoom-gz.com`), and
 * an HTTP probe against all 254 hosts of the local /24. On a corporate segment
 * the first is undeclared third-party egress and the second reads to an IDS as
 * a horizontal port scan — from every developer's machine, on every start.
 *
 * A LAN sweep belongs where the user asked for it: `agentdeck pixoo scan`,
 * foreground, with output. Mirrored in `PixooModule.swift`.
 */
export function isPixooAutoDiscoverEnabled(): boolean {
  return pixooAutoDiscoverFrom(readSettings());
}

/**
 * The gate itself, over an already-read settings object. Exported pure so the
 * default direction is pinned by a test that does not need the real
 * `~/.agentdeck/settings.json` — an unreadable or absent file must mean "off",
 * because the failure mode of a missing file must not be the scanning one.
 */
export function pixooAutoDiscoverFrom(settings: Record<string, unknown>): boolean {
  return settings.pixooAutoDiscover === true;
}
