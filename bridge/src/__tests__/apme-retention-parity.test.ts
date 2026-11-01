import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { outputs } from '../../../scripts/generate-apme-retention.mjs';
import { ApmeStore } from '../apme/store.js';

interface RawDB {
  prepare(sql: string): { run(...args: unknown[]): void; all(): unknown[] };
}
const vectors = JSON.parse(readFileSync('shared/apme-retention-vectors.json', 'utf8')) as {
  cutoffMs: number; prunedAt: number;
  rows: Array<{ table: string; label: string; ts: number; kind: string; payload: string | null }>;
};
const tables = ['runs', 'tasks', 'turns', 'evals', 'steps', 'sample_events'];
function snapshot(db: RawDB) { return Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()])); }
async function seed(path: string) {
  const store = new ApmeStore(path);
  expect(await store.init()).toBe(true);
  const db = (store as unknown as { db: RawDB }).db;
  db.prepare("INSERT INTO runs(id,session_id,agent_type,started_at) VALUES ('r','s','claude-code',1)").run();
  db.prepare("INSERT INTO tasks(id,run_id,task_index,boundary_signal,started_at) VALUES ('t','r',0,'open',1)").run();
  db.prepare("INSERT INTO turns(id,run_id,task_id,turn_index,prompt,response,started_at) VALUES ('u','r','t',0,'keep prompt','keep reply',1)").run();
  db.prepare("INSERT INTO evals(run_id,layer,metric,score,created_at) VALUES ('r','task_judge','overall',0.8,1)").run();
  let seq = 0;
  for (const row of vectors.rows) {
    if (row.table === 'steps') db.prepare('INSERT INTO steps(run_id,ts,kind,payload) VALUES (?,?,?,?)').run('r', row.ts, row.kind, row.payload);
    else db.prepare('INSERT INTO sample_events(task_id,run_id,turn_index,seq,ts,kind,payload,dedup_key) VALUES (?,?,?,?,?,?,?,?)').run('t', 'r', 0, seq++, row.ts, row.kind, row.payload, row.label);
  }
  return { store, db };
}

describe('APME retention shared policy', () => {
  it('keeps generated Node and Swift policy in sync', () => {
    for (const { path, expected } of outputs()) expect(readFileSync(path, 'utf8')).toBe(expected);
  });
  it.skipIf(process.platform !== 'darwin')('matches actual Swift SQLite preview, markers, metrics and preserved records including Unicode/NUL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'apme-retention-parity-'));
    let node: Awaited<ReturnType<typeof seed>> | undefined;
    let native: Awaited<ReturnType<typeof seed>> | undefined;
    try {
      const binary = join(dir, 'retention');
      execFileSync('swiftc', ['-module-cache-path', join(dir, 'module-cache'), '-parse-as-library',
        'apple/AgentDeck/Daemon/Apme/ApmeRetentionPolicy.generated.swift', 'apple/AgentDeck/Daemon/Apme/ApmeRetention.swift',
        'bridge/src/__tests__/fixtures/apme-retention-main.swift', '-o', binary], { timeout: 120_000 });
      node = await seed(join(dir, 'node.sqlite'));
      native = await seed(join(dir, 'swift.sqlite'));
      const before = snapshot(node.db);
      expect(snapshot(native.db)).toEqual(before);
      const preview = node.store.previewPrune(vectors.cutoffMs);
      expect(snapshot(node.db)).toEqual(before);
      const result = JSON.parse(execFileSync(binary, { input: JSON.stringify({ path: join(dir, 'swift.sqlite'), cutoffMs: vectors.cutoffMs, prunedAt: vectors.prunedAt }), encoding: 'utf8', timeout: 45_000 }));
      for (const table of ['steps', 'sampleEvents'] as const) {
        expect(result.preview[table]).toEqual(preview[table]);
      }
      const applied = node.store.applyPrune(vectors.cutoffMs, vectors.prunedAt);
      expect(result.applied.steps).toEqual(applied.steps);
      expect(result.applied.sampleEvents).toEqual(applied.sampleEvents);
      expect(snapshot(native.db)).toEqual(snapshot(node.db));
      for (const table of ['runs', 'tasks', 'turns', 'evals']) expect(snapshot(node.db)[table]).toEqual(before[table]);
      expect(node.store.previewPrune(vectors.cutoffMs).steps.rows).toBe(0);
    } finally {
      native?.store.close(); node?.store.close(); rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);
});
