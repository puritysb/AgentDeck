/** Pairing credential retirement SSOT. Replayed against the generated Swift core. */
export const PAIRING_CREDENTIALS = {
  rotationScope: 'active-owner', globalRevocation: 'incomplete',
  version: 1, file: 'auth-credentials.json', lockFile: 'auth-credentials.lock.sqlite', maxAccepted: 4,
  minTokenLength: 32, maxTokenLength: 512, maxRevision: 2_147_483_647,
  maxBytes: 8_192, timeoutMs: 4_000,
} as const;
export interface PairingRetirement { version: 1; revision: number; eventId: string }
export interface PairingCredentials extends PairingRetirement { token: string; accepted: string[] }
export function validPairingToken(raw: unknown): raw is string {
  return typeof raw === 'string' && raw.length >= PAIRING_CREDENTIALS.minTokenLength &&
    raw.length <= PAIRING_CREDENTIALS.maxTokenLength && /^[\x21-\x7e]+$/.test(raw);
}
export function parsePairingRetirement(raw: unknown): PairingRetirement | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== PAIRING_CREDENTIALS.version || typeof r.revision !== 'number' ||
      !Number.isInteger(r.revision) || r.revision < 0 || r.revision > PAIRING_CREDENTIALS.maxRevision ||
      typeof r.eventId !== 'string' || (r.revision === 0 ? r.eventId !== '' : !/^[a-f0-9]{32}$/.test(r.eventId))) return null;
  return { version: 1, revision: r.revision, eventId: r.eventId };
}
export function parsePairingCredentials(raw: unknown): PairingCredentials | null {
  const retirement = parsePairingRetirement(raw);
  if (!retirement) return null;
  const r = raw as Record<string, unknown>;
  if (!validPairingToken(r.token) || !Array.isArray(r.accepted) || r.accepted.length > PAIRING_CREDENTIALS.maxAccepted ||
      !r.accepted.every(validPairingToken) || r.accepted.includes(r.token) || new Set(r.accepted).size !== r.accepted.length ||
      (retirement.revision > 0 && r.accepted.length !== 0)) return null;
  return { ...retirement, token: r.token, accepted: [...r.accepted] };
}
export type PairingAdoption = { kind: 'unchanged' | 'adopted'; state: PairingCredentials } | { kind: 'refused'; reason: string };
export function adoptPairingCredentials(local: PairingCredentials, token: unknown, metadata?: unknown): PairingAdoption {
  if (!parsePairingCredentials(local)) return { kind: 'refused', reason: 'invalid-local-state' };
  if (!validPairingToken(token)) return { kind: 'refused', reason: 'invalid-peer-token' };
  const peer = metadata === undefined ? { version: 1 as const, revision: 0, eventId: '' } : parsePairingRetirement(metadata);
  if (!peer) return { kind: 'refused', reason: 'invalid-peer-retirement' };
  if (peer.revision < local.revision) return { kind: 'refused', reason: 'retired-peer-state' };
  if (peer.revision === local.revision && peer.revision > 0 && (peer.eventId !== local.eventId || token !== local.token)) {
    return { kind: 'refused', reason: 'conflicting-retirement' };
  }
  if (peer.revision === local.revision && token === local.token) return { kind: 'unchanged', state: local };
  const accepted = peer.revision > 0 ? [] : [local.token, ...local.accepted.filter(t => t !== local.token && t !== token)].slice(0, PAIRING_CREDENTIALS.maxAccepted);
  return { kind: 'adopted', state: { ...peer, token, accepted } };
}
export function rotatePairingCredentials(local: PairingCredentials, token: string, eventId: string, minimumRevision = 0): PairingCredentials {
  if (!parsePairingCredentials(local) || !Number.isInteger(minimumRevision) || minimumRevision < 0 || minimumRevision >= PAIRING_CREDENTIALS.maxRevision ||
      Math.max(local.revision, minimumRevision) >= PAIRING_CREDENTIALS.maxRevision || !validPairingToken(token) || token === local.token ||
      local.accepted.includes(token) || !/^[a-f0-9]{32}$/.test(eventId) || eventId === local.eventId) throw new Error('invalid-rotation');
  return { version: 1, revision: Math.max(local.revision, minimumRevision) + 1, eventId, token, accepted: [] };
}

/** Missing generation is the legacy, pre-retirement approval domain. */
export function pairingCredentialGeneration(state: PairingRetirement): string | undefined {
  return state.revision === 0 ? undefined : `${state.revision}:${state.eventId}`;
}
