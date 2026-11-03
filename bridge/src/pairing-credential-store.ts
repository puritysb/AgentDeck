import { readSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { debug } from './logger.js';
import { PAIRING_CREDENTIALS, parsePairingCredentials, type PairingCredentials } from '@agentdeck/shared';

/** The atomic state is authoritative once present. Corruption never falls back
 * to a legacy token/ring that may contain a retired credential. */
export function readCredentialState(dir: string): PairingCredentials | null {
  const path = join(dir, PAIRING_CREDENTIALS.file);
  let bytes: Buffer;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    bytes = Buffer.alloc(PAIRING_CREDENTIALS.maxBytes + 1);
    const count = readSync(fd, bytes, 0, bytes.length, null);
    bytes = bytes.subarray(0, count);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Pairing credential state could not be read; refusing legacy fallback');
  }
  finally { if (fd !== undefined) closeSync(fd); }
  if (bytes.length > PAIRING_CREDENTIALS.maxBytes) throw new Error('Pairing credential state is unreadable; refusing legacy fallback');
  let state: PairingCredentials | null;
  try { state = parsePairingCredentials(JSON.parse(bytes.toString('utf8'))); }
  catch { throw new Error('Pairing credential state is invalid; refusing legacy fallback'); }
  if (!state) throw new Error('Pairing credential state is invalid; refusing legacy fallback');
  return state;
}
interface CredentialLock { exec(sql: string): void; close(): void }
/** SQLite's OS lock is shared by Node and Swift and released on process death.
 * No credential is stored in this database. JSON remains the atomic authority. */
export function withCredentialLock<T>(dir: string, body: () => T): T {
  mkdirSync(dir, { recursive: true });
  const Database = createRequire(import.meta.url)('better-sqlite3') as new (file: string, options: {timeout: number}) => CredentialLock;
  const db = new Database(join(dir, PAIRING_CREDENTIALS.lockFile), {timeout: PAIRING_CREDENTIALS.timeoutMs});
  try {
    db.exec('BEGIN IMMEDIATE');
    try { return body(); } finally { db.exec('ROLLBACK'); }
  } finally { db.close(); }
}
export function mutateCredentialState(dir: string, fallback: PairingCredentials, transform: (current: PairingCredentials) => PairingCredentials): PairingCredentials {
  return withCredentialLock(dir, () => {
    const persisted = readCredentialState(dir);
    if (!persisted && fallback.revision > 0) throw new Error('Authoritative pairing state disappeared');
    const current = persisted ?? fallback;
    if (current.revision < fallback.revision || (current.revision === fallback.revision && current.revision > 0 &&
        (current.eventId !== fallback.eventId || current.token !== fallback.token))) throw new Error('Pairing state changed; read owner state before retrying');
    const state = transform(current);
    if (JSON.stringify(state) !== JSON.stringify(persisted)) writeUnlocked(dir, state);
    return state;
  });
}
export function writeCredentialState(dir: string, state: PairingCredentials): void {
  withCredentialLock(dir, () => {
    const current = readCredentialState(dir);
    if (current && (current.revision > state.revision || (current.revision === state.revision && state.revision > 0 &&
        (current.eventId !== state.eventId || current.token !== state.token)))) throw new Error('Pairing state changed; refusing stale write');
    writeUnlocked(dir, state);
  });
}
function writeUnlocked(dir: string, state: PairingCredentials): void {
  if (!parsePairingCredentials(state)) throw new Error('Invalid pairing credential state');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, PAIRING_CREDENTIALS.file);
  const temp = target + '.' + randomUUID() + '.tmp';
  let fd: number | undefined;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(state) + '\n');
    fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, target);
    // Compatibility mirrors are not authority for a corrected runtime.
    try {
      writeFileSync(join(dir, 'auth-token-accepted'), state.accepted.map(t => t + '\n').join(''), { mode: 0o600 });
      writeFileSync(join(dir, 'auth-token'), state.token + '\n', { mode: 0o600 });
    } catch { debug('auth', 'Legacy credential mirror could not be updated; atomic credential state remains authoritative'); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* renamed or never created */ }
  }
}
