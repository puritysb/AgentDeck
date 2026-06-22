import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  handleTrmnlSetup,
  handleTrmnlDisplay,
  handleTrmnlImage,
} from '../trmnl/byos-server.js';
import {
  findDeviceByMac,
  loadTrmnlConfig,
  normalizeMac,
  TRMNL_DEFAULT_REFRESH,
  TRMNL_DEFAULT_REFRESH_ACTIVE,
} from '../trmnl/trmnl-settings.js';
import { getTrmnlFrameKeys, refreshTrmnlFrame } from '../trmnl/frame-cache.js';
import { getTelemetry, getTelemetryHealth, _resetTelemetry } from '../trmnl/trmnl-telemetry.js';

const ORIGINAL_DATA_DIR = process.env.AGENTDECK_DATA_DIR;

function fakeReq(headers: Record<string, string>, url?: string) {
  // Node lowercases header names; mirror that.
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  if (!lower.host) lower.host = '192.168.1.50:9120';
  const req: any = { headers: lower };
  if (url) req.url = url;
  return req;
}

/** IHDR width/height of a PNG buffer (8-byte sig, then IHDR data at offset 16/20). */
function ihdrDims(buf: Buffer) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

interface Captured {
  status: number;
  headers: Record<string, any>;
  body: any; // parsed JSON for json responses, raw Buffer otherwise
  raw: any;
}

function fakeRes(): { res: any; captured: Captured } {
  const captured: Captured = { status: 0, headers: {}, body: undefined, raw: undefined };
  const res = {
    writeHead(status: number, headers: Record<string, any>) {
      captured.status = status;
      captured.headers = headers ?? {};
    },
    end(payload?: any) {
      captured.raw = payload;
      if (Buffer.isBuffer(payload)) captured.body = payload;
      else {
        try {
          captured.body = JSON.parse(payload);
        } catch {
          captured.body = payload;
        }
      }
    },
  };
  return { res, captured };
}

const MAC = 'AA:BB:CC:DD:EE:01';

