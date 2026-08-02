/**
 * Launcher dial — launch-target resolution.
 *
 * The dial's whole contract is "press opens the right thing", and the fallback
 * chain exists because the desktop app cannot be assumed installed. These tests
 * pin the ordering and the failure semantics, since a silently-wrong launch is
 * indistinguishable from a working one until a user reports it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const openApp = vi.fn<(name: string) => Promise<void>>();
const openOrFocusBrowserTab = vi.fn<(url: string) => Promise<void>>();

vi.mock('../system/index.js', () => ({
  openApp: (name: string) => openApp(name),
  openOrFocusBrowserTab: (url: string) => openOrFocusBrowserTab(url),
  openAgentDeckAppOrGitHub: vi.fn(async () => {}),
}));

vi.mock('../log.js', () => ({
  dlog: vi.fn(), dinfo: vi.fn(), dwarn: vi.fn(), derr: vi.fn(), dtrace: vi.fn(),
}));

import { runTarget, buildEntries, rollIndex, DEFAULT_TARGETS } from '../launch-targets.js';

describe('launcher: runTarget fallback chain', () => {
  beforeEach(() => {
    openApp.mockReset();
    openOrFocusBrowserTab.mockReset();
    openApp.mockResolvedValue(undefined);
    openOrFocusBrowserTab.mockResolvedValue(undefined);
  });

  it('opens a desktop app for an app: target', async () => {
    await runTarget('app:Claude');
    expect(openApp).toHaveBeenCalledWith('Claude');
    expect(openOrFocusBrowserTab).not.toHaveBeenCalled();
  });

  it('opens a browser tab for a url: target', async () => {
    await runTarget('url:https://example.com');
    expect(openOrFocusBrowserTab).toHaveBeenCalledWith('https://example.com');
    expect(openApp).not.toHaveBeenCalled();
  });

  it('stops at the first step that succeeds', async () => {
    await runTarget('app:Codex|url:https://chatgpt.com/codex/cloud');
    expect(openApp).toHaveBeenCalledWith('Codex');
    expect(openOrFocusBrowserTab).not.toHaveBeenCalled();
  });

  it('falls through to the URL when the app is not installed', async () => {
    openApp.mockRejectedValue(new Error('Cannot open "Codex"'));
    await runTarget('app:Codex|url:https://chatgpt.com/codex/cloud');
    expect(openApp).toHaveBeenCalledWith('Codex');
    expect(openOrFocusBrowserTab).toHaveBeenCalledWith('https://chatgpt.com/codex/cloud');
  });

  it('rejects when every step fails, so the dial can showAlert', async () => {
    openApp.mockRejectedValue(new Error('no app'));
    openOrFocusBrowserTab.mockRejectedValue(new Error('no browser'));
    await expect(runTarget('app:Codex|url:https://x.test')).rejects.toThrow('no browser');
  });

  it('rejects an unrecognized scheme rather than guessing', async () => {
    await expect(runTarget('Codex')).rejects.toThrow(/Unrecognized launch target/);
    expect(openApp).not.toHaveBeenCalled();
    expect(openOrFocusBrowserTab).not.toHaveBeenCalled();
  });

  it('rejects an empty target', async () => {
    await expect(runTarget('   ')).rejects.toThrow(/Empty launch target/);
  });

  it('tolerates whitespace around chain steps', async () => {
    openApp.mockRejectedValue(new Error('no app'));
    await runTarget(' app:Codex | url:https://x.test ');
    expect(openOrFocusBrowserTab).toHaveBeenCalledWith('https://x.test');
  });
});

describe('launcher: shipped defaults', () => {
  it('every default target parses into runnable steps', async () => {
    for (const [agent, target] of Object.entries(DEFAULT_TARGETS)) {
      openApp.mockReset();
      openOrFocusBrowserTab.mockReset();
      openApp.mockResolvedValue(undefined);
      openOrFocusBrowserTab.mockResolvedValue(undefined);

      await expect(runTarget(target), `default for ${agent}`).resolves.toBeUndefined();
      expect(
        openApp.mock.calls.length + openOrFocusBrowserTab.mock.calls.length,
        `default for ${agent} invoked nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it('falls back to a URL for both agents that have a desktop app', async () => {
    // Claude and Codex ship apps; a user without them must still land somewhere.
    for (const agent of ['claude', 'codex']) {
      openApp.mockReset();
      openOrFocusBrowserTab.mockReset();
      openApp.mockRejectedValue(new Error('not installed'));
      openOrFocusBrowserTab.mockResolvedValue(undefined);

      await runTarget(DEFAULT_TARGETS[agent]);
      expect(openOrFocusBrowserTab, `${agent} has no URL fallback`).toHaveBeenCalled();
    }
  });
});

describe('launcher: entry list and rolling', () => {
  it('lists every agent in a stable order', () => {
    const list = buildEntries();
    expect(list.map(e => e.agent)).toEqual(['claude', 'codex', 'openclaw']);
    expect(list.map(e => e.label)).toEqual(['Claude', 'Codex', 'OpenClaw']);
  });

  it('honours a per-agent override from the Property Inspector', () => {
    const list = buildEntries({ codexTarget: 'app:MyCodex' });
    expect(list.find(e => e.agent === 'codex')!.target).toBe('app:MyCodex');
    // Untouched agents keep their defaults.
    expect(list.find(e => e.agent === 'claude')!.target).toBe(DEFAULT_TARGETS.claude);
  });

  it('ignores a blank override rather than launching nothing', () => {
    const list = buildEntries({ codexTarget: '   ' });
    expect(list.find(e => e.agent === 'codex')!.target).toBe(DEFAULT_TARGETS.codex);
  });

  it('wraps the rolling index in both directions', () => {
    expect(rollIndex(0, 1, 3)).toBe(1);
    expect(rollIndex(2, 1, 3)).toBe(0);    // forward past the end
    expect(rollIndex(0, -1, 3)).toBe(2);   // backward past the start
    expect(rollIndex(0, -7, 3)).toBe(2);   // multi-turn backward roll
    expect(rollIndex(1, 100, 3)).toBe(2);
  });

  it('never returns a negative or out-of-range index', () => {
    for (const ticks of [-13, -1, 0, 1, 13]) {
      for (const total of [1, 2, 3]) {
        const i = rollIndex(0, ticks, total);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(total);
      }
    }
  });

  it('returns 0 for an empty list instead of NaN', () => {
    expect(rollIndex(0, 1, 0)).toBe(0);
  });
});
