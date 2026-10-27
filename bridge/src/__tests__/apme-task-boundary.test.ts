import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';
import { ApmeRunner, TASK_EVAL_PARK_MS, buildTaskJudgeInput } from '../apme/runner.js';

// Task-unit evaluation: tasks segment on EXPLICIT boundaries (`/task close` /
// device button → 'manual', `/clear`) or session_end. TodoWrite all-completed
// is a non-segmenting soft hint (demoted 2026-06 — it fired unreliably ~18% on
// Claude Code v2.1 and fragmented a single logical task into several units).

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-task-'));
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

function openRun(collector: ApmeCollector): { runId: string; sessionId: string } {
  const sessionId = 'task-test-session';
  const runId = collector.openRun({
    sessionId,
    agentType: 'claude-code',
    projectName: 'demo',
    projectPath: '/tmp/demo',
  });
  return { runId, sessionId };
}

describe('ApmeCollector task boundaries', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('first UserPromptSubmit opens a task and attaches the turn', () => {
    const collector = new ApmeCollector(store);
    const { runId, sessionId } = openRun(collector);

    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'hello' });

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(1);
    expect(tasks[0].taskIndex).toBe(0);
    expect(tasks[0].endedAt).toBeNull();
    expect(collector.getActiveTaskId(sessionId)).toBe(tasks[0].id);

    const turns = store.listTurns(runId) as Array<Record<string, unknown>>;
    expect(turns.length).toBe(1);
    expect(turns[0].task_id).toBe(tasks[0].id);
  });

  it('TodoWrite all-completed is a soft hint — does NOT close the task', () => {
    const collector = new ApmeCollector(store);
    const { runId, sessionId } = openRun(collector);

    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'build plan' });
    collector.ingestHook(sessionId, 'PreToolUse', { tool_name: 'TodoWrite' });
    collector.ingestHook(sessionId, 'PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: {
        todos: [
          { content: 'a', status: 'completed', activeForm: 'doing a' },
          { content: 'b', status: 'completed', activeForm: 'doing b' },
        ],
      },
    });

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(1);
    // Task stays open — only explicit boundaries or session_end segment now.
    expect(tasks[0].boundarySignal).toBe('open');
    expect(tasks[0].endedAt).toBeNull();
    expect(collector.getActiveTaskId(sessionId)).toBe(tasks[0].id);
  });

  it('TodoWrite all-completed does not split — later turns stay in one task', () => {
    const collector = new ApmeCollector(store);
    const { runId, sessionId } = openRun(collector);

    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'first' });
    collector.ingestHook(sessionId, 'PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ content: 'a', status: 'completed' }] },
    });
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'second' });

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(1);
    expect(tasks[0].endedAt).toBeNull();
  });

  it('TodoWrite with partial completion does NOT close the task', () => {
    const collector = new ApmeCollector(store);
    const { runId, sessionId } = openRun(collector);

    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'p' });
    collector.ingestHook(sessionId, 'PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: {
        todos: [
          { content: 'a', status: 'completed' },
          { content: 'b', status: 'in_progress' },
        ],
      },
    });

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(1);
    expect(tasks[0].endedAt).toBeNull();
    expect(tasks[0].boundarySignal).toBe('open');
  });

  it('next UserPromptSubmit after an explicit boundary opens a new task', () => {
    const collector = new ApmeCollector(store);
    const { runId, sessionId } = openRun(collector);

    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'first' });
    // Explicit manual boundary (e.g. `/task close` or a device button).
    collector.closeTaskExternal(sessionId, 'manual');
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'second' });

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(2);
    expect(tasks[0].taskIndex).toBe(0);
    expect(tasks[1].taskIndex).toBe(1);
    expect(tasks[0].endedAt).toBeGreaterThan(0);
    expect(tasks[0].boundarySignal).toBe('manual');
    expect(tasks[1].endedAt).toBeNull();
  });

  it('splitRun closes the active task with boundary=clear', () => {
    const collector = new ApmeCollector(store);
    const { runId: firstRun, sessionId } = openRun(collector);
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'pre-clear' });

    const newRunId = collector.splitRun(sessionId, '/tmp/demo');
    expect(newRunId).toBeTruthy();
    expect(newRunId).not.toBe(firstRun);

    const tasksFirst = store.listTasksForRun(firstRun);
    expect(tasksFirst.length).toBe(1);
    expect(tasksFirst[0].boundarySignal).toBe('clear');
    expect(tasksFirst[0].endedAt).toBeGreaterThan(0);
  });

  it('closeRun closes the active task with boundary=session_end', () => {
    const collector = new ApmeCollector(store);
    const { runId, sessionId } = openRun(collector);
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'x' });

    collector.closeRun(sessionId, 0, '/tmp/demo');

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(1);
    expect(tasks[0].boundarySignal).toBe('session_end');
    expect(tasks[0].endedAt).toBeGreaterThan(0);
  });

  it('onTaskClosed fires on an explicit boundary with the task metadata', () => {
    const collector = new ApmeCollector(store);
    const seen: Array<{ taskId: string; runId: string; boundarySignal: string }> = [];
    collector.onTaskClosed = ({ taskId, runId, boundarySignal }) => {
      seen.push({ taskId, runId, boundarySignal });
    };
    const { runId, sessionId } = openRun(collector);
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'x' });
    collector.closeTaskExternal(sessionId, 'manual');

    expect(seen.length).toBe(1);
    expect(seen[0].runId).toBe(runId);
    expect(seen[0].boundarySignal).toBe('manual');
  });

  it('onTaskOpened is DEFERRED: fires on the second turn, not the first', () => {
    const collector = new ApmeCollector(store);
    const opens: Array<{
      taskId: string; runId: string; sessionId: string;
      agentType: string | null; projectName: string | null; taskIndex: number;
    }> = [];
    collector.onTaskOpened = (args) => {
      opens.push({
        taskId: args.taskId,
        runId: args.runId,
        sessionId: args.sessionId,
        agentType: args.agentType,
        projectName: args.projectName,
        taskIndex: args.taskIndex,
      });
    };
    const { runId, sessionId } = openRun(collector);
    // First prompt: a single-turn Q&A must NOT surface a TASK header — the
    // task row exists in the store, but the timeline stays quiet.
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'first' });
    expect(opens.length).toBe(0);

    // Second prompt on the same task promotes it to a real multi-turn work
    // unit → the deferred task_start finally fires (backdated to task start).
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'second' });
    expect(opens.length).toBe(1);
    expect(opens[0].runId).toBe(runId);
    expect(opens[0].sessionId).toBe(sessionId);
    expect(opens[0].agentType).toBe('claude-code');
    expect(opens[0].projectName).toBe('demo');
    expect(opens[0].taskIndex).toBe(0);
  });

  it('onTaskOpened also promotes on a TodoWrite plan within the first turn', () => {
    const collector = new ApmeCollector(store);
    let opens = 0;
    collector.onTaskOpened = () => { opens++; };
    let milestones = 0;
    collector.onTaskMilestone = () => { milestones++; };
    const { sessionId } = openRun(collector);
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'plan and build' });
    expect(opens).toBe(0);
    // A TodoWrite-all-completed hint proves the turn is real work → promote.
    collector.ingestHook(sessionId, 'PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ content: 'do it', status: 'completed' }] },
    });
    expect(opens).toBe(1);
    expect(milestones).toBe(1);
  });

  // Reproduces the daemon/index.ts wiring: follow-up prompts must group under
  // ONE task_start header (never look like separate top-level tasks), and a
  // single-turn Q&A must emit neither task_start nor task_end.
  it('groups follow-up prompts under one header; single-turn stays headerless', () => {
    const timeline: Array<{ type: string; taskId?: string | null }> = [];
    const promoted = new Set<string>();
    const collector = new ApmeCollector(store);
    // Mirror apme/index.ts: onTaskOpened marks the id promoted + emits header.
    collector.onTaskOpened = ({ taskId }) => {
      promoted.add(taskId);
      timeline.push({ type: 'task_start', taskId });
    };
    // Mirror apme/index.ts: task_end emits ONLY when the header was promoted.
    collector.onTaskClosed = ({ taskId, timelineEmitted }) => {
      if (timelineEmitted) timeline.push({ type: 'task_end', taskId });
    };
    const { sessionId } = openRun(collector);

    // Three prompts in the same session — the collector must keep the SAME
    // active task across all three (the whole point of grouping).
    const emitChat = () => {
      const taskId = collector.getActiveTaskId(sessionId);
      timeline.push({ type: 'chat_start', taskId });
    };
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'p1' });
    emitChat();
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'p2' });
    emitChat();
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'p3' });
    emitChat();

    const starts = timeline.filter((e) => e.type === 'task_start');
    const chats = timeline.filter((e) => e.type === 'chat_start');
    expect(starts.length).toBe(1);                       // exactly one header
    const taskId = starts[0].taskId!;
    // Every chat row carries the SAME enclosing taskId → they nest under the
    // one header instead of each reading as a new task.
    expect(new Set(chats.map((c) => c.taskId)).size).toBe(1);
    expect(chats.every((c) => c.taskId === taskId)).toBe(true);

    collector.closeTaskExternal(sessionId, 'manual');
    expect(timeline.filter((e) => e.type === 'task_end').length).toBe(1);

    // A fresh single-turn session: header never promotes, close emits nothing.
    const solo = 'solo-session';
    collector.openRun({ sessionId: solo, agentType: 'claude-code', projectName: 'demo', projectPath: '/tmp/demo' });
    const before = timeline.length;
    collector.ingestHook(solo, 'UserPromptSubmit', { prompt: 'quick question' });
    collector.closeTaskExternal(solo, 'manual');
    expect(timeline.slice(before).some((e) => e.type === 'task_start' || e.type === 'task_end')).toBe(false);
  });

  it('onTaskClosed payload includes session, agent, project, and timing', () => {
    const collector = new ApmeCollector(store);
    const closes: Array<{
      sessionId: string;
      agentType: string | null;
      projectName: string | null;
      startedAt: number;
      endedAt: number;
    }> = [];
    collector.onTaskClosed = (args) => {
      closes.push({
        sessionId: args.sessionId,
        agentType: args.agentType,
        projectName: args.projectName,
        startedAt: args.startedAt,
        endedAt: args.endedAt,
      });
    };
    const { sessionId } = openRun(collector);
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'x' });
    collector.closeTaskExternal(sessionId, 'manual');

    expect(closes.length).toBe(1);
    expect(closes[0].sessionId).toBe(sessionId);
    expect(closes[0].agentType).toBe('claude-code');
    expect(closes[0].projectName).toBe('demo');
    expect(closes[0].endedAt).toBeGreaterThanOrEqual(closes[0].startedAt);
  });

  it('empty task (no turns between two boundaries) is dropped', () => {
    const collector = new ApmeCollector(store);
    const { runId, sessionId } = openRun(collector);

    // Turn 0 + boundary → task 0 closed (has a turn, kept)
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'x' });
    collector.ingestHook(sessionId, 'PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ content: 'a', status: 'completed' }] },
    });
    // closeRun before a new turn: task 1 would be the "empty" auto-opened one.
    // In practice openTaskIfNone only runs on UserPromptSubmit, so no new task
    // exists here — but session_end should still leave exactly task 0.
    collector.closeRun(sessionId, 0, '/tmp/demo');

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(1);
    expect(tasks[0].taskIndex).toBe(0);
  });
});

