/** Server-owned device authority. Surface registration is never an authority grant. */
export const DEVICE_CREDENTIALS = {
  version: 1, prefix: 'addev1.', file: 'device-credentials.json',
  maxDevices: 256, maxBytes: 131_072, maxNameBytes: 160,
  scopes: ['sessions.read', 'usage.read'],
} as const;
export type DeviceScope = typeof DEVICE_CREDENTIALS.scopes[number];
export interface DeviceCredentialRecord {
  id: string;
  name: string;
  verifier: string;
  scopes: DeviceScope[];
  createdAt: number;
  revokedAt: number | null;
}
export interface DeviceCredentialState {
  version: 1;
  authority: string;
  revision: number;
  devices: DeviceCredentialRecord[];
}
const hex32 = /^[a-f0-9]{32}$/;
const hex64 = /^[a-f0-9]{64}$/;
const integer = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;
const record = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Reserve the whole namespace, including malformed credentials, against legacy approval fallback. */
export function isDeviceCredential(raw: unknown): boolean {
  return typeof raw === 'string' && raw.startsWith(DEVICE_CREDENTIALS.prefix);
}
export function deviceCredentialId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return /^addev1\.([a-f0-9]{32})\.[a-f0-9]{64}$/.exec(raw)?.[1] ?? null;
}
export function parseDeviceCredentialState(raw: unknown): DeviceCredentialState | null {
  if (!record(raw) || raw.version !== 1 || typeof raw.authority !== 'string' || !hex32.test(raw.authority)
    || !integer(raw.revision) || !Array.isArray(raw.devices) || raw.devices.length > DEVICE_CREDENTIALS.maxDevices) return null;
  const ids = new Set<string>();
  const devices: DeviceCredentialRecord[] = [];
  for (const item of raw.devices) {
    if (!record(item) || typeof item.id !== 'string' || !hex32.test(item.id) || ids.has(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || new TextEncoder().encode(item.name).length > DEVICE_CREDENTIALS.maxNameBytes
      || /[\u0000-\u001f\u007f]/.test(item.name)
      || typeof item.verifier !== 'string' || !hex64.test(item.verifier)
      || !Array.isArray(item.scopes) || item.scopes.length === 0
      || !item.scopes.every(s => DEVICE_CREDENTIALS.scopes.some(known => known === s))
      || new Set(item.scopes).size !== item.scopes.length || !integer(item.createdAt)
      || (item.revokedAt !== null && (!integer(item.revokedAt) || item.revokedAt < item.createdAt))) return null;
    ids.add(item.id);
    devices.push({ id: item.id, name: item.name, verifier: item.verifier, scopes: [...item.scopes].sort() as DeviceScope[],
      createdAt: item.createdAt, revokedAt: item.revokedAt as number | null });
  }
  return {version: 1, authority: raw.authority, revision: raw.revision, devices: devices.sort((a, b) => a.id.localeCompare(b.id))};
}

/** Only an admitted current local owner can supply peer state. Never import from a device. */
export function mergeDeviceCredentialState(local: DeviceCredentialState, peer: DeviceCredentialState): DeviceCredentialState {
  const a = parseDeviceCredentialState(local), b = parseDeviceCredentialState(peer);
  if (!a || !b) throw new Error('invalid-device-credential-state');
  if (a.authority !== b.authority) {
    if (a.devices.length !== 0) throw new Error('conflicting-device-authority');
    return b;
  }
  const devices = new Map(a.devices.map(d => [d.id, d]));
  for (const incoming of b.devices) {
    const existing = devices.get(incoming.id);
    if (!existing) { devices.set(incoming.id, incoming); continue; }
    if (existing.verifier !== incoming.verifier || existing.createdAt !== incoming.createdAt
      || JSON.stringify(existing.scopes) !== JSON.stringify(incoming.scopes) || existing.name !== incoming.name) {
      throw new Error('conflicting-device-credential');
    }
    // A stale owner can never resurrect a revoked credential. Tombstones are retained.
    devices.set(incoming.id, {...existing, revokedAt: existing.revokedAt === null ? incoming.revokedAt
      : incoming.revokedAt === null ? existing.revokedAt : Math.max(existing.revokedAt, incoming.revokedAt)});
  }
  const merged = parseDeviceCredentialState({version: 1, authority: a.authority,
    revision: Math.max(a.revision, b.revision) + 1, devices: [...devices.values()]});
  if (!merged) throw new Error('device-credential-state-limit');
  return merged;
}

/** The secure listener has no legacy routes or command handlers. */
export function deviceHttpAllowed(method: string, target: string): boolean {
  return method === 'GET' && target === '/device/snapshot';
}
export function deviceMessageAllowed(value: unknown): boolean {
  if (!record(value) || value.type !== 'client_register' || value.clientType !== 'companion' || !record(value.surface)) return false;
  const surface = value.surface;
  return surface.protocol === 1 && Array.isArray(surface.profiles) && surface.profiles.length === 1
    && record(surface.profiles[0]) && surface.profiles[0].id === 'display-only/v1'
    && Array.isArray(surface.profiles[0].capabilities)
    && surface.profiles[0].capabilities.every(s => DEVICE_CREDENTIALS.scopes.some(known => known === s));
}
