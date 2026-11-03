import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const legacy = vi.hoisted(() => ({ home: `/tmp/agentdeck-settings-home-${process.pid}-${Date.now()}` }));
vi.mock('os', async original => ({ ...(await original<typeof import('os')>()), homedir: () => legacy.home }));
import { saveTimeboxDevices, loadTimeboxDevices, isTimeboxAutoDiscoverEnabled } from '../timebox/timebox-settings.js';
import { saveIDotMatrixDevices, loadIDotMatrixDevices, readIDotMatrixDevicesStrict, isIDotMatrixAutoDiscoverEnabled, loadIDotMatrixNamePrefixes } from '../idotmatrix/idotmatrix-settings.js';
const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); rmSync(legacy.home, { recursive: true, force: true }); });
const profile = () => { const dir = mkdtempSync(join(tmpdir(), 'agentdeck-device-profile-')); roots.push(dir); return dir; };
const settings = (dir: string) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));

describe('device settings active data directory', () => {
  it('keeps both device families and unrelated fields in the selected profile', () => {
    const dir = profile();
    vi.stubEnv('AGENTDECK_DATA_DIR', dir);
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ sentinel: 'retain', timeboxAutoDiscover: false, idotmatrixAutoDiscover: false, idotmatrixNamePrefixes: ['Panel'] }));
    saveTimeboxDevices([{ address: 'timebox-A' }]);
    saveIDotMatrixDevices([{ address: 'matrix-A' }]);
    expect(loadTimeboxDevices()).toMatchObject([{ address: 'timebox-A' }]);
    expect(loadIDotMatrixDevices()).toEqual([{ address: 'matrix-A' }]);
    expect(readIDotMatrixDevicesStrict()).toEqual([{ address: 'matrix-A' }]);
    expect(isTimeboxAutoDiscoverEnabled()).toBe(false);
    expect(isIDotMatrixAutoDiscoverEnabled()).toBe(false);
    expect(loadIDotMatrixNamePrefixes()).toEqual(['Panel']);
    expect(settings(dir)).toMatchObject({ sentinel: 'retain', timeboxDevices: [{ address: 'timebox-A' }], idotmatrixDevices: [{ address: 'matrix-A' }] });
    expect(existsSync(join(legacy.home, '.agentdeck', 'settings.json'))).toBe(false);
  });

  it('resolves the profile per operation without retaining the previous module-load path', () => {
    const a = profile(), b = profile();
    vi.stubEnv('AGENTDECK_DATA_DIR', a);
    saveTimeboxDevices([{ address: 'A' }]); saveIDotMatrixDevices([{ address: 'A' }]);
    vi.stubEnv('AGENTDECK_DATA_DIR', b);
    expect(loadTimeboxDevices()).toEqual([]); expect(readIDotMatrixDevicesStrict()).toEqual([]);
    saveTimeboxDevices([{ address: 'B' }]); saveIDotMatrixDevices([{ address: 'B' }]);
    vi.stubEnv('AGENTDECK_DATA_DIR', a);
    expect(loadTimeboxDevices()[0].address).toBe('A'); expect(loadIDotMatrixDevices()[0].address).toBe('A');
    expect(settings(b).timeboxDevices[0].address).toBe('B');
  });

  it('uses the canonical default directory when no override is present', () => {
    vi.stubEnv('AGENTDECK_DATA_DIR', undefined);
    mkdirSync(legacy.home, { recursive: true });
    saveTimeboxDevices([{ address: 'default' }]); saveIDotMatrixDevices([{ address: 'default' }]);
    expect(settings(join(legacy.home, '.agentdeck'))).toMatchObject({ timeboxDevices: [{ address: 'default' }], idotmatrixDevices: [{ address: 'default' }] });
  });
});
