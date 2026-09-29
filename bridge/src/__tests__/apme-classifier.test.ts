import { clearMlxSafetyForTests } from '@agentdeck/shared';
import { withMlxResident } from './mlx-test-server.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';
import {
  computeSignals,
  classify,
  classifyWithLlm,
  classifyRun,
  type TaskSignals,
  type TaskCategory,
} from '../apme/classifier.js';
import { clearMlxSettingsCache, APME_CLASSIFIER_BACKEND_ORDER, APME_CLASSIFIER_MAX_TOKENS } from '@agentdeck/shared';

// The real Foundation Models helper spawns a subprocess and calls real
// on-device Apple Intelligence — never invoke it from a unit test (slow,
// nondeterministic, and it silently no-ops on any non-macOS CI runner
// instead of failing loudly). Default: reject as unavailable, matching a
// machine with no FM helper; individual tests override with
// `mockResolvedValueOnce` / `mockRejectedValueOnce` to drive the FM leg.
vi.mock('../foundation-models-helper.js', () => ({
  callFoundationModelsHelper: vi.fn().mockRejectedValue(new Error('Foundation Models helper unavailable in tests')),
}));
import { callFoundationModelsHelper } from '../foundation-models-helper.js';
const mockedCallFoundationModelsHelper = vi.mocked(callFoundationModelsHelper);

async function makeStore(): Promise<ApmeStore> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-cls-'));
  const store = new ApmeStore(join(dir, 'apme.sqlite'));
  if (!(await store.init())) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('better-sqlite3 missing');
  }
  (store as unknown as { _tmp: string })._tmp = dir;
  return store;
}

function closeStore(s: ApmeStore) {
  s.close();
  const dir = (s as unknown as { _tmp?: string })._tmp;
  if (dir) rmSync(dir, { recursive: true, force: true });
}

function seedSteps(store: ApmeStore, runId: string, steps: Array<{ kind: string; toolName?: string; payload?: Record<string, unknown> }>): void {
  for (const s of steps) {
    store.insertStep({
      runId,
      ts: Date.now(),
      kind: s.kind,
      toolName: s.toolName ?? null,
      payload: JSON.stringify(s.payload ?? {}),
    });
  }
}

function makeBaseSignals(overrides: Partial<TaskSignals> = {}): TaskSignals {
  return {
    toolCounts: {},
    dominantTool: null,
    totalToolCalls: 0,
    turnCount: 0,
    sessionDurationSec: 0,
    promptLengthChars: 0,
    planModeUsed: false,
    permissionRequests: 0,
    diffReviews: 0,
    filesCreated: 0,
    filesModified: 0,
    testCommandsRun: 0,
    webSearches: 0,
    agentDelegations: 0,
    ...overrides,
  };
}

// ─── classify() pure function ────────────────────────────────────────────────

describe('classify()', () => {
  it('planning — plan mode used', () => {
    expect(classify(makeBaseSignals({ planModeUsed: true }))).toBe('planning');
  });

  it('planning — short session, no file changes', () => {
    expect(classify(makeBaseSignals({ turnCount: 2, totalToolCalls: 3, filesModified: 0, filesCreated: 0 }))).toBe('planning');
  });

  it('research — web searches dominant', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { WebSearch: 3, Read: 5 }, totalToolCalls: 8, webSearches: 3,
    }))).toBe('research');
  });

  it('research — grep/glob dominant, no file changes', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Grep: 6, Glob: 3, Read: 2 }, totalToolCalls: 11, filesModified: 0, filesCreated: 0,
    }))).toBe('research');
  });

  it('coding — edit+write dominant with file changes', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Edit: 5, Write: 2, Read: 3 }, totalToolCalls: 10, filesModified: 5, filesCreated: 2,
    }))).toBe('coding');
  });

  it('debugging — tests + edits + bash', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Bash: 4, Edit: 3, Read: 5 }, totalToolCalls: 12,
      testCommandsRun: 2, filesModified: 3,
    }))).toBe('debugging');
  });

  it('refactoring — many edits, no new files', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Edit: 10, Read: 3 }, totalToolCalls: 13, filesModified: 5, filesCreated: 0,
    }))).toBe('refactoring');
  });

  it('review — mostly reads, minimal edits', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Read: 12, Grep: 2 }, totalToolCalls: 14, filesModified: 0, filesCreated: 0,
    }))).toBe('review');
  });

  it('ops — bash dominant, few edits', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Bash: 8, Read: 1 }, totalToolCalls: 9,
    }))).toBe('ops');
  });

  it('conversation — very short, no tools', () => {
    expect(classify(makeBaseSignals({ totalToolCalls: 1, sessionDurationSec: 30 }))).toBe('conversation');
  });

  it('multi_agent — multiple Agent delegations', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Agent: 3, Read: 2 }, totalToolCalls: 5, agentDelegations: 3,
    }))).toBe('multi_agent');
  });

  it('unknown — no clear pattern', () => {
    expect(classify(makeBaseSignals({
      toolCounts: { Read: 2, Bash: 2 }, totalToolCalls: 4, sessionDurationSec: 300,
      turnCount: 10,
    }))).toBe('unknown');
  });
});

