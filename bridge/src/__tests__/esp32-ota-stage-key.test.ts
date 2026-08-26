import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebSocket } from 'ws';
import { __resetWifiEsp32OtaState, __wifiOtaTestApi } from '../daemon-server.js';

// ─── Pull-OTA staging: the key, and the promise ──────────────────────────────
// `--stage` reported success twice for a stage that could never install, and
// the board sat a whole release behind while its OTA read as handled.
//
// Two independent failures, both measured on t_display_pro 192.168.68.74 on
// 2026-08-19, and each of them alone is enough to make the stage inert:
//
//   1. The map was keyed on the RAW target. Naming a unit by IP is the
//      documented way to disambiguate two units sharing a `board` string, so
//      the key became `192.168.68.74` while the advert is looked up by
//      `device_info.board` — a pair that can never meet.
//   2. Nothing in this repo's esp32/ tree pulls the feed at all (`grep -rl
//      "/feed" esp32/src` is empty; those boards hold a live WS). Only the
//      external pull-sync fork does, so a stage aimed at a WS board is a
//      reservation no one collects.
//
// These pin the POLARITY, not today's fleet: a stage resolves to a board, and
// a stage the daemon has no evidence anyone will collect says so.

const fakeWs = (): WebSocket => ({ readyState: 1 } as unknown as WebSocket);

function register(board: string, ip: string): void {
  __wifiOtaTestApi.registerWifiEsp32(
    { board, ip, version: '1.0.5', otaSupported: true, otaSlotSize: 6291456 },
    fakeWs(),
  );
}

