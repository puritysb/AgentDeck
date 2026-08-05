import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PluginManifest {
  Version: string;
  OS: Array<{ Platform: string; MinimumVersion: string }>;
}

const manifest = JSON.parse(readFileSync(
  new URL('../../bound.serendipity.agentdeck.sdPlugin/manifest.json', import.meta.url),
  'utf8',
)) as PluginManifest;

const pkg = JSON.parse(readFileSync(
  new URL('../../package.json', import.meta.url),
  'utf8',
)) as { version: string };

describe('Stream Deck Marketplace platform contract', () => {
  it('ships installable entries for both maintained desktop platforms', () => {
    expect(manifest.OS).toEqual([
      { Platform: 'mac', MinimumVersion: '26.0' },
      { Platform: 'windows', MinimumVersion: '10' },
    ]);
  });

  // Elgato wants a four-component version and the Marketplace enforces
  // monotonic ordering, so the manifest carries `X.Y.Z.0` of the plugin
  // package version. Pinning the literal here made every plugin release trip
  // this test; assert the relationship instead, which is the thing that has to
  // hold — `scripts/verify-version-sync.mjs` gates the same pair.
  it('mirrors the plugin package version as X.Y.Z.0', () => {
    expect(manifest.Version).toBe(`${pkg.version}.0`);
    expect(manifest.Version).toMatch(/^\d+\.\d+\.\d+\.0$/);
  });
});