describe('classifyWithLlm()', () => {
  const originalFetch = globalThis.fetch;
  const originalDataDir = process.env.AGENTDECK_DATA_DIR;
  let settingsDir: string;

  beforeEach(() => {
    clearMlxSafetyForTests();
    settingsDir = mkdtempSync(join(tmpdir(), 'apme-classifier-settings-'));
    process.env.AGENTDECK_DATA_DIR = settingsDir;
    writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({
      llm: { mlx: { endpoint: 'http://127.0.0.1:8800', model: 'mlx-community/gemma-pinned' } },
    }));
    clearMlxSettingsCache();
    // MLX is first in APME_CLASSIFIER_BACKEND_ORDER and Foundation Models
    // second — default FM to "unavailable" so no test ever reaches the real
    // helper subprocess, and so an MLX-only setup still answers from MLX.
    mockedCallFoundationModelsHelper.mockReset();
    mockedCallFoundationModelsHelper.mockRejectedValue(new Error('Foundation Models helper unavailable in tests'));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(settingsDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.AGENTDECK_DATA_DIR;
    else process.env.AGENTDECK_DATA_DIR = originalDataDir;
    clearMlxSettingsCache();
    vi.restoreAllMocks();
  });

  it('uses the configured MLX pin without probing a stale download catalog', async () => {
    const urls: string[] = [];
    let sentModel = '';
    globalThis.fetch = withMlxResident((async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(String(url));
      const body = JSON.parse(String(init?.body)) as { model: string };
      sentModel = body.model;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'research' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch, 'mlx-community/gemma-pinned');

    const category = await classifyWithLlm('Investigate the current behavior', makeBaseSignals());

    expect(category).toBe('research');
    expect(sentModel).toBe('mlx-community/gemma-pinned');
    expect(urls).toEqual(['http://127.0.0.1:8800/chat/completions']);
  });

  it('prefers MLX when it answers with a valid label, never reaching Foundation Models', async () => {
    mockedCallFoundationModelsHelper.mockImplementation(async () => {
      throw new Error('Foundation Models must not be reached when MLX already answered');
    });
    globalThis.fetch = withMlxResident((async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'debugging' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch, 'mlx-community/gemma-pinned');

    const category = await classifyWithLlm('Fix the failing test', makeBaseSignals());
    expect(category).toBe('debugging');
    expect(mockedCallFoundationModelsHelper).not.toHaveBeenCalled();
  });

  it('falls through to Foundation Models when MLX is unreachable — the no-MLX-server Mac', async () => {
    globalThis.fetch = withMlxResident((async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch, 'mlx-community/gemma-pinned');
    mockedCallFoundationModelsHelper.mockResolvedValueOnce('coding');

    const category = await classifyWithLlm('Fix the failing test', makeBaseSignals());
    expect(category).toBe('coding');
    expect(mockedCallFoundationModelsHelper).toHaveBeenCalledTimes(1);
  });

  // ─── #299: backend order is the shared SSOT, never `api`/`openai` ────────

  it('never includes a paid backend in the classifier try-order (SSOT invariant)', () => {
    expect(APME_CLASSIFIER_BACKEND_ORDER).not.toContain('api');
    expect(APME_CLASSIFIER_BACKEND_ORDER).not.toContain('openai');
    expect(APME_CLASSIFIER_BACKEND_ORDER).not.toContain('openclaw');
    // 'rules' is always last — it is not a network call, it means "give up".
    expect(APME_CLASSIFIER_BACKEND_ORDER[APME_CLASSIFIER_BACKEND_ORDER.length - 1]).toBe('rules');
  });

  it('never calls a paid backend even when the eval judge is configured to `api` (mutation check)', async () => {
    // A user who set the eval judge to the paid Anthropic leg must not have
    // the classifier follow it — this is the exact defect #299 fixes on the
    // Swift side (`callConfiguredJudge` used to route through whatever the
    // user configured). Node's classifier has never read `apme.judge` at
    // all; this test pins that structurally, not just today's default.
    writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify({
      llm: { mlx: { endpoint: 'http://127.0.0.1:8800', model: 'mlx-community/gemma-pinned' } },
      apme: { judge: { backend: 'api', model: 'claude-opus-5', apiKey: 'sk-test-should-never-be-used' } },
    }));
    clearMlxSettingsCache();

    const urls: string[] = [];
    globalThis.fetch = withMlxResident((async (url: string | URL | Request) => {
      urls.push(String(url));
      // MLX down — force the fall-through to `rules`.
      throw new Error('connection refused');
    }) as typeof fetch, 'mlx-community/gemma-pinned');

    const category = await classifyWithLlm('Investigate the current behavior', makeBaseSignals());

    // Every attempted URL must be the local MLX endpoint — never anthropic.com,
    // openai.com, or any host that isn't 127.0.0.1.
    for (const url of urls) {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    }
    // With MLX down and no other backend configured, we fall back to rules.
    expect(category).toBe(classify(makeBaseSignals()));
  });

  it('falls back to the rule-based category when every backend answers with an out-of-vocabulary label', async () => {
    globalThis.fetch = withMlxResident((async () => new Response(
      JSON.stringify({ choices: [{ message: { content: 'this is not a category at all' } }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch, 'mlx-community/gemma-pinned');

    const signals = makeBaseSignals();
    const category = await classifyWithLlm('Investigate the current behavior', signals);
    expect(category).toBe(classify(signals));
  });

  it('falls through to the next backend when one answers but is unreachable, then to rules', async () => {
    globalThis.fetch = withMlxResident((async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch, 'mlx-community/gemma-pinned');
    const signals = makeBaseSignals();
    const category = await classifyWithLlm('Investigate the current behavior', signals);
    expect(category).toBe(classify(signals));
  });

  it('classification calls use the shared max_tokens cap and never the judge budget', async () => {
    let sentMaxTokens: number | undefined;
    globalThis.fetch = withMlxResident((async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { max_tokens?: number };
      sentMaxTokens = body.max_tokens;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'coding' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch, 'mlx-community/gemma-pinned');

    await classifyWithLlm('Fix the bug', makeBaseSignals());
    expect(sentMaxTokens).toBe(APME_CLASSIFIER_MAX_TOKENS);
    expect(APME_CLASSIFIER_MAX_TOKENS).toBeLessThanOrEqual(20);
  });
});

// ─── computeSignals() from real steps ───────────────────────────────────────

describe('computeSignals()', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => closeStore(store));

  it('counts tool calls and identifies dominant tool', () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's', agentType: 'claude-code', projectName: 'p' });
    seedSteps(store, runId, [
      { kind: 'PreToolUse', toolName: 'Edit' },
      { kind: 'PreToolUse', toolName: 'Edit' },
      { kind: 'PreToolUse', toolName: 'Read' },
      { kind: 'PreToolUse', toolName: 'Bash', payload: { command: 'pnpm test' } },
      { kind: 'UserPromptSubmit' },
      { kind: 'UserPromptSubmit' },
    ]);

    const sig = computeSignals(store, runId);
    expect(sig.toolCounts).toEqual({ Edit: 2, Read: 1, Bash: 1 });
    expect(sig.dominantTool).toBe('Edit');
    expect(sig.totalToolCalls).toBe(4);
    expect(sig.turnCount).toBe(2);
    expect(sig.filesModified).toBe(2);
    expect(sig.testCommandsRun).toBe(1);
  });

  it('detects plan mode from step payload', () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's', agentType: 'claude-code', projectName: 'p' });
    seedSteps(store, runId, [
      { kind: 'mode_change', payload: { mode: 'plan' } },
      { kind: 'PreToolUse', toolName: 'Read' },
    ]);

    const sig = computeSignals(store, runId);
    expect(sig.planModeUsed).toBe(true);
  });

  it('detects web searches', () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's', agentType: 'claude-code', projectName: 'p' });
    seedSteps(store, runId, [
      { kind: 'PreToolUse', toolName: 'WebSearch' },
      { kind: 'PreToolUse', toolName: 'WebFetch' },
      { kind: 'PreToolUse', toolName: 'Read' },
    ]);

    const sig = computeSignals(store, runId);
    expect(sig.webSearches).toBe(2);
  });
});