describe('ApmeRunner task eval', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('enqueueTask invokes judge with turns and persists summary + scores', async () => {
    const collector = new ApmeCollector(store);
    const runner = new ApmeRunner(store);

    // Mock judge — capture prompt, return a task_rollup-shaped JSON.
    let capturedPrompt = '';
    runner._setJudgeFn(async (prompt) => {
      capturedPrompt = prompt;
      return JSON.stringify({
        summary: 'Added task boundary detection.',
        completion: 0.9, coherence: 0.8, efficiency: 0.7, overall: 0.85,
        reasoning: 'Agent completed the feature end-to-end.',
        done: ['boundary detection'],
        missed: [],
      });
    });

    // Force enabled config with MLX backend (judge is mocked anyway).
    runner._setConfig({
      enabled: true,
      deterministic: { enabled: false, timeoutSec: 1, commands: {} },
      judge: { backend: 'mlx', model: 'test', fallbackToMlx: false },
    } as unknown as import('../apme/settings.js').ApmeConfig);

    collector.onTaskClosed = ({ taskId, runId, taskCategory }) => {
      runner.enqueueTask({ runId, taskId, category: taskCategory ?? undefined });
    };

    const sessionId = 'runner-test';
    const runId = collector.openRun({
      sessionId, agentType: 'claude-code', projectName: 'demo',
    });
    // A real request, not a greeting: task-gradeability.ts declines a single
    // tool-less exchange whose prompt is ≤12 chars and reply ≤200 as `trivial`,
    // and a declined task never reaches the judge this test is about.
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'add task boundary detection to the collector' });
    // Provide a response on the active turn so it's not all tool_only/empty.
    collector.setTurnResponse(sessionId, 'Sure — here is the plan.');
    // Explicit boundary closes the task and enqueues the rollup judge.
    collector.closeTaskExternal(sessionId, 'manual');

    // Drain microtasks until the fire-and-forget task eval settles.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const tasks = store.listTasksForRun(runId);
    expect(tasks.length).toBe(1);
    expect(tasks[0].summary).toBe('Added task boundary detection.');
    expect(tasks[0].compositeScore).toBeCloseTo(0.85, 2);
    expect(store.taskAttempt(tasks[0].id)).toMatchObject({status:'succeeded'});

    expect(capturedPrompt).toContain('--- TURNS ---');
    expect(capturedPrompt).toContain('Sure — here is the plan.');

    const evals = store.listEvalsForTask(tasks[0].id);
    const metrics = new Set(evals.map((e) => e.metric));
    expect(metrics.has('overall')).toBe(true);
    expect(metrics.has('completion')).toBe(true);
    // LLM-judge axes are stored under task_judge; pure trajectory scorers
    // (tool_efficiency / trajectory_quality) under the 'trajectory' layer.
    const judgeAxes = evals.filter((e) => e.layer === 'task_judge');
    expect(judgeAxes.length).toBeGreaterThan(0);
    expect(judgeAxes.some((e) => e.metric === 'overall')).toBe(true);
    expect(evals.every((e) => e.layer === 'task_judge' || e.layer === 'trajectory')).toBe(true);
  });

  it('skips task eval when all turns are tool_only / empty', async () => {
    const collector = new ApmeCollector(store);
    const runner = new ApmeRunner(store);

    let called = 0;
    runner._setJudgeFn(async () => { called++; return '{}'; });
    runner._setConfig({
      enabled: true,
      deterministic: { enabled: false, timeoutSec: 1, commands: {} },
      judge: { backend: 'mlx', model: 'test', fallbackToMlx: false },
    } as unknown as import('../apme/settings.js').ApmeConfig);

    collector.onTaskClosed = ({ taskId, runId, taskCategory }) => {
      runner.enqueueTask({ runId, taskId, category: taskCategory ?? undefined });
    };

    const sessionId = 'empty-turns-session';
    collector.openRun({ sessionId, agentType: 'claude-code', projectName: 'demo' });
    // Prompt is empty AND response is empty → meaningful-text check fails.
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: '' });
    // Intentionally no setTurnResponse — the turn stays empty.
    collector.closeTaskExternal(sessionId, 'manual');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(called).toBe(0);
  });
});

