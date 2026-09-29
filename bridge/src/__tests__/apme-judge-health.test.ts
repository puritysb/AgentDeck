import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApmeStore } from '../apme/store.js';
import { TASK_JUDGE_DRAIN_WINDOW_MS } from '../apme/runner.js';
import { judgeCoverage, type ApmeJudgeHealthRow } from '@agentdeck/shared';
import { coverageText, duration, judgeHealthWindowStart, localDay } from '../cli.js';

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
  it('splits waiting from aged out AT the drain cutoff, not merely near it', () => {
    const now = Date.now();
    const cutoff = now - TASK_JUDGE_DRAIN_WINDOW_MS;
    day('inside', cutoff + 1);
    day('exact', cutoff);
    day('outside', cutoff - 1);
    const rows = store.judgeHealth({ sinceMs: 0, agedCutoffMs: cutoff });
    const total = rows.reduce((a, r) => ({
      closed: a.closed + r.closed, judged: a.judged + r.judged, declined: a.declined + r.declined,
      waiting: a.waiting + r.waiting, agedOut: a.agedOut + r.agedOut,
    }), { closed: 0, judged: 0, declined: 0, waiting: 0, agedOut: 0 });
    // The row sitting exactly on the boundary is the one a `>=`/`>` slip drops:
    // with `>` on waiting and `<` on aged out it lands in NEITHER bucket and
    // the partition silently stops summing to `closed`.
    expect(total.waiting).toBe(2);
    expect(total.agedOut).toBe(1);
    expect(total.judged + total.declined + total.waiting + total.agedOut).toBe(total.closed);
  });

  // The predicate this used to get wrong: only the task_rollup rubric asks for
  // a summary, so a task judged under a category or `general` rubric carries a
  // score and eval rows with a NULL summary. Reading that as unjudged printed
  // "nothing will judge this" about a task that already had a verdict.
  it('counts a scored task with no summary as judged', () => {
    const now = Date.now();
    day('scored-only', now - 3600_000, { compositeScore: 0.8 });
    const [r] = store.judgeHealth({ sinceMs: now - 86_400_000, agedCutoffMs: now - TASK_JUDGE_DRAIN_WINDOW_MS });
    expect(r).toMatchObject({ closed: 1, judged: 1, waiting: 0, agedOut: 0 });
  });

  // Mutation-verified gaps: both filters on the headline number, and the
  // layer/locale conditions the day grouping and the latency join depend on.
  it('excludes judged and declined tasks from the aged-out total', () => {
    const now = Date.now();
    const cutoff = now - TASK_JUDGE_DRAIN_WINDOW_MS;
    const old = cutoff - 86_400_000;
    day('old-judged', old, { compositeScore: 0.7 });
    day('old-declined', old, { notesJson: JSON.stringify({ notGradeable: 'no_reply' }) });
    day('old-unjudged', old);
    // Only the third is a lost verdict. Counting the other two would inflate
    // the number printed unconditionally as "never judged" by the whole
    // declined-and-old population, which on a real store is hundreds.
    expect(store.judgeAgedOutTotal({ agedCutoffMs: cutoff })).toBe(1);
  });

  it('groups days in LOCAL time, matching the window the CLI snaps', () => {
    // 00:30 local belongs to today; a UTC-grouped query would file it under
    // yesterday wherever the offset is positive, disagreeing with a sinceMs
    // that was snapped to local midnight.
    const local = new Date();
    local.setHours(0, 30, 0, 0);
    day('early', local.getTime());
    const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
    const rows = store.judgeHealth({ sinceMs: local.getTime() - 1000, agedCutoffMs: 0 });
    expect(rows.map((r) => r.day)).toContain(expected);
  });

  it('reports the aged-out total for the whole store, not the window', () => {
    const now = Date.now();
    const cutoff = now - TASK_JUDGE_DRAIN_WINDOW_MS;
    day('ancient', cutoff - 86_400_000);
    day('recent', now - 3600_000);
    // A window inside the drain's lookback cannot contain an aged-out row at
    // all — which is why the total is not derived from these rows.
    const windowed = store.judgeHealth({ sinceMs: now - 7 * 86_400_000, agedCutoffMs: cutoff });
    expect(windowed.reduce((a, r) => a + r.agedOut, 0)).toBe(0);
    expect(store.judgeAgedOutTotal({ agedCutoffMs: cutoff })).toBe(1);
  });

  it('never counts a declined task as aged out, however old it is', () => {
    const now = Date.now();
    day('ancient', now - 400 * 86_400_000, { notesJson: JSON.stringify({ notGradeable: 'no_reply' }) });
    const rows = store.judgeHealth({ sinceMs: 0, agedCutoffMs: now - TASK_JUDGE_DRAIN_WINDOW_MS });
    expect(rows.reduce((a, r) => a + r.agedOut, 0)).toBe(0);
    expect(rows.reduce((a, r) => a + r.declined, 0)).toBe(1);
  });

  // The drain and the instrument must answer "judged" the same way, or they
  // describe different systems. This is the shape the park-aware drain is blind
  // to: the judge SUCCEEDS on a scored-but-summaryless task, so nothing parks
  // it, `pickBacklogTasks` cannot skip it, and it owns the head of the
  // `ended_at DESC` query forever — the #289 starvation with no failure to
  // detect it by.
  it('does not re-offer a task that already has a verdict but no summary', () => {
    const now = Date.now();
    day('scored-only', now - 3600_000, { compositeScore: 0.8 });
    day('genuinely-unjudged', now - 7200_000);
    const offered = store.listTasksNeedingSummary(20, now - 86_400_000).map((t) => t.id);
    expect(offered).toEqual(['genuinely-unjudged']);
    // …and the instrument agrees, on the same predicate. Summed across rows,
    // not read from `[0]`: the rows are LOCAL day buckets, so two tasks an hour
    // apart straddle midnight and land in different buckets for part of every
    // day — which made this assertion fail only between 00:00 and 02:00 local.
    const rows = store.judgeHealth({ sinceMs: now - 86_400_000, agedCutoffMs: now - TASK_JUDGE_DRAIN_WINDOW_MS });
    const total = rows.reduce((a, r) => ({ judged: a.judged + r.judged, waiting: a.waiting + r.waiting }), { judged: 0, waiting: 0 });
    expect(total).toEqual({ judged: 1, waiting: 1 });
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
  // n=10 is the case `floor(q·n)` got wrong: it selects one rank too high, so
  // the p90 WAS the single outlier — precisely what the percentile is chosen to
  // resist, and what this test's name claims. Asserting p50 and max alone let
  // that pass.
  it('reports percentiles a single backfilled outlier cannot move', () => {
    const now = Date.now();
    for (let i = 0; i < 9; i++) closedWithVerdict(`fast-${i}`, now - 10_000, 10_000);
    closedWithVerdict('backfilled', now - 10_000, 30 * 86_400_000);
    const l = store.judgeLatency({ sinceMs: 0 });
    expect(l).toMatchObject({ n: 10, p50Ms: 10_000, p90Ms: 10_000, maxMs: 30 * 86_400_000 });
  });

  it('places p50 and p90 by nearest rank across sizes', () => {
    const now = Date.now();
    // 1..20 seconds: nearest-rank p50 is the 10th value, p90 the 18th.
    for (let i = 1; i <= 20; i++) closedWithVerdict(`t-${i}`, now - 60_000, i * 1000);
    const l = store.judgeLatency({ sinceMs: 0 });
    expect(l).toMatchObject({ n: 20, p50Ms: 10_000, p90Ms: 18_000, maxMs: 20_000 });
  });

  it('measures task_judge rows only, not every eval layer', () => {
    const now = Date.now();
    store.insertRun({ id: 'run-traj', sessionId: 'traj', agentType: 'claude-code', startedAt: now - 70_000 });
    store.insertTask({ id: 'traj', runId: 'run-traj', taskIndex: 0, boundarySignal: 'manual', startedAt: now - 70_000 });
    store.updateTask('traj', { endedAt: now - 60_000 } as never);
    // A trajectory scorer row is not a verdict. Counting it would redefine
    // "judged" as "has any eval row" and shift `n` away from the Judged column
    // it is printed beside.
    store.insertEvalForTask({
      id: 0, runId: 'run-traj', taskId: 'traj', layer: 'trajectory', metric: 'tool_churn',
      score: 0.5, raw: null, rubricVer: null, judgeModel: 'scorer:test', createdAt: now - 50_000,
    });
    expect(store.judgeLatency({ sinceMs: 0 }).n).toBe(0);
  });

  it('measures the FIRST verdict when a task carries several', () => {
    const now = Date.now();
    closedWithVerdict('multi', now - 60_000, 5_000);
    store.insertEvalForTask({
      id: 0, runId: 'run-multi', taskId: 'multi', layer: 'task_judge', metric: 'coherence',
      score: 0.5, raw: null, rubricVer: 1, judgeModel: 'test', createdAt: now - 60_000 + 900_000,
    });
    expect(store.judgeLatency({ sinceMs: 0 }).p50Ms).toBe(5_000);
  });

  // A close backdated past its own verdict is not a latency, but dropping it
  // silently leaves `n` disagreeing with the Judged column by a number nothing
  // reports.
  it('counts a verdict that predates the close instead of dropping it silently', () => {
    const now = Date.now();
    closedWithVerdict('backdated', now - 60_000, -30_000);
    closedWithVerdict('normal', now - 60_000, 4_000);
    const l = store.judgeLatency({ sinceMs: 0 });
    expect(l).toMatchObject({ n: 1, excluded: 1, p50Ms: 4_000 });
  });

  it('reports nulls rather than NaN when nothing has been judged', () => {
    expect(store.judgeLatency({ sinceMs: 0 })).toEqual({ n: 0, p50Ms: null, p90Ms: null, maxMs: null, excluded: 0 });
  });
});

