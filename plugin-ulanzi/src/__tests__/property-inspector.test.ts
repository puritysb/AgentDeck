import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards for the two setup surfaces: the Property Inspector (the panel Studio
 * opens when a user drags the action onto a key) and the H5 tutorial page it
 * opens through `$UD.openView`.
 *
 * Three failures with real precedent:
 *  1. The manifest naming a Property Inspector that is not in the package. The
 *     1.0.1 review found the opposite (no PropertyInspectorPath at all, so
 *     Studio's "Setup / Click for guide" placeholder opened nothing); pointing
 *     at a missing file is the same dead click with more confidence.
 *  2. A string that renders as an empty element, or in the wrong language. The
 *     SDK localizes `[data-localize]` from `<language>.json`, so a key typo is
 *     invisible in review and shows the English through — in a panel whose
 *     whole purpose is to unstick a first-time user.
 *  3. English living only in JSON. `localizeUI()` runs when the socket opens;
 *     if Studio never answers, markup-resident English is the difference
 *     between a complete tutorial and a blank column.
 */
const PLUGIN_DIR = join(__dirname, '..', '..', 'com.ulanzi.ulanzistudio.agentdeck.ulanziPlugin');
const readJson = (name: string) => JSON.parse(readFileSync(join(PLUGIN_DIR, name), 'utf8'));
const manifest = readJson('manifest.json');
const PI_REL = manifest.Actions[0].PropertyInspectorPath as string;
const inspector = readFileSync(join(PLUGIN_DIR, PI_REL), 'utf8');
const tutorial = readFileSync(join(PLUGIN_DIR, 'property-inspector', 'tutorial.html'), 'utf8');
const localeFiles = readdirSync(PLUGIN_DIR).filter((f) => f.endsWith('.json') && f !== 'manifest.json');

const localizeKeys = (html: string) => [...html.matchAll(/data-localize="([^"]+)"/g)].map((m) => m[1]);

describe('ulanzi property inspector', () => {
  it('is declared by the manifest and present on disk', () => {
    expect(PI_REL).toBe('property-inspector/inspector.html');
    expect(existsSync(join(PLUGIN_DIR, PI_REL))).toBe(true);
  });

  it('loads the SDK Property Inspector libraries that the package ships', () => {
    // $UD is what makes this a Property Inspector rather than a lone web page:
    // Studio hands it the language and the action context on connect.
    for (const lib of ['constants.js', 'eventEmitter.js', 'timers.js', 'utils.js', 'ulanziApi.js']) {
      expect(inspector, `inspector loads ${lib}`).toContain(`../libs/js/${lib}`);
      expect(tutorial, `tutorial loads ${lib}`).toContain(`../libs/js/${lib}`);
      expect(existsSync(join(PLUGIN_DIR, 'libs', 'js', lib)), `${lib} shipped`).toBe(true);
    }
    expect(existsSync(join(PLUGIN_DIR, 'libs', 'css', 'uspi.css'))).toBe(true);
  });

  it('opens the H5 tutorial through the SDK, at a path the package contains', () => {
    const call = inspector.match(/TUTORIAL_PATH\s*=\s*'([^']+)'/)
      ?? readFileSync(join(PLUGIN_DIR, 'property-inspector', 'inspector.js'), 'utf8')
        .match(/TUTORIAL_PATH\s*=\s*'([^']+)'/);
    expect(call, 'inspector.js declares TUTORIAL_PATH').toBeTruthy();
    // openView resolves a local path against the plugin root.
    const rel = call![1].replace(/^\.\//, '');
    expect(existsSync(join(PLUGIN_DIR, rel)), `${rel} exists`).toBe(true);
    expect(readFileSync(join(PLUGIN_DIR, 'property-inspector', 'inspector.js'), 'utf8'))
      .toContain('$UD.openView');
  });

  it('is self-contained — no remote asset can leave either surface half-drawn', () => {
    // A webview with no network (or a reviewer testing offline) must still get
    // the whole tutorial. Links are fine; loaded subresources are not.
    for (const [name, html] of [['inspector', inspector], ['tutorial', tutorial]] as const) {
      const loaded = (html.match(/(?:src|href)="https?:[^"]*"/g) ?? []).filter((r) => r.startsWith('src='));
      expect(loaded, `${name} loads no remote subresource`).toEqual([]);
    }
  });

  it('keeps English in the markup, not only in the language files', () => {
    // Every localizable element must carry real English text as its content —
    // that text is what a user sees when Studio never answers.
    for (const [name, html] of [['inspector', inspector], ['tutorial', tutorial]] as const) {
      const empties = [...html.matchAll(/data-localize="([^"]+)"[^>]*>\s*</g)].map((m) => m[1]);
      expect(empties, `${name} has no empty localizable element`).toEqual([]);
    }
  });

  it('resolves every data-localize key against every shipped language', () => {
    const used = new Set([...localizeKeys(inspector), ...localizeKeys(tutorial)]);
    expect(used.size).toBeGreaterThan(0);
    expect(localeFiles).toContain('en.json');
    expect(localeFiles).toContain('zh_CN.json');
    for (const file of localeFiles) {
      const table = readJson(file).Localization ?? {};
      for (const key of used) {
        expect(Object.keys(table), `${file} defines ${key}`).toContain(key);
      }
    }
  });

  it('resolves every runtime string lookup against every shipped language', () => {
    const common = readFileSync(join(PLUGIN_DIR, 'property-inspector', 'setup-common.js'), 'utf8');
    const used = [...common.matchAll(/\bt\('([^']+)'\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    // $UD.t returns the key itself when a language has no entry, so a missing
    // key here prints an identifier at the user.
    for (const file of localeFiles) {
      const table = readJson(file).Localization ?? {};
      for (const key of used) {
        expect(Object.keys(table), `${file} defines ${key}`).toContain(key);
      }
    }
    // The English fallback in the script covers the same set, for the case
    // where no language file loaded at all.
    const fallback = common.slice(common.indexOf('var EN = {'), common.indexOf('function t('));
    for (const key of used) expect(fallback, `EN fallback defines ${key}`).toContain(`${key}:`);
  });

  it('keeps every language key-aligned with canonical en', () => {
    const en = Object.keys(readJson('en.json').Localization).sort();
    for (const file of localeFiles) {
      const pack = readJson(file).Localization ?? {};
      // Missing keys show English through, which reads as half-translated;
      // extra keys are dead weight that hides a rename.
      expect({ file, keys: Object.keys(pack).sort() }).toEqual({ file, keys: en });
      for (const [key, value] of Object.entries(pack)) {
        expect(`${file}.${key}: ${String(value).trim()}`).not.toBe(`${file}.${key}: `);
      }
    }
  });

  it('preserves the {port} placeholder the script substitutes', () => {
    // These three strings are formatted with the discovered port; a translation
    // that drops the placeholder loses the number entirely.
    for (const file of localeFiles) {
      const pack = readJson(file).Localization;
      for (const key of ['foundApp', 'foundCli', 'foundOpaque']) {
        expect(pack[key], `${file}.${key} keeps {port}`).toContain('{port}');
      }
    }
  });

  it('reads the daemon only through routes that carry no secret', () => {
    const common = readFileSync(join(PLUGIN_DIR, 'property-inspector', 'setup-common.js'), 'utf8');
    // /health answers this panel too (older daemons, and the macOS app), but it
    // carries `pairingToken`. Rendering or logging that in a webview would put
    // the LAN credential on screen — the panel must never touch the field.
    expect(common).toContain('/setup-status');
    expect(common).not.toMatch(/\.pairingToken|\[['"]pairingToken['"]\]/);
  });
});
