/**
 * GET/POST /esp32/wifi (bridge/src/esp32-wifi-setup.ts) and the serial-layer
 * pieces they drive: the operator-request fan-out, the per-board rows and the
 * recorded `wifi_provision_ack`. The Swift daemon answers in the same shape
 * (ESP32WifiSetup.swift), field for field: both suites replay
 * shared/esp32-wifi-setup-vectors.json. The decision and the credential check
 * are the shared rule, pinned by shared/esp32-wifi-provision-vectors.json.
 */
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WIFI_PROVISION_ACK_TIMEOUT_MS } from '@agentdeck/shared';
import type { WifiProvisionMessage } from '@agentdeck/shared/protocol';
import {
  __setConnectionsForTest,
  describeWifiProvisionAck,
  handleSerialLine,
  parseWifiProvisionAck,
  provisionSerialBoards,
  recordWifiProvisionAck,
  wifiSetupBoardRow,
  wifiSetupBoards,
  writeWifiProvision,
  type SerialConnection,
  type WifiProvisionOutcome,
  type WifiSetupBoardRow,
} from '../esp32-serial.js';
import { wifiCredId } from '../esp32-wifi-cred.js';
import {
  applyWifiSetup,
  parseWifiSetupBody,
  readWifiSetupBody,
  WIFI_SETUP_MAX_BODY_BYTES,
  WIFI_SETUP_MAX_DRAIN_BYTES,
  wifiSetupAuthorized,
  wifiSetupRefusal,
  wifiSetupStatus,
  type WifiSetupDeps,
} from '../esp32-wifi-setup.js';
import type { WifiConfig } from '../wifi-config.js';

const TOKEN = 'setup-token-0123456789abcdef';
const SSID = 'DeskNet';
const PASSWORD = 'correct horse battery staple';

function fakeDeps(initial: WifiConfig | null = null, serial = true) {
  const calls = {
    saved: [] as WifiConfig[],
    provisioned: [] as Array<{ msg: WifiProvisionMessage; manual: boolean }>,
    boardsAskedWith: [] as Array<string | null>,
  };
  let config = initial;
  const deps: WifiSetupDeps = {
    loadConfig: () => config,
    saveConfig: (next) => { calls.saved.push(next); config = next; },
    serialRunning: () => serial,
    boards: (expected) => {
      calls.boardsAskedWith.push(expected);
      return [] as WifiSetupBoardRow[];
    },
    provision: (msg, opts) => {
      calls.provisioned.push({ msg, manual: opts.manual });
      return [{ port: '/dev/cu.usbmodem1101', board: 't_embed', sent: true, reason: 'credentials-differ' }] as WifiProvisionOutcome[];
    },
    authToken: () => TOKEN,
    bridgeIp: () => '192.168.1.50',
    bridgePort: 9120,
  };
  return { deps, calls };
}

describe('who may read or change the WiFi credentials', () => {
  const valid = (token: string) => token === TOKEN;

  it('a loopback caller with the token as a bearer', () => {
    for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(wifiSetupAuthorized(address, `Bearer ${TOKEN}`, valid), address).toBe(true);
    }
  });

  it('never a LAN address, even one holding the token', () => {
    expect(wifiSetupAuthorized('192.168.1.23', `Bearer ${TOKEN}`, valid)).toBe(false);
    expect(wifiSetupAuthorized('::ffff:192.168.1.23', `Bearer ${TOKEN}`, valid)).toBe(false);
    expect(wifiSetupAuthorized(undefined, `Bearer ${TOKEN}`, valid)).toBe(false);
  });

  it('never this machine without the token', () => {
    expect(wifiSetupAuthorized('127.0.0.1', undefined, valid)).toBe(false);
    expect(wifiSetupAuthorized('127.0.0.1', 'Bearer ', valid)).toBe(false);
    expect(wifiSetupAuthorized('127.0.0.1', 'Bearer wrong', valid)).toBe(false);
    expect(wifiSetupAuthorized('127.0.0.1', TOKEN, valid)).toBe(false);
    expect(wifiSetupAuthorized('127.0.0.1', [`Bearer ${TOKEN}`], valid)).toBe(false);
  });

  it('is refused in the routes\' own shape', () => {
    expect(wifiSetupRefusal()).toEqual({ status: 403, body: { ok: false, error: 'local-token-required' } });
  });
});

