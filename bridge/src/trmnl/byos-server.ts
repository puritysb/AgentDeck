/**
 * TRMNL BYOS (Bring Your Own Server) HTTP handlers, mounted on the daemon hub.
 *
 * Implements the minimal TRMNL device contract so a stock-firmware panel pointed
 * at `http://<daemon-host>:9120` renders the AgentDeck dashboard:
 *
 *   GET  /api/setup    ID:<mac>                       → { api_key, friendly_id, image_url }
 *   GET  /api/display  ID:<mac> Access-Token:<key>    → { image_url, filename, refresh_rate, ... }
 *   GET  /trmnl/image/<W>x<H>-<hash>.png              → 1-bit PNG frame (per resolution)
 *   POST /api/log      ID:<mac>                        → 204 (device logs, debug only)
 *
 * The device authenticates only by MAC (ID header); the api_key issued at setup
 * is a soft gate on /api/display. This is LAN-local hardware, so no token is
 * required to fetch the image itself. Any panel auto-enrolls regardless of MAC,
 * and the dashboard is rendered at the device-reported Width/Height so different
 * BYOS panels render correctly. The device's FW-Version/RSSI/Battery/etc. headers
 * are captured as runtime telemetry. See docs: https://docs.trmnl.com/go/diy/byos
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { TRMNL_WIDTH, TRMNL_HEIGHT } from '@agentdeck/shared';
import {
  ensureDevice,
  findDeviceByMac,
  loadTrmnlConfig,
  normalizeMac,
  effectiveRefreshRate,
} from './trmnl-settings.js';
import { getTrmnlFrame, getTrmnlFrameByKey, forceRenderTrmnlFrame, getTrmnlActivity } from './frame-cache.js';
import type { TrmnlFrame } from './image-renderer.js';
import { recordTelemetry } from './trmnl-telemetry.js';
import { debug } from '../logger.js';

const TAG = 'trmnl-byos';

// Sane device-reported resolution bounds; anything outside falls back to OG size.
const MIN_DIM = 120;
const MAX_DIM = 4000;

function header(req: IncomingMessage, name: string): string {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? (v[0] ?? '') : (v ?? '');
}

function toNum(v: string): number | null {
  if (!v) return null;
  const n = Number(v.trim());
  return Number.isFinite(n) ? n : null;
}

interface DeviceHeaders {
  mac: string;
  accessToken: string;
  fwVersion: string;
  batteryVoltage: number | null;
  rssi: number | null;
  refreshRate: number | null;
  /** Sanitized panel width (null when absent/out-of-range → caller defaults). */
  width: number | null;
  /** Sanitized panel height (null when absent/out-of-range → caller defaults). */
  height: number | null;
  userAgent: string;
}

/** Parse the BYOS telemetry headers a panel sends on /api/setup + /api/display. */
function parseDeviceHeaders(req: IncomingMessage): DeviceHeaders {
  const sane = (n: number | null) => (n != null && n >= MIN_DIM && n <= MAX_DIM ? Math.round(n) : null);
  return {
    mac: header(req, 'ID'),
    accessToken: header(req, 'Access-Token'),
    fwVersion: header(req, 'FW-Version'),
    batteryVoltage: toNum(header(req, 'Battery-Voltage')),
    rssi: toNum(header(req, 'RSSI')),
    refreshRate: toNum(header(req, 'Refresh-Rate')),
    width: sane(toNum(header(req, 'Width'))),
    height: sane(toNum(header(req, 'Height'))),
    userAgent: header(req, 'User-Agent'),
  };
}

/** Render size for a device: its reported resolution, or the OG default. */
function renderSize(h: DeviceHeaders): { width: number; height: number } {
  return { width: h.width ?? TRMNL_WIDTH, height: h.height ?? TRMNL_HEIGHT };
}

/** Build the image URL, qualified by resolution so the image route serves the
 * right-sized frame. The hash is the cache-buster the firmware re-downloads on. */
function imageUrl(req: IncomingMessage, size: { width: number; height: number }, hash: string): string {
  return `${imageBase(req)}/trmnl/image/${size.width}x${size.height}-${hash}.png`;
}