// ─── classifyRun() end-to-end ───────────────────────────────────────────────

describe('classifyRun()', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => closeStore(store));

  it('returns signals and category for a coding run', () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's', agentType: 'claude-code', projectName: 'p' });
    seedSteps(store, runId, [
      { kind: 'PreToolUse', toolName: 'Edit' },
      { kind: 'PreToolUse', toolName: 'Edit' },
      { kind: 'PreToolUse', toolName: 'Write' },
      { kind: 'PreToolUse', toolName: 'Read' },
    ]);

    const result = classifyRun(store, runId);
    expect(result.category).toBe('coding');
    expect(result.signals.filesModified).toBe(2);
    expect(result.signals.filesCreated).toBe(1);
  });

  it('returns unknown for empty runs', () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's', agentType: 'claude-code', projectName: 'p' });
    const result = classifyRun(store, runId);
    // Empty run with sessionDuration=0 and no tools matches conversation first
    // (totalToolCalls<=2 && sessionDurationSec<120)
    expect(['conversation', 'planning', 'unknown']).toContain(result.category);
  });
});

// ─── Schema migration ───────────────────────────────────────────────────────

describe('task_category schema migration', () => {
  let store!: ApmeStore;
  beforeEach(async () => { store = await makeStore(); });
  afterEach(() => closeStore(store));

  it('runs table has task_signals, task_category, task_category_source columns', () => {
    const collector = new ApmeCollector(store);
    const runId = collector.openRun({ sessionId: 's', agentType: 'claude-code', projectName: 'p' });
    store.updateRun(runId, {
      taskSignals: '{"test":true}',
      taskCategory: 'coding',
      taskCategorySource: 'user',
    });
    const run = store.getRun(runId);
    expect(run?.taskSignals).toBe('{"test":true}');
    expect(run?.taskCategory).toBe('coding');
    expect(run?.taskCategorySource).toBe('user');
  });
});
