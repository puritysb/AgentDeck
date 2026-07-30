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

describe('Stream Deck Marketplace platform contract', () => {
  it('ships installable entries for both maintained desktop platforms', () => {
    expect(manifest.OS).toEqual([
      { Platform: 'mac', MinimumVersion: '26.0' },
      { Platform: 'windows', MinimumVersion: '10' },
    ]);
  });

  it('uses the Windows compatibility release version', () => {
    expect(manifest.Version).toBe('1.0.3.0');
  });
});