describe('GET /esp32/wifi', () => {
  it('reports nothing configured as such', () => {
    const { deps } = fakeDeps(null);
    expect(wifiSetupStatus(deps)).toEqual({
      status: 200,
      body: { ok: true, configured: false, ssid: '', autoProvision: false, serial: true, boards: [] },
    });
  });

  it('serves the SSID and never the password', () => {
    const { deps, calls } = fakeDeps({ ssid: SSID, password: PASSWORD, autoProvision: true });
    const result = wifiSetupStatus(deps);
    expect(result.body).toMatchObject({ ok: true, configured: true, ssid: SSID, autoProvision: true, serial: true });
    expect(JSON.stringify(result.body)).not.toContain(PASSWORD);
    // Boards are judged against the id of the configured credentials.
    expect(calls.boardsAskedWith).toEqual([wifiCredId(TOKEN, SSID, PASSWORD)]);
  });

  it('a daemon without the serial channel lists no boards', () => {
    const { deps, calls } = fakeDeps({ ssid: SSID, password: PASSWORD, autoProvision: false }, false);
    expect(wifiSetupStatus(deps).body).toMatchObject({ serial: false, boards: [], autoProvision: false });
    expect(calls.boardsAskedWith).toEqual([]);
  });
});

describe('POST /esp32/wifi', () => {
  it('saves, then sends to the serial boards as an operator request', () => {
    const { deps, calls } = fakeDeps();
    const result = applyWifiSetup({ ssid: SSID, password: PASSWORD }, deps);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      ok: true, saved: true, autoProvision: true,
      boards: [{ port: '/dev/cu.usbmodem1101', board: 't_embed', sent: true, reason: 'credentials-differ' }],
    });
    expect(calls.saved).toEqual([{ ssid: SSID, password: PASSWORD, autoProvision: true }]);
    expect(calls.provisioned).toHaveLength(1);
    const { msg, manual } = calls.provisioned[0];
    expect(manual).toBe(true);
    expect(msg).toMatchObject({
      type: 'wifi_provision', ssid: SSID, password: PASSWORD,
      bridgeIp: '192.168.1.50', bridgePort: 9120, authToken: TOKEN,
      credId: wifiCredId(TOKEN, SSID, PASSWORD),
    });
    expect(JSON.stringify(result.body)).not.toContain(PASSWORD);
  });

  it('keeps autoProvision false when asked, and still sends this once', () => {
    const { deps, calls } = fakeDeps();
    const result = applyWifiSetup({ ssid: SSID, password: PASSWORD, autoProvision: false }, deps);
    expect(result.body).toMatchObject({ ok: true, autoProvision: false });
    expect(calls.saved[0].autoProvision).toBe(false);
    expect(calls.provisioned).toHaveLength(1);
  });

  it('a daemon without the serial channel saves and sends nothing', () => {
    const { deps, calls } = fakeDeps(null, false);
    expect(applyWifiSetup({ ssid: SSID, password: PASSWORD }, deps).body)
      .toEqual({ ok: true, saved: true, autoProvision: true, boards: [] });
    expect(calls.saved).toHaveLength(1);
    expect(calls.provisioned).toEqual([]);
  });

  it.each([
    [{ ssid: '', password: PASSWORD }, 'ssid-missing'],
    [{ password: PASSWORD }, 'ssid-missing'],
    [{ ssid: 'abcdefghijklmnopqrstuvwxyz0123456', password: PASSWORD }, 'ssid-too-long'],
    [{ ssid: SSID, password: 'seven77' }, 'password-too-short'],
    [{ ssid: SSID }, 'password-too-short'],
    [{ ssid: SSID, password: 'g'.repeat(64) }, 'password-too-long'],
    [{ ssid: SSID, password: 'pass\nword1' }, 'control-character'],
    [{ ssid: SSID, password: PASSWORD, autoProvision: 'yes' }, 'invalid-body'],
    [[SSID, PASSWORD], 'invalid-body'],
    ['ssid', 'invalid-body'],
    [null, 'invalid-body'],
  ])('refuses %j with 400 %s and saves nothing', (body, error) => {
    const { deps, calls } = fakeDeps();
    expect(applyWifiSetup(body, deps)).toEqual({ status: 400, body: { ok: false, error } });
    expect(calls.saved).toEqual([]);
    expect(calls.provisioned).toEqual([]);
  });

  it('a failed save sends nothing', () => {
    const { deps, calls } = fakeDeps();
    deps.saveConfig = () => { throw new Error('EACCES'); };
    expect(applyWifiSetup({ ssid: SSID, password: PASSWORD }, deps))
      .toEqual({ status: 500, body: { ok: false, error: 'save-failed' } });
    expect(calls.provisioned).toEqual([]);
  });
});

