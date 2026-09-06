import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vectors from '../../../shared/apme-judge-response-vectors.json';
import { ApmeStore } from '../apme/store.js';
import { ApmeRunner, callJudgeWithMeta, parseJudgeJson } from '../apme/runner.js';
import { ApmeCollector } from '../apme/collector.js';
import { DEFAULT_APME_CONFIG } from '../apme/settings.js';

const answer = JSON.stringify({
  completion: 0.8,
  coherence: 0.8,
  efficiency: 0.7,
  overall: 0.8,
  summary: 'Added regression coverage.',
  reasoning: 'The requested test was added.',
  done: ['test'],
  missed: [],
});
const response = () =>
  new Response(JSON.stringify({ choices: [{ message: { content: answer }, finish_reason: 'stop' }] }));

describe('Ollama-compatible task judge persistence and recovery', () => {
  let dir: string;
  let store: ApmeStore;
  let runner: ApmeRunner;
  let runId: string;
  let taskId: string;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ad-serving-test-'));
    store = new ApmeStore(join(dir, 'apme.sqlite'));
    expect(await store.init()).toBe(true);
    const collector = new ApmeCollector(store);
    runId = collector.openRun({ sessionId: 'serving-test', agentType: 'claude-code', projectName: 'fixture' })!;
    collector.ingestHook('serving-test', 'UserPromptSubmit', {
      prompt: 'Add a regression test for missing configuration files.',
    });
    collector.setTurnResponse(
      'serving-test',
      'Added and ran the regression test. The missing-file path now returns the default configuration.',
    );
    collector.closeTaskExternal('serving-test', 'manual');
    taskId = store.listTasksForRun(runId)[0].id;
    store.updateTask(taskId, { outcome: 'abandoned' });
    runner = new ApmeRunner(store);
    runner._setConfig({
      ...DEFAULT_APME_CONFIG,
      enabled: true,
      deterministic: { enabled: false, timeoutSec: 1, commands: {} },
      judge: {
        backend: 'openai',
        model: 'foundby-gemma4-ad:16k',
        endpoint: 'http://127.0.0.1:11434/v1',
        reasoningEffort: 'none',
        fallbackToMlx: false,
        fallbackToFoundationModels: false,
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  async function settled() {
    await vi.waitFor(() => expect(runner.inFlightTaskEvals).toBe(0));
  }
  it.each(['http', 'json', 'timeout', 'length', 'empty'])(
    'leaves no score after %s failure and persists on recovery',
    async (kind) => {
      const fetcher = vi
        .fn()
        .mockImplementationOnce(async (_url, options) => {
          expect(options.signal).toBeInstanceOf(AbortSignal);
          expect(JSON.parse(options.body).reasoning_effort).toBe('none');
          if (kind === 'empty') return new Response(JSON.stringify({ choices: [{ message: { content: '  ' } }] }));
          if (kind === 'http') return new Response('unavailable', { status: 503 });
          if (kind === 'json') return new Response(JSON.stringify({ choices: [{ message: { content: 'not JSON' } }] }));
          // Cut mid-object — the only shape the output-limit rule still
          // refuses. A `length` response whose JSON closed is a finished
          // verdict and is now accepted (#286 item 3).
          if (kind === 'length')
            return new Response(
              JSON.stringify({ choices: [{ message: { content: answer.slice(0, 30) }, finish_reason: 'length' }] }),
            );
          throw new DOMException('request timed out', 'TimeoutError');
        })
        .mockImplementation(async () => response());
      vi.stubGlobal('fetch', fetcher);
      runner.enqueueTask({ runId, taskId });
      await settled();
      expect(store.listEvalsForTask(taskId)).toHaveLength(0);
      expect(store.getTask(taskId)?.compositeScore).toBeNull();
      let storedAtEvent = 0;
      runner.onTaskEvaluated(() => {
        storedAtEvent = store.listEvalsForTask(taskId).length;
      });
      runner.enqueueTask({ runId, taskId });
      await settled();
      const rows = store.listEvalsForTask(taskId).filter((r) => r.layer === 'task_judge');
      expect(rows.map((r) => r.metric).sort()).toEqual(['coherence', 'completion', 'efficiency', 'overall']);
      expect(rows.every((r) => r.judgeModel === 'openai:foundby-gemma4-ad:16k')).toBe(true);
      expect(storedAtEvent).toBe(store.listEvalsForTask(taskId).length);
      expect(store.getTask(taskId)?.summary).toBe('Added regression coverage.');
      expect(store.getTask(taskId)?.outcome).toBe('abandoned');
      expect(rows.every((row) => row.runId === runId)).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it('coalesces duplicate in-flight task requests', async () => {
    let release!: () => void;
    const latch = new Promise<void>((r) => {
      release = r;
    });
    const fetcher = vi.fn(async () => {
      await latch;
      return response();
    });
    vi.stubGlobal('fetch', fetcher);
    runner.enqueueTask({ runId, taskId });
    runner.enqueueTask({ runId, taskId });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    release();
    await settled();
    expect(store.listEvalsForTask(taskId).filter((r) => r.layer === 'task_judge')).toHaveLength(4);
  });
});

describe('incomplete judge response', () => {
  afterEach(() => vi.unstubAllGlobals());
  const call = (backend: 'mlx' | 'openai') =>
    callJudgeWithMeta('judge', {
      ...DEFAULT_APME_CONFIG.judge,
      backend,
      model: 'gemma-test',
      endpoint: 'http://127.0.0.1:8800/v1/chat/completions',
      fallbackToMlx: false,
      fallbackToFoundationModels: false,
    });
  const serve = (content: string, finish_reason: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason }] }))),
    );

  it.each(['mlx', 'openai'] as const)('%s rejects a response cut mid-object', async (backend) => {
    serve(answer.slice(0, 30), 'length');
    await expect(call(backend)).rejects.toThrow(/output limit/);
  });

  // The rule is about the body, not the flag. A cut that landed after the JSON
  // object closed left a finished verdict; rejecting it dropped a good verdict
  // and, on the default chain, rerouted to the Foundation Models floor.
  it.each(['mlx', 'openai'] as const)('%s accepts a closed object at the output limit', async (backend) => {
    serve(`${answer} …and then the model kept talking`, 'length');
    await expect(call(backend)).resolves.toHaveProperty('text');
  });

  // Node indexed `json.choices?.[0]`, which reads this happily; Swift's
  // `as? [[String: Any]]` cast rejected it. Nothing pinned the disagreement.
  it.each(['mlx', 'openai'] as const)('%s rejects choices that is not an array', async (backend) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ choices: { 0: { message: { content: answer } } } }))),
    );
    await expect(call(backend)).rejects.toThrow(/no choices/);
  });
});

