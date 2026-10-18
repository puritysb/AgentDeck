/**
 * `idotmatrixNamePrefixes` is hand-edited config that becomes argv for the BLE
 * scanner (scan.py), so the reader has to be defensive about what a user's
 * settings.json actually contains. The matching rule itself is the shared
 * SSOT's (shared/src/__tests__/idotmatrix-identity.test.ts).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { readIDotMatrixDevicesStrict, sanitizeNamePrefixes } from '../idotmatrix/idotmatrix-settings.js';

describe('iDotMatrix extra name prefixes', () => {
  it('keeps the configured prefixes', () => {
    expect(sanitizeNamePrefixes(['iPixel-', 'MyPanel-'])).toEqual(['iPixel-', 'MyPanel-']);
  });

  it('drops blanks and non-strings instead of passing them to the scanner', () => {
    expect(sanitizeNamePrefixes(['', '   ', 42, null, { a: 1 }, 'ok-'])).toEqual(['ok-']);
  });

  it('treats a missing or malformed key as no extra prefixes', () => {
    expect(sanitizeNamePrefixes(undefined)).toEqual([]);
    expect(sanitizeNamePrefixes('IDM-')).toEqual([]);
    expect(sanitizeNamePrefixes({ 0: 'IDM-' })).toEqual([]);
  });
});

// The daemon's supervisor stops the client when the device is gone from the
// settings, so "could not read the file" must not look like "no device".
describe('iDotMatrix devices read strictly', () => {
  let dir: string;
  const settingsWith = (text: string): string => {
    const path = join(dir, 'settings.json');
    writeFileSync(path, text);
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agentdeck-idotmatrix-settings-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a missing settings file as nothing configured', () => {
    expect(readIDotMatrixDevicesStrict(join(dir, 'settings.json'))).toEqual([]);
  });

  it('returns the configured devices, and none when the key is absent', () => {
    expect(readIDotMatrixDevicesStrict(settingsWith('{"idotmatrixDevices":[{"address":"AA:AA"}]}'))).toEqual([
      { address: 'AA:AA' },
    ]);
    expect(readIDotMatrixDevicesStrict(settingsWith('{"daemonPort":9120}'))).toEqual([]);
  });

  it('returns null for a file it cannot parse, such as one caught mid-write', () => {
    expect(readIDotMatrixDevicesStrict(settingsWith(''))).toBeNull();
    expect(readIDotMatrixDevicesStrict(settingsWith('{"idotmatrixDevices":[{"addr'))).toBeNull();
    expect(readIDotMatrixDevicesStrict(settingsWith('null'))).toBeNull();
  });
});
