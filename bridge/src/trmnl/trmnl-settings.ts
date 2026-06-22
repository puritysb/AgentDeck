/**
 * TRMNL BYOS settings — reads/writes the `trmnl` block in
 * ~/.agentdeck/settings.json, preserving all other keys (same pattern as
 * pixoo-settings.ts).
 *
 * Shape:
 *   "trmnl": {
 *     "enabled": false,            // force the module on even with no device yet
 *     "refreshRate": 180,          // seconds between device polls
 *     "autoRegister": true,        // auto-enroll a device that hits /api/setup
 *     "devices": [ { mac, apiKey, friendlyId, name? } ]
 *   }
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomBytes } from 'crypto';

// Resolve lazily so tests (and explicit pinning) can redirect via
// AGENTDECK_DATA_DIR, matching apme/settings.ts and esp32-serial.ts.
function settingsDir(): string {
  return process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
}
function settingsPath(): string {
  return join(settingsDir(), 'settings.json');
}

export const TRMNL_DEFAULT_REFRESH = 180;
/** Cadence used while an agent is AWAITING/WORKING so the panel updates fast. */
export const TRMNL_DEFAULT_REFRESH_ACTIVE = 30;
/** Floor on any cadence — too-frequent polls drain the panel battery. */
export const TRMNL_MIN_REFRESH = 15;

export interface TrmnlDevice {
  /** Normalized (uppercase, colon-separated) MAC address — the device identity. */
  mac: string;
  /** Secret issued at /api/setup, presented back as the Access-Token header. */
  apiKey: string;
  /** Short human-friendly id shown on the device + in logs. */
  friendlyId: string;
  /** Optional user label. */
  name?: string;
}

export interface TrmnlConfig {
  enabled: boolean;
  /** Idle cadence (seconds) — the slow, battery-friendly default. */
  refreshRate: number;
  /** Cadence (seconds) while any session is AWAITING/WORKING. */
  refreshActive: number;
  autoRegister: boolean;
  devices: TrmnlDevice[];
}

/** Cadence for a poll given current session activity, clamped to the floor. */
export function effectiveRefreshRate(
  cfg: TrmnlConfig,
  activity: { awaiting: number; working: number },
): number {
  const active = activity.awaiting > 0 || activity.working > 0;
  return Math.max(TRMNL_MIN_REFRESH, active ? cfg.refreshActive : cfg.refreshRate);
}

function readSettings(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf-8'));
  } catch {
    return {};
  }
}

function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(settingsDir(), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2) + '\n');
}

/** Load the trmnl config with defaults filled in. */
export function loadTrmnlConfig(): TrmnlConfig {
  const raw = (readSettings().trmnl ?? {}) as Partial<TrmnlConfig>;
  const refreshRate =
    typeof raw.refreshRate === 'number' && raw.refreshRate >= 5 ? Math.floor(raw.refreshRate) : TRMNL_DEFAULT_REFRESH;
  const refreshActive =
    typeof raw.refreshActive === 'number' && raw.refreshActive >= 5
      ? Math.floor(raw.refreshActive)
      : TRMNL_DEFAULT_REFRESH_ACTIVE;
  return {
    enabled: raw.enabled === true,
    refreshRate,
    refreshActive,
    autoRegister: raw.autoRegister !== false, // default on
    devices: Array.isArray(raw.devices) ? raw.devices.filter((d) => d && typeof d.mac === 'string') : [],
  };
}

function saveTrmnlConfig(cfg: TrmnlConfig): void {
  const settings = readSettings();
  settings.trmnl = cfg;
  writeSettings(settings);
}

/**
 * Normalize a MAC to a stable identity key. A canonical 12-hex address becomes
 * uppercase colon-separated pairs; any other id (some firmware/cloud setups
 * report non-standard or punctuated identifiers) collapses to its bare uppercase
 * hex digits. Returning the raw, untrimmed string for the odd case would orphan
 * or duplicate a device whose punctuation varies between polls — so we always
 * derive a deterministic key from the hex content.
 */
export function normalizeMac(mac: string): string {
  const hex = (mac || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length === 12) return hex.match(/.{2}/g)!.join(':');
  return hex || (mac || '').trim().toUpperCase();
}

/** True when two MAC spellings resolve to the same canonical identity. */
export function sameMac(a: string, b: string): boolean {
  return normalizeMac(a) === normalizeMac(b);
}

export function findDeviceByMac(mac: string): TrmnlDevice | undefined {
  return loadTrmnlConfig().devices.find((d) => sameMac(d.mac, mac));
}

function genFriendlyId(): string {
  // 6 chars from an unambiguous base32 alphabet (no 0/1/O/I).
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * Find or create a device record for the given MAC. Returns the device and
 * whether it was newly created. Respects `autoRegister`: when off, a new MAC
 * is NOT persisted and `created` is false with `device` undefined.
 */
export function ensureDevice(mac: string, name?: string): { device?: TrmnlDevice; created: boolean } {
  const cfg = loadTrmnlConfig();
  const norm = normalizeMac(mac);
  const existing = cfg.devices.find((d) => sameMac(d.mac, mac));
  if (existing) return { device: existing, created: false };
  if (!cfg.autoRegister) return { created: false };

  const device: TrmnlDevice = {
    mac: norm,
    apiKey: randomBytes(16).toString('hex'),
    friendlyId: genFriendlyId(),
    name,
  };
  cfg.devices.push(device);
  saveTrmnlConfig(cfg);
  return { device, created: true };
}

export function removeDevice(mac: string): boolean {
  const cfg = loadTrmnlConfig();
  const filtered = cfg.devices.filter((d) => !sameMac(d.mac, mac));
  if (filtered.length === cfg.devices.length) return false;
  cfg.devices = filtered;
  saveTrmnlConfig(cfg);
  return true;
}
