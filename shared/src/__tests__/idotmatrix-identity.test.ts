// Guards the iDotMatrix BLE identity SSOT (shared/src/idotmatrix-identity.ts):
//  1. the discovery predicate itself — a panel is identified by the advertised
//     service UUID first and by a known name family second, so a rebranded but
//     protocol-identical panel (iPixel, issue #115) is discoverable, and
//  2. the generated Swift/Python mirrors on disk match what the generator emits
//     from the current source — a hand edit or a skipped
//     `pnpm generate-idotmatrix-identity` fails here in CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  IDOTMATRIX_NAME_PREFIXES,
  IDOTMATRIX_SERVICE_UUID,
  IDOTMATRIX_WRITE_CHARACTERISTIC_UUID,
  isIDotMatrixAdvertisement,
  matchesIDotMatrixName,
  normalizeBleUuid,
} from '../idotmatrix-identity.js';
import { OUTPUTS, emitSwift, emitPython } from '../../../scripts/generate-idotmatrix-identity.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const identity = {
  serviceUuid: IDOTMATRIX_SERVICE_UUID,
  writeCharacteristicUuid: IDOTMATRIX_WRITE_CHARACTERISTIC_UUID,
  namePrefixes: [...IDOTMATRIX_NAME_PREFIXES],
};

describe('BLE UUID normalization', () => {
  it('expands the short advertisement forms onto the Bluetooth base UUID', () => {
    expect(normalizeBleUuid('00fa')).toBe(IDOTMATRIX_SERVICE_UUID);
    expect(normalizeBleUuid('000000FA')).toBe(IDOTMATRIX_SERVICE_UUID);
    expect(normalizeBleUuid('000000FA-0000-1000-8000-00805F9B34FB')).toBe(IDOTMATRIX_SERVICE_UUID);
  });

  it('left-pads a short form that dropped its leading zeroes', () => {
    // CBUUID.uuidString does not promise "00FA" over "FA".
    expect(normalizeBleUuid('fa')).toBe(IDOTMATRIX_SERVICE_UUID);
    expect(normalizeBleUuid('fa02')).toBe(IDOTMATRIX_WRITE_CHARACTERISTIC_UUID);
  });

  it('leaves an unrelated 128-bit UUID alone', () => {
    const other = '0000180f-0000-1000-8000-00805f9b34fb';
    expect(normalizeBleUuid(other)).toBe(other);
  });
});

describe('iDotMatrix discovery predicate', () => {
  it('matches the iDotMatrix and iPixel name families case-insensitively', () => {
    expect(matchesIDotMatrixName('IDM-L')).toBe(true);
    expect(matchesIDotMatrixName('idm-32')).toBe(true);
    // Issue #115: same protocol, different brand name.
    expect(matchesIDotMatrixName('iPixel-1234')).toBe(true);
    expect(matchesIDotMatrixName('IPIXEL')).toBe(true);
  });

  it('does not match unrelated peripherals', () => {
    expect(matchesIDotMatrixName('Divoom Timebox')).toBe(false);
    expect(matchesIDotMatrixName('')).toBe(false);
    expect(matchesIDotMatrixName('   ')).toBe(false);
  });

  it('accepts a user-configured prefix for the next rebrand', () => {
    expect(matchesIDotMatrixName('MyPanel-7')).toBe(false);
    expect(matchesIDotMatrixName('MyPanel-7', ['mypanel-'])).toBe(true);
    // A blank entry in settings.json must not match everything.
    expect(matchesIDotMatrixName('Divoom Timebox', ['', '  '])).toBe(false);
  });

  it('identifies an unnamed peripheral by its advertised service UUID', () => {
    expect(isIDotMatrixAdvertisement({ serviceUuids: [IDOTMATRIX_SERVICE_UUID] })).toBe(true);
    expect(isIDotMatrixAdvertisement({ name: '', serviceUuids: ['000000FA'] })).toBe(true);
    expect(isIDotMatrixAdvertisement({ name: 'Whatever', serviceUuids: ['00fa'] })).toBe(true);
  });

  it('still identifies a named panel that keeps the service out of its advertisement', () => {
    expect(isIDotMatrixAdvertisement({ name: 'IDM-L', serviceUuids: [] })).toBe(true);
    expect(isIDotMatrixAdvertisement({ name: 'iPixel-9' })).toBe(true);
  });

  it('rejects a peripheral with neither signal', () => {
    expect(
      isIDotMatrixAdvertisement({ name: 'Some Speaker', serviceUuids: ['0000180f-0000-1000-8000-00805f9b34fb'] }),
    ).toBe(false);
  });
});

describe('generated mirrors in sync', () => {
  for (const [rel, emit] of OUTPUTS) {
    it(`${rel} matches the SSOT`, () => {
      const onDisk = readFileSync(`${repoRoot}${rel}`, 'utf8');
      expect(onDisk).toBe(emit(identity));
    });
  }

  it('emitters embed the SSOT literals (sanity on the emitters themselves)', () => {
    for (const emit of [emitSwift, emitPython]) {
      const src = emit(identity);
      expect(src).toContain(IDOTMATRIX_SERVICE_UUID);
      expect(src).toContain(IDOTMATRIX_WRITE_CHARACTERISTIC_UUID);
      for (const prefix of IDOTMATRIX_NAME_PREFIXES) expect(src).toContain(`"${prefix}"`);
    }
  });
});
