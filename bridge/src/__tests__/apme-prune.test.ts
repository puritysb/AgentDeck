import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApmeStore } from '../apme/store.js';
import {
  buildPrunedPayload, isPrunedPayload, checkVacuumSpace, type VacuumSpaceProbe,
} from '../apme/payload-prune.js';
import { computeSignals } from '../apme/classifier.js';
import { runSampleScorers, TrajectoryQualityScorer } from '../apme/scorers/index.js';
import { buildTrajectoryLines } from '../apme/runner.js';
import type { SessionSample } from '@agentdeck/shared';

// #302 — apme.sqlite retention: steps.payload and tool sample_events.payload
// are reclaimed (row kept, payload replaced by a marker) for rows older than
// a cutoff. runs/tasks/turns/evals are untouched forever; ts=0 rows (age
// unknown) are never candidates; non-'tool' sample_events kinds are never
// touched even when old.

const DAY_MS = 86_400_000;

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-prune-'));
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

function seed(store: ApmeStore): { runId: string; taskId: string } {
  const runId = 'run-1';
  const taskId = 'task-1';
  store.insertRun({ id: runId, sessionId: 's1', agentType: 'claude-code', modelId: 'claude-opus-4-8', startedAt: 1000 });
  store.insertTask({ id: taskId, runId, taskIndex: 0, boundarySignal: 'open', startedAt: 1000 });
  return { runId, taskId };
}

