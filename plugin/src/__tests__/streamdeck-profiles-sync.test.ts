// Drift gate for the bundled Stream Deck profiles. The `.streamDeckProfile`
// zips are generated from the SSOT in scripts/generate-streamdeck-profiles.mjs
// (deterministic bytes) and committed. If the SSOT (models, grids, dial roles,
// plugin version) changes without regenerating, this fails — run
// `pnpm generate-streamdeck-profiles`.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error — plain .mjs generator, no types
import { PROFILES, KEYPAD_ROLE, ENCODER_ROLES, profileBytes, PLUGIN_DIR } from '../../../scripts/generate-streamdeck-profiles.mjs';

interface Role { name: string; uuid: string }

describe('bundled Stream Deck profiles in sync', () => {
  for (const p of PROFILES as Array<{ name: string; deviceType: number }>) {
    it(`${p.name}.streamDeckProfile matches the SSOT`, () => {
      const onDisk = readFileSync(resolve(PLUGIN_DIR, `${p.name}.streamDeckProfile`));
      const expected = profileBytes(p) as Buffer;
      // Compare bytes; equals() keeps the failure message small (no giant diff).
      expect(onDisk.equals(expected)).toBe(true);
    });
  }

  // A placed action carries the name the profile gave it, so a manifest rename
  // that skips the generator leaves bundled decks showing the old name.
  it('names every placed action exactly as the plugin manifest does', () => {
    const manifest = JSON.parse(readFileSync(resolve(PLUGIN_DIR, 'manifest.json'), 'utf8')) as {
      Actions: Array<{ Name: string; UUID: string }>;
    };
    const manifestName = new Map(manifest.Actions.map((a) => [a.UUID, a.Name]));
    for (const role of [KEYPAD_ROLE, ...ENCODER_ROLES] as Role[]) {
      expect(manifestName.get(role.uuid), role.uuid).toBe(role.name);
    }
  });

  it('covers exactly the five shipped device families', () => {
    const types = (PROFILES as Array<{ deviceType: number }>).map((p) => p.deviceType).sort((a, b) => a - b);
    expect(types).toEqual([0, 1, 2, 7, 13]);
  });
});
