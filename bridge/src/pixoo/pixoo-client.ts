/**
 * Pixoo64 HTTP Client — direct REST API for Divoom Pixoo64 LED matrix.
 *
 * Zero dependencies: uses Node 18+ native fetch().
 * All requests have 2s timeout and fail silently (display is non-critical).
 *
 * Frame format: 64×64 RGB = 12,288 bytes → base64 encoded.
 *
 * CRITICAL: PicID must be strictly incrementing — device silently ignores
 * frames with non-sequential IDs (returns error_code:0 but doesn't update display).
 * GetHttpGifId syncs counter; ResetHttpGifId resets to 0 (use sparingly — may crash firmware).
 */

import http from 'node:http';
import { debug } from '../logger.js';

// Pixoo's embedded HTTP server can't handle keep-alive connections properly
// (Node 19+ defaults to keepAlive:true). Force fresh TCP per request.
const pixooAgent = new http.Agent({ keepAlive: false, maxSockets: 1 });

const TAG = 'Pixoo';
const REQUEST_TIMEOUT_MS = 2000;
const PIC_ID_RESYNC_THRESHOLD = 250;  // Re-sync before ~300 overflow

// Per-device static PicID — synced once and held forever (allows real-time streaming without loading screen)
const devicePicId = new Map<string, number>();

/** Clear cached static PicID for a device (call when device reboots to re-sync). */
export function clearStaticPicId(ip: string): void {
  devicePicId.delete(ip);
  debug(TAG, `Static PicID cleared for ${ip} — will re-sync on next push`);
}

// Gamma correction LUT: pow(v/255, 0.7) * 255 — boosts dark values for LED display
const gammaLUT = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  gammaLUT[i] = Math.round(Math.pow(i / 255, 0.7) * 255);
}

// ===== Circuit Breaker (per-device exponential backoff + auto-probe) =====

const deviceBackoff = new Map<string, { failures: number; backoffUntil: number }>();
const BACKOFF_THRESHOLD = 6;            // failures before backing off (ESP32 has transient drops)
const BACKOFF_INITIAL_MS = 5_000;       // 5s initial backoff (quick recovery)
const BACKOFF_MAX_MS = 60_000;          // 1m max cap
const PROBE_INTERVAL_MS = 5_000;        // Probe every 5s during backoff

let probeTimer: ReturnType<typeof setInterval> | null = null;
let statusCallback: ((ip: string, online: boolean) => void) | null = null;

/** Register a callback for device online/offline transitions. */
export function onDeviceStatusChange(cb: (ip: string, online: boolean) => void): void {
  statusCallback = cb;
}

function isBackedOff(ip: string): boolean {
  const entry = deviceBackoff.get(ip);
  if (!entry || entry.failures < BACKOFF_THRESHOLD) return false;
  return Date.now() < entry.backoffUntil;
}

function recordSuccess(ip: string): void {
  const wasBackedOff = isBackedOff(ip);
  deviceBackoff.delete(ip);
  if (wasBackedOff) {
    debug(TAG, `Device ${ip} recovered — backoff cleared, re-syncing PicID`);
    clearStaticPicId(ip);  // Device may have rebooted — force fresh PicID sync
    statusCallback?.(ip, true);
    updateProbeTimer();
  }
}

function recordFailure(ip: string): void {
  const wasBackedOff = isBackedOff(ip);
  const entry = deviceBackoff.get(ip) ?? { failures: 0, backoffUntil: 0 };
  entry.failures++;
  if (entry.failures >= BACKOFF_THRESHOLD) {
    const delay = Math.min(BACKOFF_INITIAL_MS * Math.pow(2, entry.failures - BACKOFF_THRESHOLD), BACKOFF_MAX_MS);
    entry.backoffUntil = Date.now() + delay;
    debug(TAG, `Backoff ${ip}: ${Math.round(delay / 1000)}s (${entry.failures} failures)`);
    if (!wasBackedOff) {
      statusCallback?.(ip, false);
      updateProbeTimer();
    }
  }
  deviceBackoff.set(ip, entry);
}

