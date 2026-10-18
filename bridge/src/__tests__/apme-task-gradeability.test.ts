import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';
import { ApmeRunner } from '../apme/runner.js';
import type { ApmeConfig } from '../apme/settings.js';
import { taskGradeability, readNotGradeable, TRIVIAL_PROMPT_MAX_CHARS, type NotGradeableReason } from '../apme/task-gradeability.js';

/**
 * A verdict about the agent's work needs the agent's work. Measured before
 * this existed (2026-09-03, one week): 69 of 182 judged tasks held no agent
 * reply, a usage-limit abort was scored 0% on its abort notice, and `hello`
 * was scored as a failed planning task — all of which floated to the top of
 * the Work board's attention sort.
 */

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-grade-'));
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

const STUB_CONFIG: ApmeConfig = {
  enabled: true,
  deterministic: { enabled: false, timeoutSec: 30, commands: {} },
  judge: { backend: 'mlx', endpoint: 'http://stub', model: 'stub', alwaysRun: true, onDeterministicPass: false, minTurnsForJudge: 0 },
};

describe('taskGradeability', () => {
  const turn = (o: Partial<{ prompt: string; response: string | null; tool_calls: number; end_source: string }>) => ({
    prompt: 'do the thing', response: null, tool_calls: 0, end_source: 'stop', ...o,
  });

  it('a task with no agent reply and no real tool trajectory is not gradeable', () => {
    expect(taskGradeability([turn({}), turn({ tool_calls: 2 })])).toEqual({ gradeable: false, reason: 'no_reply' });
    expect(taskGradeability([])).toEqual({ gradeable: false, reason: 'no_reply' });
  });

  it("a replyless task whose tool trajectory is the agent's work is gradeable", () => {
    // Headless / workflow agents end on a Write or a Bash with no closing prose.
    expect(taskGradeability([turn({ tool_calls: 3 })])).toEqual({ gradeable: true });
    expect(taskGradeability([turn({ tool_calls: 1, files_created: 1 } as never)])).toEqual({ gradeable: true });
    // …but an aborted turn's tools do not count.
    expect(taskGradeability([turn({ tool_calls: 9, end_source: 'aborted' }), turn({ tool_calls: 1 })]))
      .toEqual({ gradeable: false, reason: 'no_reply' });
  });

  it('a task whose every turn was ended by the client is not gradeable, whatever text the notice carried', () => {
    expect(taskGradeability([
      turn({ end_source: 'aborted', response: "You've hit your session limit · resets 5:50pm" }),
    ])).toEqual({ gradeable: false, reason: 'aborted_only' });
  });

  it('an aborted turn beside a real one does not block the judge, and its notice is not the reply', () => {
    expect(taskGradeability([
      turn({ end_source: 'aborted', response: 'session limit' }),
      turn({ response: 'Refactored the module and ran the tests.', tool_calls: 4 }),
    ])).toEqual({ gradeable: true });
    expect(taskGradeability([
      turn({ end_source: 'aborted', response: 'session limit' }),
      turn({ tool_calls: 1 }),
    ])).toEqual({ gradeable: false, reason: 'no_reply' });
  });

  it('a single tool-less exchange short enough to be a greeting is trivial', () => {
    expect(taskGradeability([turn({ prompt: 'hello', response: 'Hi! How can I help you today?' })]))
      .toEqual({ gradeable: false, reason: 'trivial' });
    // A short prompt with a substantial answer is a real Q&A.
    expect(taskGradeability([turn({ prompt: 'why?', response: 'x'.repeat(400) })])).toEqual({ gradeable: true });
    // A long prompt is a task even with a short answer.
    expect(taskGradeability([turn({ prompt: 'p'.repeat(TRIVIAL_PROMPT_MAX_CHARS + 1), response: 'done' })])).toEqual({ gradeable: true });
    // Tools mean work happened.
    expect(taskGradeability([turn({ prompt: 'hello', response: 'ok', tool_calls: 1 })])).toEqual({ gradeable: true });
  });

  it('a task opened only by background-job notices has no request to grade, whatever work followed', () => {
    const notice = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n</task-notification>`;
    expect(taskGradeability([
      turn({ prompt: notice('bg1'), response: 'The suite passed.', tool_calls: 1 }),
      turn({ prompt: notice('bg2'), response: 'Fixed the type error and rebuilt.', tool_calls: 6 }),
    ])).toEqual({ gradeable: false, reason: 'notification_only' });
    // A request someone typed, or another session sent, is something to grade against.
    expect(taskGradeability([
      turn({ prompt: 'run the suite in the background and fix what fails', response: 'Started it.', tool_calls: 1 }),
      turn({ prompt: notice('bg3'), response: 'Fixed the failing test.', tool_calls: 4 }),
    ])).toEqual({ gradeable: true });
    expect(taskGradeability([
      turn({ prompt: '<cross-session-message from="lead">re-run the release build</cross-session-message>', response: 'It passes.', tool_calls: 3 }),
    ])).toEqual({ gradeable: true });
  });

  it("honours the collector's response_kind tag over raw text", () => {
    expect(taskGradeability([turn({ response: 'leftover', efficiency_json: JSON.stringify({ response_kind: 'tool_only' }) } as never)]))
      .toEqual({ gradeable: false, reason: 'no_reply' });
  });

  it('reads the reason back off notes_json and ignores judge notes', () => {
    expect(readNotGradeable(JSON.stringify({ notGradeable: 'aborted_only' }))).toBe('aborted_only');
    expect(readNotGradeable(JSON.stringify({ notGradeable: 'notification_only' }))).toBe('notification_only');
    expect(readNotGradeable(JSON.stringify({ reasoning: 'x', done: [], missed: [] }))).toBeNull();
    expect(readNotGradeable(null)).toBeNull();
    expect(readNotGradeable('not json')).toBeNull();
  });
});

describe('shared vector file parity (shared/task-gradeability-vectors.json)', () => {
  interface VectorTurn {
    prompt?: string;
    response?: string | null;
    toolCalls?: number;
    filesModified?: number;
    filesCreated?: number;
    endSource?: string;
    efficiencyJson?: string;
  }
  interface Vector {
    turns: VectorTurn[];
    expected: NotGradeableReason | null;
    note: string;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const vectors = JSON.parse(readFileSync(
    join(here, '..', '..', '..', 'shared', 'task-gradeability-vectors.json'), 'utf8',
  )) as Vector[];

  it('has enough vectors to be a gate', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(10);
  });

  it.each(vectors.map((v) => [v.note, v] as const))('%s', (_note, v) => {
    const turns = v.turns.map((t) => ({
      prompt: t.prompt,
      response: t.response,
      tool_calls: t.toolCalls,
      files_modified: t.filesModified,
      files_created: t.filesCreated,
      end_source: t.endSource,
      efficiency_json: t.efficiencyJson,
    }));
    const result = taskGradeability(turns);
    expect(result.gradeable ? null : result.reason).toBe(v.expected);
  });
});

describe('runner declines what it cannot grade', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('does not call the judge for a task with no reply, and stamps the reason on the row', async () => {
    const collector = new ApmeCollector(store);
    const runner = new ApmeRunner(store);
    runner._setConfig(STUB_CONFIG);
    let judgeCalls = 0;
    runner._setJudgeFn(async () => { judgeCalls++; return JSON.stringify({ overall: 0.1, reasoning: 'x', summary: 'Failed', done: [], missed: [] }); });

    const runId = collector.openRun({ sessionId: 's-nr', agentType: 'codex-cli', projectName: 'demo' })!;
    collector.ingestHook('s-nr', 'UserPromptSubmit', { prompt: 'fix the flaky test please' });
    collector.ingestHook('s-nr', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pnpm test' } });
    const taskId = collector.getActiveTaskId('s-nr')!;
    collector.noteTurnStop('s-nr');
    collector.closeRun('s-nr');

    runner.enqueueTask({ runId, taskId, boundarySignal: 'session_end' });
    await runner.drain();

    expect(judgeCalls).toBe(0);
    const task = store.getTask(taskId)!;
    expect(task.compositeScore).toBeNull();
    expect(task.summary).toBeNull();
    expect(readNotGradeable(task.notesJson)).toBe('no_reply');
  });

  it('judges a task that has a reply, inheriting the run category when the task row has none', async () => {
    const collector = new ApmeCollector(store);
    const runner = new ApmeRunner(store);
    runner._setConfig(STUB_CONFIG);
    const prompts: string[] = [];
    runner._setJudgeFn(async (p) => { prompts.push(p); return JSON.stringify({ overall: 0.9, reasoning: 'x', summary: 'Fixed it', done: ['fixed'], missed: [] }); });

    const runId = collector.openRun({ sessionId: 's-ok', agentType: 'codex-cli', projectName: 'demo' })!;
    collector.ingestHook('s-ok', 'UserPromptSubmit', { prompt: 'fix the flaky test please' });
    collector.setTurnResponse('s-ok', 'Fixed the race in the retry helper and re-ran the suite.');
    const taskId = collector.getActiveTaskId('s-ok')!;
    collector.noteTurnStop('s-ok');
    collector.closeRun('s-ok');
    store.updateRun(runId, { taskCategory: 'ops' });
    store.updateTask(taskId, { taskCategory: null });

    runner.enqueueTask({ runId, taskId, boundarySignal: 'session_end' });
    await runner.drain();

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('task_category: ops');
    expect(store.getTask(taskId)!.summary).toBe('Fixed it');
  });
});

describe('judge backlog drain', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('offers closed unjudged tasks inside the window, never declined ones', () => {
    const now = Date.now();
    store.insertRun({ id: 'r', sessionId: 's', agentType: 'claude-code', startedAt: now - 10_000 });
    const add = (id: string, endedAt: number, notes?: string, summary?: string) => {
      store.insertTask({ id, runId: 'r', taskIndex: 0, boundarySignal: 'open', startedAt: endedAt - 1000 });
      store.updateTask(id, { endedAt, boundarySignal: 'idle_gap', ...(notes ? { notesJson: notes } : {}), ...(summary ? { summary } : {}) });
    };
    add('t-fresh', now - 1000);
    add('t-declined', now - 2000, JSON.stringify({ notGradeable: 'no_reply' }));
    add('t-judged', now - 3000, JSON.stringify({ reasoning: 'x' }), 'Did the thing');
    add('t-ancient', now - 40 * 86_400_000);
    store.insertTask({ id: 't-open', runId: 'r', taskIndex: 1, boundarySignal: 'open', startedAt: now });

    expect(store.listTasksNeedingSummary(10, now - 30 * 86_400_000).map((t) => t.id)).toEqual(['t-fresh']);
    expect(store.listTasksNeedingSummary(10).map((t) => t.id)).toEqual(['t-fresh', 't-ancient']);
  });

  it('a task whose judge keeps failing is offered twice per process, then left alone', async () => {
    const collector = new ApmeCollector(store);
    const runner = new ApmeRunner(store);
    runner._setConfig(STUB_CONFIG);
    let calls = 0;
    runner._setJudgeFn(async () => { calls++; return 'not json at all'; });
    const runId = collector.openRun({ sessionId: 's-f', agentType: 'claude-code', projectName: 'demo' })!;
    collector.ingestHook('s-f', 'UserPromptSubmit', { prompt: 'fix the flaky test please' });
    collector.setTurnResponse('s-f', 'Fixed the race in the retry helper and re-ran the suite.');
    const taskId = collector.getActiveTaskId('s-f')!;
    collector.noteTurnStop('s-f');
    collector.closeRun('s-f');
    for (let i = 0; i < 4; i++) { runner.enqueueTask({ runId, taskId }); await runner.drain(); }
    expect(calls).toBe(2);
  });
});

describe('retractUngradeableVerdicts', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('withdraws verdicts reached without the agent\'s work and keeps the rest', async () => {
    const { retractUngradeableVerdicts } = await import('../apme/task-gradeability.js');
    const now = Date.now();
    store.insertRun({ id: 'r', sessionId: 's', agentType: 'claude-code', startedAt: now - 10_000 });
    const seed = (id: string, turn: { response?: string; end_source?: string; tool_calls?: number; prompt?: string }, outcome = 'fail') => {
      store.insertTask({ id, runId: 'r', taskIndex: 0, boundarySignal: 'open', startedAt: now - 5000 });
      store.updateTask(id, { endedAt: now - 1000, boundarySignal: 'idle_gap', summary: 'Failed to do it', compositeScore: 0.1, outcome, notesJson: JSON.stringify({ reasoning: 'x' }) });
      store.insertTurn({ id: `u-${id}`, runId: 'r', taskId: id, turnIndex: 0, prompt: turn.prompt ?? 'do the long thing', startedAt: now - 4000 });
      store.updateTurn(`u-${id}`, { endedAt: now - 2000, endSource: turn.end_source ?? 'stop', toolCalls: turn.tool_calls ?? 0, ...(turn.response ? { response: turn.response } : {}) });
      store.insertEvalForTask({ id: 0, runId: 'r', taskId: id, layer: 'task_judge', metric: 'overall', score: 0.1, raw: null, rubricVer: null, judgeModel: 'stub', createdAt: now });
    };
    seed('t-silent', { tool_calls: 1 });
    seed('t-abort', { response: "You've hit your session limit", end_source: 'aborted' });
    seed('t-hello', { prompt: 'hello', response: 'Hi there!' });
    seed('t-real', { response: 'Refactored the module and the suite is green.', tool_calls: 5 });
    seed('t-notice', { prompt: '<task-notification>\n<task-id>bg1</task-id>\n</task-notification>', response: 'The background build passed.', tool_calls: 4 });
    seed('t-cancelled', { tool_calls: 2 }, 'abandoned');

    // Declined under the stricter first cut, but its trajectory is real work.
    store.insertTask({ id: 't-declined-worker', runId: 'r', taskIndex: 0, boundarySignal: 'open', startedAt: now - 5000 });
    store.updateTask('t-declined-worker', { endedAt: now - 1000, boundarySignal: 'session_end', notesJson: JSON.stringify({ notGradeable: 'no_reply' }) });
    store.insertTurn({ id: 'u-w', runId: 'r', taskId: 't-declined-worker', turnIndex: 0, prompt: 'build the catalog shard', startedAt: now - 4000 });
    store.updateTurn('u-w', { endedAt: now - 2000, endSource: 'stop', toolCalls: 11, filesCreated: 2 });

    const r = retractUngradeableVerdicts(store, now - 86_400_000);
    expect(r).toEqual({ no_reply: 2, aborted_only: 1, trivial: 1, notification_only: 1, readmitted: 1 });
    expect(store.getTask('t-declined-worker')!.notesJson).toBeNull();

    for (const id of ['t-silent', 't-abort', 't-hello', 't-notice']) {
      const t = store.getTask(id)!;
      expect(t.compositeScore).toBeNull();
      expect(t.summary).toBeNull();
      expect(t.outcome).toBeNull();
      expect(store.listEvalsForTask(id)).toHaveLength(0);
    }
    expect(readNotGradeable(store.getTask('t-silent')!.notesJson)).toBe('no_reply');
    expect(readNotGradeable(store.getTask('t-notice')!.notesJson)).toBe('notification_only');
    expect(store.getTask('t-cancelled')!.outcome).toBe('abandoned'); // the user's statement survives
    expect(store.getTask('t-real')!.compositeScore).toBe(0.1);
    expect(store.listEvalsForTask('t-real')).toHaveLength(1);
    // Idempotent.
    expect(retractUngradeableVerdicts(store, now - 86_400_000)).toEqual({ no_reply: 0, aborted_only: 0, trivial: 0, notification_only: 0, readmitted: 0 });
  });
});