describe('TRMNL BYOS handlers', () => {
  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), 'trmnl-byos-'));
    process.env.AGENTDECK_DATA_DIR = dir;
  });

  afterAll(() => {
    if (ORIGINAL_DATA_DIR === undefined) delete process.env.AGENTDECK_DATA_DIR;
    else process.env.AGENTDECK_DATA_DIR = ORIGINAL_DATA_DIR;
  });

  it('/api/setup enrolls a new device and issues an api_key', () => {
    const { res, captured } = fakeRes();
    handleTrmnlSetup(fakeReq({ ID: MAC }), res);

    expect(captured.status).toBe(200);
    expect(captured.body.status).toBe(200);
    expect(captured.body.api_key).toMatch(/^[0-9a-f]{32}$/);
    expect(captured.body.friendly_id).toMatch(/^[A-Z2-9]{6}$/);
    expect(captured.body.image_url).toMatch(
      /^http:\/\/192\.168\.1\.50:9120\/trmnl\/image\/800x480-[0-9a-f]{16}\.png$/,
    );

    // Persisted to settings.
    const dev = findDeviceByMac(MAC);
    expect(dev?.apiKey).toBe(captured.body.api_key);
  });

  it('/api/setup without an ID header is a 400', () => {
    const { res, captured } = fakeRes();
    handleTrmnlSetup(fakeReq({}), res);
    expect(captured.status).toBe(400);
  });

  it('/api/setup rejects an unknown MAC when autoRegister is off', () => {
    writeFileSync(
      join(process.env.AGENTDECK_DATA_DIR!, 'settings.json'),
      JSON.stringify({ trmnl: { autoRegister: false, devices: [] } }),
    );
    const { res, captured } = fakeRes();
    handleTrmnlSetup(fakeReq({ ID: MAC }), res);
    expect(captured.status).toBe(404);
  });

  it('/api/display returns image + cadence for an enrolled device', () => {
    const setup = fakeRes();
    handleTrmnlSetup(fakeReq({ ID: MAC }), setup.res);
    const apiKey = setup.captured.body.api_key as string;

    const { res, captured } = fakeRes();
    handleTrmnlDisplay(fakeReq({ ID: MAC, 'Access-Token': apiKey }), res);

    expect(captured.status).toBe(200);
    expect(captured.body.status).toBe(0);
    // refresh_rate is a number (matches the reference BYOS + firmware uint parse).
    expect(captured.body.refresh_rate).toBe(180);
    expect(captured.body.reset_firmware).toBe(false);
    expect(captured.body.update_firmware).toBe(false);
    expect(captured.body.image_url).toContain(`-${captured.body.filename}.png`);
  });

  it('/api/display still serves a screen with a mismatched Access-Token (soft auth)', () => {
    // Real devices carry an api_key issued by a previous/cloud server; we must
    // not hard-reject on token mismatch (it would brick same-LAN hardware).
    handleTrmnlSetup(fakeReq({ ID: MAC }), fakeRes().res);
    const { res, captured } = fakeRes();
    handleTrmnlDisplay(fakeReq({ ID: MAC, 'Access-Token': 'deadbeef' }), res);
    expect(captured.status).toBe(200);
    expect(captured.body.status).toBe(0);
  });

  it('/api/display auto-enrolls an unknown device and serves a real screen (autoRegister on)', () => {
    // Devices that skip /api/setup (kept a prior api_key) poll display directly —
    // they must get status 0, not be stuck on "not registered".
    const { res, captured } = fakeRes();
    handleTrmnlDisplay(fakeReq({ ID: 'FF:FF:FF:FF:FF:FF' }), res);
    expect(captured.status).toBe(200);
    expect(captured.body.status).toBe(0);
    expect(captured.body.image_url).toContain(`-${captured.body.filename}.png`);
    expect(findDeviceByMac('FF:FF:FF:FF:FF:FF')).toBeTruthy();
  });

  it('/api/display returns 202 for an unknown device when autoRegister is off', () => {
    writeFileSync(
      join(process.env.AGENTDECK_DATA_DIR!, 'settings.json'),
      JSON.stringify({ trmnl: { autoRegister: false, devices: [] } }),
    );
    const { res, captured } = fakeRes();
    handleTrmnlDisplay(fakeReq({ ID: 'AB:CD:EF:00:11:22' }), res);
    expect(captured.status).toBe(200);
    expect(captured.body.status).toBe(202);
    // Unenrolled devices still get a real, resolution-keyed frame (not a bogus
    // `setup.png` the image route can't serve), so the panel shows something
    // instead of the firmware's "not responding" error.
    expect(captured.body.filename).toMatch(/^[0-9a-f]{16}$/);
    expect(captured.body.image_url).toMatch(/\/trmnl\/image\/\d+x\d+-[0-9a-f]+\.png$/);
  });

  it('keeps the same filename across polls when the state is unchanged', () => {
    handleTrmnlSetup(fakeReq({ ID: MAC }), fakeRes().res);
    const a = fakeRes();
    const b = fakeRes();
    handleTrmnlDisplay(fakeReq({ ID: MAC }), a.res);
    handleTrmnlDisplay(fakeReq({ ID: MAC }), b.res);
    expect(a.captured.body.filename).toBe(b.captured.body.filename);
  });

  it('/trmnl/image serves a PNG body', () => {
    handleTrmnlSetup(fakeReq({ ID: MAC }), fakeRes().res);
    const { res, captured } = fakeRes();
    handleTrmnlImage(fakeReq({ ID: MAC }), res);
    expect(captured.headers['Content-Type']).toBe('image/png');
    expect(Buffer.isBuffer(captured.body)).toBe(true);
    expect(captured.body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
  });

  it('captures device telemetry headers', () => {
    _resetTelemetry();
    handleTrmnlDisplay(
      fakeReq({
        ID: MAC,
        'FW-Version': '1.5.12',
        RSSI: '-55',
        'Battery-Voltage': '4.1',
        Width: '800',
        Height: '480',
        'User-Agent': 'TRMNL/1.5.12',
      }),
      fakeRes().res,
    );
    const dev = getTelemetry().find((t) => t.mac === MAC);
    expect(dev?.fwVersion).toBe('1.5.12');
    expect(dev?.rssi).toBe(-55);
    expect(dev?.batteryVoltage).toBe(4.1);
    expect(dev?.width).toBe(800);
    expect(dev?.height).toBe(480);
    expect(dev?.userAgent).toBe('TRMNL/1.5.12');
  });

  it('honors the device-reported resolution in the image_url + served PNG', () => {
    const { res, captured } = fakeRes();
    handleTrmnlDisplay(fakeReq({ ID: MAC, Width: '480', Height: '800' }), res);
    expect(captured.body.status).toBe(0);
    expect(captured.body.image_url).toMatch(/\/trmnl\/image\/480x800-[0-9a-f]{16}\.png$/);

    // The image route for that URL returns a 480×800 PNG.
    const path = new URL(captured.body.image_url).pathname;
    const img = fakeRes();
    handleTrmnlImage(fakeReq({ ID: MAC }, path), img.res);
    expect(Buffer.isBuffer(img.captured.body)).toBe(true);
    const dims = ihdrDims(img.captured.body);
    expect(dims.width).toBe(480);
    expect(dims.height).toBe(800);
  });

  it('defaults to 800×480 when no size headers are sent', () => {
    const { res, captured } = fakeRes();
    handleTrmnlDisplay(fakeReq({ ID: MAC }), res);
    expect(captured.body.image_url).toMatch(/\/trmnl\/image\/800x480-[0-9a-f]{16}\.png$/);
  });

  it('includes special_function in both display branches', () => {
    handleTrmnlSetup(fakeReq({ ID: MAC }), fakeRes().res);
    const enrolled = fakeRes();
    handleTrmnlDisplay(fakeReq({ ID: MAC }), enrolled.res);
    expect(enrolled.captured.body.special_function).toBe('sleep');

    writeFileSync(
      join(process.env.AGENTDECK_DATA_DIR!, 'settings.json'),
      JSON.stringify({ trmnl: { autoRegister: false, devices: [] } }),
    );
    const needsSetup = fakeRes();
    handleTrmnlDisplay(fakeReq({ ID: 'AB:CD:EF:00:11:22' }), needsSetup.res);
    expect(needsSetup.captured.body.status).toBe(202);
    expect(needsSetup.captured.body.special_function).toBe('sleep');
  });

  it('treats varied MAC spellings as a single device (no duplicates)', () => {
    handleTrmnlSetup(fakeReq({ ID: 'aabbccddee01' }), fakeRes().res);
    handleTrmnlDisplay(fakeReq({ ID: 'AA:BB:CC:DD:EE:01' }), fakeRes().res);
    handleTrmnlDisplay(fakeReq({ ID: 'aa-bb-cc-dd-ee-01' }), fakeRes().res);
    const cfg = loadTrmnlConfig();
    expect(cfg.devices.length).toBe(1);
    expect(cfg.devices.filter((d) => normalizeMac(d.mac) === 'AA:BB:CC:DD:EE:01').length).toBe(1);
  });

  it('caches a separate frame per resolution for two devices', () => {
    const a = fakeRes();
    handleTrmnlDisplay(fakeReq({ ID: 'AA:AA:AA:AA:AA:01', Width: '800', Height: '480' }), a.res);
    const b = fakeRes();
    handleTrmnlDisplay(fakeReq({ ID: 'BB:BB:BB:BB:BB:02', Width: '480', Height: '800' }), b.res);
    expect(a.captured.body.image_url).toContain('800x480-');
    expect(b.captured.body.image_url).toContain('480x800-');
    const keys = getTrmnlFrameKeys();
    expect(keys).toContain('800x480');
    expect(keys).toContain('480x800');
  });

  it('serves the slow cadence when idle (refresh_rate is a number + image timeout set)', () => {
    refreshTrmnlFrame({ allSessions: [{ id: 's1', state: 'idle' }] });
    const { res, captured } = fakeRes();
    handleTrmnlDisplay(fakeReq({ ID: MAC }), res);
    expect(captured.body.refresh_rate).toBe(TRMNL_DEFAULT_REFRESH);
    expect(typeof captured.body.refresh_rate).toBe('number');
    expect(captured.body.image_url_timeout).toBeGreaterThan(0);
  });

  it('keeps the slow cadence while WORKING (only AWAITING speeds it up)', () => {
    refreshTrmnlFrame({ allSessions: [{ id: 's1', state: 'processing' }] });
    const { res, captured } = fakeRes();
    handleTrmnlDisplay(fakeReq({ ID: MAC }), res);
    expect(captured.body.refresh_rate).toBe(TRMNL_DEFAULT_REFRESH);
  });

  it('serves the fast active cadence when a session is AWAITING', () => {
    refreshTrmnlFrame({ allSessions: [{ id: 's1', state: 'awaiting_permission' }] });
    const { res, captured } = fakeRes();
    handleTrmnlDisplay(fakeReq({ ID: MAC }), res);
    expect(captured.body.refresh_rate).toBe(TRMNL_DEFAULT_REFRESH_ACTIVE);
  });

  it('flags a panel as stale once it stops polling past 2x its cadence', () => {
    _resetTelemetry();
    handleTrmnlDisplay(fakeReq({ ID: MAC, Width: '800', Height: '480' }), fakeRes().res);
    const now = Date.now();
    // Fresh right after a poll.
    expect(getTelemetryHealth(TRMNL_DEFAULT_REFRESH, now).find((t) => t.mac === MAC)?.stale).toBe(false);
    // Stale well past 2× the cadence.
    const later = now + (TRMNL_DEFAULT_REFRESH * 2 + 10) * 1000;
    expect(getTelemetryHealth(TRMNL_DEFAULT_REFRESH, later).find((t) => t.mac === MAC)?.stale).toBe(true);
  });
});
