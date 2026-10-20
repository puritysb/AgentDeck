/**
 * WiFi credential management for ESP32 auto-provisioning.
 *
 * Stores SSID/password in <data dir>/wifi-config.json (`AGENTDECK_DATA_DIR`,
 * else ~/.agentdeck), like every other file the daemon keeps.
 * Can auto-detect current macOS WiFi SSID and query Keychain for password.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { debug, log } from './logger.js';

const LEGACY_DIR = join(homedir(), '.agentdeck');

// Resolved per call, from the same override every other data file honours.
// It used to be fixed at ~/.agentdeck, so a daemon run with AGENTDECK_DATA_DIR
// (a captured systemd unit, a throwaway test daemon) read the user's real
// credentials while keeping everything else elsewhere.
function dataDir(): string {
  return process.env.AGENTDECK_DATA_DIR || LEGACY_DIR;
}

/** Where the credentials live for this process. */
export function wifiConfigPath(): string {
  return join(dataDir(), 'wifi-config.json');
}

let legacyHintShown = false;

export interface WifiConfig {
  ssid: string;
  password: string;
  autoProvision: boolean;
}

/** Load saved WiFi config, or null if not configured. */
export function loadWifiConfig(): WifiConfig | null {
  try {
    const file = wifiConfigPath();
    if (!existsSync(file)) {
      // Say where an earlier save went, without reading it: under an override
      // that file belongs to another data dir, and tests must never load it.
      const legacy = join(LEGACY_DIR, 'wifi-config.json');
      if (!legacyHintShown && file !== legacy && existsSync(legacy)) {
        legacyHintShown = true;
        log(`[wifi-config] No WiFi config in ${dataDir()}; one exists in ~/.agentdeck. Run \`agentdeck wifi-setup\` with AGENTDECK_DATA_DIR set to use it here.`);
      }
      return null;
    }
    const data = JSON.parse(readFileSync(file, 'utf-8'));
    if (data.ssid && data.password) {
      return {
        ssid: data.ssid,
        password: data.password,
        autoProvision: data.autoProvision !== false,
      };
    }
  } catch {
    debug('wifi-config', 'Failed to load wifi-config.json');
  }
  return null;
}

/** Save WiFi config to disk. */
export function saveWifiConfig(config: WifiConfig): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(wifiConfigPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    debug('wifi-config', `Saved WiFi config for SSID: ${config.ssid}`);
  } catch (err) {
    debug('wifi-config', `Failed to save wifi-config.json: ${err}`);
    throw err;
  }
}

/** Detect current macOS WiFi SSID. Returns null on other platforms or if not connected. */
export function detectCurrentSSID(): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    // Find the actual Wi-Fi interface (not always en0 — e.g. en1 on Mac Studio)
    const ports = execSync('networksetup -listallhardwareports', {
      encoding: 'utf-8', timeout: 3000,
    });
    const wifiMatch = ports.match(/Hardware Port: Wi-Fi\nDevice: (en\d+)/);
    const iface = wifiMatch ? wifiMatch[1] : 'en0';

    const output = execSync(`networksetup -getairportnetwork ${iface}`, {
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
    // Output: "Current Wi-Fi Network: MyNetwork"
    const match = output.match(/Current Wi-Fi Network:\s*(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Try to retrieve WiFi password from macOS Keychain.
 * Requires user approval (Touch ID / password dialog) on first access.
 * Returns null if not found or denied.
 */
export function getKeychainPassword(ssid: string): string | null {
  if (process.platform !== 'darwin') return null;
  try {
    const output = execSync(
      `security find-generic-password -ga "${ssid.replace(/"/g, '\\"')}" -w 2>/dev/null`,
      { encoding: 'utf-8', timeout: 10000 },
    ).trim();
    return output || null;
  } catch {
    return null;
  }
}