describe('ApmeRunner task judge parking', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); vi.useFakeTimers({ toFake: ['Date'] }); });
  afterEach(() => { vi.useRealTimers(); cleanup(store); });

  it('a task parked after two failures is offered again once the park expires', async () => {
    // One busy hour at the judge used to park the whole backlog for the life
    // of the process (2026-09-03: 289 tasks pending, drain at zero).
    const collector = new ApmeCollector(store);
    const runner = new ApmeRunner(store);
    let calls = 0;
    runner._setJudgeFn(async () => { calls++; throw new Error('MLX judge HTTP 503'); });
    runner._setConfig({
      enabled: true,
      deterministic: { enabled: false, timeoutSec: 1, commands: {} },
      judge: { backend: 'mlx', model: 'test', fallbackToMlx: false },
    } as unknown as import('../apme/settings.js').ApmeConfig);
    const sessionId = 'park-test';
    const runId = collector.openRun({ sessionId, agentType: 'claude-code', projectName: 'demo' })!;
    collector.ingestHook(sessionId, 'UserPromptSubmit', { prompt: 'add task boundary detection to the collector' });
    collector.setTurnResponse(sessionId, 'Sure — here is the plan.');
    collector.closeTaskExternal(sessionId, 'manual');
    const taskId = store.listTasksForRun(runId)[0].id;

    const settle = () => new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 4; i++) { runner.enqueueTask({ runId, taskId }); await settle(); }
    expect(calls).toBe(2); // two attempts, then parked
    expect(store.taskAttempt(taskId)).toMatchObject({status:'failed',reason:'transport_or_backend'});
    expect(runner.inFlightTaskEvals).toBe(0);

    vi.setSystemTime(Date.now() + TASK_EVAL_PARK_MS + 1);
    runner.enqueueTask({ runId, taskId }); await settle();
    expect(calls).toBe(3); // the park expired: a fresh attempt
  });
});