// These exact HTTP envelopes are also replayed by macOS ApmeParseJudgeTests.
describe.each(['mlx', 'openai'] as const)('%s shared response contract', (backend) => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(vectors)('$note', async (vector) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(vector.response))),
    );
    const result = callJudgeWithMeta('judge', {
      ...DEFAULT_APME_CONFIG.judge,
      backend,
      model: 'fixture-model',
      endpoint: 'http://127.0.0.1:8800/v1/chat/completions',
      fallbackToMlx: false,
      fallbackToFoundationModels: false,
    });
    if (vector.accepted) {
      // Accepted means accepted as a VERDICT, not merely returned by the gate —
      // the same assertion macOS ApmeParseJudgeTests makes, so the vectors pin
      // both daemons end to end rather than one at the transport and one at the
      // parser.
      const { text } = await result;
      expect(parseJudgeJson(text)).not.toBeNull();
    } else {
      await expect(result).rejects.toThrow();
    }
  });
});

describe('optional OpenAI-compatible reasoning control', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([undefined, 'none', 'high'] as const)('sends only the requested effort: %s', async (reasoningEffort) => {
    const fetcher = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetcher);
    await callJudgeWithMeta('judge', {
      ...DEFAULT_APME_CONFIG.judge,
      backend: 'openai',
      model: 'fixture-model',
      endpoint: 'http://127.0.0.1:11434/v1',
      reasoningEffort,
      fallbackToMlx: false,
      fallbackToFoundationModels: false,
    });
    const request = JSON.parse((fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    if (reasoningEffort === undefined) expect(request).not.toHaveProperty('reasoning_effort');
    else expect(request.reasoning_effort).toBe(reasoningEffort);
  });
});

// The backlog drain feeds ONE task per tick, taken from a query ordered by
// `ended_at DESC`. A task whose judge call fails every attempt therefore owns
// that head, and `enqueueTask` drops a parked task silently — so every tick
// spent its one slot on it and everything behind it starved. Measured
// 2026-09-06: 156 closed tasks from 2026-08-07..23 unjudged for two weeks
// while the day's own tasks were judged normally by the live close path.
describe('task judge backlog drain', () => {
  let dir: string;
  let store: ApmeStore;
  let runner: ApmeRunner;
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ad-drain-test-'));
    store = new ApmeStore(join(dir, 'apme.sqlite'));
    expect(await store.init()).toBe(true);
    runner = new ApmeRunner(store);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function poison(taskId: string) {
    // Two failed attempts is the park threshold; a judge that answers nothing
    // parseable is the cheapest way to reach it.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not JSON' } }] }))));
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: taskId, agentType: 'claude-code', projectName: 'fixture' })!;
    collector.ingestHook(taskId, 'UserPromptSubmit', {
      prompt: 'Add a regression test for missing configuration files.',
    });
    collector.setTurnResponse(
      taskId,
      'Added and ran the regression test. The missing-file path now returns the default configuration.',
    );
    collector.closeTaskExternal(taskId, 'manual');
    const id = store.listTasksForRun(runId)[0].id;
    runner._setConfig({
      ...DEFAULT_APME_CONFIG,
      enabled: true,
      deterministic: { enabled: false, timeoutSec: 1, commands: {} },
      judge: { backend: 'openai', model: 'm', endpoint: 'http://127.0.0.1:11434/v1', fallbackToMlx: false, fallbackToFoundationModels: false },
    });
    for (let i = 0; i < 2; i++) {
      runner.enqueueTask({ runId, taskId: id });
      await vi.waitFor(() => expect(runner.inFlightTaskEvals).toBe(0));
    }
    return id;
  }

  it('skips the parked head instead of spending the tick on it', async () => {
    const parked = await poison('poison-session');
    expect(runner.isTaskParked(parked)).toBe(true);
    const backlog = [{ id: parked }, { id: 'next-in-line' }, { id: 'after-that' }];
    expect(runner.pickBacklogTasks(backlog, 1)).toEqual([{ id: 'next-in-line' }]);
  });

  it('still feeds one task per tick', () => {
    const backlog = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(runner.pickBacklogTasks(backlog, 1)).toEqual([{ id: 'a' }]);
  });

  it('feeds nothing when every candidate is parked, and says so once', async () => {
    const parked = await poison('poison-session');
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      lines.push(String(chunk));
      return true;
    });
    try {
      expect(runner.pickBacklogTasks([{ id: parked }], 1)).toEqual([]);
      // Silence is what let the original stall run for two weeks — but a line
      // per 30s tick is its own kind of unreadable, so it is throttled.
      expect(runner.pickBacklogTasks([{ id: parked }], 1)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    const said = lines.filter((l) => l.includes('backlog candidate(s) in the window are parked'));
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('all 1 backlog candidate(s)');
  });
});
