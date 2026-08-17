import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  resolveDaemonPort,
  parseDaemonPort,
  isValidDaemonPort,
  preferredDaemonPortFrom,
  describeDaemonPortSource,
  DAEMON_PORT_ENV_VAR,
  DAEMON_PORT_SETTING_KEY,
  DAEMON_PORT_MIN,
  DAEMON_PORT_MAX,
  PREFERRED_PORT_RECLAIM_MS,
} from '../daemon-port.js';
import { loadDaemonSettings, updateDaemonSetting, ownSettingsPath } from '../daemon-settings.js';
import { portExhaustionMessage, DAEMON_DEFAULT_PORT } from '../session-registry.js';

describe('daemon port — validation', () => {
  it('accepts only integers inside the bindable range', () => {
    expect(isValidDaemonPort(9120)).toBe(true);
    expect(isValidDaemonPort(DAEMON_PORT_MIN)).toBe(true);
    expect(isValidDaemonPort(DAEMON_PORT_MAX)).toBe(true);
    expect(isValidDaemonPort(DAEMON_PORT_MIN - 1)).toBe(false);
    expect(isValidDaemonPort(DAEMON_PORT_MAX + 1)).toBe(false);
    expect(isValidDaemonPort(9120.5)).toBe(false);
    expect(isValidDaemonPort('9120')).toBe(false);
    expect(isValidDaemonPort(null)).toBe(false);
  });

  it('rejects text that parseInt would silently truncate', () => {
    // `parseInt('9120abc')` is 9120 — a typo that would bind a port the user
    // never typed. The whole string has to be digits.
    expect(parseDaemonPort('9120abc')).toBeNull();
    expect(parseDaemonPort('0x2398')).toBeNull();
    expect(parseDaemonPort('91 20')).toBeNull();
    expect(parseDaemonPort('')).toBeNull();
    expect(parseDaemonPort(undefined)).toBeNull();
    expect(parseDaemonPort(' 9200 ')).toBe(9200);
  });
});

describe('daemon port — precedence', () => {
  const noEnv: NodeJS.ProcessEnv = {};

  it('falls back to the documented default when nothing is set', () => {
    expect(resolveDaemonPort({ env: noEnv, settings: {} }))
      .toEqual({ port: DAEMON_DEFAULT_PORT, source: 'default' });
  });

  it('orders flag › env › settings › default', () => {
    const env = { [DAEMON_PORT_ENV_VAR]: '9300' };
    const settings = { [DAEMON_PORT_SETTING_KEY]: 9400 };

    expect(resolveDaemonPort({ flag: '9200', env, settings }))
      .toEqual({ port: 9200, source: 'flag' });
    expect(resolveDaemonPort({ env, settings }))
      .toEqual({ port: 9300, source: 'env' });
    expect(resolveDaemonPort({ env: noEnv, settings }))
      .toEqual({ port: 9400, source: 'settings' });
    expect(resolveDaemonPort({ env: noEnv, settings: {} }))
      .toEqual({ port: DAEMON_DEFAULT_PORT, source: 'default' });
  });

  it('reads a persisted port stored as a string (hand-edited settings.json)', () => {
    expect(preferredDaemonPortFrom({ [DAEMON_PORT_SETTING_KEY]: '9200' })).toBe(9200);
  });

  it('ignores an unusable persisted port instead of refusing to start', () => {
    // Lenient reader, strict setter: a malformed stored value must fall
    // through to the default rather than stop the daemon from coming up.
    for (const bad of [0, 80, 70000, -1, 9120.5, true, null, {}, [], 'nine thousand']) {
      expect(preferredDaemonPortFrom({ [DAEMON_PORT_SETTING_KEY]: bad }), String(bad))
        .toBeNull();
      expect(resolveDaemonPort({ env: noEnv, settings: { [DAEMON_PORT_SETTING_KEY]: bad } }).port)
        .toBe(DAEMON_DEFAULT_PORT);
    }
  });

  it('ignores a malformed env override the same way', () => {
    expect(resolveDaemonPort({ env: { [DAEMON_PORT_ENV_VAR]: 'nope' }, settings: {} }))
      .toEqual({ port: DAEMON_DEFAULT_PORT, source: 'default' });
    // …and lets the persisted value win over a malformed env var, rather than
    // letting the broken higher-precedence source shadow a good lower one.
    expect(resolveDaemonPort({
      env: { [DAEMON_PORT_ENV_VAR]: 'nope' },
      settings: { [DAEMON_PORT_SETTING_KEY]: 9400 },
    })).toEqual({ port: 9400, source: 'settings' });
  });

  it('names every source', () => {
    for (const source of ['flag', 'env', 'settings', 'default'] as const) {
      expect(describeDaemonPortSource(source)).toBeTruthy();
    }
  });

  it('waits long enough to outlast the measured kernel port reservation', () => {
    // macOS holds a NECP reservation ~14s after a listener is cancelled
    // (bindable at ~17s, measured 2026-08-06). A budget below that turns
    // "the port is coming back" into a permanent move to a fallback port.
    expect(PREFERRED_PORT_RECLAIM_MS).toBeGreaterThan(17_000);
  });
});