describe('P1 long task judge evidence', () => {
  it('includes initial request, final response and older validation output in a bounded prompt', () => {
    const turns=Array.from({length:50},(_,i)=>({turn_index:i,prompt:'request '+i,response:'response '+i,tool_calls:2}));
    turns[49].response='FIRST RESULT '+ 'x'.repeat(4000)+' FINAL_RESULT_RETAINED';
    const events=Array.from({length:60},(_,i)=>({kind:'tool',name:'Read',input:{path:'file-'+i},status:'success',output:''}));
    events[20]={kind:'tool',name:'Bash',input:{path:'pnpm test'},status:'success',output:'SECRET '+ 'x'.repeat(1000)+' FINAL_TESTS_PASSED'};
    const store={getTask:()=>({id:'task',runId:'run',taskCategory:'coding'}),listTurnsForTask:()=>turns,
      getRun:()=>({taskCategory:'coding'}),getCurrentRubric:()=>({version:1,prompt:'Judge task evidence'}),
      getSample:()=>({events,cost:{inputTokens:0,outputTokens:0,costUsd:0},model:{modelId:'model'}})} as unknown as ApmeStore;
    const input=buildTaskJudgeInput(store,{runId:'run',taskId:'task'},{field:t=>t.replaceAll('SECRET','[REDACTED]')});
    expect(input.kind).toBe('ready');if(input.kind!=='ready')return;
    expect(input.prompt).toContain('request 0');expect(input.prompt).toContain('FINAL_RESULT_RETAINED');
    expect(input.prompt).toContain('FINAL_TESTS_PASSED');expect(input.prompt).not.toContain('SECRET');
    expect(input.prompt).toContain('40 more turns omitted');
    expect(input.evidence.turnIndices).toHaveLength(10);expect(input.evidence.turnIndices).toContain(49);
    expect(input.evidence.eventIndices).toHaveLength(30);expect(input.evidence.eventIndices).toContain(20);
  });
});
