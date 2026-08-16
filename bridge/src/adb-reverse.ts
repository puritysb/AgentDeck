import { execSync } from 'child_process';
import { debug } from './logger.js';

const TAG = 'adb';
const ANDROID_PORT = 9120;

/**
 * ADB reverse tunnel management for Android dashboard clients.
 * D200H Deck Dock is driven by the Ulanzi Studio plugin over WebSocket — no ADB needed.
 */

export function hasAdb(): boolean {
  try {
    execSync('which adb', { stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * True when an adb serial names a network transport rather than a USB cable.
 *
 * `adb devices` lists TCP/IP devices as `<ip>:<port>` (after `adb connect`) and
 * wireless-debugging devices by their mDNS instance name
 * (`adb-<serial>-<suffix>._adb-tls-connect._tcp`). USB serials contain neither
 * a `:` nor a service-type suffix. The distinction matters for the loopback
 * posture: `adb reverse` over USB terminates on the host's own loopback and
 * emits nothing onto the LAN, but the same command against a TCP/mDNS device
 * stands up a LAN-carried tunnel — which would let a network peer reach a
 * daemon whose posture promises "LAN devices cannot connect".
 * (`emulator-5554` is neither — the emulator console is host-local.)
 */
export function isNetworkAdbTransport(serial: string): boolean {
  return serial.includes(':') || serial.includes('._adb');
}

export interface AdbReverseOptions {
  /**
   * Restrict to USB-transport devices (loopback posture). Network-transport
   * devices (`adb connect`, wireless debugging) are skipped, not torn down.
   */
  usbOnly?: boolean;
}

export function getConnectedAdbDevices(opts: AdbReverseOptions = {}): string[] {
  try {
    const output = execSync('adb devices', { stdio: 'pipe', timeout: 5000, windowsHide: true }).toString();
    const lines = output.split('\n').slice(1).filter((l) => l.trim().length > 0);
    const connected: string[] = [];
    for (const line of lines) {
      const [serial, state] = line.split('\t');
      if (state === 'device') {
        if (opts.usbOnly && isNetworkAdbTransport(serial)) {
          debug(TAG, `Skipping ${serial} — network adb transport excluded under loopback posture`);
          continue;
        }
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
export function setupAdbReverse(port: number, opts: AdbReverseOptions = {}): void {
  if (!hasAdb()) {
    debug(TAG, 'adb not found, skipping reverse setup');
    return;
  }

  const devices = getConnectedAdbDevices(opts);
  if (devices.length === 0) {
    debug(TAG, 'no connected devices');
    return;
  }

  for (const serial of devices) {
    try {
      execSync(`adb -s ${serial} reverse tcp:${ANDROID_PORT} tcp:${port}`, {
        stdio: 'pipe',
        timeout: 5000,
        windowsHide: true,
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
export function startAdbReversePolling(
  port: number,
  opts: AdbReverseOptions & { intervalMs?: number } = {},
): () => void {
  if (!hasAdb()) return () => {};
  const intervalMs = opts.intervalMs ?? 30_000;

  const timer = setInterval(() => {
    const devices = getConnectedAdbDevices(opts);
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
        windowsHide: true,
      });
      debug(TAG, `removed reverse for ${serial}`);
    } catch {
      // ignore — device may already be disconnected
    }
  }
}
