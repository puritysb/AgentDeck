import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import {
  parseAdbDeviceLines,
  getAdbDeviceCountCached,
  getCachedAdbDevices,
  __setCachedAdbDevicesForTest,
} from '../adb-reverse.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

describe('adb probe stays off the event loop (#327)', () => {
  it('adb-reverse.ts never spawns synchronously', () => {
    // The measured failure: execSync('adb devices') blocked the loop for the
    // whole call — 19 ms idle, ~170 ms at load 10, 5–15 s at the 2026-09-13
    // load 600–800 — and /health (which embedded the probe via module health)
    // starved until the macOS app promoted a fallback daemon on 9121 and
    // opened the same serial devices. Async is the fix; this gate keeps it.
    // Comments are blanked first, same as the windows-child-window gate —
    // this file's own prose names the banned calls.
    const raw = readFileSync(join(moduleDir, '..', 'adb-reverse.ts'), 'utf-8');
    const source = raw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    for (const banned of ['execSync', 'spawnSync', 'execFileSync']) {
      expect(source, `adb-reverse.ts must not use ${banned}`).not.toContain(banned);
    }
  });

  it('the adb module activates without a synchronous probe', () => {
    const raw = readFileSync(join(moduleDir, '..', 'modules', 'adb-module.ts'), 'utf-8');
    const source = raw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    for (const banned of ['execSync', 'spawnSync', 'execFileSync']) {
      expect(source, `adb-module.ts must not use ${banned}`).not.toContain(banned);
    }
  });
});

describe('parseAdbDeviceLines', () => {
  const output = [
    'List of devices attached',
    'AA007422R24C1300039\tdevice',
    'CREMAA21W09235\tunauthorized',
    'HVA095B4\tdevice',
    '192.168.68.54:5555\tdevice',
    'adb-980a-beat._adb-tls-connect._tcp\tdevice',
    'emulator-5554\tdevice',
    'deadbeef\toffline',
    '',
  ].join('\n');

  it('collects every ready device; usbOnly is the only network filter', () => {
    // Without usbOnly the network transports are included — that is the
    // pre-existing contract of getConnectedAdbDevices (the filter exists for
    // the loopback posture, not as a default).
    expect(parseAdbDeviceLines(output)).toEqual([
      'AA007422R24C1300039',
      'HVA095B4',
      '192.168.68.54:5555',
      'adb-980a-beat._adb-tls-connect._tcp',
      'emulator-5554',
    ]);
  });

  it('usbOnly drops network transports but keeps the emulator', () => {
    expect(parseAdbDeviceLines(output, { usbOnly: true })).toEqual([
      'AA007422R24C1300039',
      'HVA095B4',
      'emulator-5554',
    ]);
  });

  it('tolerates a header-only or empty listing', () => {
    expect(parseAdbDeviceLines('List of devices attached\n')).toEqual([]);
    expect(parseAdbDeviceLines('')).toEqual([]);
  });
});

describe('cached adb device count serves request handlers', () => {
  it('reads zero before any refresh and the cached list after one', () => {
    __setCachedAdbDevicesForTest([]);
    expect(getAdbDeviceCountCached()).toBe(0);
    expect(getCachedAdbDevices().ageMs).toBe(Number.POSITIVE_INFINITY);

    __setCachedAdbDevicesForTest(['HVA095B4', 'AA007422R24C1300039']);
    expect(getAdbDeviceCountCached()).toBe(2);
    expect(getCachedAdbDevices().devices).toEqual(['HVA095B4', 'AA007422R24C1300039']);
    expect(getCachedAdbDevices().ageMs).toBeLessThan(60_000);

    __setCachedAdbDevicesForTest([]);
  });
});