describe('serial layer behind the routes', () => {
  const msg: WifiProvisionMessage = {
    type: 'wifi_provision', ssid: SSID, password: PASSWORD, bridgeIp: '192.168.1.50', bridgePort: 9120,
    authToken: TOKEN, credId: wifiCredId(TOKEN, SSID, PASSWORD) ?? undefined,
  };
  let restore: (() => void) | null = null;
  let live: SerialConnection[] = [];

  function conn(port: string, deviceInfo: Record<string, unknown> | null, extra: Partial<SerialConnection> = {}): SerialConnection {
    return {
      port,
      fd: null,
      stream: { destroyed: false, writable: true, write: () => true } as any,
      reader: null,
      readBuf: '',
      connected: true,
      deviceInfo: deviceInfo as SerialConnection['deviceInfo'],
      deviceInfoFresh: deviceInfo !== null,
      provisionSent: false,
      connectedAt: Date.now(),
      lastReadAt: Date.now(),
      lastWriteAt: Date.now(),
      lastDeviceInfoRequestAt: 0,
      deviceInfoRequestsSent: 0,
      writeQueue: [],
      writeTimer: null,
      ...extra,
    };
  }

  function use(conns: SerialConnection[]): void {
    live = conns;
    restore = __setConnectionsForTest(conns);
  }

  afterEach(() => {
    restore?.();
    restore = null;
    for (const c of live) {
      c.connected = false;
      if (c.writeTimer) clearTimeout(c.writeTimer);
    }
    live = [];
  });

  const parked = { board: 't_embed', wifiConfigured: true, wifiConnected: false, wifiRadioParked: true };
  const sentTypes = (c: SerialConnection) => c.writeQueue.map((json) => JSON.parse(json).type);

  it('an operator request reaches a connection that already had a provision and old firmware', () => {
    const resent = conn('/dev/cu.resent', { ...parked, wifiCredId: '0000000000000000' }, { provisionSent: true });
    const old = conn('/dev/cu.old', { ...parked }, { provisionSent: true });
    const holds = conn('/dev/cu.holds', { ...parked, wifiCredId: msg.credId });
    const joined = conn('/dev/cu.joined', { ...parked, wifiConnected: true, wifiRadioParked: false, wifiCredId: '' });
    const unidentified = conn('/dev/cu.unidentified', null);
    use([resent, old, holds, joined, unidentified]);

    // The automatic path sends none of them.
    expect(provisionSerialBoards(msg).filter((o) => o.sent)).toEqual([]);

    expect(provisionSerialBoards(msg, { manual: true })).toEqual([
      { port: '/dev/cu.resent', board: 't_embed', sent: true, reason: 'credentials-differ' },
      { port: '/dev/cu.old', board: 't_embed', sent: true, reason: 'operator-request' },
      { port: '/dev/cu.holds', board: 't_embed', sent: false, reason: 'credentials-match' },
      { port: '/dev/cu.joined', board: 't_embed', sent: false, reason: 'wifi-connected' },
      { port: '/dev/cu.unidentified', board: '', sent: false, reason: 'unidentified' },
    ]);
    expect(sentTypes(resent)).toEqual(['wifi_provision']);
    expect(sentTypes(old)).toEqual(['wifi_provision']);
    expect(sentTypes(holds)).toEqual([]);
    expect(sentTypes(joined)).toEqual([]);
    expect(sentTypes(unidentified)).toEqual([]);
  });

  it('a send stamps the connection and forgets the answer to the previous one', () => {
    const board = conn('/dev/cu.stamp', { ...parked, wifiCredId: '' }, {
      wifiProvisionAck: { success: false, joined: null, ip: '', error: 'connection failed', at: 1 },
    });
    use([board]);
    const before = Date.now();
    provisionSerialBoards(msg, { manual: true });
    expect(board.wifiProvisionSentAt).toBeGreaterThanOrEqual(before);
    expect(board.wifiProvisionAck).toBeUndefined();
  });

  it('records the board\'s ack as it said it, cleaned', () => {
    const board = conn('/dev/cu.ack', { ...parked });
    handleSerialLine(board, '{"type":"wifi_provision_ack","success":true,"joined":true,"ip":"192.168.1.23"}');
    expect(board.wifiProvisionAck).toMatchObject({ success: true, joined: true, ip: '192.168.1.23', error: '' });
    handleSerialLine(board, '{"type":"wifi_provision_ack","success":false,"error":"connection\\u0007 failed"}');
    expect(board.wifiProvisionAck).toMatchObject({ success: false, joined: null, ip: '', error: 'connection failed' });
    // Anything but a literal true is a failure.
    handleSerialLine(board, '{"type":"wifi_provision_ack","success":"true"}');
    expect(board.wifiProvisionAck?.success).toBe(false);
  });

  it('an ack that arrives while a later provision is owed one answers the earlier provision', () => {
    const board = conn('/dev/cu.ledger', { ...parked, wifiCredId: '' });
    use([board]);
    writeWifiProvision(board, msg, 1_000);
    writeWifiProvision(board, msg, 2_000);
    // The board answers in order: this is the first provision's answer.
    recordWifiProvisionAck(board, { success: false, error: 'connection failed' }, 3_000);
    expect(board.wifiProvisionAck).toBeUndefined();
    recordWifiProvisionAck(board, { success: true, joined: false }, 4_000);
    expect(board.wifiProvisionAck).toEqual({ success: true, joined: false, ip: '', error: '', at: 4_000 });
    expect(board.wifiProvisionAckLedger).toEqual({ owed: 0, lastWriteAt: 2_000, latestCredId: msg.credId });
  });

  it('an ack naming an earlier provision is not shown as the latest one\'s result', () => {
    const board = conn('/dev/cu.named', { ...parked, wifiCredId: '' });
    use([board]);
    const earlier = { ...msg, credId: '0123456789abcdef' };
    writeWifiProvision(board, earlier, 1_000);
    writeWifiProvision(board, msg, 2_000);
    // The board names the provision it answers.
    recordWifiProvisionAck(board, { success: true, joined: false, credId: earlier.credId }, 3_000);
    expect(board.wifiProvisionAck).toBeUndefined();
    recordWifiProvisionAck(board, { success: true, joined: true, ip: '192.168.1.23', credId: msg.credId }, 4_000);
    expect(board.wifiProvisionAck).toMatchObject({ success: true, joined: true, ip: '192.168.1.23' });
    expect(board.wifiProvisionAckLedger?.owed).toBe(0);
  });

  it('logs connected only for a board that says it joined (ESP32WifiSetupTests: the same lines)', () => {
    const line = (msg: Record<string, unknown>) => describeWifiProvisionAck(parseWifiProvisionAck(msg, 0));
    expect(line({ success: true, joined: true, ip: '192.168.1.23' })).toBe('WiFi connected: 192.168.1.23 \u2713');
    expect(line({ success: true, joined: false, ip: '192.168.1.23' }))
      .toBe('WiFi credentials saved; the board joins when it leaves USB');
    expect(line({ success: true, ip: '192.168.1.23' })).toBe('WiFi credentials accepted');
    expect(line({ success: false, error: 'connection failed' })).toBe('WiFi failed: connection failed');
  });

  it('an ack owed past the shared timeout is presumed lost when the next provision is written', () => {
    const board = conn('/dev/cu.lost', { ...parked, wifiCredId: '' });
    use([board]);
    writeWifiProvision(board, msg, 1_000);
    writeWifiProvision(board, msg, 1_000 + WIFI_PROVISION_ACK_TIMEOUT_MS + 1);
    recordWifiProvisionAck(board, { success: true, joined: true, ip: '192.168.1.23' }, 40_000);
    expect(board.wifiProvisionAck).toMatchObject({ success: true, joined: true, ip: '192.168.1.23' });
  });

  it('a row says whether the board holds the configured credentials, never the id', () => {
    const expected = msg.credId ?? null;
    const holds = wifiSetupBoardRow(conn('/dev/cu.a', { ...parked, wifiCredId: expected }), expected);
    expect(holds).toEqual({
      port: '/dev/cu.a', board: 't_embed', wifiConnected: false, wifiRadioParked: true,
      holdsCredentials: true, provisionedAt: 0, ack: null,
    });
    expect(JSON.stringify(holds)).not.toContain(String(expected));
    expect(wifiSetupBoardRow(conn('/dev/cu.b', { ...parked, wifiCredId: '' }), expected).holdsCredentials).toBe(false);
    // Old firmware, or nothing configured to compare: cannot tell.
    expect(wifiSetupBoardRow(conn('/dev/cu.c', { ...parked }), expected).holdsCredentials).toBeNull();
    expect(wifiSetupBoardRow(conn('/dev/cu.d', { ...parked, wifiCredId: expected }), null).holdsCredentials).toBeNull();
    // A record seeded from the device cache describes an earlier connection.
    const cached = wifiSetupBoardRow(conn('/dev/cu.e', { ...parked, wifiCredId: expected }, { deviceInfoFresh: false }), expected);
    expect(cached).toMatchObject({ board: '', wifiConnected: null, wifiRadioParked: null, holdsCredentials: null });
  });

  it('lists only live connections', () => {
    const gone = conn('/dev/cu.gone', { ...parked }, { connected: false });
    const here = conn('/dev/cu.here', { ...parked });
    use([gone, here]);
    expect(wifiSetupBoards(null).map((row) => row.port)).toEqual(['/dev/cu.here']);
    expect(provisionSerialBoards(msg, { manual: true }).map((o) => o.port)).toEqual(['/dev/cu.here']);
  });
});