/** Start/stop the probe timer based on whether any device is backed off. */
function updateProbeTimer(): void {
  const anyBackedOff = [...deviceBackoff.values()].some(
    e => e.failures >= BACKOFF_THRESHOLD && Date.now() < e.backoffUntil
  );
  if (anyBackedOff && !probeTimer) {
    probeTimer = setInterval(probeBackedOffDevices, PROBE_INTERVAL_MS);
    debug(TAG, 'Probe timer started (30s interval)');
  } else if (!anyBackedOff && probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
    debug(TAG, 'Probe timer stopped — all devices online');
  }
}

/** Probe backed-off devices to detect recovery. */
async function probeBackedOffDevices(): Promise<void> {
  const ipsToProbe = [...deviceBackoff.entries()]
    .filter(([, e]) => e.failures >= BACKOFF_THRESHOLD)
    .map(([ip]) => ip);

  for (const ip of ipsToProbe) {
    debug(TAG, `Probing backed-off device ${ip}...`);
    const config = await getDeviceConfig(ip);
    if (config) {
      debug(TAG, `Probe success for ${ip} — restoring connection`);
      recordSuccess(ip);
      // Re-initialize: switch to custom channel
      switchToCustomChannel(ip).catch(() => {});
    }
  }
}

/** Clean up probe timer. Call on shutdown. */
export function stopProbeTimer(): void {
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

/**
 * Wake recovery — clear all PicID caches and circuit breaker state.
 * Devices may have rebooted during sleep, so all cached state is stale.
 */
export function handlePixooWake(): void {
  debug(TAG, `Wake recovery — clearing ${devicePicId.size} PicID(s) and ${deviceBackoff.size} backoff(s)`);
  for (const ip of devicePicId.keys()) {
    clearStaticPicId(ip);
  }
  deviceBackoff.clear();
  if (probeTimer) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

/** Get circuit breaker status for a device. */
export function getDeviceBackoffStatus(ip: string): { failures: number; backedOff: boolean; nextProbeMs: number } {
  const entry = deviceBackoff.get(ip);
  if (!entry) return { failures: 0, backedOff: false, nextProbeMs: 0 };
  const now = Date.now();
  const backedOff = entry.failures >= BACKOFF_THRESHOLD && now < entry.backoffUntil;
  return {
    failures: entry.failures,
    backedOff,
    nextProbeMs: backedOff ? entry.backoffUntil - now : 0,
  };
}

/**
 * POST a command to the Pixoo device using node:http (not fetch).
 * Pixoo's embedded HTTP server can't handle keep-alive connections —
 * Node 19+ fetch uses keepAlive:true by default, causing timeouts after 2-3 requests.
 */
async function postCommand(ip: string, command: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<boolean> {
  if (isBackedOff(ip)) return false;

  try {
    const result = await httpPost(ip, command, timeoutMs);
    if (!result) {
      recordFailure(ip);
      return false;
    }
    recordSuccess(ip);
    return true;
  } catch (err: any) {
    debug(TAG, `Request failed to ${ip}: ${err.message}`);
    recordFailure(ip);
    return false;
  }
}

/** Low-level HTTP POST with keepAlive:false agent. */
function httpPost(ip: string, body: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: ip,
      port: 80,
      path: '/post',
      method: 'POST',
      agent: pixooAgent,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: timeoutMs,
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          debug(TAG, `HTTP ${res.statusCode} from ${ip}`);
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
        } catch {
          resolve({});
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(data);
  });
}

/** Max frames in one device-side animation (Divoom documents PicNum < 60). */
export const PIXOO_MAX_ANIMATION_FRAMES = 40;
/** Pause between the per-frame POSTs of one animation upload. */
export const PIXOO_ANIMATION_FRAME_GAP_MS = 120;

/**
 * Build the `Draw/SendHttpGif` requests for one animation, as the Divoom LAN
 * API specifies it: ONE request per frame, every request carrying the same
 * `PicID` and `PicNum`, with `PicOffset` = that frame's index and `PicData` =
 * exactly one 64×64 RGB frame (12,288 bytes → 16,384 base64 chars).
 *
 * The multi-frame attempts recorded in 2026-06/07 (REST timeout and 60–87.5%
 * ping loss right after the request) sent every frame concatenated into ONE
 * `PicData` at `PicOffset: 0` — an N× oversized body the API never documents.
 * A single-frame command stays byte-identical to the proven path.
 */
export function buildSendHttpGifCommands(
  buffers: Uint8Array[],
  picId: number,
  speedMs: number,
): Array<Record<string, unknown>> {
  return buffers.map((buffer, offset) => {
    const boosted = new Uint8Array(buffer.length);
    for (let i = 0; i < buffer.length; i++) boosted[i] = gammaLUT[buffer[i]];
    return {
      Command: 'Draw/SendHttpGif',
      PicNum: buffers.length,
      PicWidth: 64,
      PicOffset: offset,
      PicID: picId,
      PicSpeed: speedMs,
      PicData: Buffer.from(boosted).toString('base64'),
    };
  });
}

/**
 * Push one image (1 buffer) or one device-side looping animation (N buffers).
 * Frames of an animation are uploaded strictly sequentially, each awaited and
 * spaced by `PIXOO_ANIMATION_FRAME_GAP_MS`; the first failed frame aborts the
 * upload and forces a PicID re-sync on the next push.
 * @param buffers - Raw RGB buffers, each 12,288 bytes (64 * 64 * 3)
 * @param speed - Playback speed in ms per frame
 */
export async function pushFrames(ip: string, buffers: Uint8Array[], speed = 100): Promise<boolean> {
  if (buffers.length === 0 || buffers.length > PIXOO_MAX_ANIMATION_FRAMES) return false;
  for (const buffer of buffers) {
    if (buffer.length !== 64 * 64 * 3) {
      debug(TAG, `Invalid frame size: ${buffer.length} (expected 12288)`);
      return false;
    }
  }

  // Get or initialize PicID for this device
  let picId = devicePicId.get(ip);
  if (picId === undefined) {
    // First push — sync with device's current counter + 1 to ensure freshness
    const synced = await getHttpGifId(ip);
    if (synced === null) {
      debug(TAG, `Failed to sync PicID for ${ip} — will retry next time`);
      return false;
    }
    picId = synced;
    debug(TAG, `Synced PicID for ${ip}: ${picId}`);
  }

  // One PicID per image/animation (device shows new content only on a new sequential ID)
  picId++;

  // Prevent counter overflow (~300 causes device lockup) — reset gracefully
  if (picId >= PIC_ID_RESYNC_THRESHOLD) {
    debug(TAG, `PicID ${picId} near overflow for ${ip}, resetting and sleeping 2s for stabilization`);
    await resetPicId(ip);
    await new Promise(resolve => setTimeout(resolve, 2000));
    picId = 1;
  }

  devicePicId.set(ip, picId);

  const commands = buildSendHttpGifCommands(buffers, picId, speed);
  for (let i = 0; i < commands.length; i++) {
    if (i > 0) await new Promise(resolve => setTimeout(resolve, PIXOO_ANIMATION_FRAME_GAP_MS));
    const ok = await postCommand(ip, commands[i], 5000);
    if (!ok) {
      if (commands.length > 1) {
        devicePicId.delete(ip);
        debug(TAG, `Animation upload to ${ip} failed at frame ${i + 1}/${commands.length}`);
      }
      return false;
    }
  }
  return true;
}

/**
 * Push a single 64×64 RGB frame to the device.
 * @param buffer - 12,288 bytes (64 * 64 * 3) raw RGB
 */
export async function pushFrame(ip: string, buffer: Uint8Array): Promise<boolean> {
  return pushFrames(ip, [buffer], 1000);
}

/**
 * Send scrolling text overlay (device-native font, supports long text).
 * Up to 20 simultaneous text items supported by device.
 * @param textId - 0-19, used to update/remove specific text
 * @param color - hex color string e.g. "#22c55e"
 * @param speed - scroll speed 0-100 (default 50)
 */
export async function sendScrollText(
  ip: string, textId: number, text: string, color: string, speed = 50
): Promise<boolean> {
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);

  return postCommand(ip, {
    Command: 'Draw/SendHttpText',
    TextId: textId,
    x: 0,
    y: 0,
    dir: 0,          // 0=left scroll
    font: 2,         // small built-in font
    TextWidth: 64,
    speed,
    TextString: text,
    color: `#${color.slice(1)}`,
    align: 1,
  });
}

