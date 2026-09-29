import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let dir: string;
vi.mock('../session-registry.js', () => ({ getDataDir: () => dir, getCandidateDataDirs: () => [dir] }));
import { dashboardProviders, DASHBOARD_PROVIDER_IDS } from '../dashboard-providers.js';
describe('stable dashboard provider membership', () => {
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'provider-display-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  it('initializes once and preserves the list through a cold read and absent telemetry', () => {
    expect(dashboardProviders()).toBeNull();
    expect(dashboardProviders({ providers: ['codex', 'claude'], initialize: true })).toEqual(['claude', 'codex']);
    expect(dashboardProviders({ providers: [], initialize: true })).toEqual(['claude', 'codex']);
    expect(dashboardProviders()).toEqual(['claude', 'codex']);
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).dashboardProviders).toEqual(['claude', 'codex']);
  });
  it('explicit hiding survives re-registration and preserves unrelated settings', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ daemonPort: 9200 }));
    dashboardProviders({ providers: ['codex'] });
    expect(dashboardProviders({ providers: [] })).toEqual([]);
    expect(dashboardProviders({ providers: ['claude'], initialize: true })).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).daemonPort).toBe(9200);
  });
  it('rejects invalid membership without overwriting saved choices', () => {
    dashboardProviders({ providers: ['codex'] });
    for (const providers of [null, 'claude', ['unknown'], [3]]) expect(() => dashboardProviders({ providers })).toThrow(TypeError);
    expect(dashboardProviders()).toEqual(['codex']);
  });
  it('deduplicates and keeps stable order', () => {
    expect(dashboardProviders({ providers: [...DASHBOARD_PROVIDER_IDS].reverse().concat('codex') })).toEqual(DASHBOARD_PROVIDER_IDS);
  });
});
