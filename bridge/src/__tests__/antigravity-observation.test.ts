import { describe, it, expect, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, utimesSync, chmodSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { ANTIGRAVITY_POLICY as P } from '../antigravity-policy.generated.js';
import { outputs } from '../../../scripts/generate-antigravity-observation.mjs';
import { observeAntigravityTranscript, scanAntigravityRoot } from '../antigravity-observation.js';
import { bindAntigravityOwners, collectAntigravitySessions, dedupeObservedSessions, PassiveSessionObserver } from '../passive-observer.js';

interface Vector { name: string; conversationId: string; raw: string; modifiedAtMs: number; nowMs: number }
const vectors = JSON.parse(readFileSync('shared/antigravity-observation-vectors.json', 'utf8')) as Vector[];
const observe = (v: Vector) => observeAntigravityTranscript(v.conversationId, v.raw, v.modifiedAtMs, v.nowMs);
function source(root: string, v: Vector) {
  const dir = join(root, 'brain', v.conversationId, '.system_generated', 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'transcript.jsonl'); writeFileSync(file, v.raw); utimesSync(file, v.modifiedAtMs / 1000, v.modifiedAtMs / 1000);
  return file;
}

interface FixtureDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...values: unknown[]): unknown };
  close(): void;
}
const Sqlite = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => FixtureDatabase;
function timestamp(ms: number) {
  const integer = (input: bigint) => { const out: number[] = []; do { const next = Number(input & 127n); input >>= 7n; out.push(next | (input ? 128 : 0)); } while (input); return Buffer.from(out); };
  const bytes = Buffer.concat([Buffer.from([8]), integer(BigInt(Math.floor(ms / 1000))), Buffer.from([16]), integer(BigInt(ms % 1000) * 1_000_000n + 123_000n)]);
  return Buffer.concat([Buffer.from([10, bytes.length]), bytes]);
}
function activity(root: string, v: Vector) {
  mkdirSync(join(root, 'conversations'), { recursive: true });
  const path = join(root, 'conversations', v.conversationId + '.db');
  const db = new Sqlite(path);
  db.exec('CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY,cascade_id TEXT,trajectory_type INTEGER,source INTEGER); CREATE TABLE steps (idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,metadata BLOB)');
  db.prepare('INSERT INTO trajectory_meta VALUES (?,?,4,17)').run('fixture-trajectory', v.conversationId);
  const user = JSON.parse(v.raw.split('\n')[0]);
  db.prepare('INSERT INTO steps VALUES (0,14,3,?)').run(timestamp(Date.parse(user.created_at)));
  db.prepare('INSERT INTO steps VALUES (2,15,8,?)').run(timestamp(v.nowMs));
  const stamp = () => { for (const suffix of ['', '-wal', '-shm']) { try { utimesSync(path + suffix, v.nowMs / 1000, v.nowMs / 1000); } catch { /* absent optional WAL */ } } };
  stamp();
  return { db, path, stamp };
}