/** Clear all text overlays. */
export async function clearText(ip: string): Promise<boolean> {
  return postCommand(ip, { Command: 'Draw/ClearHttpText' });
}

/** Set display brightness (0-100). */
export async function setBrightness(ip: string, value: number): Promise<boolean> {
  return postCommand(ip, {
    Command: 'Channel/SetBrightness',
    Brightness: Math.max(0, Math.min(100, value)),
  });
}

/** Query the device's current PicID counter. Returns null on failure. */
export async function getHttpGifId(ip: string): Promise<number | null> {
  try {
    const data = await httpPost(ip, { Command: 'Draw/GetHttpGifId' });
    if (!data) return null;
    return (data as any)?.PicId ?? 0;
  } catch {
    return null;
  }
}

/**
 * Is the panel still showing what WE last uploaded? Two tiny queries, no upload
 * (so no loading hourglass): the active channel is Custom (3) and the device's
 * PicID counter has not fallen below ours. NOT equality: measured 2026-10-08 on
 * the Pixoo64, the counter does not track the uploaded ID one-for-one (215 →
 * 217 after one single-frame upload, → 218 after a four-frame one), so equality
 * called every healthy device stale. A reboot resets the counter (lower), a
 * button press changes the channel — those are the two things worth catching.
 * Three answers, not two: `unknown` (a query failed,
 * or the device is backed off) must never read as `stale`, or a flaky link
 * re-uploads forever — the caller retains and asks again later.
 */