function imageBase(req: IncomingMessage): string {
  // The device reached us at exactly this host:port — reuse it so the image_url
  // is always resolvable from the device's perspective (no IP guessing).
  return `http://${req.headers.host ?? 'localhost'}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(payload);
}

/** GET /api/setup — enroll the device (by MAC) and hand back an api_key. */
export function handleTrmnlSetup(req: IncomingMessage, res: ServerResponse): void {
  const h = parseDeviceHeaders(req);
  const mac = h.mac;
  if (!mac) {
    sendJson(res, 400, { status: 400, message: 'Missing ID (MAC) header' });
    return;
  }
  const { device, created } = ensureDevice(mac);
  if (!device) {
    // autoRegister is off and this MAC isn't enrolled.
    debug(TAG, `setup rejected for ${normalizeMac(mac)} (autoRegister off, not enrolled)`);
    sendJson(res, 404, { status: 404, message: 'Device not enrolled. Add it to settings.trmnl.devices.' });
    return;
  }
  recordTelemetry(mac, h);
  const size = renderSize(h);
  if (created) {
    debug(TAG, `enrolled TRMNL ${device.mac} as ${device.friendlyId} (${size.width}x${size.height})`);
    forceRenderTrmnlFrame(size.width, size.height); // first served image reflects live state
  }
  const frame = getTrmnlFrame(size.width, size.height);
  sendJson(res, 200, {
    status: 200,
    api_key: device.apiKey,
    friendly_id: device.friendlyId,
    image_url: imageUrl(req, size, frame.contentHash),
    filename: frame.contentHash,
    message: 'Welcome to AgentDeck',
  });
}

/**
 * GET /api/display — return the next image + polling cadence.
 *
 * NOTE: we always reply with HTTP 200; the BYOS `status` field carries the real
 * signal (0 = show image, 202 = call /api/setup). Stock firmware treats a non-200
 * HTTP status as an error and goes back to sleep without rendering, so HTTP 200 is
 * required even in the "needs setup" case.
 */
export function handleTrmnlDisplay(req: IncomingMessage, res: ServerResponse): void {
  const h = parseDeviceHeaders(req);
  const mac = h.mac;
  const cfg = loadTrmnlConfig();
  const size = renderSize(h);
  if (mac) recordTelemetry(mac, h);
  let device = mac ? findDeviceByMac(mac) : undefined;

  if (!device) {
    // Real devices often carry an api_key from a prior (cloud) setup and never
    // call /api/setup again — they poll /api/display straight away. If we answer
    // "not registered" (status 202) they just sleep/retry forever and never show
    // a screen. So auto-enroll on first poll (when autoRegister is on) and serve
    // a real dashboard (status 0). Only fall back to 202 when autoRegister is off.
    if (mac && cfg.autoRegister) {
      const r = ensureDevice(mac);
      device = r.device;
      if (r.created) {
        debug(TAG, `auto-enrolled ${normalizeMac(mac)} on display poll (${size.width}x${size.height})`);
        forceRenderTrmnlFrame(size.width, size.height);
      }
    }
    if (!device) {
      // autoRegister off and unenrolled: serve a real, correctly-sized frame (the
      // idle hero / dashboard) rather than a bogus `setup.png` the image route
      // can't match. status 202 still tells the firmware "not fully set up".
      const setupFrame = getTrmnlFrame(size.width, size.height);
      debug(TAG, `display from unenrolled ${normalizeMac(mac)} (autoRegister off) — requesting setup`);
      sendJson(res, 200, {
        status: 202,
        image_url: imageUrl(req, size, setupFrame.contentHash),
        filename: setupFrame.contentHash,
        refresh_rate: cfg.refreshRate,
        image_url_timeout: cfg.imageUrlTimeout,
        special_function: 'sleep',
        reset_firmware: false,
        update_firmware: false,
        firmware_url: null,
      });
      return;
    }
  }

  // Soft auth only: the MAC (ID header) identifies the device. The api_key it
  // presents may have been issued by a previous/cloud server, so we don't
  // hard-reject on mismatch — this is same-LAN hardware.
  const frame = getTrmnlFrame(size.width, size.height);
  // Adaptive cadence: poll fast while an agent is AWAITING/WORKING, slow when idle.
  const activity = getTrmnlActivity();
  const refreshRate = effectiveRefreshRate(cfg, activity);
  debug(
    TAG,
    `display ${normalizeMac(mac)} ${size.width}x${size.height} hash=${frame.contentHash} ` +
      `refresh=${refreshRate}s awaiting=${activity.awaiting} working=${activity.working}`,
  );
  sendJson(res, 200, {
    status: 0,
    image_url: imageUrl(req, size, frame.contentHash),
    filename: frame.contentHash,
    // Number (matches the reference BYOS + firmware's uint parse), not a string.
    refresh_rate: refreshRate,
    // Generous image-download window so a flaky WiFi link doesn't trip "not responding".
    image_url_timeout: cfg.imageUrlTimeout,
    special_function: 'sleep',
    reset_firmware: false,
    update_firmware: false,
    firmware_url: null,
  });
}

/** GET /trmnl/image/<W>x<H>-<hash>.png — serve the 1-bit PNG for that resolution. */
export function handleTrmnlImage(req: IncomingMessage, res: ServerResponse): void {
  // The URL carries the resolution (and a cache-busting hash) so we serve the
  // right-sized frame. We ignore the hash itself — the device always wants the
  // freshest screen for its resolution. Unknown/legacy URLs fall back to the
  // default-size frame.
  const pathname = (req.url || '').split('?')[0];
  const m = /\/trmnl\/image\/(\d+)x(\d+)-[0-9a-f]+\.png$/.exec(pathname);
  let frame: TrmnlFrame | undefined;
  if (m) {
    const key = `${m[1]}x${m[2]}`;
    frame = getTrmnlFrameByKey(key) ?? getTrmnlFrame(Number(m[1]), Number(m[2]));
  }
  if (!frame) frame = getTrmnlFrame();
  res.writeHead(200, {
    'Content-Type': frame.contentType,
    'Content-Length': frame.buffer.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(frame.buffer);
}

/** POST /api/log — accept device logs (debug only). */
export function handleTrmnlLog(req: IncomingMessage, res: ServerResponse): void {
  let body = '';
  req.on('data', (c: Buffer) => {
    body += c;
    if (body.length > 64_000) req.destroy();
  });
  req.on('end', () => {
    const mac = normalizeMac(header(req, 'ID'));
    debug(TAG, `log from ${mac}: ${body.slice(0, 500)}`);
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
  });
  req.on('error', () => {
    try {
      res.writeHead(204);
      res.end();
    } catch {
      /* ignore */
    }
  });
}

/** True for any path this module owns, so the daemon router can delegate. */
export function isTrmnlImagePath(pathname: string): boolean {
  return pathname.startsWith('/trmnl/image/');
}
