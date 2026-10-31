import { createRequire } from 'node:module';
import { constants, openSync, closeSync, fstatSync, readSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ANTIGRAVITY_POLICY as P } from './antigravity-policy.generated.js';
import type { AntigravityObservation } from './antigravity-observation.js';

interface ReadonlyDatabase {
  prepare(sql: string): { all(...parameters: unknown[]): unknown[]; get(...parameters: unknown[]): unknown };
  pragma(sql: string): unknown;
  exec(sql: string): void;
  close(): void;
}
const require = createRequire(import.meta.url);
type DatabaseConstructor = new (path: string | Buffer, options: { readonly: boolean; fileMustExist: boolean; timeout: number }) => ReadonlyDatabase;

type Field = { number: number; value: bigint | Buffer | undefined };
function fields(bytes: Buffer): Field[] {
  let offset = 0;
  const read = () => {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw new Error('truncated_proto');
      const byte = bytes[offset++];
      if (i === 9 && byte > 1) throw new Error('oversize_varint');
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (byte < 128) return value;
    }
    throw new Error('oversize_varint');
  };
  const result: Field[] = [];
  while (offset < bytes.length) {
    if (result.length >= P.activityProtoFields) throw new Error('proto_field_limit');
    const tag = read(), number = Number(tag >> 3n), wire = Number(tag & 7n);
    if (number <= 0 || number >= 2 ** 29) throw new Error('invalid_proto');
    if (wire === 0) result.push({ number, value: read() });
    else {
      const size = wire === 2 ? Number(read()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (!Number.isSafeInteger(size) || size < 0 || size > bytes.length - offset) throw new Error('truncated_proto');
      result.push({ number, value: wire === 2 ? bytes.subarray(offset, offset + size) : undefined }); offset += size;
    }
  }
  return result;
}
export function antigravityStepCreatedAt(metadata: unknown): number {
  if (!Buffer.isBuffer(metadata) || metadata.length > P.activityMetadataBytes) throw new Error('invalid_metadata');
  const timestamps = fields(metadata).filter(f => f.number === P.activityCreatedAtField);
  if (timestamps.length !== 1 || !Buffer.isBuffer(timestamps[0].value)) throw new Error('invalid_timestamp');
  const timestamp = fields(timestamps[0].value);
  const seconds = timestamp.filter(f => f.number === 1), nanos = timestamp.filter(f => f.number === 2);
  if (seconds.length !== 1 || typeof seconds[0].value !== 'bigint' || nanos.length > 1 ||
      (nanos.length && typeof nanos[0].value !== 'bigint')) throw new Error('invalid_timestamp');
  const sec = seconds[0].value, ns = nanos.length ? nanos[0].value as bigint : 0n;
  const ms = sec * 1000n + ns / 1_000_000n;
  if (sec <= 0n || ns < 0n || ns >= 1_000_000_000n || ms > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('invalid_timestamp');
  return Number(ms);
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid_integer');
  return value;
}
function fileStamp(path: string, wal = false): number {
  const info = lstatSync(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe_source');
  if (wal && info.size <= BigInt(P.activityWalHeaderBytes)) return 0;
  return Number(info.mtimeNs / 1_000_000n);
}
function fingerprint(path: string): string {
  return ['', '-wal', '-shm', '-journal'].map(suffix => {
    try {
      const stat = lstatSync(path + suffix, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe_source');
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    } catch (e) { if (suffix && (e as NodeJS.ErrnoException).code === 'ENOENT') return '-'; throw e; }
  }).join('|');
}
function readFile(path: string, image: boolean): Buffer {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const info = fstatSync(fd, { bigint: true });
    if (!info.isFile() || info.size < 100n || (image && info.size > BigInt(P.activityColdMaxBytes))) throw new Error('invalid_store');
    const bytes = Buffer.alloc(image ? Number(info.size) : 100);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) throw new Error('short_read');
      offset += n;
    }
    return bytes;
  } finally { closeSync(fd); }
}
/** Metadata-only probe: an unknown result requires inspection, never a healthy fallback. */
export function antigravityActivityFreshness(root: string, id: string, now: number): 'recent' | 'historical' | 'unknown' {
  let modified = 0;
  for (const suffix of ['', '-wal']) {
    try { modified = Math.max(modified, fileStamp(join(root, 'conversations', id + '.db' + suffix), suffix === '-wal')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return 'unknown'; }
  }
  return modified && now - modified <= P.rosterWindowMs ? 'recent' : 'historical';
}
/** The DB is an optional explicit activity source. A present but unreadable or
 * mismatched DB must never fall back to a completed JSONL step as healthy idle. */
export function observeAntigravityActivity(
  root: string, base: AntigravityObservation, now: number,
  safePath: (components: string[], directory: boolean) => string,
): AntigravityObservation {
  if (base.status === 'unknown' || !base.currentTurnId) return base;
  const unknown = (reason = 'unreadable_activity'): AntigravityObservation => ({ ...base, status: 'unknown', reason, state: undefined });
  let db: ReadonlyDatabase | undefined;
  try {
    // lstat distinguishes an absent optional store from a broken symlink.
    try { lstatSync(join(root, 'conversations')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return base; throw e; }
    safePath(['conversations'], true);
    const name = base.conversationId + '.db';
    try { lstatSync(join(root, 'conversations', name)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return base; throw e; }
    const path = safePath(['conversations', name], false);
    let modified = fileStamp(path);
    let walFrames = false, journal = false, shm = false;
    for (const suffix of ['-wal', '-shm', '-journal']) {
      try {
        lstatSync(path + suffix);
        const companion = safePath(['conversations', name + suffix], false);
        const stamp = fileStamp(companion, suffix === '-wal');
        if (suffix === '-wal') walFrames = lstatSync(companion).size > P.activityWalHeaderBytes;
        if (suffix === '-journal') journal = true;
        if (suffix === '-shm') shm = true;
        // A reader can touch SHM; it is never an activity heartbeat.
        if (suffix === '-wal') modified = Math.max(modified, stamp);
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    if (walFrames && !shm) return unknown();
    const before = fingerprint(path);
    const header = !walFrames && !journal ? readFile(path, false) : undefined;
    const cold = header?.[18] === 2 && header[19] === 2;
    let input: string | Buffer = path;
    if (cold) {
      const image = readFile(path, true);
      // Deserialize cannot consume WAL-format headers. Only this private image
      // is normalized; logical pages and the source store remain unchanged.
      image[18] = 1; image[19] = 1;
      if (fingerprint(path) !== before) return unknown('activity_changed_during_read');
      input = image;
    }
    const Database = require('better-sqlite3') as DatabaseConstructor;
    db = new Database(input, { readonly: true, fileMustExist: true, timeout: P.activityBusyMs });
    db.pragma('query_only = ON'); db.pragma('trusted_schema = OFF');
    db.exec('BEGIN');
    const tables = db.prepare(P.activityTablesSQL).all() as Array<{ name: string; type: string }>;
    if (tables.length !== 2 || tables.some(t => t.type !== 'table')) return unknown('unsupported_activity_schema');
    const columns = db.prepare(P.activityColumnsSQL).all(P.activitySchemaColumns + 1) as Array<{ name: string; type: string; pk: number }>;
    if (columns.length > P.activitySchemaColumns || !['idx', 'step_type', 'status', 'metadata'].every(n => columns.some(c => c.name === n)) ||
        !['idx', 'step_type', 'status'].every(n => columns.some(c => c.name === n && c.type.toLowerCase() === 'integer')) ||
        !columns.some(c => c.name === 'metadata' && c.type.toLowerCase() === 'blob') || !columns.some(c => c.name === 'idx' && c.pk === 1)) return unknown('unsupported_activity_schema');
    const identity = db.prepare(P.activityTrajectorySQL).all() as Array<{ cascade_id: string }>;
    if (identity.length !== 1 || identity[0].cascade_id !== base.conversationId) return unknown('activity_identity_mismatch');
    const latest = db.prepare(P.activityLatestSQL).get(P.activityMetadataBytes) as Record<string, unknown> | undefined;
    if (!latest) return unknown('missing_activity_step');
    const step = integer(latest.idx), status = integer(latest.status);
    integer(latest.step_type);
    const user = db.prepare(P.activityUserSQL).get(P.activityMetadataBytes, Math.max(0, step - P.activityStepWindow), step, P.activityUserStepType) as Record<string, unknown> | undefined;
    const turn = base.turns.at(-1);
    if (!user || !turn || step < (base.latestStepIndex ?? Number.MAX_SAFE_INTEGER) || integer(user.idx) !== turn.stepIndex) return unknown('activity_identity_mismatch');
    const userTime = antigravityStepCreatedAt(user.metadata);
    const precision = turn.startedAtMs % P.activityTimestampPrecisionMs === 0 ? P.activityTimestampPrecisionMs : 1;
    if (Math.floor(userTime / precision) !== Math.floor(turn.startedAtMs / precision)) return unknown('activity_identity_mismatch');
    const updated = antigravityStepCreatedAt(latest.metadata);
    if (updated < userTime || updated > now + P.futureSkewMs || modified > now + P.futureSkewMs) return unknown('invalid_activity_time');
    const working = (P.activityWorkingStatuses as readonly number[]).includes(status);
    if (!working && !(P.activityIdleStatuses as readonly number[]).includes(status)) return unknown('unknown_activity_status');
    if (cold && fingerprint(path) !== before) return unknown('activity_changed_during_read');
    const out: AntigravityObservation = { ...base, status: 'known', reason: 'database_step_evidence', state: working ? 'processing' : 'idle', updatedAtMs: updated, modifiedAtMs: modified, latestStepIndex: step };
    const ttl = working ? P.activeWindowMs : P.rosterWindowMs;
    if (now - Math.min(updated, modified) > ttl) return { ...out, status: 'stale', reason: working ? 'unconfirmed_work' : 'history', state: undefined };
    return out;
  } catch { return unknown(); }
  finally { db?.close(); }
}