export type DeviceContent = 'ours' | 'stale' | 'unknown';
export async function checkDeviceContent(ip: string): Promise<DeviceContent> {
  if (isBackedOff(ip)) return 'unknown';
  const expected = devicePicId.get(ip);
  if (expected === undefined) return 'stale';
  try {
    const channel = await httpPost(ip, { Command: 'Channel/GetIndex' });
    const picId = await getHttpGifId(ip);
    if (!channel || picId === null) return 'unknown';
    return channel.SelectIndex === 3 && picId >= expected ? 'ours' : 'stale';
  } catch {
    return 'unknown';
  }
}

/** Reset the PicID counter to prevent device lockup. */
export async function resetPicId(ip: string): Promise<boolean> {
  return postCommand(ip, { Command: 'Draw/ResetHttpGifId' });
}

/** Switch device to the custom channel that shows SendHttpGif content. */
export async function switchToCustomChannel(ip: string): Promise<boolean> {
  // SelectIndex: 0=Faces, 1=Cloud, 2=Visualizer, 3=Custom
  return postCommand(ip, { Command: 'Channel/SetIndex', SelectIndex: 3 });
}

/**
 * Get device configuration (also serves as a connectivity test).
 * Returns null on failure.
 */
export async function getDeviceConfig(ip: string, timeoutMs?: number): Promise<Record<string, unknown> | null> {
  try {
    return await httpPost(ip, { Command: 'Channel/GetAllConf' }, timeoutMs);
  } catch {
    return null;
  }
}

/**
 * Discover Pixoo devices via Divoom cloud API.
 * Falls back gracefully if cloud is unreachable.
 */
export async function discoverDevices(): Promise<Array<{ name: string; ip: string }>> {
  try {
    const response = await fetch('https://app.divoom-gz.com/Device/ReturnSameLANDevice', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return [];
    const data = await response.json() as any;
    if (!data?.DeviceList) return [];
    return data.DeviceList.map((d: any) => ({
      name: d.DeviceName || 'Pixoo',
      ip: d.DevicePrivateIP,
    }));
  } catch {
    return [];
  }
}
