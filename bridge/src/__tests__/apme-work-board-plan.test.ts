/**
 * The Work board's page query must not walk the whole tool-event table once
 * per task.
 *
 * Measured 2026-09-10 on the maintainer's live store (2,142 tasks, 94,386
 * `kind='tool'` sample events): `listTaskPage({ order: 'attention' })` took
 * **137,802 ms** on the daemon's main thread — synchronous better-sqlite3, so
 * the event loop was gone for the duration — and the macOS app polls that
 * page every 15 s. `/health` stopped answering, the app read the daemon as
 * gone and promoted itself to a fallback port, stood down a minute later, and
 * did it again: three promotions in five minutes.
 *
 * The plan said why. The per-task `tool_count` subquery
 * (`COUNT(*) … WHERE se.task_id = t.id AND se.kind = 'tool'`) was being served
 * by `idx_sevents_kind_ts (kind=?)` — every tool row in the table, per task,
 * ~200 M row visits of multi-KB payload rows. That index had been added the
 * same day for the prune command's age scan (#302); before it existed the
 * planner had nothing better than `idx_sevents_task` and the query was fast.
 * An index added for one query changed another query's plan. With
 * `idx_sevents_task_kind (task_id, kind)` the subquery is a covering probe:
 * 257 ms for the same page.
 *
 * This pins the PLAN, not a timing: a timing test passes on a small fixture
 * whatever the plan, and the plan is the thing that regressed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { ApmeStore } from '../apme/store.js';

describe('Work board page query plan', () => {
  let dir: string;
  let store: ApmeStore;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'apme-plan-'));
    store = new ApmeStore(join(dir, 'apme.sqlite'));
    await store.init();
  });
  afterEach(() => {
    try { store.close?.(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the per-task tool count from a (task_id, kind) covering index, never from the kind index', () => {
    const db = new Database(join(dir, 'apme.sqlite'), { readonly: true });
    try {
      const plan = db.prepare(
        `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM sample_events se WHERE se.task_id = ? AND se.kind = 'tool'`,
      ).all('t1') as Array<{ detail: string }>;
      const details = plan.map((r) => r.detail).join('\n');
      expect(details).toContain('idx_sevents_task_kind');
      expect(details).toContain('COVERING INDEX');
      expect(details).not.toContain('idx_sevents_kind_ts');
    } finally {
      db.close();
    }
  });

  it('keeps the prune index — the fix is an additional index, not the removal of the #302 one', () => {
    const db = new Database(join(dir, 'apme.sqlite'), { readonly: true });
    try {
      const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sample_events'`).all() as Array<{ name: string }>)
        .map((r) => r.name);
      expect(names).toContain('idx_sevents_kind_ts');
      expect(names).toContain('idx_sevents_task_kind');
    } finally {
      db.close();
    }
  });
});
