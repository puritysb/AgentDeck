import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeviceCredentialStore } from '../device-credential-store.js';
import { DEVICE_CREDENTIALS, deviceHttpAllowed, deviceMessageAllowed, isDeviceCredential } from '@agentdeck/shared';

const directories: string[] = [];
function store() { const dir = mkdtempSync(join(tmpdir(), 'agentdeck-device-auth-')); directories.push(dir); return new DeviceCredentialStore(dir); }
afterEach(() => directories.splice(0).forEach(dir => rmSync(dir, {recursive: true, force: true})));
describe('device authority independent of legacy pairing', () => {
  it('persists a verifier, not the bearer secret, and reloads the same authority', () => {
    const s = store(); const {token, device} = s.issue('Vobot', ['sessions.read', 'usage.read']);
    const bytes = readFileSync(join(s.directory, DEVICE_CREDENTIALS.file), 'utf8');
    expect(bytes).not.toContain(token); expect(bytes).not.toContain(token.split('.')[2]);
    expect(new DeviceCredentialStore(s.directory).authenticate(token)?.id).toBe(device.id);
    expect(s.list()[0]).not.toHaveProperty('verifier');
  });
  it('rejects altered secrets and malformed reserved credentials', () => {
    const s = store(); const {token} = s.issue('Dock', ['sessions.read']);
    expect(s.authenticate(token.slice(0, -1) + (token.endsWith('0') ? '1' : '0'))).toBeNull();
    expect(s.authenticate('addev1.invalid')).toBeNull();
    expect(isDeviceCredential('addev1.invalid')).toBe(true);
  });
  it('revokes one credential without changing another or legacy files', () => {
    const s = store(); writeFileSync(join(s.directory, 'auth-token'), 'existing-legacy-token');
    const a = s.issue('First', ['sessions.read']); const b = s.issue('Second', ['usage.read']);
    expect(s.revoke(a.device.id)).toBe(true);
    expect(s.authenticate(a.token)).toBeNull(); expect(s.authenticate(b.token)).not.toBeNull();
    expect(readFileSync(join(s.directory, 'auth-token'), 'utf8')).toBe('existing-legacy-token');
  });
  it('never revives a revoked credential during stale-owner adoption', () => {
    const s = store(); const a = s.issue('Dock', ['sessions.read']); const stale = s.snapshot();
    s.revoke(a.device.id); s.adopt(stale);
    expect(new DeviceCredentialStore(s.directory).authenticate(a.token)).toBeNull();
  });
  it('carries revocation to a receiver that still holds old state', () => {
    const a = store(), b = store(); const issued = a.issue('Dock', ['sessions.read']);
    b.adopt(a.snapshot()); a.revoke(issued.device.id); b.adopt(a.snapshot());
    expect(b.authenticate(issued.token)).toBeNull();
  });
  it('refuses a conflicting verifier, scope or authority on handover', () => {
    const a = store(), b = store(); a.issue('Dock', ['sessions.read']); b.issue('Other', ['usage.read']);
    expect(() => a.adopt(b.snapshot())).toThrow('conflicting-device-authority');
    const state = a.snapshot()!; state.devices[0].scopes = ['usage.read'];
    expect(() => a.adopt(state)).toThrow('conflicting-device-credential');
  });
  it('fails closed on corrupt state instead of resurrecting a legacy credential', () => {
    const s = store(); const {token} = s.issue('Dock', ['sessions.read']);
    writeFileSync(join(s.directory, DEVICE_CREDENTIALS.file), '{broken');
    expect(() => s.authenticate(token)).toThrow('unavailable');
    expect(() => s.issue('Next', ['usage.read'])).toThrow('unavailable');
  });
  it('does not persist failed scope or identity validation', () => {
    const s = store();
    expect(() => s.issue('Dock', ['admin' as never])).toThrow();
    expect(() => s.issue('bad\nname', ['sessions.read'])).toThrow();
    expect(s.snapshot()).toBeNull();
  });
  it('uses the persisted latest state when two owners mutate the same store', () => {
    const a = store(), b = new DeviceCredentialStore(a.directory);
    const first = a.issue('First', ['sessions.read']); b.issue('Second', ['usage.read']); a.revoke(first.device.id);
    expect(b.list()).toHaveLength(2); expect(b.authenticate(first.token)).toBeNull();
  });
});
describe('read-only authority boundary', () => {
  it('does not admit legacy HTTP routes or query credentials', () => {
    expect(deviceHttpAllowed('GET', '/device/snapshot')).toBe(true);
    for (const path of ['/health', '/shutdown', '/hooks/Stop', '/pair/open', '/device/snapshot?token=x']) {
      expect(deviceHttpAllowed('GET', path)).toBe(false); expect(deviceHttpAllowed('POST', path)).toBe(false);
    }
  });
  it('cannot promote a device to a worker or steering surface by registering again', () => {
    const valid = {type: 'client_register', clientType: 'companion', surface: {protocol: 1,
      profiles: [{id: 'display-only/v1', capabilities: ['sessions.read']}]}};
    expect(deviceMessageAllowed(valid)).toBe(true);
    expect(deviceMessageAllowed({...valid, clientType: 'bridge'})).toBe(false);
    expect(deviceMessageAllowed({...valid, surface: {...valid.surface, profiles: [{id: 'companion-control/v1', capabilities: ['sessions.read']}]}})).toBe(false);
    for (const type of ['relay_hello', 'session_command', 'select_option', 'permission_decision', 'voice_start']) {
      expect(deviceMessageAllowed({type})).toBe(false);
    }
  });
});
