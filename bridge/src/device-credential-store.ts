import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, openSync, fstatSync, readSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DEVICE_CREDENTIALS as P, deviceCredentialId, parseDeviceCredentialState, mergeDeviceCredentialState,
  type DeviceCredentialRecord, type DeviceCredentialState, type DeviceScope } from '@agentdeck/shared';
import { withCredentialLock } from './pairing-credential-store.js';

export class DeviceCredentialStore {
  constructor(readonly directory: string) {}

  /** Missing is distinct from corrupt/unreadable. Never recover from the legacy shared token. */
  snapshot(): DeviceCredentialState | null {
    let fd: number | undefined;
    try {
      fd = openSync(join(this.directory, P.file), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > P.maxBytes) throw new Error('invalid-device-credential-file');
      const buffer = Buffer.alloc(P.maxBytes + 1);
      let count = 0;
      while (count < buffer.length) {
        const n = readSync(fd, buffer, count, buffer.length - count, null);
        if (!n) break;
        count += n;
      }
      const bytes = buffer.subarray(0, count);
      if (bytes.length > P.maxBytes) throw new Error('device-credential-file-too-large');
      const state = parseDeviceCredentialState(JSON.parse(bytes.toString('utf8')));
      if (!state) throw new Error('invalid-device-credential-state');
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('device-credential-state-unavailable');
    } finally { if (fd !== undefined) closeSync(fd); }
  }

  private write(state: DeviceCredentialState): void {
    if (!parseDeviceCredentialState(state)) throw new Error('invalid-device-credential-state');
    const bytes = JSON.stringify(state) + '\n';
    if (Buffer.byteLength(bytes) > P.maxBytes) throw new Error('device-credential-file-too-large');
    const path = join(this.directory, P.file), tmp = `${path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(tmp, 'wx', 0o600); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(tmp, path);
    } catch (error) {
      // Preserve the original write failure even if cleanup is also denied.
      try { unlinkSync(tmp); } catch { /* owner-only temporary verifier file */ }
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** Called only after owner authorization or successful TLS pairing-window redemption. */
  issue(name: string, scopes: DeviceScope[], now = Date.now()): { token: string; device: DeviceCredentialRecord } {
    return withCredentialLock(this.directory, () => {
      const state = this.snapshot() ?? {version: 1 as const, authority: randomBytes(16).toString('hex'), revision: 0, devices: []};
      const id = randomBytes(16).toString('hex');
      const token = `${P.prefix}${id}.${randomBytes(32).toString('hex')}`;
      const device: DeviceCredentialRecord = {id, name, scopes: [...scopes], createdAt: now, revokedAt: null,
        verifier: createHash('sha256').update(token, 'ascii').digest('hex')};
      const next = parseDeviceCredentialState({...state, revision: state.revision + 1, devices: [...state.devices, device]});
      if (!next) throw new Error('invalid-device-credential-issuance');
      this.write(next);
      return {token, device: next.devices.find(d => d.id === id)!};
    });
  }

  /** Read current persisted state at every decision, including each outbound frame. */
  authenticate(token: unknown): DeviceCredentialRecord | null {
    const id = deviceCredentialId(token);
    if (!id) return null;
    const device = this.snapshot()?.devices.find(d => d.id === id);
    if (!device || device.revokedAt !== null) return null;
    const digest = createHash('sha256').update(token as string, 'ascii').digest();
    return timingSafeEqual(digest, Buffer.from(device.verifier, 'hex')) ? device : null;
  }

  revoke(id: string, now = Date.now()): boolean {
    return withCredentialLock(this.directory, () => {
      const state = this.snapshot();
      const device = state?.devices.find(d => d.id === id);
      if (!state || !device) return false;
      if (device.revokedAt !== null) return true;
      device.revokedAt = Math.max(now, device.createdAt);
      state.revision++;
      this.write(state);
      return true;
    });
  }

  /** Caller must establish same-user current-owner admission before custody transfer. */
  adopt(peer: unknown): void {
    const incoming = parseDeviceCredentialState(peer);
    if (!incoming) throw new Error('invalid-peer-device-state');
    withCredentialLock(this.directory, () => {
      const local = this.snapshot();
      this.write(local ? mergeDeviceCredentialState(local, incoming) : incoming);
    });
  }

  list(): Omit<DeviceCredentialRecord, 'verifier'>[] {
    return (this.snapshot()?.devices ?? []).map(({verifier: _verifier, ...metadata}) => metadata);
  }
}
