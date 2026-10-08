import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';
import type { CodexTurnCompletion } from '../codex-rollout-response.js';

/**
 * Daemon restart survival for the APME collector.
 *
 * The collector's state is in-memory maps and its idle-gap boundary is a
 * setTimeout, so a restart used to strand every run that was mid-session:
 * the next hook opened a fresh run, the old one waited two hours for the
 * abandoned-run reaper, its task came back `orphaned`, its open turn closed
 * with `tool_calls = 0`, and the Stop that did arrive was discarded for want
 * of a turn to close. Measured 2026-09-03 over 5.5 days: 60 of the 68 tasks
 * the reaper closed straddled a restart. These tests drive a SECOND collector
 * over the store the first one left behind — the restart, minus the process.
 */

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-rehydrate-'));
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

const IDLE_MS = 10_000;

function makeCollector(store: ApmeStore, probe?: (sid: string, since: number) => CodexTurnCompletion | null): ApmeCollector {
  return new ApmeCollector(store, undefined, undefined, IDLE_MS, probe ?? (() => null));
}

function prompt(c: ApmeCollector, sid: string, text: string) {
  c.ingestHook(sid, 'UserPromptSubmit', { prompt: text });
}

describe('collector rehydration after a restart', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); cleanup(store); });

  it('keeps distinct CI wait spans when a collector restarts during the same turn', () => {
    vi.setSystemTime(100_000);
    const first = makeCollector(store);
    const runId = first.openRun({ sessionId: 'ci-restart', agentType: 'claude-code' })!;
    prompt(first, 'ci-restart', 'watch CI');
    const start = { tool_name: 'Bash', tool_use_id: 'watch', tool_input: { command: 'gh run watch 12' } };
    vi.setSystemTime(101_000);
    first.ingestHook('ci-restart', 'PreToolUse', start);
    vi.setSystemTime(102_000);
    first.ingestHook('ci-restart', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'watch' });
    const second = makeCollector(store);
    second.rehydrateOpenRuns();
    vi.setSystemTime(103_000);
    second.ingestHook('ci-restart', 'PreToolUse', start);
    vi.setSystemTime(105_000);
    second.ingestHook('ci-restart', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'watch' });
    vi.setSystemTime(106_000);
    second.noteTurnStop('ci-restart');
    expect(JSON.parse(store.listTurns(runId)[0].efficiency_json as string)).toMatchObject({
      wall_time_ms: 6000, ci_wait_ms: 3000, agent_active_ms: 3000,
    });
  });

  it('the next prompt continues the SAME run and task instead of opening a fresh run', () => {
    const first = makeCollector(store);
    const runId = first.openRun({ sessionId: 's1', agentType: 'claude-code', projectName: 'demo' })!;
    prompt(first, 's1', 'refactor the auth module');
    first.noteTurnStop('s1');
    prompt(first, 's1', 'now add tests');
    first.noteTurnStop('s1');
    // — process dies here; nothing closes —

    const second = makeCollector(store);
    const r = second.rehydrateOpenRuns();
    expect(r.runs).toBe(1);
    expect(r.tasks).toBe(1);
    expect(r.turns).toBe(0);
    expect(r.armed).toBe(1);
    expect(second.getRunId('s1')).toBe(runId);
    expect(second.getActiveTaskId('s1')).toBe(first.getActiveTaskId('s1'));

    prompt(second, 's1', 'and update the docs');
    expect(store.listRuns({ limit: 10 })).toHaveLength(1);
    const turns = store.listTurns(runId);
    expect(turns.map((t) => t.turn_index)).toEqual([0, 1, 2]); // index kept monotonic
    expect(turns[2]!.task_id).toBe(first.getActiveTaskId('s1'));
  });

  it('re-arms the idle-gap timer for the REMAINDER of the gap, and closes the task as idle_gap', () => {
    const first = makeCollector(store);
    first.openRun({ sessionId: 's2', agentType: 'claude-code', projectName: 'demo' });
    prompt(first, 's2', 'do the thing');
    first.noteTurnStop('s2');
    const stoppedAt = Date.now();

    // Restart 4s into a 10s gap: the timer must fire 6s later, not 10s.
    vi.setSystemTime(stoppedAt + 4_000);
    const second = makeCollector(store);
    const closed: string[] = [];
    second.onTaskClosed = (a) => { closed.push(a.boundarySignal); };
    second.rehydrateOpenRuns();

    vi.advanceTimersByTime(5_900);
    expect(closed).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(closed).toEqual(['idle_gap']);
    const [task] = store.listAllTasks({ limit: 1 });
    expect(task!.boundarySignal).toBe('idle_gap');
    expect(task!.firstTurnIndex).toBe(0);
    expect(task!.lastTurnIndex).toBe(0);
  });

  it('a gap that fully elapsed during the downtime closes on the next tick', () => {
    const first = makeCollector(store);
    first.openRun({ sessionId: 's3', agentType: 'codex-cli', projectName: 'demo' });
    prompt(first, 's3', 'do the thing');
    first.noteTurnStop('s3');
    const stoppedAt = Date.now();

    vi.setSystemTime(stoppedAt + 3 * IDLE_MS);
    const second = makeCollector(store);
    const closed: string[] = [];
    second.onTaskClosed = (a) => { closed.push(a.boundarySignal); };
    second.rehydrateOpenRuns();
    vi.advanceTimersByTime(1);
    expect(closed).toEqual(['idle_gap']);
  });

  it('an open turn is resumed with its tool counters recovered, and its late Stop closes it as `stop`', () => {
    const first = makeCollector(store);
    const runId = first.openRun({ sessionId: 's4', agentType: 'claude-code', projectName: 'demo' })!;
    prompt(first, 's4', 'edit three files');
    first.ingestHook('s4', 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.ts' } });
    first.ingestHook('s4', 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'b.ts' } });
    first.ingestHook('s4', 'PreToolUse', { tool_name: 'Write', tool_input: { file_path: 'c.ts' } });
    first.ingestHook('s4', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test' } });
    // — restart mid-turn —

    const second = makeCollector(store);
    const r = second.rehydrateOpenRuns();
    expect(r.turns).toBe(1);
    expect(r.armed).toBe(0); // never arm under an open turn
    expect(second.getActiveTurnId('s4')).toBe(first.getActiveTurnId('s4'));

    second.noteTurnStop('s4'); // the Stop the old daemon never got
    const [turn] = store.listTurns(runId);
    expect(turn!.end_source).toBe('stop');
    expect(turn!.tool_calls).toBe(4);
    expect(turn!.files_modified).toBe(2);
    expect(turn!.files_created).toBe(1);
  });

  it('a codex turn whose rollout shows task_complete is closed as synthetic_stop with the reply', () => {
    const first = makeCollector(store);
    const runId = first.openRun({ sessionId: 'thread-9', agentType: 'codex-cli', projectName: 'demo' })!;
    prompt(first, 'thread-9', '진행하라');
    const openedAt = Date.now();
    // — restart; the Stop was posted to a dead port —

    const probe = vi.fn((sid: string, since: number): CodexTurnCompletion | null =>
      sid === 'thread-9' && since === openedAt ? { completedAt: openedAt + 5_000, text: '완료했습니다.' } : null);
    const second = makeCollector(store, probe);
    const r = second.rehydrateOpenRuns();
    expect(r.recovered).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
    const [turn] = store.listTurns(runId);
    expect(turn!.end_source).toBe('synthetic_stop');
    expect(turn!.response).toBe('완료했습니다.');
    expect(second.getActiveTurnId('thread-9')).toBeNull();
    // The idle gap now runs from the recovery, so the task still closes.
    const closed: string[] = [];
    second.onTaskClosed = (a) => { closed.push(a.boundarySignal); };
    vi.advanceTimersByTime(IDLE_MS + 1);
    expect(closed).toEqual(['idle_gap']);
  });

  it('a codex turn with no completion in its rollout stays open — no evidence is not a verdict', () => {
    const first = makeCollector(store);
    const runId = first.openRun({ sessionId: 'thread-10', agentType: 'codex-cli', projectName: 'demo' })!;
    prompt(first, 'thread-10', 'still running');

    const second = makeCollector(store, () => null);
    expect(second.rehydrateOpenRuns().recovered).toBe(0);
    expect(store.listTurns(runId)[0]!.ended_at).toBeNull();
    expect(second.getActiveTurnId('thread-10')).not.toBeNull();
  });

  it('a claude turn is never probed against a codex rollout', () => {
    const first = makeCollector(store);
    first.openRun({ sessionId: 'c-1', agentType: 'claude-code', projectName: 'demo' });
    prompt(first, 'c-1', 'open');
    const probe = vi.fn(() => ({ completedAt: Date.now(), text: 'x' }));
    const second = makeCollector(store, probe);
    second.rehydrateOpenRuns();
    expect(probe).not.toHaveBeenCalled();
  });

  it('two open runs under one session resolve to the newest; the older stays for the reaper', () => {
    const first = makeCollector(store);
    const older = first.openRun({ sessionId: 's5', agentType: 'claude-code', projectName: 'demo' })!;
    prompt(first, 's5', 'old work');
    // Simulate the pre-fix defect: a second collector opened a fresh run for
    // the same session while the first was still open in the store.
    const stray = makeCollector(store);
    const newer = stray.openRun({ sessionId: 's5', agentType: 'claude-code', projectName: 'demo' })!;
    prompt(stray, 's5', 'new work');

    const third = makeCollector(store);
    expect(third.rehydrateOpenRuns().runs).toBe(2); // both read; one mapping survives
    expect(third.getRunId('s5')).toBe(newer);
    expect(third.isLiveRun(older)).toBe(false); // reapable
    // Adoption is provisional: the newer run is owned in name only until its
    // session sends a hook, so a session that ended while the daemon was down
    // does not hold its run open forever.
    expect(third.isLiveRun(newer)).toBe(false);
    prompt(third, 's5', 'still here');
    expect(third.isLiveRun(newer)).toBe(true);
  });

  it('a claude turn open at startup that its transcript says ended is closed at the transcript time, with its reply', () => {
    // Two worker sessions whose final end_turn landed 75 minutes before a
    // restart were adopted with the turn open and stayed open 17 hours
    // (2026-09-03): no Stop was coming, no idle timer arms on an open turn,
    // and the reaper deferred to the adopting collector.
    const first = makeCollector(store);
    const runId = first.openRun({ sessionId: 'w-1', agentType: 'claude-code', projectName: 'demo', projectPath: '/tmp/demo' })!;
    prompt(first, 'w-1', 'derive the shard');
    const endedAt = Date.now() + 5_000;
    const claudeProbe = vi.fn((_sid: string, _path: string | null, _since: number) => ({ endedAt, source: 'synthetic_stop' as const, text: '샤드 완료 보고다.' }));
    const second = new ApmeCollector(store, undefined, undefined, IDLE_MS, () => null, claudeProbe);
    const r = second.rehydrateOpenRuns();
    expect(r.recovered).toBe(1);
    expect(claudeProbe).toHaveBeenCalledWith('w-1', '/tmp/demo', expect.any(Number));
    const turn = store.listTurns(runId)[0]!;
    expect(turn.end_source).toBe('synthetic_stop');
    expect(turn.ended_at).toBe(endedAt);
    expect(turn.response).toBe('샤드 완료 보고다.');
  });

  it('a claude turn whose transcript tail is still mid-turn stays open', () => {
    const first = makeCollector(store);
    const runId = first.openRun({ sessionId: 'w-2', agentType: 'claude-code', projectName: 'demo' })!;
    prompt(first, 'w-2', 'long task');
    const second = new ApmeCollector(store, undefined, undefined, IDLE_MS, () => null, () => null);
    expect(second.rehydrateOpenRuns().recovered).toBe(0);
    expect(store.listTurns(runId)[0]!.ended_at).toBeNull();
  });

  it('a codex turn whose rollout records a failure closes as aborted, not as a recovered Stop', () => {
    const first = makeCollector(store);
    const runId = first.openRun({ sessionId: 'x-1', agentType: 'codex-cli', projectName: 'demo' })!;
    prompt(first, 'x-1', 'glm 5.3 으로 업데이트');
    const completedAt = Date.now() + 14_000;
    const second = makeCollector(store, () => ({ completedAt, text: '', error: 'unexpected status 404 Not Found', errorKind: 'other' }));
    expect(second.rehydrateOpenRuns().recovered).toBe(1);
    const turn = store.listTurns(runId)[0]!;
    expect(turn.end_source).toBe('aborted');
    expect(turn.ended_at).toBe(completedAt);
  });

  it('releaseRun drops the adopted mapping so a later hook opens a fresh run', () => {
    const first = makeCollector(store);
    const older = first.openRun({ sessionId: 'r-1', agentType: 'claude-code', projectName: 'demo' })!;
    prompt(first, 'r-1', 'work');
    const second = makeCollector(store);
    second.rehydrateOpenRuns();
    expect(second.getRunId('r-1')).toBe(older);
    second.releaseRun(older);
    expect(second.getRunId('r-1')).toBeNull();
    expect(second.isLiveRun(older)).toBe(false);
  });

  it('a run opened live before rehydrate is not displaced by a stale store row', () => {
    const first = makeCollector(store);
    first.openRun({ sessionId: 's6', agentType: 'claude-code', projectName: 'demo' });
    prompt(first, 's6', 'stale');

    const second = makeCollector(store);
    const live = second.openRun({ sessionId: 's6', agentType: 'claude-code', projectName: 'demo' })!;
    second.rehydrateOpenRuns();
    expect(second.getRunId('s6')).toBe(live);
  });
});