// The CLI helpers round 2 changed on reasoning alone — a rounding rule removed,
// a seam re-floored, a snap made conditional — had no test to regress against.
describe('judge-health presentation', () => {
  it('never rounds coverage up to 100% while anything is unjudged', () => {
    expect(coverageText({ adjudicable: 471, ratio: 469 / 471 })).toBe('99% of 471');
    expect(coverageText({ adjudicable: 10_000, ratio: 9_999 / 10_000 })).toBe('99% of 10000');
    expect(coverageText({ adjudicable: 7, ratio: 1 })).toBe('100% of 7');
    expect(coverageText({ adjudicable: 0, ratio: null })).toBe('—');
  });

  // 90s printed `2m` and 90m printed `2h` when the demoted unit was rounded,
  // so the 1m and 1h bands did not exist and every seam overstated by a third.
  it('floors the demoted unit so no band is skipped', () => {
    expect(duration(0)).toBe('0s');
    expect(duration(59_400)).toBe('59s');
    expect(duration(90_000)).toBe('1m');
    expect(duration(3_599_000)).toBe('59m');
    expect(duration(5_400_000)).toBe('1h');
    expect(duration(47 * 3_600_000)).toBe('47h');
    expect(duration(48 * 3_600_000)).toBe('2d');
    expect(duration(null)).toBe('—');
  });

  it('snaps day-or-longer windows to a local midnight and leaves shorter ones alone', () => {
    const now = new Date(2026, 8, 7, 20, 5, 0).getTime();
    // A sub-day window is the one case where snapping would report more than
    // was asked for — 6h at 01:00 would reach back to yesterday's midnight.
    expect(judgeHealthWindowStart(6 * 3_600_000, now)).toBe(now - 6 * 3_600_000);
    const snapped = judgeHealthWindowStart(86_400_000, now);
    expect(new Date(snapped).getHours()).toBe(0);
    expect(new Date(snapped).getMinutes()).toBe(0);
    // Snapping may only move the start EARLIER, so a 23- or 25-hour local day
    // can never shorten the window below what was asked for.
    expect(snapped).toBeLessThanOrEqual(now - 86_400_000);
    expect(localDay(snapped)).toBe('2026-09-06');
  });
});
