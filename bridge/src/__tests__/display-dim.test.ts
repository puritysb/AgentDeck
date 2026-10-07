import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDisplayStateEvent, hostLocalHm, loadDisplayDimInstruction, normalizeDisplayDimInstruction } from '../display-dim.js';

const originalDataDir = process.env.AGENTDECK_DATA_DIR;

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.AGENTDECK_DATA_DIR;
  } else {
    process.env.AGENTDECK_DATA_DIR = originalDataDir;
  }
});

describe('display dim settings', () => {
  it('defaults to enabled full-off when settings are missing', () => {
    process.env.AGENTDECK_DATA_DIR = mkdtempSync(join(tmpdir(), 'agentdeck-display-dim-'));
    expect(loadDisplayDimInstruction()).toEqual({ enabled: true, mode: 'off', level: 10 });
  });

  it('normalizes minimum-brightness settings', () => {
    expect(normalizeDisplayDimInstruction({ enabled: false, mode: 'min', level: 250 })).toEqual({
      enabled: false,
      mode: 'min',
      level: 100,
    });
  });

  it('embeds the resolved dim instruction in display_state events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentdeck-display-dim-'));
    process.env.AGENTDECK_DATA_DIR = dir;
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({
      displaySleepDim: { enabled: true, mode: 'min', level: 25 },
    }));

    const at = new Date(2026, 9, 7, 9, 5, 59);
    expect(buildDisplayStateEvent(false, at)).toEqual({
      type: 'display_state',
      displayOn: false,
      dim: { enabled: true, mode: 'min', level: 25 },
      hostHm: '09:05',
    });
  });

  it('stamps host-local HH:MM, zero-padded, on every build', () => {
    expect(hostLocalHm(new Date(2026, 0, 1, 0, 0, 0))).toBe('00:00');
    expect(hostLocalHm(new Date(2026, 0, 1, 23, 59, 59))).toBe('23:59');
    // The default reads the clock at call time — each re-sync is fresh.
    expect(buildDisplayStateEvent(true).hostHm).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
  });
});
