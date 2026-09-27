import { describe, it, expect } from 'vitest';
import { measure, readBaseline, regressions } from '../check-native-palette.mjs';

describe('native Dashboard palette ratchet', () => {
  it('adds no raw colour literal to a Swift, Kotlin or ESP32 Dashboard file', () => {
    // Use a design token (DesignTokens.* / ProductPalette::*), or remove a literal
    // and run `node scripts/check-native-palette.mjs --write` to lower the floor.
    expect(regressions(measure(), readBaseline())).toEqual([]);
  });

  it('flags a file that gains a literal and a new file that starts with one', () => {
    expect(regressions({ 'a.swift': 3, 'b.kt': 1 }, { 'a.swift': 2 })).toEqual([
      { file: 'a.swift', baseline: 2, current: 3 },
      { file: 'b.kt', baseline: 0, current: 1 },
    ]);
    expect(regressions({ 'a.swift': 1 }, { 'a.swift': 2 })).toEqual([]);
  });
});
