import { execSync } from './proc.js';
import { debug } from './logger.js';

const TAG = 'adb';
const ANDROID_PORT = 9120;

/**
 * ADB reverse tunnel management for Android dashboard clients.
 * D200H Deck Dock is driven by the Ulanzi Studio plugin over WebSocket — no ADB needed.
 */

export function hasAdb(): boolean {
  try {
    execSync('which adb', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export function getConnectedAdbDevices(): string[] {
  try {
    const output = execSync('adb devices', { stdio: 'pipe', timeout: 5000 }).toString();
    const lines = output.split('\n').slice(1).filter((l) => l.trim().length > 0);
    const connected: string[] = [];
    for (const line of lines) {
      const [serial, state] = line.split('\t');
      if (state === 'device') {
        connected.push(serial);
      } else if (state === 'unauthorized') {
        debug(TAG, `Device ${serial} is unauthorized — accept USB debugging prompt on device`);
      } else if (state === 'offline') {
        debug(TAG, `Device ${serial} is offline`);
      }
    }
    return connected;
  } catch {
    return [];
  }
}

/**
 * Set up `adb reverse` for all connected Android devices.
 * Non-blocking, best-effort — bridge starts fine without adb.
 */
export function setupAdbReverse(port: number): void {
  if (!hasAdb()) {
    debug(TAG, 'adb not found, skipping reverse setup');
    return;
  }

  const devices = getConnectedAdbDevices();
  if (devices.length === 0) {
    debug(TAG, 'no connected devices');
    return;
  }

  for (const serial of devices) {
    try {
      execSync(`adb -s ${serial} reverse tcp:${ANDROID_PORT} tcp:${port}`, {
        stdio: 'pipe',
        timeout: 5000,
      });
      debug(TAG, `adb reverse ${serial}: android:${ANDROID_PORT} → daemon:${port}`);
    } catch (err) {
      debug(TAG, `adb reverse failed for ${serial}: ${err}`);
    }
  }
}

/**
 * Periodically re-check adb reverse (handles USB re-plug).
 * Returns a cleanup function to stop polling.
 */
export function startAdbReversePolling(port: number, intervalMs = 30_000): () => void {
  if (!hasAdb()) return () => {};

  const timer = setInterval(() => {
    const devices = getConnectedAdbDevices();
    if (devices.length === 0) return;

    for (const serial of devices) {
      try {
        // Check if reverse already exists — if not, set it up
        const existing = execSync(`adb -s ${serial} reverse --list`, {
          stdio: 'pipe',
          timeout: 5000,
        }).toString();
        if (!existing.includes(`tcp:${ANDROID_PORT}`)) {
          execSync(`adb -s ${serial} reverse tcp:${ANDROID_PORT} tcp:${port}`, {
            stdio: 'pipe',
            timeout: 5000,
          });
          debug(TAG, `adb reverse re-established ${serial}: android:${ANDROID_PORT} → daemon:${port}`);
        }
      } catch (err: any) {
        debug(TAG, `adb reverse poll failed for ${serial}: ${err?.message ?? err}`);
      }
    }
  }, intervalMs);

  return () => clearInterval(timer);
}

/**
 * Get number of currently connected ADB devices (best-effort).
 */
export function getAdbDeviceCount(): number {
  if (!hasAdb()) return 0;
  return getConnectedAdbDevices().length;
}

/**
 * Remove `adb reverse` mappings on shutdown.
 */
export function cleanupAdbReverse(port: number): void {
  if (!hasAdb()) return;

  const devices = getConnectedAdbDevices();
  for (const serial of devices) {
    try {
      execSync(`adb -s ${serial} reverse --remove tcp:${ANDROID_PORT}`, {
        stdio: 'pipe',
        timeout: 3000,
      });
      debug(TAG, `removed reverse for ${serial}`);
    } catch {
      // ignore — device may already be disconnected
    }
  }
}