describe('Antigravity evidence contract', () => {
  it.each([false, true])('publishes file evidence with an unknown process table (rejected=%s), expires its lease and refuses ambiguous PID ownership', async rejected => {
    const dir = mkdtempSync(join(tmpdir(), 'antigravity-lease-'));
    vi.useFakeTimers({ now: vectors[0].nowMs });
    try {
      source(dir, vectors[0]);
      const rows = await collectAntigravitySessions([dir], Date.now());
      bindAntigravityOwners(rows, [{ conversationId: vectors[0].conversationId, pid: 42 }]);
      expect(rows[0].pid).toBe(42);
      bindAntigravityOwners(rows, [{ conversationId: vectors[0].conversationId, pid: 42 }, { conversationId: vectors[0].conversationId, pid: 43 }]);
      expect(rows[0].pid).toBe(0);
      const observer = new PassiveSessionObserver(async () => { if (rejected) throw new Error('process probe unknown'); return []; }, undefined, undefined, async () => rows);
      observer.collect([]);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(observer.collect([])).toHaveLength(1);
      vi.advanceTimersByTime(11 * 60_000);
      expect(observer.collect([])).toHaveLength(0);
    } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('keeps the generated policy current', () => {
    for (const { path, expected } of outputs()) expect(readFileSync(path, 'utf8')).toBe(expected);
  });
  it('projects the explicit DB activity without changing the store and refuses unknown activity', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'antigravity-db-'));
    const v = vectors.find(v => v.name === 'duplicate-step-finish')!;
    source(dir, v);
    const fixture = activity(dir, v);
    try {
      const before = readFileSync(fixture.path);
      expect(scanAntigravityRoot(dir, v.nowMs).observations[0].state).toBe('processing');
      expect(readFileSync(fixture.path)).toEqual(before);
      expect((await collectAntigravitySessions([dir], v.nowMs))[0].state).toBe('processing');
      fixture.db.prepare('UPDATE steps SET status=3 WHERE idx=2').run(); fixture.stamp();
      expect(scanAntigravityRoot(dir, v.nowMs).observations[0].state).toBe('idle');
      fixture.db.prepare('UPDATE steps SET status=9 WHERE idx=2').run(); fixture.stamp();
      expect(scanAntigravityRoot(dir, v.nowMs).observations[0].status).toBe('unknown');
      expect(await collectAntigravitySessions([dir], v.nowMs)).toEqual([]);
    } finally { fixture.db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('uses stable conversation/turn identities and never invents completion for stale/unknown evidence', () => {
    const byName = Object.fromEntries(vectors.map(v => [v.name, observe(v)]));
    expect(byName['fresh-running'].state).toBe('processing');
    expect(byName['duplicate-step-finish'].state).toBe('idle');
    expect(byName['fresh-running'].currentTurnId).toBe(byName['duplicate-step-finish'].currentTurnId);
    expect(byName['new-turn'].currentTurnId).not.toBe(byName['fresh-running'].currentTurnId);
    expect(byName['rotation-reused-index'].currentTurnId).not.toBe(byName['fresh-running'].currentTurnId);
    expect(byName['historical-running-then-done'].state).toBe('idle');
    for (const name of ['unknown-step', 'missing-time', 'partial-tail', 'unsupported-id', 'no-user-identity', 'boolean-index-last']) {
      expect(byName[name].status, name).toBe('unknown'); expect(byName[name].state, name).toBeUndefined();
    }
    for (const name of ['stale-running', 'ancient-source-touched', 'old-file-mtime']) {
      expect(byName[name].status, name).toBe('stale'); expect(byName[name].state, name).toBeUndefined();
    }
  });
  it('scans explicit sources without a process, ignores unreadable/symlinked records and keeps timestamps stable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'antigravity-source-'));
    try {
      source(dir, vectors[0]);
      mkdirSync(join(dir, 'cache')); writeFileSync(join(dir, 'cache', 'last_conversations.json'), JSON.stringify({ '/work/project': vectors[0].conversationId }));
      const first = await collectAntigravitySessions([dir], vectors[0].nowMs);
      expect(first).toHaveLength(1); expect(first[0].pid).toBe(0); expect(first[0].projectName).toBe('project');
      expect((await collectAntigravitySessions([dir], vectors[0].nowMs + 1000))[0].startedAt).toBe(first[0].startedAt);
      expect(dedupeObservedSessions(first, [{ ...first[0], id: vectors[0].conversationId }], [])).toHaveLength(0);
      const outside = join(dir, 'outside.jsonl'); writeFileSync(outside, vectors[0].raw);
      const file = join(dir, 'brain', vectors[0].conversationId, '.system_generated', 'logs', 'transcript.jsonl'); rmSync(file); symlinkSync(outside, file);
      expect(scanAntigravityRoot(dir, vectors[0].nowMs).observations[0].status).toBe('unknown');
      expect(await collectAntigravitySessions([dir], vectors[0].nowMs)).toHaveLength(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it.skipIf(process.platform !== 'darwin')('executes the actual Swift parser and scoped reader against Node vectors and the same filesystem', () => {
    const dir = mkdtempSync(join(tmpdir(), 'antigravity-parity-'));
    try {
      const binary = join(dir, 'observer');
      execFileSync('swiftc', ['-module-cache-path', join(dir, 'modules'), '-parse-as-library',
        'apple/AgentDeck/Daemon/Session/AntigravityPolicy.generated.swift', 'apple/AgentDeck/Daemon/Session/AntigravityObservation.swift',
        'apple/AgentDeck/Daemon/Session/AntigravityActivity.swift',
        'apple/AgentDeck/Daemon/Session/AntigravitySourceReader.swift', 'bridge/src/__tests__/fixtures/antigravity-observation-main.swift', '-lsqlite3', '-o', binary], { timeout: 120000 });
      const native = JSON.parse(execFileSync(binary, { input: JSON.stringify(vectors), encoding: 'utf8', timeout: 15000 }));
      expect(native).toEqual(vectors.map(observe));
      source(dir, vectors[0]);
      const scan = JSON.parse(execFileSync(binary, [dir, String(vectors[0].nowMs)], { encoding: 'utf8', timeout: 15000 }));
      delete scan.projects;
      expect(scan).toEqual(scanAntigravityRoot(dir, vectors[0].nowMs));
      for (const hasNewUser of [true, false]) {
        const records = vectors[0].raw.trim().split('\n');
        const large = { ...vectors[0], raw: records[0] + '\n' + (JSON.stringify({ padding: 'x'.repeat(1000) }) + '\n').repeat(700)
          + (hasNewUser ? records[0] + '\n' : '') + records.at(-1) + '\n' };
        source(dir, large);
        const nativeScan = JSON.parse(execFileSync(binary, [dir, String(large.nowMs)], { encoding: 'utf8', timeout: 15000 }));
        delete nativeScan.projects;
        expect(nativeScan).toEqual(scanAntigravityRoot(dir, large.nowMs));
        expect(nativeScan.observations[0].status).toBe(hasNewUser ? 'known' : 'unknown');
      }
      for (const model of ['', 'fallback-model']) {
        const records = vectors[0].raw.trim().split('\n').map(line => JSON.parse(line));
        records[0].content = '<USER_REQUEST>Metadata fixture</USER_REQUEST>';
        source(dir, { ...vectors[0], raw: records.map(record => JSON.stringify(record)).join('\n') + '\n' });
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model }));
        const nativeScan = JSON.parse(execFileSync(binary, [dir, String(vectors[0].nowMs)], { encoding: 'utf8', timeout: 15000 }));
        delete nativeScan.projects;
        expect(nativeScan).toEqual(scanAntigravityRoot(dir, vectors[0].nowMs));
        expect(nativeScan.observations[0].model).toBe(model);
      }
      const v = vectors.find(v => v.name === 'duplicate-step-finish')!;
      source(dir, v);
      const fixture = activity(dir, v);
      const compare = (expected: string, reason?: string, now = v.nowMs) => {
        fixture.stamp();
        const node = scanAntigravityRoot(dir, now);
        const swift = JSON.parse(execFileSync(binary, [dir, String(now)], { encoding: 'utf8', timeout: 15000 }));
        delete swift.projects;
        expect(swift).toEqual(node);
        expect(node.observations[0].state ?? node.observations[0].status).toBe(expected);
        if (reason) expect(node.observations[0].reason).toBe(reason);
      };
      try {
        const initial = readFileSync(fixture.path);
        compare('processing', 'database_step_evidence');
        expect(readFileSync(fixture.path)).toEqual(initial);
        // An explicitly new DB step can revive an old identity, but touching
        // an old active step must not renew its age.
        const old = v.nowMs - P.rosterWindowMs - 60_000;
        const records = v.raw.trim().split('\n').map(line => JSON.parse(line));
        records[0].created_at = new Date(old).toISOString();
        for (const record of records.slice(1)) record.created_at = new Date(old + 1000).toISOString();
        source(dir, { ...v, raw: records.map(record => JSON.stringify(record)).join('\n') + '\n', modifiedAtMs: old + 1000 });
        fixture.db.prepare('UPDATE steps SET metadata=? WHERE idx=0').run(timestamp(old));
        compare('processing', 'database_step_evidence');
        fixture.db.prepare('UPDATE steps SET metadata=? WHERE idx=2').run(timestamp(old + 1000));
        compare('stale', 'unconfirmed_work');
        source(dir, v);
        fixture.db.prepare('UPDATE steps SET metadata=? WHERE idx=0').run(timestamp(Date.parse(JSON.parse(v.raw.split('\n')[0]).created_at)));
        fixture.db.prepare('UPDATE steps SET metadata=? WHERE idx=2').run(timestamp(v.nowMs));
        compare('processing', 'database_step_evidence');
        compare('stale', 'unconfirmed_work', v.nowMs + P.activeWindowMs + 1);
        fixture.db.prepare('UPDATE steps SET status=3 WHERE idx=2').run();
        compare('idle', 'database_step_evidence');
        fixture.db.prepare('UPDATE steps SET status=9 WHERE idx=2').run();
        compare('unknown', 'unknown_activity_status');
        fixture.db.prepare('UPDATE steps SET status=8 WHERE idx=2').run();
        fixture.db.prepare('UPDATE trajectory_meta SET cascade_id=?').run('other-conversation');
        compare('unknown', 'activity_identity_mismatch');
        fixture.db.prepare('UPDATE trajectory_meta SET cascade_id=?').run(v.conversationId + '\0wrong');
        compare('unknown', 'activity_identity_mismatch');
        fixture.db.prepare('UPDATE trajectory_meta SET cascade_id=?').run(v.conversationId);
        fixture.db.prepare('UPDATE steps SET metadata=? WHERE idx=0').run(timestamp(v.nowMs - 60_000));
        compare('unknown', 'activity_identity_mismatch');
        fixture.db.prepare('UPDATE steps SET metadata=? WHERE idx=0').run(timestamp(Date.parse(JSON.parse(v.raw.split('\n')[0]).created_at)));
        fixture.db.prepare('UPDATE steps SET metadata=? WHERE idx=2').run(Buffer.from([10, 100]));
        compare('unknown', 'unreadable_activity');
        fixture.db.prepare('UPDATE steps SET metadata=? WHERE idx=2').run(timestamp(v.nowMs + P.futureSkewMs + 1));
        compare('unknown', 'invalid_activity_time');
        fixture.db.prepare('UPDATE steps SET metadata=? WHERE idx=2').run(timestamp(v.nowMs));
        const blob = timestamp(v.nowMs).toString('hex');
        fixture.db.exec(`WITH RECURSIVE seq(x) AS (SELECT 3 UNION ALL SELECT x+1 FROM seq WHERE x<${P.activityStepWindow}) INSERT INTO steps SELECT x,15,3,X'${blob}' FROM seq; UPDATE steps SET status=8 WHERE idx=${P.activityStepWindow}`);
        compare('processing', 'database_step_evidence');
        fixture.db.prepare('INSERT INTO steps VALUES (?,15,8,?)').run(P.activityStepWindow + 1, timestamp(v.nowMs));
        compare('unknown', 'activity_identity_mismatch');
        fixture.db.exec('DELETE FROM steps WHERE idx>2');
        // Keep a real writer and uncheckpointed WAL open during both readers.
        fixture.db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
        fixture.db.prepare('UPDATE steps SET status=2 WHERE idx=2').run();
        compare('processing', 'database_step_evidence');
        fixture.db.prepare('UPDATE steps SET status=3 WHERE idx=2').run();
        compare('idle', 'database_step_evidence');
        renameSync(fixture.path + '-shm', fixture.path + '-shm-held');
        try {
          compare('unknown', 'unreadable_activity');
          expect(existsSync(fixture.path + '-shm')).toBe(false);
        } finally { renameSync(fixture.path + '-shm-held', fixture.path + '-shm'); }
        fixture.db.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; UPDATE steps SET status=2 WHERE idx=2');
        compare('unknown', 'unreadable_activity');
        fixture.db.exec('ROLLBACK');
        compare('idle', 'database_step_evidence');
        const wal = fixture.path + '-wal';
        symlinkSync(join(dir, 'settings.json'), wal);
        compare('unknown', 'unreadable_activity');
        rmSync(wal);
        fixture.db.exec('DROP TABLE steps; CREATE TABLE steps (idx TEXT,step_type INTEGER,status INTEGER,metadata BLOB)');
        compare('unknown', 'unsupported_activity_schema');
      } finally { fixture.db.close(); }
      // A closed WAL store has a WAL-format header but no sidecars. Read the
      // native path first so a Node reader cannot create SHM and mask failure.
      const coldRoot = join(dir, 'cold');
      source(coldRoot, v);
      const cold = activity(coldRoot, v);
      cold.db.exec('PRAGMA journal_mode=WAL');
      cold.db.prepare('UPDATE steps SET status=8 WHERE idx=2').run();
      cold.db.close(); cold.stamp();
      const bytes = readFileSync(cold.path);
      expect(bytes[18]).toBe(2);
      const folder = join(coldRoot, 'conversations');
      chmodSync(folder, 0o555);
      try {
        const swift = JSON.parse(execFileSync(binary, [coldRoot, String(v.nowMs)], { encoding: 'utf8', timeout: 15000 }));
        delete swift.projects;
        expect(swift.observations[0].state).toBe('processing');
        expect(swift).toEqual(scanAntigravityRoot(coldRoot, v.nowMs));
        expect(readFileSync(cold.path)).toEqual(bytes);
        expect(existsSync(cold.path + '-wal')).toBe(false);
        expect(existsSync(cold.path + '-shm')).toBe(false);
      } finally { chmodSync(folder, 0o755); }

    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 150000);
});
