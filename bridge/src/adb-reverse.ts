import { execFile } from 'child_process';
import { promisify } from 'util';
import { debug, log } from './logger.js';

const execFileAsync = promisify(execFile);

const TAG = 'adb';
const ANDROID_PORT = 9120;

/**
 * ADB reverse tunnel management for Android dashboard clients.
 * D200H Deck Dock is driven by the Ulanzi Studio plugin over WebSocket — no ADB needed.
 *
 * Every spawn in this module is ASYNC, and that is load-bearing: this code runs
 * on the daemon's event loop, from a 30 s poll and (via the cached count) from
 * /status and /devices. The synchronous `execSync` spelling blocked the loop
 * for the whole wall time of `adb devices` — 19 ms idle, ~170 ms at load 10,
 * and 5–15 s during the 2026-09-13 release check at host load 600–800 (#327),
 * which starved /health until the macOS app promoted a fallback daemon on 9121
 * and opened the same serial devices. Nothing here may call execSync /
 * spawnSync again; `adb-async.test.ts` greps for it.
 */

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

/**
 * Parse `adb devices` output into connected serials. Exported as a pure
 * function so the offline/unauthorized/network-transport cases stay testable
 * without spawning adb.
 */
export function parseAdbDeviceLines(output: string, opts: { usbOnly?: boolean } = {}): string[] {
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
}

export interface AdbReverseOptions {
  /**
   * Restrict to USB-transport devices (loopback posture). Network-transport
   * devices (`adb connect`, wireless debugging) are skipped, not torn down.
   */
  usbOnly?: boolean;
}

/** Cache of the last device list, refreshed by the poll / explicit reads.
 * /status and /devices serve this instead of spawning adb on the request
 * path — a synchronous count there was half of #327's loop starvation. */
let cachedDevices: string[] = [];
let cachedAtMs = 0;

export function getCachedAdbDevices(): { devices: string[]; ageMs: number } {
  return { devices: cachedDevices, ageMs: cachedAtMs ? Date.now() - cachedAtMs : Number.POSITIVE_INFINITY };
}

/** Serve the cached count instantly (0 before the first refresh). */
export function getAdbDeviceCountCached(): number {
  return cachedDevices.length;
}

/** Test seam for the cache; production code never calls it. */
export function __setCachedAdbDevicesForTest(devices: string[]): void {
  cachedDevices = devices;
  cachedAtMs = devices.length ? Date.now() : 0;
}

export async function getConnectedAdbDevices(opts: AdbReverseOptions = {}): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('adb', ['devices'], { timeout: 5000, windowsHide: true });
    const connected = parseAdbDeviceLines(stdout.toString(), opts);
    cachedDevices = connected;
    cachedAtMs = Date.now();
    return connected;
  } catch {
    return [];
  }
}

export type AdbReverseState = { kind: 'absent' | 'matching' | 'unknown' } | { kind: 'conflict'; target: string };
/** --list names endpoints, not an OS user. Malformed data is unknown. */
export function inspectAdbReverse(output: string, port: number): AdbReverseState {
  const matches: string[] = [];
  for (const line of output.split(/\r?\n/).filter(l => l.trim())) {
    const fields = line.trim().split(/\s+/);
    if (fields.length !== 3) return { kind: 'unknown' };
    if (fields[1] === `tcp:${ANDROID_PORT}`) matches.push(fields[2]);
  }
  if (matches.length > 1) return { kind: 'unknown' };
  if (!matches.length) return { kind: 'absent' };
  return matches[0] === `tcp:${port}` ? { kind: 'matching' } : { kind: 'conflict', target: matches[0] };
}
const notices = new Map<string, string>();
function warnReverse(serial: string, state: AdbReverseState): void {
  const message = state.kind === 'conflict' ? `already maps to ${state.target.replace(/[^a-zA-Z0-9_.:/-]/g, '').slice(0, 80)}` : 'could not be inspected';
  if (notices.get(serial) === message) return;
  if (notices.size >= 64) notices.clear();
  notices.set(serial, message);
  log(`[agentdeck] ADB reverse on ${serial.replace(/[^a-zA-Z0-9_.:-]/g, '')}: Android tcp:${ANDROID_PORT} ${message}; left unchanged. Another daemon or OS user may own it. Check its owner before changing the USB mapping.`);
}
async function ensureAdbReverse(serial: string, port: number, active = () => true): Promise<void> {
  let state: AdbReverseState;
  try {
    const { stdout } = await execFileAsync('adb', ['-s', serial, 'reverse', '--list'], { timeout: 5000, windowsHide: true });
    state = inspectAdbReverse(stdout.toString(), port);
  } catch { state = {kind:'unknown'}; }
  if (!active()) return;
  if (state.kind === 'matching') { notices.delete(serial); return; }
  if (state.kind !== 'absent') { warnReverse(serial,state); return; }
  try {
    // The probe is advisory. --no-rebind closes the create-after-probe race:
    // an intervening owner wins and is never overwritten.
    await execFileAsync('adb', ['-s', serial, 'reverse', '--no-rebind', `tcp:${ANDROID_PORT}`, `tcp:${port}`], { timeout: 5000, windowsHide: true });
    notices.delete(serial);
    debug(TAG, `adb reverse ${serial}: android:${ANDROID_PORT} → daemon:${port}`);
  } catch { if (active()) warnReverse(serial,{kind:'unknown'}); }
}

/** Set up missing mappings only. Never replace another endpoint. */
export async function setupAdbReverse(port: number, opts: AdbReverseOptions = {}): Promise<void> {
  const devices = await getConnectedAdbDevices(opts);
  for (const serial of devices) await ensureAdbReverse(serial, port);
}

/**
 * Periodically re-check adb reverse (handles USB re-plug).
 * Returns a cleanup function to stop polling.
 *
 * The tick body is async and serialized: a stalled adb call under host load
 * must not stack intervals on top of itself.
 */
export function startAdbReversePolling(
  port: number,
  opts: AdbReverseOptions & { intervalMs?: number } = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 30_000;
  let inFlight = false, active = true;

  const timer = setInterval(() => {
    if (!active || inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const devices = await getConnectedAdbDevices(opts);
        for (const serial of devices) {
          if (!active) break;
          await ensureAdbReverse(serial, port, () => active);
        }
      } finally {
        inFlight = false;
      }
    })();
  }, intervalMs);

  return () => { active = false; clearInterval(timer); };
}

/**
 * Get number of currently connected ADB devices (spawns adb — use
 * getAdbDeviceCountCached() from request handlers).
 */
export async function getAdbDeviceCount(): Promise<number> {
  return (await getConnectedAdbDevices()).length;
}

/** ADB has no compare-and-remove operation. Leave mappings on shutdown rather
 * than deleting a replacement installed by another process after our probe.
 * A later owner of the same host port can reuse the mapping; a different target
 * is reported as a conflict and requires an explicit operator decision. */
export async function cleanupAdbReverse(_port: number): Promise<void> {
  debug(TAG, 'Leaving ADB reverse mappings intact: endpoint listing cannot prove ownership for removal');
}
