import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApmeStore } from '../apme/store.js';
import { TASK_JUDGE_DRAIN_WINDOW_MS } from '../apme/runner.js';
import { judgeCoverage, type ApmeJudgeHealthRow } from '@agentdeck/shared';

const row = (o: Partial<ApmeJudgeHealthRow>): ApmeJudgeHealthRow =>
  ({ day: 'd', closed: 0, judged: 0, declined: 0, waiting: 0, agedOut: 0, ...o });

describe('judgeCoverage', () => {
  // The choice of denominator IS the instrument, so it is pinned rather than
  // left to whichever caller renders it.
  it('excludes declined rows — refusing to grade an empty task is the judge working', () => {
    expect(judgeCoverage(row({ judged: 3, declined: 97 }))).toEqual({ adjudicable: 3, ratio: 1 });
  });

  it('counts waiting AND aged-out against coverage — both are ungraded work', () => {
    expect(judgeCoverage(row({ judged: 1, waiting: 1 })).ratio).toBeCloseTo(0.5);
    expect(judgeCoverage(row({ judged: 1, agedOut: 3 })).ratio).toBeCloseTo(0.25);
  });

  it('reports null rather than 0% when there is nothing to adjudicate', () => {
    expect(judgeCoverage(row({ declined: 5 }))).toEqual({ adjudicable: 0, ratio: null });
  });
});

describe('ApmeStore.judgeHealth', () => {
  let dir: string;
  let store: ApmeStore;
  const day = (id: string, endedAt: number, extra: Record<string, unknown> = {}) => {
    store.insertRun({ id: `run-${id}`, sessionId: id, agentType: 'claude-code', startedAt: endedAt - 1000 });
    store.insertTask({ id, runId: `run-${id}`, taskIndex: 0, boundarySignal: 'manual', startedAt: endedAt - 1000 });
    store.updateTask(id, { endedAt, ...extra } as never);
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ad-judge-health-'));
    store = new ApmeStore(join(dir, 'apme.sqlite'));
    expect(await store.init()).toBe(true);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  it('sorts each task into exactly one bucket', () => {
    const now = Date.now();
    day('judged', now - 3600_000, { summary: 'did the thing' });
    day('declined', now - 3600_000, { notesJson: JSON.stringify({ notGradeable: 'no_reply' }) });
    day('waiting', now - 3600_000);
    const [r] = store.judgeHealth({ sinceMs: now - 86_400_000, agedCutoffMs: now - TASK_JUDGE_DRAIN_WINDOW_MS });
    expect(r).toMatchObject({ closed: 3, judged: 1, declined: 1, waiting: 1, agedOut: 0 });
    expect(r.judged + r.declined + r.waiting + r.agedOut).toBe(r.closed);
  });

  // The aged-out column exists because this boundary is otherwise invisible:
  // one millisecond decides whether the drain can ever offer the task again.
  it('splits waiting from aged out at the drain cutoff, not near it', () => {
    const now = Date.now();
    const cutoff = now - TASK_JUDGE_DRAIN_WINDOW_MS;
    day('inside', cutoff + 1);
    day('outside', cutoff - 1);
    const rows = store.judgeHealth({ sinceMs: 0, agedCutoffMs: cutoff });
    const total = rows.reduce((a, r) => ({
      waiting: a.waiting + r.waiting, agedOut: a.agedOut + r.agedOut,
    }), { waiting: 0, agedOut: 0 });
    expect(total).toEqual({ waiting: 1, agedOut: 1 });
  });

  it('never counts a declined task as aged out, however old it is', () => {
    const now = Date.now();
    day('ancient', now - 400 * 86_400_000, { notesJson: JSON.stringify({ notGradeable: 'no_reply' }) });
    const rows = store.judgeHealth({ sinceMs: 0, agedCutoffMs: now - TASK_JUDGE_DRAIN_WINDOW_MS });
    expect(rows.reduce((a, r) => a + r.agedOut, 0)).toBe(0);
    expect(rows.reduce((a, r) => a + r.declined, 0)).toBe(1);
  });

  it('reports no rows rather than throwing when nothing closed in the window', () => {
    expect(store.judgeHealth({ sinceMs: Date.now(), agedCutoffMs: 0 })).toEqual([]);
  });
});

describe('ApmeStore.judgeLatency', () => {
  let dir: string;
  let store: ApmeStore;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ad-judge-latency-'));
    store = new ApmeStore(join(dir, 'apme.sqlite'));
    expect(await store.init()).toBe(true);
  });
  afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

  const closedWithVerdict = (id: string, endedAt: number, latencyMs: number) => {
    store.insertRun({ id: `run-${id}`, sessionId: id, agentType: 'claude-code', startedAt: endedAt - 1000 });
    store.insertTask({ id, runId: `run-${id}`, taskIndex: 0, boundarySignal: 'manual', startedAt: endedAt - 1000 });
    store.updateTask(id, { endedAt } as never);
    store.insertEvalForTask({
      id: 0, runId: `run-${id}`, taskId: id, layer: 'task_judge', metric: 'overall',
      score: 0.8, raw: null, rubricVer: 1, judgeModel: 'test', createdAt: endedAt + latencyMs,
    });
  };

  // Percentiles, not a mean: one task backfilled weeks after it closed drags a
  // mean past every number a live turn ever produces.
  it('reports percentiles a single backfilled outlier cannot move', () => {
    const now = Date.now();
    for (let i = 0; i < 9; i++) closedWithVerdict(`fast-${i}`, now - 10_000, 10_000);
    closedWithVerdict('backfilled', now - 10_000, 30 * 86_400_000);
    const l = store.judgeLatency({ sinceMs: 0 });
    expect(l.n).toBe(10);
    expect(l.p50Ms).toBe(10_000);
    expect(l.maxMs).toBe(30 * 86_400_000);
  });

  it('reports nulls rather than NaN when nothing has been judged', () => {
    expect(store.judgeLatency({ sinceMs: 0 })).toEqual({ n: 0, p50Ms: null, p90Ms: null, maxMs: null });
  });
});
