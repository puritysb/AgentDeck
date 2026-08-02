// Drift gate for the bundled Stream Deck profiles. The `.streamDeckProfile`
// zips are generated from the SSOT in scripts/generate-streamdeck-profiles.mjs
// (deterministic bytes) and committed. If the SSOT (models, grids, dial roles,
// plugin version) changes without regenerating, this fails — run
// `pnpm generate-streamdeck-profiles`.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — plain .mjs generator, no types
import { PROFILES, profileBytes, PLUGIN_DIR } from '../../../scripts/generate-streamdeck-profiles.mjs';

describe('bundled Stream Deck profiles in sync', () => {
  for (const p of PROFILES as Array<{ name: string; deviceType: number }>) {
    it(`${p.name}.streamDeckProfile matches the SSOT`, () => {
      const onDisk = readFileSync(resolve(PLUGIN_DIR, `${p.name}.streamDeckProfile`));
      const expected = profileBytes(p) as Buffer;
      // Compare bytes; equals() keeps the failure message small (no giant diff).
      expect(onDisk.equals(expected)).toBe(true);
    });
  }

  it('covers exactly the five shipped device families', () => {
    const types = (PROFILES as Array<{ deviceType: number }>).map((p) => p.deviceType).sort((a, b) => a - b);
    expect(types).toEqual([0, 1, 2, 7, 13]);
  });
});