interface RouteVectors {
  token: string;
  bridgeIp: string;
  bridgePort: number;
  credId: string;
  boardsReply: WifiSetupBoardRow[];
  provisionReply: WifiProvisionOutcome[];
  status: Array<{ name: string; config: WifiConfig | null; serial: boolean; boardsAskedWith?: string | null; response: Record<string, unknown> }>;
  apply: Array<{
    name: string; body: unknown; serial: boolean; saveFails?: boolean; status: number; response: Record<string, unknown>;
    saved: WifiConfig | null; provisioned: { credId: string; manual: boolean } | null;
  }>;
  authorized: Array<{ name: string; remoteAddress: string; authorization: string | null; authorized: boolean }>;
  refusal: { status: number; response: Record<string, unknown> };
  rows: Array<{
    name: string; deviceInfo: Record<string, unknown> | null; expectedCredId: string | null; provisionedAt: number;
    ack: { success: boolean; joined: boolean | null; ip: string; error: string; at: number } | null; row: WifiSetupBoardRow;
  }>;
  acks: Array<{
    name: string; message: Record<string, unknown>;
    recorded: { success: boolean; joined: boolean | null; ip: string; error: string };
  }>;
  bodies: Array<{ name: string; text?: string; hex?: string; padTo?: number; valid: boolean; value?: unknown }>;
}

