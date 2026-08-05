import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';

// A daemon restart drops the in-memory session→run map that `closeRun` depends
// on, so every run that was mid-session is left with `ended_at` NULL forever.
// The pre-existing `listOrphanedRuns` only matches empty shells (no prompt, no
// turns), so those runs — which carry the actual work — were invisible to it,
// and because their TASK never closed they were never evaluated (the live store
// had accumulated 65 open tasks against 9 closed ones).

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-reaper-'));
  const store = new ApmeStore(join(dir, 'apme.sqlite'));
  const ok = await store.init();
  if (!ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('APME store failed to initialize — is better-sqlite3 installed?');
  }
  (store as unknown as { _tmpDir: string })._tmpDir = dir;
  return store;
}

function cleanup(store: ApmeStore) {
  store.close();
  const dir = (store as unknown as { _tmpDir?: string })._tmpDir;
  if (dir) rmSync(dir, { recursive: true, force: true });
}

const HOUR = 3_600_000;

/** A run left open mid-work, with `lastActivity` ms ago. */
function seedAbandoned(store: ApmeStore, id: string, agoMs: number): number {
  const lastActivity = Date.now() - agoMs;
  store.insertRun({ id, sessionId: `s-${id}`, agentType: 'claude-code', startedAt: lastActivity - 60_000, taskPrompt: 'do the thing' });
  store.insertTask({ id: `task-${id}`, runId: id, taskIndex: 0, boundarySignal: 'open', startedAt: lastActivity - 60_000 });
  store.insertTurn({ id: `turn-${id}`, runId: id, taskId: `task-${id}`, turnIndex: 3, prompt: 'do the thing', startedAt: lastActivity });
  return lastActivity;
}

describe('abandoned APME run reaper', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('finds runs with real work that the empty-shell reaper cannot see', () => {
    seedAbandoned(store, 'run-old', 3 * HOUR);
    // The exact shape listOrphanedRuns targets — must stay ITS job, not ours.
    store.insertRun({ id: 'run-shell', sessionId: 's-shell', agentType: 'claude-code', startedAt: Date.now() - 3 * HOUR });

    expect(store.listOrphanedRuns(1800)).toEqual(['run-shell']);
    expect(store.listAbandonedRuns(7200).map(r => r.id)).toEqual(['run-old']);
  });

  it('measures staleness from last activity, not started_at', () => {
    // Started 5h ago but a turn landed a minute ago: a live long session.
    store.insertRun({ id: 'run-live', sessionId: 's-live', agentType: 'claude-code', startedAt: Date.now() - 5 * HOUR, taskPrompt: 'p' });
    store.insertTask({ id: 'task-live', runId: 'run-live', taskIndex: 0, boundarySignal: 'open', startedAt: Date.now() - 5 * HOUR });
    store.insertTurn({ id: 'turn-live', runId: 'run-live', taskId: 'task-live', turnIndex: 0, prompt: 'p', startedAt: Date.now() - 60_000 });

    expect(store.listAbandonedRuns(7200)).toEqual([]);
  });

  it('counts steps and sample events as activity, not just turns', () => {
    const lastActivity = seedAbandoned(store, 'run-busy', 3 * HOUR);
    // Tool traffic 1 minute ago on a turn that opened 3h back.
    store.insertStep({ runId: 'run-busy', ts: Date.now() - 60_000, kind: 'PostToolUse', toolName: 'Edit', payload: '{}' });
    expect(store.listAbandonedRuns(7200)).toEqual([]);

    store.insertSampleEvent({
      taskId: 'task-run-busy', runId: 'run-busy', turnIndex: 3, seq: 0,
      ts: lastActivity, kind: 'tool', toolName: 'Read', toolStatus: 'success', dedupKey: 'k0',
    });
    // Still fresh — the newest event wins, not the oldest.
    expect(store.listAbandonedRuns(7200)).toEqual([]);
  });

  it('closes turns, tasks and the run at the last activity, not now', () => {
    const lastActivity = seedAbandoned(store, 'run-x', 3 * HOUR);

    const closed = store.reapAbandonedRun('run-x', lastActivity);
    expect(closed).toEqual([{ id: 'task-run-x', category: null }]);

    const run = store.getRun('run-x');
    expect(run?.endedAt).toBe(lastActivity);
    const task = store.getTask('task-run-x');
    expect(task?.endedAt).toBe(lastActivity);
    expect(task?.boundarySignal).toBe('orphaned');
    // Backfilled from the run's real turns so the task rollup has its range.
    expect(task?.firstTurnIndex).toBe(3);
    expect(task?.lastTurnIndex).toBe(3);
    const turn = store.getTurn('turn-run-x');
    expect(turn?.ended_at).toBe(lastActivity);
  });

  it('is idempotent and drops out of the candidate list once reaped', () => {
    const lastActivity = seedAbandoned(store, 'run-y', 3 * HOUR);
    store.reapAbandonedRun('run-y', lastActivity);

    expect(store.listAbandonedRuns(7200)).toEqual([]);
    // A second pass finds nothing left open, so it reports no tasks to judge —
    // the eval queue must not be handed the same task twice.
    expect(store.reapAbandonedRun('run-y', lastActivity + 999)).toEqual([]);
    expect(store.getRun('run-y')?.endedAt).toBe(lastActivity);
  });

  it('leaves reaped runs to the normal eval queue', () => {
    const lastActivity = seedAbandoned(store, 'run-z', 3 * HOUR);
    expect(store.listUnevaluatedRuns(10).map(r => r.id)).not.toContain('run-z');
    store.reapAbandonedRun('run-z', lastActivity);
    expect(store.listUnevaluatedRuns(10).map(r => r.id)).toContain('run-z');
  });

  it('reports a run the collector still owns as live', () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 'live-session', agentType: 'claude-code' });
    expect(runId).not.toBeNull();
    expect(collector.isLiveRun(runId!)).toBe(true);
    expect(collector.isLiveRun('some-other-run')).toBe(false);
    collector.closeRun('live-session');
    expect(collector.isLiveRun(runId!)).toBe(false);
  });
});
