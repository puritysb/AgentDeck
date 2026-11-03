import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { adoptPairingCredentials, rotatePairingCredentials, parsePairingCredentials, PAIRING_CREDENTIALS, type PairingCredentials } from '../pairing-credentials.js';
import vectors from '../../pairing-credential-vectors.json';
import { emitSwift, OUTPUT } from '../../../scripts/generate-pairing-credentials.mjs';

export function replayCredentialVector(vector: typeof vectors[number]) {
  try {
    const local = vector.local as PairingCredentials;
    if (vector.operation === 'rotate') return { kind: 'adopted', state: rotatePairingCredentials(local, vector.token, vector.eventId!, vector.minimumRevision!) };
    const result = adoptPairingCredentials(local, vector.token, vector.metadata);
    return result.kind === 'refused' ? { kind: 'refused' } : result;
  } catch { return { kind: 'refused' }; }
}
describe('pairing credential retirement policy', () => {
  for (const vector of vectors) it(vector.name, () => expect(replayCredentialVector(vector)).toEqual(vector.expected));
  it('matches generated Swift bytes', () => {
    expect(readFileSync(fileURLToPath(new URL('../../../' + OUTPUT, import.meta.url)), 'utf8')).toBe(emitSwift(PAIRING_CREDENTIALS));
  });
  it('rejects malformed authoritative states instead of reviving a legacy ring', () => {
    for (const value of [null, {}, [], { ...vectors[0].local, accepted: ['x'] }, { ...vectors[0].local, version: true }]) {
      expect(parsePairingCredentials(value)).toBeNull();
    }
  });
});
