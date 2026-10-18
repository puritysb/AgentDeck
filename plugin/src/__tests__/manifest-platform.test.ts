import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PluginManifest {
  Version: string;
  Actions: Array<{ Name: string; States: Array<{ Name?: string }>; UUID: string }>;
  OS: Array<{ Platform: string; MinimumVersion: string }>;
  Profiles: Array<{
    Name: string;
    AutoInstall: boolean;
    DontAutoSwitchWhenInstalled: boolean;
  }>;
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

describe('bundled profile selection contract', () => {
  it('installs and initially selects every bundled profile for first-time users', () => {
    expect(manifest.Profiles).toHaveLength(5);
    for (const profile of manifest.Profiles) {
      expect(profile.AutoInstall, profile.Name).toBe(true);
      expect(profile.DontAutoSwitchWhenInstalled, profile.Name).toBe(false);
    }
  });

  it('does not programmatically switch profiles after connecting', () => {
    const pluginSource = readFileSync(new URL('../plugin.ts', import.meta.url), 'utf8');
    expect(pluginSource).not.toMatch(/profiles\.switchToProfile\s*\(/);
  });
});

// docs/streamdeck-layout.md "Action names and icons": an action is named for
// what it does, never after a provider. Provider names belong in its tooltip.
describe('action naming contract', () => {
  const VENDOR_NAMES = /\b(claude|anthropic|codex|openai|chatgpt|gpt|gemini|google|antigravity|kiro|z\.ai|glm|cursor|opencode|openclaw)\b/i;

  it('names no action or action state after a provider', () => {
    for (const action of manifest.Actions) {
      expect(action.Name, action.UUID).not.toMatch(VENDOR_NAMES);
      for (const state of action.States) expect(state.Name ?? '', action.UUID).not.toMatch(VENDOR_NAMES);
    }
  });
});