describe('APME retention — payload pruning (#302)', () => {
  let store!: ApmeStore;
  const now = Date.now();
  const oldTs = now - 45 * DAY_MS;      // clearly older than a 30d cutoff
  const recentTs = now - 5 * DAY_MS;    // clearly newer than a 30d cutoff
  const cutoffMs = now - 30 * DAY_MS;

  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('previewPrune (dry run) reports rows/bytes without changing anything', () => {
    const { runId, taskId } = seed(store);
    const oldPayload = JSON.stringify({ command: 'npm test', big: 'x'.repeat(200) });
    store.insertStep({ runId, ts: oldTs, kind: 'PreToolUse', toolName: 'Bash', payload: oldPayload });
    store.insertStep({ runId, ts: recentTs, kind: 'PreToolUse', toolName: 'Bash', payload: JSON.stringify({ command: 'echo hi' }) });
    store.insertSampleEvent({
      taskId, runId, turnIndex: 0, seq: 0, ts: oldTs, kind: 'tool', toolName: 'Edit',
      toolStatus: 'success', payload: JSON.stringify({ input: { file_path: 'a.ts' }, output: 'ok' }), dedupKey: 't-old',
    });

    const preview = store.previewPrune(cutoffMs);
    expect(preview.steps.rows).toBe(1);
    expect(preview.steps.bytesBefore).toBe(oldPayload.length);
    expect(preview.steps.bytesAfter).toBeNull();
    expect(preview.sampleEvents.rows).toBe(1);
    expect(preview.sampleEvents.bytesBefore).toBeGreaterThan(0);

    // Dry run must not touch a single row.
    const steps = store.listSteps(runId);
    expect(steps.find(s => s.ts === oldTs)!.payload).toBe(oldPayload);
    expect(isPrunedPayload(steps.find(s => s.ts === oldTs)!.payload)).toBe(false);
    const sample = store.getSample(taskId)!;
    expect(sample.events[0]).toMatchObject({ kind: 'tool', name: 'Edit' });
    expect((sample.events[0] as { input?: unknown }).input).toEqual({ file_path: 'a.ts' });
  });

  it('applyPrune replaces payloads only for rows strictly older than the cutoff', () => {
    const { runId, taskId } = seed(store);
    const oldPayload = JSON.stringify({ command: 'npm test', big: 'x'.repeat(200) });
    const recentPayload = JSON.stringify({ command: 'echo hi' });
    store.insertStep({ runId, ts: oldTs, kind: 'PreToolUse', toolName: 'Bash', payload: oldPayload });
    store.insertStep({ runId, ts: recentTs, kind: 'PreToolUse', toolName: 'Bash', payload: recentPayload });
    store.insertSampleEvent({
      taskId, runId, turnIndex: 0, seq: 0, ts: oldTs, kind: 'tool', toolName: 'Edit',
      toolStatus: 'success', payload: JSON.stringify({ input: { file_path: 'old.ts' } }), dedupKey: 't-old',
    });
    store.insertSampleEvent({
      taskId, runId, turnIndex: 0, seq: 1, ts: recentTs, kind: 'tool', toolName: 'Edit',
      toolStatus: 'success', payload: JSON.stringify({ input: { file_path: 'new.ts' } }), dedupKey: 't-new',
    });

    const result = store.applyPrune(cutoffMs);
    expect(result.steps.rows).toBe(1);
    expect(result.sampleEvents.rows).toBe(1);
    expect(result.steps.bytesBefore).toBe(oldPayload.length);
    expect(result.steps.bytesAfter).toBeLessThan(result.steps.bytesBefore!);

    const steps = store.listSteps(runId);
    const oldStep = steps.find(s => s.ts === oldTs)!;
    const recentStep = steps.find(s => s.ts === recentTs)!;
    expect(isPrunedPayload(oldStep.payload)).toBe(true);
    expect(isPrunedPayload(recentStep.payload)).toBe(false);
    expect(recentStep.payload).toBe(recentPayload);

    const sample = store.getSample(taskId)!;
    const oldEvent = sample.events.find(e => e.ts === oldTs) as { pruned?: boolean; input?: unknown };
    const newEvent = sample.events.find(e => e.ts === recentTs) as { pruned?: boolean; input?: unknown };
    expect(oldEvent.pruned).toBe(true);
    expect(oldEvent.input).toBeUndefined();
    expect(newEvent.pruned).toBeUndefined();
    expect(newEvent.input).toEqual({ file_path: 'new.ts' });
  });

  it('never touches a row whose age is unknown (ts=0)', () => {
    const { runId, taskId } = seed(store);
    const payload = JSON.stringify({ command: 'npm test' });
    store.insertStep({ runId, ts: 0, kind: 'PreToolUse', toolName: 'Bash', payload });
    store.insertSampleEvent({
      taskId, runId, turnIndex: 0, seq: 0, ts: 0, kind: 'tool', toolName: 'Edit',
      toolStatus: 'success', payload: JSON.stringify({ input: { file_path: 'a.ts' } }), dedupKey: 't-zero',
    });

    const preview = store.previewPrune(cutoffMs);
    expect(preview.steps.rows).toBe(0);
    expect(preview.sampleEvents.rows).toBe(0);

    const result = store.applyPrune(cutoffMs);
    expect(result.steps.rows).toBe(0);
    expect(result.sampleEvents.rows).toBe(0);

    const steps = store.listSteps(runId);
    expect(steps[0].payload).toBe(payload);
    expect(isPrunedPayload(steps[0].payload)).toBe(false);
  });

  it('never touches sample_events kinds other than tool, even when old', () => {
    const { runId, taskId } = seed(store);
    store.insertSampleEvent({
      taskId, runId, turnIndex: 0, seq: 0, ts: oldTs, kind: 'user_message',
      payload: JSON.stringify({ text: 'fix the login bug' }), dedupKey: 'u-old',
    });
    store.insertSampleEvent({
      taskId, runId, turnIndex: 0, seq: 1, ts: oldTs, kind: 'assistant_message',
      payload: JSON.stringify({ text: 'done', responseKind: 'text' }), dedupKey: 'a-old',
    });

    const preview = store.previewPrune(cutoffMs);
    expect(preview.sampleEvents.rows).toBe(0);

    store.applyPrune(cutoffMs);
    const sample = store.getSample(taskId)!;
    expect(sample.events.find(e => e.kind === 'user_message')).toMatchObject({ text: 'fix the login bug' });
    expect(sample.events.find(e => e.kind === 'assistant_message')).toMatchObject({ text: 'done' });
  });

  it('never deletes rows and never touches runs/tasks/turns/evals', () => {
    const { runId, taskId } = seed(store);
    store.insertStep({ runId, ts: oldTs, kind: 'PreToolUse', toolName: 'Bash', payload: JSON.stringify({ command: 'npm test' }) });
    store.insertTurn({ id: 'turn-1', runId, taskId, turnIndex: 0, prompt: 'fix the bug', startedAt: oldTs });
    store.insertEvalForTask({
      id: 0, runId, taskId, layer: 'task_judge', metric: 'overall', score: 0.9,
      raw: null, rubricVer: 1, judgeModel: 'test', createdAt: oldTs,
    });

    const beforeRun = store.getRun(runId)!;
    const beforeTask = store.getTask(taskId)!;
    const beforeStepCount = store.listSteps(runId).length;

    store.applyPrune(cutoffMs);

    expect(store.getRun(runId)).toEqual(beforeRun);
    expect(store.getTask(taskId)).toEqual(beforeTask);
    expect(store.listSteps(runId).length).toBe(beforeStepCount); // row kept, not deleted
    expect(store.listTurns(runId).length).toBe(1);
    expect(store.listEvalsForTask(taskId).length).toBe(1);
  });

  it('is idempotent: a second apply over the same window reclaims nothing further', () => {
    const { runId } = seed(store);
    store.insertStep({ runId, ts: oldTs, kind: 'PreToolUse', toolName: 'Bash', payload: JSON.stringify({ command: 'npm test' }) });
    store.applyPrune(cutoffMs);
    const second = store.applyPrune(cutoffMs);
    expect(second.steps.rows).toBe(0);
    expect(second.sampleEvents.rows).toBe(0);
  });

  // ─── Reader tolerance ───────────────────────────────────────────────────

  it('classifier.computeSignals treats a pruned Bash step as no signal, not a crash', () => {
    const { runId } = seed(store);
    store.insertStep({ runId, ts: oldTs, kind: 'PreToolUse', toolName: 'Bash', payload: JSON.stringify({ command: 'pnpm test' }) });
    store.applyPrune(cutoffMs);

    expect(() => computeSignals(store, runId)).not.toThrow();
    const signals = computeSignals(store, runId);
    expect(signals.toolCounts.Bash).toBe(1); // tool_name column survives — unaffected by payload pruning
    expect(signals.testCommandsRun).toBe(0); // command text is gone — no false signal invented from the marker
  });

  it('a pruned tool call is read as "no content" by the judge trajectory renderer', () => {
    const sample: SessionSample = {
      id: 't1', runId: 'r1', sessionId: 's1', agentType: 'claude-code', index: 0,
      boundarySignal: 'open', startedAt: 0, endedAt: null,
      model: { modelId: 'claude-opus-4-8' }, projectName: null, projectPath: null,
      events: [
        { ts: 1, turnIndex: 0, kind: 'tool', name: 'Bash', status: 'success', pruned: true },
      ],
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 },
      summary: null, outcome: null, compositeScore: null, taskCategory: null,
    } as SessionSample;
    const lines = buildTrajectoryLines(sample);
    expect(lines[0]).toContain('pruned');
    expect(lines[0]).not.toMatch(/Bash\(\{/); // no fabricated input rendered
  });

  it('the trajectory-churn scorer does not count two pruned calls as a duplicate', () => {
    const base = { ts: 1, turnIndex: 0, kind: 'tool' as const, name: 'Read', status: 'success' as const };
    const sample: SessionSample = {
      id: 't1', runId: 'r1', sessionId: 's1', agentType: 'claude-code', index: 0,
      boundarySignal: 'open', startedAt: 0, endedAt: null,
      model: { modelId: 'claude-opus-4-8' }, projectName: null, projectPath: null,
      events: [
        { ...base, pruned: true },
        { ...base, pruned: true },
        { ...base, pruned: true },
      ],
      cost: { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 },
      summary: null, outcome: null, compositeScore: null, taskCategory: null,
    } as SessionSample;
    const results = runSampleScorers(sample, [TrajectoryQualityScorer]);
    const trajectory = results.find(r => r.metric === 'trajectory_quality')!;
    expect(trajectory.reasoning).toContain('0 consecutive repeats');
  });

  // ─── payload-prune.ts unit coverage ────────────────────────────────────

  it('buildPrunedPayload / isPrunedPayload round-trip, and reject real content', () => {
    const marker = buildPrunedPayload(1234, 999);
    expect(isPrunedPayload(marker)).toBe(true);
    const parsed = JSON.parse(marker);
    expect(parsed).toEqual({ pruned: true, prunedAt: 999, bytes: 1234 });

    expect(isPrunedPayload(null)).toBe(false);
    expect(isPrunedPayload(undefined)).toBe(false);
    expect(isPrunedPayload('')).toBe(false);
    expect(isPrunedPayload('not json')).toBe(false);
    expect(isPrunedPayload(JSON.stringify({ command: 'ls' }))).toBe(false);
    // A real payload that happens to contain the substring must not false-positive.
    expect(isPrunedPayload(JSON.stringify({ note: 'the previous run pruned nothing' }))).toBe(false);
  });

  it('vacuum() shrinks the on-disk file immediately, without requiring close() first', async () => {
    // WAL mode (this store's mode) does not fold VACUUM's rewrite back into
    // the main file until a checkpoint runs — measured: without an explicit
    // `wal_checkpoint(TRUNCATE)`, `statSync(dbPath)` right after `vacuum()`
    // read the PRE-vacuum size, and only close() (unavailable to a caller
    // still using the store) forced the shrink. This guards that fix.
    //
    // Close + reopen once the data is seeded, mirroring the real CLI: it
    // opens a store that already exists on disk (fully checkpointed by
    // whatever wrote it last), not a brand-new never-checkpointed file — a
    // fresh WAL file's main page never grows past its initial size until
    // SOME checkpoint runs, which would make a before/after comparison on
    // the untouched-since-creation file meaningless regardless of vacuum.
    const { runId } = seed(store);
    for (let i = 0; i < 30; i++) {
      store.insertStep({ runId, ts: oldTs + i, kind: 'PreToolUse', toolName: 'Bash', payload: JSON.stringify({ big: 'x'.repeat(5000) }) });
    }
    const dbPath = store.dbPath;
    const tmpDir = (store as unknown as { _tmpDir?: string })._tmpDir;
    store.close();
    store = new ApmeStore(dbPath);
    await store.init();
    (store as unknown as { _tmpDir?: string })._tmpDir = tmpDir;

    store.applyPrune(cutoffMs);
    const sizeBeforeVacuum = statSync(dbPath).size;
    store.vacuum();
    const sizeAfterVacuum = statSync(dbPath).size; // read while store is still open
    expect(sizeAfterVacuum).toBeLessThan(sizeBeforeVacuum);
  });

  it('checkVacuumSpace gates on 1.1x the file size, using the injected probe', () => {
    const probe: VacuumSpaceProbe = { statSize: () => 1000, statfsFreeBytes: () => 1099 };
    expect(checkVacuumSpace('/fake/db', probe).ok).toBe(false); // just under 1.1x
    const probeOk: VacuumSpaceProbe = { statSize: () => 1000, statfsFreeBytes: () => 1100 };
    expect(checkVacuumSpace('/fake/db', probeOk).ok).toBe(true);
  });
});
