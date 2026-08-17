import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';

// These tests require the optional native dep `better-sqlite3`. If the store
// cannot initialize we fail loudly — silent skips would hide regressions.

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-test-'));
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

describe('ApmeCollector', () => {
  let store!: ApmeStore;

  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => { cleanup(store); });

  it('openRun → ingestHook → closeRun persists a run with steps', async () => {
    const collector = new ApmeCollector(store);

    const runId = collector.openRun({
      sessionId: 'session-1',
      agentType: 'claude-code',
      projectName: 'demo',
      projectPath: '/tmp/demo',
    });
    expect(runId).toBeTruthy();

    collector.ingestHook('session-1', 'UserPromptSubmit', { prompt: 'refactor the thing' });
    collector.ingestHook('session-1', 'PreToolUse', { tool_name: 'Edit', file_path: '/tmp/demo/a.ts' });
    collector.ingestHook('session-1', 'PostToolUse', { tool_name: 'Edit' });

    const closedId = collector.closeRun('session-1', 0, '/tmp/demo');
    expect(closedId).toBe(runId);

    const run = store.getRun(runId);
    expect(run).not.toBeNull();
    expect(run?.sessionId).toBe('session-1');
    expect(run?.agentType).toBe('claude-code');
    expect(run?.projectName).toBe('demo');
    expect(run?.endedAt).toBeGreaterThan(0);
    expect(run?.exitCode).toBe(0);
    expect(run?.taskPrompt).toBe('refactor the thing');

    const steps = store.listSteps(runId);
    expect(steps.length).toBe(3);
    const kinds = steps.map((s) => s.kind);
    expect(kinds).toEqual(['UserPromptSubmit', 'PreToolUse', 'PostToolUse']);
    const editStep = steps.find((s) => s.kind === 'PreToolUse');
    expect(editStep?.toolName).toBe('Edit');
  });

  it('updateUsage and updateModel reflect in the run row', async () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({
      sessionId: 'session-2',
      agentType: 'claude-code',
      projectName: 'demo',
    });

    collector.updateModel('session-2', 'claude-opus-4-6');
    collector.updateUsage('session-2', {
      sessionDurationSec: 10,
      inputTokens: 1200,
      outputTokens: 340,
      toolCalls: 3,
      estimatedCostUsd: 0.075,
      sessionPercent: null,
      costSpent: null,
      costLimit: null,
      resetTime: null,
      resetDate: null,
    });

    const run = store.getRun(runId);
    expect(run?.modelId).toBe('claude-opus-4-6');
    expect(run?.inputTokens).toBe(1200);
    expect(run?.outputTokens).toBe(340);
    expect(run?.costUsd).toBeCloseTo(0.075);
  });

  it('listRuns filters by agent and orders by started_at desc', async () => {
    const collector = new ApmeCollector(store);

    const a = collector.openRun({ sessionId: 's-a', agentType: 'claude-code', projectName: 'p' });
    await new Promise((r) => setTimeout(r, 5));
    const b = collector.openRun({ sessionId: 's-b', agentType: 'openclaw', projectName: 'p' });
    await new Promise((r) => setTimeout(r, 5));
    const c = collector.openRun({ sessionId: 's-c', agentType: 'claude-code', projectName: 'p' });

    const claudeRuns = store.listRuns({ agentType: 'claude-code' });
    expect(claudeRuns.length).toBe(2);
    expect(claudeRuns[0].id).toBe(c); // newest first
    expect(claudeRuns[1].id).toBe(a);

    const openclaw = store.listRuns({ agentType: 'openclaw' });
    expect(openclaw.length).toBe(1);
    expect(openclaw[0].id).toBe(b);
  });

  it('default rubric v1 is seeded on init', async () => {
    const rubric = store.getCurrentRubric('general');
    expect(rubric).not.toBeNull();
    expect(rubric?.version).toBe(1);
    expect(rubric?.purpose).toBe('general');
    expect(rubric?.prompt).toContain('task_completion');
    const weights = JSON.parse(rubric!.weights) as Record<string, number>;
    expect(weights.task_completion).toBeGreaterThan(0);
  });

  it('insertEval + listEvalsForRun round-trip', async () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's', agentType: 'claude-code', projectName: 'p' });

    store.insertEval({ runId, layer: 'deterministic', metric: 'tests_pass', score: 1, createdAt: Date.now() });
    store.insertEval({ runId, layer: 'llm_judge', metric: 'overall', score: 0.82, rubricVer: 1, judgeModel: 'claude-opus-4-6', createdAt: Date.now() });

    const evals = store.listEvalsForRun(runId);
    expect(evals.length).toBe(2);
    expect(evals.find((e) => e.metric === 'tests_pass')?.score).toBe(1);
    expect(evals.find((e) => e.metric === 'overall')?.score).toBeCloseTo(0.82);
  });

  it('excludes _empty runs from the unevaluated run queue', async () => {
    const collector = new ApmeCollector(store);

    const emptyRunId = collector.openRun({ sessionId: 'empty', agentType: 'openclaw', projectName: 'openclaw' });
    collector.closeRun('empty');

    const realRunId = collector.openRun({
      sessionId: 'real',
      agentType: 'claude-code',
      projectName: 'p',
      taskPrompt: 'fix the dashboard',
    });
    collector.closeRun('real');

    expect(store.getRun(emptyRunId)?.taskCategory).toBe('_empty');
    const pendingIds = store.listUnevaluatedRuns(10).map((r) => r.id);
    expect(pendingIds).toContain(realRunId);
    expect(pendingIds).not.toContain(emptyRunId);
  });

  it('scorecard view aggregates runs per model', async () => {
    const collector = new ApmeCollector(store);
    const runA = collector.openRun({ sessionId: 's1', agentType: 'claude-code', projectName: 'p' });
    collector.updateModel('s1', 'claude-opus-4-6');
    collector.updateUsage('s1', {
      sessionDurationSec: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
      estimatedCostUsd: 0.5,
      sessionPercent: null, costSpent: null, costLimit: null, resetTime: null, resetDate: null,
    });
    store.insertEval({ runId: runA, layer: 'llm_judge', metric: 'overall', score: 0.9, createdAt: Date.now() });

    const runB = collector.openRun({ sessionId: 's2', agentType: 'claude-code', projectName: 'p' });
    collector.updateModel('s2', 'claude-opus-4-6');
    collector.updateUsage('s2', {
      sessionDurationSec: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
      estimatedCostUsd: 0.3,
      sessionPercent: null, costSpent: null, costLimit: null, resetTime: null, resetDate: null,
    });
    store.insertEval({ runId: runB, layer: 'llm_judge', metric: 'overall', score: 0.7, createdAt: Date.now() });

    const cards = store.scorecard();
    const opus = cards.find((c) => c.modelId === 'claude-opus-4-6');
    expect(opus).toBeDefined();
    expect(opus?.runs).toBe(2);
    expect(opus?.avgOverall).toBeCloseTo(0.8);
    expect(opus?.totalCost).toBeCloseTo(0.8);
  });

  it('multi-turn cycle captures prompts and responses (wireAgentApme path)', async () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({
      sessionId: 'oc-1',
      agentType: 'openclaw',
      projectName: 'test',
      projectPath: '/tmp/test',
    });

    // Turn 1: chat_start → ingestHook(UserPromptSubmit) + setTurnResponse
    collector.ingestHook('oc-1', 'UserPromptSubmit', { message: { content: 'explain the auth flow' } });
    const turn1 = collector.getActiveTurnId('oc-1');
    expect(turn1).toBeTruthy();
    collector.setTurnResponse('oc-1', 'The auth flow uses OAuth2 with PKCE...');

    // Verify turn 1 has response
    const t1 = store.getTurn(turn1!);
    expect(t1?.prompt).toBe('explain the auth flow');
    expect(t1?.response).toBe('The auth flow uses OAuth2 with PKCE...');

    // Turn 2: another prompt creates a new turn
    collector.ingestHook('oc-1', 'UserPromptSubmit', { message: { content: 'refactor it' } });
    const turn2 = collector.getActiveTurnId('oc-1');
    expect(turn2).toBeTruthy();
    expect(turn2).not.toBe(turn1);

    // setLastClosedTurnResponse applies to last closed turn (turn1)
    // but turn1 already has response, so this should be a no-op
    collector.setLastClosedTurnResponse('oc-1', 'should not overwrite');
    const t1After = store.getTurn(turn1!);
    expect(t1After?.response).toBe('The auth flow uses OAuth2 with PKCE...');

    // Turn 2 response via setTurnResponse
    collector.setTurnResponse('oc-1', 'Refactored the middleware.');
    const t2 = store.getTurn(turn2!);
    expect(t2?.response).toBe('Refactored the middleware.');

    // Close run — both turns should exist
    collector.closeRun('oc-1', 0, '/tmp/test');
    const run = store.getRun(runId);
    expect(run?.endedAt).toBeGreaterThan(0);
  });

  it('setLastClosedTurnResponse fills missing response on closed turn', async () => {
    const collector = new ApmeCollector(store);
    collector.openRun({ sessionId: 's-fb', agentType: 'opencode', projectName: 'p' });

    // Turn with prompt but no response
    collector.ingestHook('s-fb', 'UserPromptSubmit', { message: { content: 'hello' } });
    const turnId = collector.getActiveTurnId('s-fb');

    // Close turn by starting a new one (or close run)
    collector.ingestHook('s-fb', 'UserPromptSubmit', { message: { content: 'second' } });

    // Now turnId is closed, setLastClosedTurnResponse should work
    collector.setLastClosedTurnResponse('s-fb', 'delayed response text');
    const t = store.getTurn(turnId!);
    expect(t?.response).toBe('delayed response text');
  });

  it('setTurnResponse tags efficiency_json.response_kind (text / tool_only / empty)', async () => {
    const collector = new ApmeCollector(store);
    collector.openRun({ sessionId: 's-kind', agentType: 'claude-code', projectName: 'p' });

    // Case 1: text response → response_kind='text'
    collector.ingestHook('s-kind', 'UserPromptSubmit', { message: { content: 'what is 2+2?' } });
    const t1 = collector.getActiveTurnId('s-kind');
    collector.setTurnResponse('s-kind', '4');
    const row1 = store.getTurn(t1!);
    expect(JSON.parse((row1!.efficiency_json as string) ?? '{}').response_kind).toBe('text');

    // Case 2: empty response + tool calls → response_kind='tool_only'
    collector.ingestHook('s-kind', 'UserPromptSubmit', { message: { content: 'read the file' } });
    collector.ingestHook('s-kind', 'PreToolUse', { tool_name: 'Read' });
    collector.ingestHook('s-kind', 'PreToolUse', { tool_name: 'Bash' });
    const t2 = collector.getActiveTurnId('s-kind');
    collector.setTurnResponse('s-kind', '');
    const row2 = store.getTurn(t2!);
    expect(JSON.parse((row2!.efficiency_json as string) ?? '{}').response_kind).toBe('tool_only');

    // Case 3: empty response + zero tool calls → response_kind='empty'
    collector.ingestHook('s-kind', 'UserPromptSubmit', { message: { content: 'hi' } });
    const t3 = collector.getActiveTurnId('s-kind');
    collector.setTurnResponse('s-kind', '   ');
    const row3 = store.getTurn(t3!);
    expect(JSON.parse((row3!.efficiency_json as string) ?? '{}').response_kind).toBe('empty');
  });

  it('no-op gracefully when store is disabled', () => {
    const dummy = new ApmeStore('/nonexistent/_disabled');
    // init() never called, so enabled=false
    expect(dummy.enabled).toBe(false);
    const collector = new ApmeCollector(dummy);
    expect(collector.openRun({ sessionId: 'x', agentType: 'claude-code', projectName: 'p' })).toBe('');
    expect(() => collector.ingestHook('x', 'PreToolUse', { tool_name: 'Bash' })).not.toThrow();
    expect(collector.closeRun('x')).toBeNull();
  });

  it('ignores an echoed duplicate turn_start (same prompt on a fresh empty turn)', async () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's-echo', agentType: 'openclaw', projectName: 'p' });

    // OpenClaw shape: our chat.send span opens the turn, then the gateway
    // re-delivers the same text as session.message role=user moments later.
    collector.ingestHook('s-echo', 'UserPromptSubmit', { prompt: '같은 프롬프트' });
    const firstTurnId = collector.getActiveTurnId('s-echo');
    collector.ingestHook('s-echo', 'UserPromptSubmit', { prompt: '같은 프롬프트' });

    expect(collector.getActiveTurnId('s-echo')).toBe(firstTurnId);
    expect(store.listTurns(runId).length).toBe(1);

    // A different prompt is a genuine new turn.
    collector.ingestHook('s-echo', 'UserPromptSubmit', { prompt: '다른 프롬프트' });
    expect(store.listTurns(runId).length).toBe(2);
  });

  it('treats a same-prompt re-send after a response or tool use as a new turn', async () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's-resend', agentType: 'claude-code', projectName: 'p' });

    collector.ingestHook('s-resend', 'UserPromptSubmit', { prompt: '반복 질문' });
    collector.setTurnResponse('s-resend', '첫 번째 답변');
    collector.ingestHook('s-resend', 'UserPromptSubmit', { prompt: '반복 질문' });
    expect(store.listTurns(runId).length).toBe(2);

    // Tool activity also releases the guard.
    collector.ingestHook('s-resend', 'PreToolUse', { tool_name: 'Bash' });
    collector.ingestHook('s-resend', 'UserPromptSubmit', { prompt: '반복 질문' });
    expect(store.listTurns(runId).length).toBe(3);
  });

  it('an agent_error span records the failure reason in the trajectory without closing the task', async () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's-err', agentType: 'openclaw', projectName: 'OpenClaw' });
    collector.ingestHook('s-err', 'UserPromptSubmit', { prompt: 'summarize today' });

    collector.ingestSpan('s-err', {
      traceId: 't', spanId: 'sp1', name: 'agentdeck.agent.error', kind: 'agent_error',
      ts: Date.now(),
      attributes: {
        'agentdeck.error_label': 'The AI service is temporarily overloaded. Please try again in a moment.',
        'agentdeck.error_detail': 'kind unavailable · run 95babe45',
      },
    });

    const taskId = store.listTasksForRun(runId)[0]?.id;
    expect(taskId).toBeTruthy();
    const sample = store.getSample(taskId!);
    const info = sample!.events.find((e) => e.kind === 'info');
    // Before this, a failed turn reached the eval as a turn_start with no
    // response and no annotation — indistinguishable from a dropped event.
    expect(info).toMatchObject({
      kind: 'info',
      label: 'The AI service is temporarily overloaded. Please try again in a moment.',
      detail: 'kind unavailable · run 95babe45',
    });
    // The task stays open: the agent may retry the same prompt, and the
    // boundary belongs to the adapter's idle-gap timer.
    expect(store.listTasksForRun(runId)[0].boundarySignal).toBe('open');
  });

  it('drops an agent_error span with no open task instead of inventing one', async () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's-err2', agentType: 'openclaw', projectName: 'OpenClaw' });
    collector.ingestSpan('s-err2', {
      traceId: 't', spanId: 'sp1', name: 'agentdeck.agent.error', kind: 'agent_error',
      ts: Date.now(),
      attributes: { 'agentdeck.error_label': 'boom' },
    });
    expect(store.listTasksForRun(runId).length).toBe(0);
  });
});
