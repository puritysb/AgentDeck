import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ApmeStore } from '../apme/store.js';

describe('APME background queues avoid payload table scans', () => {
  let dir: string;
  let store: ApmeStore;
  let db: Database.Database;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'apme-background-plan-'));
    store = new ApmeStore(join(dir, 'apme.sqlite'));
    expect(await store.init()).toBe(true);
    db = new Database(join(dir, 'apme.sqlite'));
    for (const [id, endedAt, category] of [
      ['old', 100, null], ['new', 200, null], ['empty', 300, '_empty'], ['open', null, null],
    ] as const) {
      store.insertRun({ id, sessionId: id, agentType: 'claude-code', startedAt: 1 });
      db.prepare('UPDATE runs SET ended_at=?, task_category=? WHERE id=?').run(endedAt, category, id);
    }
    for (const [id, response, outcome, startedAt] of [
      ['reply', 'done', null, 10], ['new-reply', 'done', null, 20],
      ['no-reply', null, null, 30], ['empty-reply', '', null, 40], ['judged', 'done', 'committed', 50],
    ] as const) {
      store.insertTurn({ id, runId: 'old', turnIndex: startedAt, startedAt });
      db.prepare('UPDATE turns SET response=?, outcome=? WHERE id=?').run(response, outcome, id);
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  });

  function planFor(call: () => unknown): string {
    const spy = vi.spyOn(Database.prototype, 'prepare');
    call();
    const sql = spy.mock.calls[0][0];
    spy.mockRestore();
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(5) as { detail: string }[])
      .map(row => row.detail).join('\n');
  }

  it('orders the closed-run queue from a covering index and still excludes open/empty runs', () => {
    expect(store.listUnevaluatedRuns(5).map(row => row.id)).toEqual(['new', 'old']);
    const plan = planFor(() => store.listUnevaluatedRuns(5));
    expect(plan).toContain('COVERING INDEX idx_runs_closed_queue');
    expect(plan).not.toContain('SCAN r');
    expect(plan).not.toContain('TEMP B-TREE');
    expect(planFor(() => store.listUnclassifiedRuns(5))).toContain('COVERING INDEX idx_runs_closed_queue');
  });

  it('reads only pending nonempty responses, ordered without sorting the full turns table', () => {
    expect(store.listTurnsNeedingOutcome(5).map(row => row.id)).toEqual(['new-reply', 'reply']);
    const plan = planFor(() => store.listTurnsNeedingOutcome(5));
    // SQLite does not label partial indexes COVERING even when the selected
    // columns live in the index; the index excludes all completed/empty rows.
    expect(plan).toContain('USING INDEX idx_turns_pending_outcome');
    expect(plan).not.toContain('TEMP B-TREE');
    store.updateTurn('new-reply', { outcome: 'committed' });
    expect(store.listTurnsNeedingOutcome(5).map(row => row.id)).toEqual(['reply']);
  });
});
