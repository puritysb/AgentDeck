import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AddressInfo } from 'net';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';
import { ApmeRunner } from '../apme/runner.js';
import { ApmeHwSampler } from '../apme/hw-sampler.js';
import { ApmeRecommender } from '../apme/recommend.js';
import { handleApmeRequest } from '../apme/http.js';
import type { ApmeModule } from '../apme/index.js';

async function makeApme(): Promise<{ apme: ApmeModule; tmpDir: string } | null> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'apme-http-'));
  const store = new ApmeStore(join(tmpDir, 'apme.sqlite'));
  if (!(await store.init())) {
    rmSync(tmpDir, { recursive: true, force: true });
    return null;
  }
  const hwSampler = new ApmeHwSampler();
  const apme: ApmeModule = {
    store,
    collector: new ApmeCollector(store, hwSampler),
    runner: new ApmeRunner(store),
    hwSampler,
    recommender: new ApmeRecommender(store),
  };
  return { apme, tmpDir };
}

async function makeServer(apme: ApmeModule | null): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    void handleApmeRequest(req, res, apme).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end('not found');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}` };
}

describe('APME HTTP routes', () => {
  let apme: ApmeModule | null = null;
  let tmpDir: string | null = null;
  let server: Server | null = null;
  let base = '';

  beforeEach(async () => {
    const result = await makeApme();
    if (!result) return;
    apme = result.apme;
    tmpDir = result.tmpDir;
    const s = await makeServer(apme);
    server = s.server;
    base = s.base;
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    apme?.store.close();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    apme = null; tmpDir = null; server = null; base = '';
  });

  it('returns 503 when APME is not initialized', async () => {
    const noApme = await makeServer(null);
    try {
      const resp = await fetch(`${noApme.base}/apme/runs`);
      expect(resp.status).toBe(503);
      const body = await resp.json() as Record<string, unknown>;
      expect(body.error).toMatch(/APME not initialized/);
    } finally {
      await new Promise<void>((resolve) => noApme.server.close(() => resolve()));
    }
  });

  // A GET from this machine keeps local trust whatever page sent it, so the
  // only thing between a web page and the task history is this header.
  it('answers without Access-Control-Allow-Origin, so another origin cannot read task history', async () => {
    const response = await fetch(`${base}/apme/runs`, { headers: { Origin: 'https://evil.example' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('serves bounded cross-task communications without tool payloads or unrelated relations', async () => {
    const now = Date.now();
    for (const sid of ['sender', 'receiver']) {
      apme!.collector.openRun({ sessionId: sid, agentType: 'claude-code' });
      apme!.collector.ingestHook(sid, 'UserPromptSubmit', { prompt: 'private prompt omitted from graph' });
      apme!.collector.ingestHook(sid, 'PostToolUse', { tool_name: 'Read', tool_input: { private: 'tool payload' } });
      for (const [relation, ts, key] of [
        ['messaged', now - 1_000, 'recent'], ['messaged', now - 90_000_000, 'old'],
        ['waiting_on', now - 500, 'job'],
      ] as const) {
        apme!.collector.noteRelation(sid, { relation, direction: sid === 'sender' ? 'out' : 'in',
          phase: 'closed', peerSessionId: sid === 'sender' ? 'receiver' : 'sender',
          peerName: 'peer', evidence: 'test', detail: 'x'.repeat(300), ts, key, messageIntent: 'request', messageFingerprint: 'abc' });
      }
    }
    const response = await fetch(`${base}/apme/communications`);
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value.schema).toBe('agentdeck-communications/v1');
    expect(value.truncated).toBe(false);
    expect(value.events).toHaveLength(2);
    expect(new Set(value.events.map((e: { sessionId: string }) => e.sessionId))).toEqual(new Set(['sender', 'receiver']));
    expect(value.capturedAt - value.since).toBe(86_400_000);
    for (const event of value.events) {
      expect(event.relation).toBe('messaged');
      expect(event.messageIntent).toBe('request');
      expect(event.messageFingerprint).toBe('abc');
      expect(event.detail).toHaveLength(140);
      expect(event.input).toBeUndefined();
      expect(event.text).toBeUndefined();
      expect(typeof event.id).toBe('string');
    }
  });

  it('marks a capped communications feed partial and keeps the newest observations', async () => {
    apme!.collector.openRun({ sessionId: 'busy', agentType: 'claude-code' });
    apme!.collector.ingestHook('busy', 'UserPromptSubmit', { prompt: 'many messages' });
    const now = Date.now();
    for (let i = 0; i < 2001; i++) {
      apme!.collector.noteRelation('busy', { relation: 'messaged', direction: 'out', phase: 'closed',
        peerSessionId: 'peer', evidence: 'test', ts: now - i, key: String(i) });
    }
    const value = await (await fetch(`${base}/apme/communications`)).json();
    expect(value.truncated).toBe(true);
    expect(value.events).toHaveLength(2000);
    expect(value.events[0].ts).toBe(now);
    expect(value.events.at(-1).ts).toBe(now - 1999);
  });

  it('GET /apme/runs lists recent runs with evals and overall score', async () => {
    const runId = apme.collector.openRun({
      sessionId: 's1', agentType: 'claude-code', projectName: 'p', projectPath: '/tmp/p',
      taskPrompt: 'do thing',
    });
    apme.collector.closeRun('s1', 0, '/tmp/p');
    apme.store.insertEval({
      runId, layer: 'deterministic', metric: 'tests_pass', score: 1, createdAt: Date.now(),
    });
    apme.store.insertEval({
      runId, layer: 'llm_judge', metric: 'overall', score: 0.82,
      rubricVer: 1, judgeModel: 'mlx:qwen3-30b', createdAt: Date.now(),
    });

    const resp = await fetch(`${base}/apme/runs?limit=10`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { runs: Array<{ id: string; overallScore: number; evals: unknown[] }> };
    expect(body.runs.length).toBe(1);
    expect(body.runs[0].id).toBe(runId);
    expect(body.runs[0].overallScore).toBeCloseTo(0.82);
    expect(body.runs[0].evals.length).toBe(2);
  });

  it('GET /apme/runs filters by agent', async () => {
    apme.collector.openRun({ sessionId: 's-cc', agentType: 'claude-code', projectName: 'p' });
    apme.collector.closeRun('s-cc');
    apme.collector.openRun({ sessionId: 's-oc', agentType: 'openclaw', projectName: 'p' });
    apme.collector.closeRun('s-oc');

    const cc = await (await fetch(`${base}/apme/runs?agent=claude-code`)).json() as { runs: unknown[] };
    expect(cc.runs.length).toBe(1);
    const oc = await (await fetch(`${base}/apme/runs?agent=openclaw`)).json() as { runs: unknown[] };
    expect(oc.runs.length).toBe(1);
  });

  it('GET /apme/activity returns the stable, deduplicated activity projection', async () => {
    apme.collector.openRun({ sessionId: 'thread-activity', agentType: 'codex-cli', projectName: 'AgentDeck' });
    apme.collector.ingestHook('thread-activity', 'UserPromptSubmit', { prompt: 'Add activity view' });
    apme.collector.setTurnResponse('thread-activity', 'Done');
    apme.collector.noteTurnStop('thread-activity');
    apme.collector.closeRun('thread-activity');

    const resp = await fetch(`${base}/apme/activity`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as {
      schema: string;
      rows: Array<{ agentType: string; task: string; durationMs: number }>;
      agents: Array<{ agentType: string; taskCount: number }>;
    };
    expect(body.schema).toBe('agentdeck-activity/v1');
    expect(body.rows).toContainEqual(expect.objectContaining({
      agentType: 'codex-cli', task: 'Add activity view',
    }));
    expect(body.rows.find((row) => row.agentType === 'codex-cli')?.durationMs).toBeGreaterThanOrEqual(0);
    expect(body.agents).toContainEqual(expect.objectContaining({ agentType: 'codex-cli', taskCount: 1 }));
  });

  it('GET /apme/run/:id returns run detail with steps and evals', async () => {
    const runId = apme.collector.openRun({
      sessionId: 's', agentType: 'claude-code', projectName: 'p', projectPath: '/tmp/p',
    });
    apme.collector.ingestHook('s', 'PreToolUse', { tool_name: 'Edit' });
    apme.collector.closeRun('s', 0, '/tmp/p');

    const resp = await fetch(`${base}/apme/run/${runId}`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as {
      run: { id: string };
      steps: Array<{ kind: string }>;
      evals: unknown[];
    };
    expect(body.run.id).toBe(runId);
    expect(body.steps.length).toBe(1);
    expect(body.steps[0].kind).toBe('PreToolUse');
  });

  it('GET /apme/run/:id returns 404 for unknown runs', async () => {
    const resp = await fetch(`${base}/apme/run/nope`);
    expect(resp.status).toBe(404);
  });

  it('GET /apme/run/:id includes per-task rollup with attached evals', async () => {
    // Seed a run + a turn, record a TodoWrite all-completed hint (no longer a
    // boundary), then close the run — the task closes on the session_end boundary.
    const runId = apme!.collector.openRun({
      sessionId: 's-task', agentType: 'claude-code', projectName: 'p', projectPath: '/tmp/p',
    });
    apme!.collector.ingestHook('s-task', 'UserPromptSubmit', { message: { content: 'do it' } });
    apme!.collector.ingestHook('s-task', 'PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ status: 'completed', content: 'step' }] },
    });
    apme!.collector.closeRun('s-task', 0, '/tmp/p');

    // Manually attach a task_judge eval row so the API surfaces it.
    const tasks = apme!.store.listTasksForRun(runId);
    expect(tasks.length).toBeGreaterThan(0);
    const firstTaskId = tasks[0].id;
    apme!.store.insertEvalForTask({
      id: 0,
      runId,
      taskId: firstTaskId,
      layer: 'task_judge',
      metric: 'overall',
      score: 0.83,
      raw: null,
      rubricVer: 1,
      judgeModel: 'mlx',
      createdAt: Date.now(),
    });

    const resp = await fetch(`${base}/apme/run/${runId}`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as {
      tasks: Array<{
        id: string;
        boundarySignal: string;
        evals: Array<{ metric: string; score: number; layer: string }>;
      }>;
    };
    expect(body.tasks).toBeDefined();
    expect(body.tasks.length).toBeGreaterThan(0);
    // session_end boundary fired (TodoWrite all-completed is now a soft hint).
    expect(body.tasks.some((t) => t.boundarySignal === 'session_end')).toBe(true);
    // The seeded task_judge eval is attached
    const judged = body.tasks.find((t) => t.id === firstTaskId);
    expect(judged?.evals.some((e) => e.layer === 'task_judge' && e.metric === 'overall' && e.score === 0.83)).toBe(true);
  });

  it('GET /apme/tasks/:id returns task detail with evals + turns', async () => {
    const runId = apme!.collector.openRun({
      sessionId: 's-tasksingle', agentType: 'codex-cli', projectName: 'p', projectPath: '/tmp/p',
    });
    apme!.collector.ingestHook('s-tasksingle', 'UserPromptSubmit', { message: { content: 'a prompt' } });
    apme!.collector.ingestHook('s-tasksingle', 'PostToolUse', {
      tool_name: 'TodoWrite',
      tool_input: { todos: [{ status: 'completed', content: 'a' }] },
    });
    apme!.collector.closeRun('s-tasksingle', 0, '/tmp/p');

    const tasks = apme!.store.listTasksForRun(runId);
    expect(tasks.length).toBeGreaterThan(0);
    const tid = tasks[0].id;

    const resp = await fetch(`${base}/apme/tasks/${tid}`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as {
      task: { id: string; runId?: string; run_id?: string };
      evals: unknown[];
      turns: Array<{ task_id?: string; taskId?: string }>;
    };
    expect(body.task.id).toBe(tid);
    expect(Array.isArray(body.turns)).toBe(true);

    // 404 path
    const missing = await fetch(`${base}/apme/tasks/no-such-task`);
    expect(missing.status).toBe(404);
  });

  it('closeTaskExternal with manual signal records outcome + boundary_signal=manual', async () => {
    apme!.collector.openRun({ sessionId: 's-manual', agentType: 'openclaw', projectName: 'p' });
    apme!.collector.ingestHook('s-manual', 'UserPromptSubmit', { message: { content: 'hello' } });
    const closed = apme!.collector.closeTaskExternal('s-manual', 'manual', 'abandoned');
    expect(closed).toBe(true);

    // Closing again returns false (no active task left).
    const second = apme!.collector.closeTaskExternal('s-manual', 'manual');
    expect(second).toBe(false);

    apme!.collector.closeRun('s-manual');
    const runs = apme!.store.listRuns({ agentType: 'openclaw', limit: 5 });
    const tasks = apme!.store.listTasksForRun(runs[0].id);
    const manualTask = tasks.find((t) => t.boundarySignal === 'manual');
    expect(manualTask).toBeDefined();
    expect(manualTask?.outcome).toBe('abandoned');
  });

  it('GET /apme/scorecard returns model aggregates', async () => {
    const runId = apme.collector.openRun({
      sessionId: 's', agentType: 'claude-code', projectName: 'p',
    });
    apme.collector.updateModel('s', 'claude-opus-4-6');
    apme.collector.closeRun('s');
    apme.store.insertEval({
      runId, layer: 'llm_judge', metric: 'overall', score: 0.9, createdAt: Date.now(),
    });

    const resp = await fetch(`${base}/apme/scorecard`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { scorecards: Array<{ modelId: string; avgOverall: number }> };
    const opus = body.scorecards.find((s) => s.modelId === 'claude-opus-4-6');
    expect(opus).toBeDefined();
    expect(opus?.avgOverall).toBeCloseTo(0.9);
  });

  it('GET /apme/rubric/current returns seeded rubric v1', async () => {
    const resp = await fetch(`${base}/apme/rubric/current`);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { rubric: { version: number; prompt: string } };
    expect(body.rubric.version).toBe(1);
    expect(body.rubric.prompt).toContain('task_completion');
  });

  it('POST /apme/vibe records feedback and rejects unknown runs', async () => {
    const runId = apme.collector.openRun({ sessionId: 's', agentType: 'claude-code', projectName: 'p' });
    apme.collector.closeRun('s');

    const good = await fetch(`${base}/apme/vibe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, verdict: 'approve', note: 'nice' }),
    });
    expect(good.status).toBe(200);
    const vibe = apme.store.latestVibeForRun(runId);
    expect(vibe?.verdict).toBe('approve');
    expect(vibe?.note).toBe('nice');

    const bad = await fetch(`${base}/apme/vibe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: 'nope', verdict: 'approve' }),
    });
    expect(bad.status).toBe(404);

    const invalid = await fetch(`${base}/apme/vibe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, verdict: 'maybe' }),
    });
    expect(invalid.status).toBe(400);
  });

  it('POST /apme/recommend returns candidate list', async () => {
    // Seed enough runs for the recommender's min-runs threshold.
    for (let i = 0; i < 4; i++) {
      const id = apme.collector.openRun({ sessionId: `s${i}`, agentType: 'claude-code', projectName: 'p' });
      apme.collector.updateModel(`s${i}`, 'claude-opus-4-6');
      apme.collector.updateUsage(`s${i}`, {
        sessionDurationSec: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
        estimatedCostUsd: 0.1,
        sessionPercent: null, costSpent: null, costLimit: null, resetTime: null, resetDate: null,
      });
      apme.collector.closeRun(`s${i}`);
      apme.store.insertEval({ runId: id, layer: 'llm_judge', metric: 'overall', score: 0.8, createdAt: Date.now() });
    }

    const resp = await fetch(`${base}/apme/recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ budgetUsd: 100 }),
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as { candidates: Array<{ modelId: string; expectedScore: number }> };
    expect(body.candidates.length).toBeGreaterThan(0);
    expect(body.candidates[0].modelId).toBe('claude-opus-4-6');
    expect(body.candidates[0].expectedScore).toBeCloseTo(0.8);
  });

  it('unknown /apme/* path returns 404', async () => {
    const resp = await fetch(`${base}/apme/nonsense`);
    expect(resp.status).toBe(404);
  });
});
