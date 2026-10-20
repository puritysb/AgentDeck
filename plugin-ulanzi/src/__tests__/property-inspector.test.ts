import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
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
    // `t('key')` calls, plus the detail keys sessionLive() hands to t().
    const used = [
      ...[...common.matchAll(/\bt\('([^']+)'\)/g)].map((m) => m[1]),
      ...[...common.matchAll(/'(detail[A-Z][A-Za-z]*)'/g)].map((m) => m[1]),
    ];
    expect(used).toContain('detailHooksMissing');
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

/**
 * Ulanzi Studio QA, plugin 1.8.1 on Windows (2026-10-19): the panel said "No
 * agent session yet" over a deck full of sessions, its "Full guide" link did
 * nothing, and the Windows tab carried macOS / App Store / ChatGPT notes under
 * a command that did not start the daemon.
 */
describe('ulanzi property inspector — QA 1.8.1', () => {
  const common = readFileSync(join(PLUGIN_DIR, 'property-inspector', 'setup-common.js'), 'utf8');
  const inspectorJs = readFileSync(join(PLUGIN_DIR, 'property-inspector', 'inspector.js'), 'utf8');

  /** Evaluate setup-common.js the way a webview would, without a document. */
  function loadSetup() {
    const sandbox: Record<string, unknown> = { navigator: { userAgent: 'test' } };
    sandbox.window = sandbox;
    runInNewContext(common, sandbox);
    return sandbox.AgentDeckSetup as {
      command: string;
      sessionLive: (health: Record<string, unknown>) => { live: boolean; detail: string };
    };
  }

  it('step 2 trusts the session count over the state word', () => {
    const { sessionLive } = loadSetup();
    // The reported case: observed sessions on the deck, daemon state word
    // `disconnected` because no managed session is focused.
    expect(sessionLive({ state: 'disconnected', sessions: 3 })).toEqual({ live: true, detail: 'detailSession' });
    expect(sessionLive({ state: 'idle', sessions: 0 })).toEqual({ live: false, detail: 'detailNoSession' });
    // Older daemons send no count: the old state-word rule still decides.
    expect(sessionLive({ state: 'idle' }).live).toBe(true);
    expect(sessionLive({ state: 'disconnected' }).live).toBe(false);
    // `null` = the daemon could not count in time: no information, not zero.
    expect(sessionLive({ state: 'processing', sessions: null }).live).toBe(true);
  });

  it('hints at the hooks only when the daemon definitely found none', () => {
    const { sessionLive } = loadSetup();
    expect(sessionLive({ state: 'disconnected', sessions: 0, claudeHooks: 'missing' }).detail).toBe('detailHooksMissing');
    expect(sessionLive({ state: 'disconnected', sessions: 0, claudeHooks: 'unknown' }).detail).toBe('detailNoSession');
    expect(sessionLive({ state: 'disconnected', sessions: 2, claudeHooks: 'missing' }).detail).toBe('detailSession');
  });

  it('opens the guide and the tutorial fallback through Studio, not a webview link', () => {
    expect(common).toContain('$UD.openUrl(');
    expect(common).toMatch(/getElementById\('guide'\)[\s\S]*preventDefault\(\)[\s\S]*openExternal\(GUIDE_URL/);
    // The H5 tutorial keeps openView, plus a browser path that cannot open
    // behind Studio: a `local` openUrl of the same plugin-root path.
    expect(inspectorJs).toContain('$UD.openView');
    expect(inspectorJs).toMatch(/openExternal\(TUTORIAL_PATH, true,/);
    expect(inspector).toContain('id="tutorialBrowser"');
  });

  it('gives each platform its own command, notes and troubleshooting', () => {
    const { command } = loadSetup();
    expect(command).toBe('npx -y @agentdeck/setup --yes');
    const pane = (html: string, open: RegExp, close: RegExp) => {
      const start = html.search(open);
      expect(start, String(open)).toBeGreaterThan(-1);
      const rest = html.slice(start);
      return rest.slice(0, rest.search(close));
    };
    const surfaces = [
      { name: 'inspector', mac: pane(inspector, /<div id="paneMac">/, /<!-- Windows:/), win: pane(inspector, /<div id="paneWin"/, /<!-- Step 2/) },
      { name: 'tutorial', mac: pane(tutorial, /<h4>macOS<\/h4>/, /<h4>Windows<\/h4>/), win: pane(tutorial, /<h4>Windows<\/h4>/, /<!-- Step 2/) },
    ];
    for (const { name, mac, win } of surfaces) {
      for (const [os, html] of [['mac', mac], ['win', win]] as const) {
        expect(html, `${name} ${os} has its own command row`).toContain(`>${command}</code>`);
        expect(html, `${name} ${os} has its own copy button`).toContain('class="ad-copy"');
      }
      expect(mac).toContain('data-localize="s1MacTrouble"');
      expect(win).toContain('data-localize="s1WinTrouble"');
      expect(win).toContain('data-localize="s1WinPs"');
      // Nothing macOS-only in the Windows pane.
      expect(win, `${name} Windows pane`).not.toMatch(/macOS|App Store|ChatGPT|data-localize="s1Mac/);
    }
    // The shared step text says nothing platform-specific either.
    const en = readJson('en.json').Localization as Record<string, string>;
    for (const key of ['s2Body', 's2Hooks', 's3Body', 's3Note', 'keysSession', 'keysDetail', 'keysUsage']) {
      expect(en[key], key).not.toMatch(/macOS|App Store|ChatGPT/);
    }
    for (const key of Object.keys(en).filter((k) => k.startsWith('s1Win'))) {
      expect(en[key], key).not.toMatch(/macOS|App Store|ChatGPT/);
    }
  });

  it('describes the keys the deck actually draws', () => {
    const en = readJson('en.json').Localization as Record<string, string>;
    // A running daemon with no session draws HUB READY / NO SESSION
    // (shared/src/d200h-layout.ts), not OFFLINE — the old note said otherwise.
    expect(en.s3Note).toContain('HUB READY');
    expect(en.s3Note).toContain('NO SESSION');
    expect(en.keysDetail).toContain('BACK');
    expect(en.keysUsage).toMatch(/5-hour/);
  });
});