describe('the POST body reader', () => {
  it('reads an oversized body to its end, keeping none of it, so the refusal is an answer', async () => {
    const stream = Readable.from([Buffer.alloc(WIFI_SETUP_MAX_BODY_BYTES), Buffer.alloc(1000)], { objectMode: false });
    await expect(readWifiSetupBody(stream)).resolves.toBeNull();
    // Ended, not destroyed: an HTTP request read this way keeps its connection.
    expect(stream.readableEnded).toBe(true);
  });

  it('drops a request that runs past the drain bound', async () => {
    const pieces = Array.from({ length: WIFI_SETUP_MAX_DRAIN_BYTES / 4096 + 2 }, () => Buffer.alloc(4096));
    const stream = Readable.from(pieces, { objectMode: false });
    await expect(readWifiSetupBody(stream)).rejects.toThrow();
    expect(stream.readableEnded).toBe(false);
  });
});

describe('the route contract both daemons answer (shared/esp32-wifi-setup-vectors.json)', () => {
  const vectors = JSON.parse(readFileSync(
    fileURLToPath(new URL('../../../shared/esp32-wifi-setup-vectors.json', import.meta.url)), 'utf8',
  )) as RouteVectors;

  function vectorDeps(initial: WifiConfig | null, serial: boolean, saveFails = false) {
    const calls = {
      saved: [] as WifiConfig[],
      provisioned: [] as Array<{ credId: string | undefined; manual: boolean }>,
      boardsAskedWith: [] as Array<string | null>,
    };
    const deps: WifiSetupDeps = {
      loadConfig: () => initial,
      saveConfig: (next) => {
        if (saveFails) throw new Error('read-only volume');
        calls.saved.push(next);
      },
      serialRunning: () => serial,
      boards: (expected) => { calls.boardsAskedWith.push(expected); return vectors.boardsReply; },
      provision: (msg, opts) => { calls.provisioned.push({ credId: msg.credId, manual: opts.manual }); return vectors.provisionReply; },
      authToken: () => vectors.token,
      bridgeIp: () => vectors.bridgeIp,
      bridgePort: vectors.bridgePort,
    };
    return { deps, calls };
  }

  it('names the id of its credentials under its token', () => {
    expect(wifiCredId(vectors.token, SSID, PASSWORD)).toBe(vectors.credId);
  });

  for (const c of vectors.status) {
    it(`GET: ${c.name}`, () => {
      const { deps, calls } = vectorDeps(c.config, c.serial);
      expect(wifiSetupStatus(deps)).toEqual({ status: 200, body: c.response });
      expect(calls.boardsAskedWith).toEqual('boardsAskedWith' in c ? [c.boardsAskedWith ?? null] : []);
    });
  }

  for (const c of vectors.apply) {
    it(`POST: ${c.name}`, () => {
      const { deps, calls } = vectorDeps(null, c.serial, c.saveFails === true);
      expect(applyWifiSetup(c.body, deps)).toEqual({ status: c.status, body: c.response });
      expect(calls.saved).toEqual(c.saved ? [c.saved] : []);
      expect(calls.provisioned).toEqual(c.provisioned ? [c.provisioned] : []);
    });
  }

  for (const c of vectors.authorized) {
    it(`gate: ${c.name}`, () => {
      const valid = (token: string) => token === vectors.token;
      expect(wifiSetupAuthorized(c.remoteAddress, c.authorization ?? undefined, valid)).toBe(c.authorized);
    });
  }

  it('refuses in one shape', () => {
    expect(wifiSetupRefusal()).toEqual({ status: vectors.refusal.status, body: vectors.refusal.response });
  });

  const stub = (deviceInfo: Record<string, unknown> | null, extra: Partial<SerialConnection>) => ({
    port: '/dev/cu.row',
    deviceInfo: deviceInfo as SerialConnection['deviceInfo'],
    deviceInfoFresh: deviceInfo !== null,
    ...extra,
  });

  for (const c of vectors.rows) {
    it(`row: ${c.name}`, () => {
      const connection = stub(c.deviceInfo, {
        wifiProvisionSentAt: c.provisionedAt > 0 ? c.provisionedAt : undefined,
        wifiProvisionAck: c.ack ?? undefined,
      });
      expect(wifiSetupBoardRow(connection, c.expectedCredId)).toEqual(c.row);
    });
  }

  const bodyBytes = (c: RouteVectors['bodies'][number]): Buffer => {
    const raw = c.hex !== undefined ? Buffer.from(c.hex, 'hex') : Buffer.from(c.text ?? '', 'utf8');
    return c.padTo === undefined ? raw : Buffer.concat([raw, Buffer.alloc(c.padTo - raw.length, 0x20)]);
  };
  const inChunks = (bytes: Buffer, size: number) =>
    Readable.from(Array.from({ length: Math.ceil(bytes.length / size) }, (_, i) => bytes.subarray(i * size, (i + 1) * size)),
      { objectMode: false });

  for (const c of vectors.bodies) {
    it(`body: ${c.name}`, async () => {
      const expected = c.valid ? { ok: true, value: c.value } : { ok: false };
      expect(parseWifiSetupBody(bodyBytes(c))).toEqual(expected);
      // As the route reads it: in pieces that split multibyte sequences.
      expect(parseWifiSetupBody(await readWifiSetupBody(inChunks(bodyBytes(c), 5)))).toEqual(expected);
    });
  }

  for (const c of vectors.acks) {
    it(`ack: ${c.name}`, () => {
      expect(parseWifiProvisionAck(c.message, 7)).toEqual({ ...c.recorded, at: 7 });
      // The line the board writes takes the same path.
      const board = { port: '/dev/cu.ack', connected: true } as SerialConnection;
      handleSerialLine(board, JSON.stringify(c.message));
      expect(board.wifiProvisionAck).toMatchObject(c.recorded);
    });
  }
});