describe('pull-OTA staging', () => {
  let dir: string;
  let firmware: string;
  let realHome: string | undefined;

  beforeEach(() => {
    __resetWifiEsp32OtaState();
    __wifiOtaTestApi.clearStagedFwForTest();
    dir = mkdtempSync(join(tmpdir(), 'stage-fw-'));
    firmware = join(dir, 'firmware.bin');
    writeFileSync(firmware, Buffer.alloc(2048, 0x5a));
    // stageEsp32Fw persists to ~/.agentdeck/staged-fw.json; keep the real one
    // out of reach. os.homedir() reads $HOME per call on POSIX.
    realHome = process.env.HOME;
    process.env.HOME = dir;
    mkdirSync(join(dir, '.agentdeck'), { recursive: true });
  });

  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    __wifiOtaTestApi.clearStagedFwForTest();
    rmSync(dir, { recursive: true, force: true });
  });

  it('resolves an IP target to the board the advert is keyed on', () => {
    register('t_display_pro', '192.168.68.74');
    expect(__wifiOtaTestApi.resolveStagedFwBoard('192.168.68.74')).toBe('t_display_pro');
  });

  it('keeps an unknown target verbatim rather than inventing a board', () => {
    // Staging for a board this daemon has not met is legitimate — an empty
    // registry must not silently retarget the stage at something else.
    expect(__wifiOtaTestApi.resolveStagedFwBoard('xteink_x4')).toBe('xteink_x4');
  });

  it('adverts an IP-targeted stage to the board that pulls the feed', () => {
    register('t_display_pro', '192.168.68.74');
    const staged = __wifiOtaTestApi.stageEsp32Fw('192.168.68.74', firmware);

    expect(staged.board).toBe('t_display_pro');
    // The regression: the advert is looked up by device_info.board, so a stage
    // stored under the IP answers `undefined` here and installs nowhere.
    expect(__wifiOtaTestApi.stagedFwAdvert('t_display_pro')).toEqual({
      size: 2048,
      md5: staged.md5,
    });
    expect(__wifiOtaTestApi.stagedFwAdvert('192.168.68.74')).toBeUndefined();
  });

  it('reports pullSeen=false when no feed pull has ever been observed', () => {
    register('t_display_pro', '192.168.68.74');
    expect(__wifiOtaTestApi.stageEsp32Fw('192.168.68.74', firmware).pullSeen).toBe(false);
  });

  it('reports pullSeen=true once that board has actually pulled the feed', () => {
    __wifiOtaTestApi.feedPulls.noteBoard('192.168.68.90', 'xteink_x4');
    __wifiOtaTestApi.feedPulls.record('192.168.68.90', { cards: 3, nextPullSec: 900 });

    expect(__wifiOtaTestApi.stageEsp32Fw('xteink_x4', firmware).pullSeen).toBe(true);
  });

  it('resolves a target through the feed tracker when the board has slept out of the WS roster', () => {
    // A wake-sync-sleep client is absent from the WiFi registry between wakes —
    // which is exactly the board staging exists for, so the roster cannot be
    // the only place a target is resolved.
    __wifiOtaTestApi.feedPulls.noteBoard('192.168.68.91', 'xteink_x3');
    __wifiOtaTestApi.feedPulls.record('192.168.68.91', { cards: 2, nextPullSec: 1800 });

    expect(__wifiOtaTestApi.resolveStagedFwBoard('192.168.68.91')).toBe('xteink_x3');
  });

  it('isolates X3 and X4 stages by the complete product tuple', () => {
    const x3 = { productId: 'io.pocketdaily.reader', board: 'xteink_x3', updateChannel: 'stable' };
    const x4 = { productId: 'io.pocketdaily.reader', board: 'xteink_x4', updateChannel: 'stable' };
    __wifiOtaTestApi.stageEsp32Fw('xteink_x3', firmware, x3);

    expect(__wifiOtaTestApi.stagedFwAdvert('xteink_x3', x3)).toMatchObject({ ...x3, size: 2048 });
    expect(__wifiOtaTestApi.stagedFwAdvert('xteink_x4', x4)).toBeUndefined();
    expect(__wifiOtaTestApi.stagedFwAdvert('xteink_x3')).toBeUndefined();
  });

  it('acknowledges an SD-installed staged image by its embedded client version', () => {
    const version = '1.4.1-dev-pocket-w12345678';
    const image = Buffer.concat([
      Buffer.alloc(64, 0x5a),
      Buffer.from(`CrossPoint version: ${version}\0`, 'ascii'),
      Buffer.alloc(64, 0x5a),
    ]);
    writeFileSync(firmware, image);
    const x3 = { productId: 'io.pocketdaily.reader', board: 'xteink_x3', updateChannel: 'stable' };
    __wifiOtaTestApi.stageEsp32Fw('xteink_x3', firmware, x3);

    expect(__wifiOtaTestApi.embeddedFirmwareVersion(image)).toBe(version);
    expect(__wifiOtaTestApi.stagedFwAdvert('xteink_x3', x3, version)).toBeUndefined();
    expect(__wifiOtaTestApi.getStagedFw(x3)).toBeUndefined();
  });

  it('refreshes a rebuilt-in-place image before accepting a version acknowledgement', () => {
    const version = '1.4.1-dev-pocket-w12345678';
    const image = (fill: number) => Buffer.concat([
      Buffer.alloc(64, fill),
      Buffer.from(`CrossPoint version: ${version}\0`, 'ascii'),
      Buffer.alloc(64, fill),
    ]);
    writeFileSync(firmware, image(0x11));
    const x3 = { productId: 'io.pocketdaily.reader', board: 'xteink_x3', updateChannel: 'stable' };
    const staged = __wifiOtaTestApi.stageEsp32Fw('xteink_x3', firmware, x3);

    writeFileSync(firmware, image(0x22));
    const advert = __wifiOtaTestApi.stagedFwAdvert('xteink_x3', x3, version);

    expect(advert).toMatchObject(x3);
    expect(advert?.md5).not.toBe(staged.md5);
    expect(__wifiOtaTestApi.getStagedFw(x3)?.md5).toBe(advert?.md5);
  });

  it('rejects cross-product and cross-channel stages before persisting', () => {
    expect(() => __wifiOtaTestApi.stageEsp32Fw('xteink_x3', firmware, {
      productId: 'dev.agentdeck.dashboard-firmware', board: 'xteink_x3', updateChannel: 'stable',
    })).toThrow(/product and board do not match/i);
    expect(() => __wifiOtaTestApi.stageEsp32Fw('xteink_x3', firmware, {
      productId: 'io.pocketdaily.reader', board: 'xteink_x3', updateChannel: 'beta',
    })).toThrow(/update channel do not match/i);
  });

  it('serves pull OTA as bounded, contiguous resume segments', () => {
    const image = Buffer.alloc(300 * 1024);
    image.fill(0x11, 0, 128 * 1024);
    image.fill(0x22, 128 * 1024, 256 * 1024);
    image.fill(0x33, 256 * 1024);

    const first = __wifiOtaTestApi.pullOtaSegment(image, 0);
    const second = __wifiOtaTestApi.pullOtaSegment(image, first.body.length);
    const tail = __wifiOtaTestApi.pullOtaSegment(image, second.from + second.body.length);

    expect(first).toMatchObject({ from: 0 });
    expect(first.body).toHaveLength(256 * 1024);
    expect(second).toMatchObject({ from: 256 * 1024 });
    expect(second.body).toHaveLength(44 * 1024);
    expect(second.body[0]).toBe(0x33);
    expect(tail).toMatchObject({ from: 300 * 1024 });
    expect(tail.body).toHaveLength(0);
  });

  it('honors a bounded cooperative OTA segment limit', () => {
    const image = Buffer.alloc(700 * 1024);
    expect(__wifiOtaTestApi.pullOtaSegment(image, 0, 128 * 1024).body).toHaveLength(128 * 1024);
    expect(__wifiOtaTestApi.pullOtaSegment(image, 0, 1).body).toHaveLength(32 * 1024);
    expect(__wifiOtaTestApi.pullOtaSegment(image, 0, 2 * 1024 * 1024).body).toHaveLength(512 * 1024);
  });

  it('redirects dual-homed OTA traffic to the device-side Wi-Fi interface once', () => {
    const interfaces = {
      en0: [{ address: '192.168.68.100', netmask: '255.255.252.0', family: 'IPv4',
        mac: '00:00:00:00:00:01', internal: false, cidr: '192.168.68.100/22' }],
      en1: [{ address: '192.168.68.60', netmask: '255.255.252.0', family: 'IPv4',
        mac: '00:00:00:00:00:02', internal: false, cidr: '192.168.68.60/22' }],
    } as Parameters<typeof __wifiOtaTestApi.preferredPullOtaIp>[2];

    expect(__wifiOtaTestApi.preferredPullOtaIp('192.168.68.57', '192.168.68.100', interfaces))
      .toBe('192.168.68.60');
    expect(__wifiOtaTestApi.preferredPullOtaIp('192.168.68.57', '192.168.68.60', interfaces))
      .toBeUndefined();
  });
});
