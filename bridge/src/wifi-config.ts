/**
 * WiFi credential management for ESP32 auto-provisioning.
 *
 * Stores SSID/password in ~/.agentdeck/wifi-config.json.
 * Can auto-detect current macOS WiFi SSID and query Keychain for password.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from './proc.js';
import { debug } from './logger.js';

const AGENTDECK_DIR = join(homedir(), '.agentdeck');
const WIFI_CONFIG_FILE = join(AGENTDECK_DIR, 'wifi-config.json');

export interface WifiConfig {
  ssid: string;
  password: string;
  autoProvision: boolean;
}

/** Load saved WiFi config, or null if not configured. */
export function loadWifiConfig(): WifiConfig | null {
  try {
    if (!existsSync(WIFI_CONFIG_FILE)) return null;
    const data = JSON.parse(readFileSync(WIFI_CONFIG_FILE, 'utf-8'));
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
    mkdirSync(AGENTDECK_DIR, { recursive: true });
    writeFileSync(WIFI_CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
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
