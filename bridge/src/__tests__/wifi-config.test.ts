import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'agentdeck-wifi-home-'));
vi.mock('os', async (orig) => ({ ...(await orig<typeof import('os')>()), homedir: () => home }));
const logs: string[] = [];
vi.mock('../logger.js', () => ({ debug: () => {}, log: (...a: unknown[]) => { logs.push(a.join(' ')); } }));

describe('wifi-config follows the data dir', () => {
  let dataDir: string;
  beforeEach(() => {
    vi.resetModules();
    logs.length = 0;
    dataDir = mkdtempSync(join(tmpdir(), 'agentdeck-wifi-data-'));
    vi.stubEnv('AGENTDECK_DATA_DIR', dataDir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(join(home, '.agentdeck'), { recursive: true, force: true });
  });

  it('saves and loads under AGENTDECK_DATA_DIR', async () => {
    const { saveWifiConfig, loadWifiConfig, wifiConfigPath } = await import('../wifi-config.js');
    expect(wifiConfigPath()).toBe(join(dataDir, 'wifi-config.json'));
    saveWifiConfig({ ssid: 'Desk', password: 'pw-1', autoProvision: true });
    expect(JSON.parse(readFileSync(join(dataDir, 'wifi-config.json'), 'utf8')).ssid).toBe('Desk');
    if (process.platform !== 'win32') expect(statSync(join(dataDir, 'wifi-config.json')).mode & 0o777).toBe(0o600);
    expect(loadWifiConfig()).toEqual({ ssid: 'Desk', password: 'pw-1', autoProvision: true });
  });

  it('never loads the ~/.agentdeck copy under an override, and says once where it is', async () => {
    mkdirSync(join(home, '.agentdeck'), { recursive: true });
    writeFileSync(join(home, '.agentdeck', 'wifi-config.json'), JSON.stringify({ ssid: 'Home', password: 'legacy-pw' }));
    const { loadWifiConfig } = await import('../wifi-config.js');
    expect(loadWifiConfig()).toBeNull();
    expect(loadWifiConfig()).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('~/.agentdeck');
    expect(logs[0]).not.toContain('legacy-pw');
  });

  it('uses ~/.agentdeck when no override is set', async () => {
    vi.stubEnv('AGENTDECK_DATA_DIR', '');
    const { wifiConfigPath } = await import('../wifi-config.js');
    expect(wifiConfigPath()).toBe(join(home, '.agentdeck', 'wifi-config.json'));
  });
});
