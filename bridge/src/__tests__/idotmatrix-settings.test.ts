/**
 * `idotmatrixNamePrefixes` is hand-edited config that becomes argv for the BLE
 * scanner (scan.py), so the reader has to be defensive about what a user's
 * settings.json actually contains. The matching rule itself is the shared
 * SSOT's (shared/src/__tests__/idotmatrix-identity.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { sanitizeNamePrefixes } from '../idotmatrix/idotmatrix-settings.js';

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