describe('daemon port — persistence round trip', () => {
  let dir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    prevDataDir = process.env.AGENTDECK_DATA_DIR;
    dir = mkdtempSync(join(tmpdir(), 'agentdeck-port-'));
    process.env.AGENTDECK_DATA_DIR = dir;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.AGENTDECK_DATA_DIR;
    else process.env.AGENTDECK_DATA_DIR = prevDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists, reads back, and clears', () => {
    expect(preferredDaemonPortFrom(loadDaemonSettings())).toBeNull();

    updateDaemonSetting(DAEMON_PORT_SETTING_KEY, 9200);
    expect(preferredDaemonPortFrom(loadDaemonSettings())).toBe(9200);
    expect(ownSettingsPath()).toBe(join(dir, 'settings.json'));

    updateDaemonSetting(DAEMON_PORT_SETTING_KEY, undefined);
    // Cleared must be indistinguishable from never-set — a stored null would
    // make every reader carry a third case.
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'));
    expect(DAEMON_PORT_SETTING_KEY in raw).toBe(false);
    expect(preferredDaemonPortFrom(loadDaemonSettings())).toBeNull();
  });

  it('preserves unrelated settings when writing', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      wakeWord: true,
      pixooDevices: [{ ip: '192.168.0.9' }],
    }), 'utf-8');

    updateDaemonSetting(DAEMON_PORT_SETTING_KEY, 9200);

    const after = loadDaemonSettings();
    expect(after.wakeWord).toBe(true);
    expect(after.pixooDevices).toEqual([{ ip: '192.168.0.9' }]);
    expect(after[DAEMON_PORT_SETTING_KEY]).toBe(9200);
  });

  it('writes over a malformed settings.json rather than refusing', () => {
    writeFileSync(join(dir, 'settings.json'), '{ not json', 'utf-8');
    updateDaemonSetting(DAEMON_PORT_SETTING_KEY, 9200);
    expect(preferredDaemonPortFrom(loadDaemonSettings())).toBe(9200);
  });

  it('never records the port the daemon actually landed on', () => {
    // The invariant the module exists for: only the user writes this value.
    // If startup wrote its outcome here, a 14-second kernel hold would become
    // a permanent move to the fallback port.
    const source = readFileSync(
      new URL('../daemon-server.ts', import.meta.url),
      'utf-8',
    );
    expect(source).not.toMatch(/updateDaemonSetting/);
  });
});

describe('port window exhaustion message', () => {
  it('separates ports this install owns from ports it cannot see into', () => {
    const msg = portExhaustionMessage(9120, 9139, 3, 17);
    expect(msg).toContain("3 held by this install's own sessions");
    expect(msg).toContain('17 by processes outside its registry');
    expect(msg).toContain('Stop an existing session');
    expect(msg).toContain('AGENTDECK_PORT_WINDOW=9140-9159');
  });

  it('does not tell a user to stop sessions they do not have', () => {
    // The shared-box case: every port in the window belongs to another OS
    // user, so "Stop an existing session first" is advice that cannot work.
    const msg = portExhaustionMessage(9120, 9139, 0, 20);
    expect(msg).not.toContain('Stop an existing session');
    expect(msg).toContain('Nothing here can free those ports');
    expect(msg).toContain('AGENTDECK_PORT_WINDOW');
  });
});
