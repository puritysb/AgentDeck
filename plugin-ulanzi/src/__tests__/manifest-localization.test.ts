import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The Ulanzi SDK maps a localization file's `Actions` array onto
// `manifest.json`'s by index, so a longer or reordered array silently
// mislabels the action in the palette (this shipped once: en.json still
// carried the five pre-consolidation actions while the manifest declared
// one, so the palette read "Session" instead of "AgentDeck").
const PLUGIN_DIR = join(
  __dirname,
  '..',
  '..',
  'com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin',
);

const readJson = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(PLUGIN_DIR, name), 'utf8'));

describe('ulanzi manifest ↔ localization alignment', () => {
  const manifest = readJson('manifest.json');
  const manifestActions = manifest.Actions as Array<{ Name: string; Tooltip?: string }>;

  it('declares exactly one dynamic action', () => {
    expect(manifestActions).toHaveLength(1);
    expect(manifestActions[0].Name).toBe('AgentDeck');
  });

  // `en` is the manifest's own language, so its entries must match the manifest
  // text exactly; a translated file must be aligned and non-empty, not equal —
  // asserting equality there would forbid translating at all.
  it('en.json repeats the manifest text verbatim', () => {
    const actions = readJson('en.json').Actions as Array<{ Name: string; Tooltip?: string }>;
    expect(actions).toHaveLength(manifestActions.length);
    actions.forEach((action, index) => {
      expect(action.Name).toBe(manifestActions[index].Name);
      expect(action.Tooltip).toBe(manifestActions[index].Tooltip);
    });
  });

  for (const locale of ['zh_CN', 'zh_HK', 'ja_JP', 'ko_KR'] as const) {
    it(`${locale}.json Actions is index-aligned with the manifest`, () => {
      const localization = readJson(`${locale}.json`);
      const actions = localization.Actions as Array<{ Name: string; Tooltip?: string }>;

      expect(actions).toHaveLength(manifestActions.length);
      actions.forEach((action) => {
        expect(action.Name?.trim()).toBeTruthy();
        expect(action.Tooltip?.trim()).toBeTruthy();
      });
      // A translated file that still carries the English tooltip is an
      // untranslated file wearing a translated filename.
      expect(actions[0].Tooltip).not.toBe(manifestActions[0].Tooltip);
      expect(String(localization.Description ?? '').trim()).toBeTruthy();
    });
  }
});
