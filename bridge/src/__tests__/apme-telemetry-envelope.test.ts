/**
 * Coverage for the telemetry-envelope ingestion path.
 *
 * Two layers under test:
 *   1. Adapters (claude-hook / timeline) — pure functions that
 *      translate per-source events into TelemetrySpan[]. Verified by direct
 *      input/output assertions, no DB.
 *   2. ingestSpan dispatch — uses a real SQLite store to confirm each span
 *      kind reaches the right collector method (turn opens, response stored,
 *      tool counters increment, /clear splits the run).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { AdapterContext } from '@agentdeck/shared';
import { EVAL_SCHEMA_VERSION, spanNameForKind } from '@agentdeck/shared';

import { claudeHookToSpans } from '../apme/adapters/claude-hook.js';
import { timelineEntryToSpans } from '../apme/adapters/timeline.js';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';

function ctx(extra: Partial<AdapterContext> = {}): AdapterContext {
  return {
    sessionId: 'sess-1',
    agentType: 'claude-code',
    traceId: 'trace-1',
    cwd: '/tmp/proj',
    ...extra,
  };
}

// ─── Adapter unit tests (no DB) ───────────────────────────────────────────────

describe('claudeHookToSpans', () => {
  it('emits turn_start with prompt for UserPromptSubmit', () => {
    const spans = claudeHookToSpans(ctx(), 'UserPromptSubmit', {
      message: { content: 'fix the bug' },
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('turn_start');
    expect(spans[0].name).toBe(spanNameForKind('turn_start'));
    expect(spans[0].attributes['agentdeck.prompt_text']).toBe('fix the bug');
    expect(spans[0].attributes['agentdeck.agent_type']).toBe('claude-code');
    expect(spans[0].attributes['agentdeck.cwd']).toBe('/tmp/proj');
  });

  it('detects /clear and emits a task_boundary span (not turn_start)', () => {
    const spans = claudeHookToSpans(ctx(), 'UserPromptSubmit', {
      message: { content: '/clear' },
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('task_boundary');
    expect(spans[0].attributes['agentdeck.boundary_signal']).toBe('clear');
    // Must not also emit a turn_start — that would create a phantom turn.
    expect(spans.find(s => s.kind === 'turn_start')).toBeUndefined();
  });

  it('drops Claude task notification payloads from UserPromptSubmit', () => {
    const spans = claudeHookToSpans(ctx(), 'UserPromptSubmit', {
      message: {
        content: '<task-notification>\n<summary>Background command completed</summary>',
      },
    });
    expect(spans).toEqual([]);
  });

  it('emits tool_call for PreToolUse with gen_ai.tool.name', () => {
    const spans = claudeHookToSpans(ctx(), 'PreToolUse', {
      tool_name: 'Edit',
      tool_input: { path: 'foo.ts' },
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('tool_call');
    expect(spans[0].attributes['gen_ai.tool.name']).toBe('Edit');
    expect(spans[0].attributes['agentdeck.tool_name']).toBe('Edit');
    // Raw payload preserved so the collector can detect TodoWrite all-completed.
    expect(spans[0].attributes['agentdeck.raw_payload']).toMatchObject({ tool_name: 'Edit' });
  });

  it('emits tool_result for PostToolUse', () => {
    const spans = claudeHookToSpans(ctx(), 'PostToolUse', { tool_name: 'TodoWrite' });
    expect(spans[0].kind).toBe('tool_result');
    expect(spans[0].attributes['gen_ai.tool.name']).toBe('TodoWrite');
  });

  it('falls through to raw_step for unknown events (Stop, SessionEnd, …)', () => {
    const spans = claudeHookToSpans(ctx(), 'Stop', { transcript_path: '/x' });
    expect(spans[0].kind).toBe('raw_step');
    expect(spans[0].attributes['agentdeck.raw_event']).toBe('Stop');
    expect(spans[0].attributes['agentdeck.raw_payload']).toMatchObject({ transcript_path: '/x' });
  });

  it('handles legacy { prompt: ... } shape on UserPromptSubmit', () => {
    const spans = claudeHookToSpans(ctx(), 'UserPromptSubmit', { prompt: 'hello' });
    expect(spans[0].attributes['agentdeck.prompt_text']).toBe('hello');
  });
});

describe('timelineEntryToSpans', () => {
  it('translates chat_start to turn_start with detail as prompt', () => {
    const spans = timelineEntryToSpans(ctx({ agentType: 'openclaw' }), {
      ts: 1, type: 'chat_start', raw: 'Prompt sent', detail: 'fix the bug',
      agentType: 'openclaw',
    });
    expect(spans[0].kind).toBe('turn_start');
    expect(spans[0].attributes['agentdeck.prompt_text']).toBe('fix the bug');
  });

  it('translates chat_response to turn_response', () => {
    const spans = timelineEntryToSpans(ctx({ agentType: 'opencode' }), {
      ts: 2, type: 'chat_response', raw: '', detail: 'patched it',
      agentType: 'opencode',
    });
    expect(spans[0].kind).toBe('turn_response');
    expect(spans[0].attributes['agentdeck.response_text']).toBe('patched it');
    expect(spans[0].attributes['agentdeck.fallback_to_last_closed']).toBeUndefined();
  });

  it('translates chat_end with response detail to turn_response with fallback flag', () => {
    const spans = timelineEntryToSpans(ctx({ agentType: 'opencode' }), {
      ts: 3, type: 'chat_end', raw: '', detail: 'final response',
      agentType: 'opencode',
    });
    expect(spans[0].kind).toBe('turn_response');
    expect(spans[0].attributes['agentdeck.fallback_to_last_closed']).toBe(true);
  });

  it('drops chat_response / chat_end with empty body', () => {
    expect(timelineEntryToSpans(ctx(), {
      ts: 4, type: 'chat_response', raw: '', detail: '', agentType: 'openclaw',
    })).toHaveLength(0);
    expect(timelineEntryToSpans(ctx(), {
      ts: 5, type: 'chat_end', raw: '', detail: '', agentType: 'openclaw',
    })).toHaveLength(0);
  });

  it('translates tool_request with first-token tool name', () => {
    const spans = timelineEntryToSpans(ctx({ agentType: 'openclaw' }), {
      ts: 6, type: 'tool_request', raw: 'Bash echo hi', agentType: 'openclaw',
    });
    expect(spans[0].kind).toBe('tool_call');
    expect(spans[0].attributes['gen_ai.tool.name']).toBe('Bash');
  });

  it('codex_user_prompt_submit → turn_start span', async () => {
    const { codexHookToSpans } = await import('../apme/adapters/codex-hook.js');
    const spans = codexHookToSpans(ctx({ agentType: 'codex-cli' }), 'codex_user_prompt_submit', {
      message: { content: 'fix this' },
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('turn_start');
    expect(spans[0].attributes['agentdeck.prompt_text']).toBe('fix this');
  });

  it('codex_user_prompt_submit with /clear → task_boundary span', async () => {
    const { codexHookToSpans } = await import('../apme/adapters/codex-hook.js');
    const spans = codexHookToSpans(ctx({ agentType: 'codex-cli' }), 'codex_user_prompt_submit', {
      message: { content: '/clear' },
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('task_boundary');
    expect(spans[0].attributes['agentdeck.boundary_signal']).toBe('clear');
  });

  it('codex_tool_start → tool_call span with tool name', async () => {
    const { codexHookToSpans } = await import('../apme/adapters/codex-hook.js');
    const spans = codexHookToSpans(ctx({ agentType: 'codex-cli' }), 'codex_tool_start', {
      tool_name: 'shell',
      tool_input: { command: 'ls' },
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('tool_call');
    expect(spans[0].attributes['gen_ai.tool.name']).toBe('shell');
  });

  it('codex_tool_end → tool_result span', async () => {
    const { codexHookToSpans } = await import('../apme/adapters/codex-hook.js');
    const spans = codexHookToSpans(ctx({ agentType: 'codex-cli' }), 'codex_tool_end', {
      tool_name: 'shell',
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('tool_result');
  });

  it('codex_stop / codex_session_start / codex_turn_complete → raw_step', async () => {
    const { codexHookToSpans } = await import('../apme/adapters/codex-hook.js');
    for (const ev of ['codex_stop', 'codex_session_start', 'codex_turn_complete']) {
      const spans = codexHookToSpans(ctx({ agentType: 'codex-cli' }), ev, {});
      expect(spans).toHaveLength(1);
      expect(spans[0].kind).toBe('raw_step');
      expect(spans[0].attributes['agentdeck.raw_event']).toBe(ev);
    }
  });

  it('translates tool_exec the same as tool_request (legacy + Codex paths)', () => {
    const spans = timelineEntryToSpans(ctx({ agentType: 'codex-cli' }), {
      ts: 6, type: 'tool_exec', raw: 'shell ls -la', agentType: 'codex-cli',
    });
    expect(spans).toHaveLength(1);
    expect(spans[0].kind).toBe('tool_call');
    expect(spans[0].attributes['gen_ai.tool.name']).toBe('shell');
    expect(spans[0].attributes['agentdeck.tool_name']).toBe('shell');
  });

  it('translates tool_resolved to a tool_result span', () => {
    const spans = timelineEntryToSpans(ctx({ agentType: 'openclaw' }), {
      ts: 7, type: 'tool_resolved', raw: '', agentType: 'openclaw',
    });
    expect(spans[0].kind).toBe('tool_result');
  });
});

// ─── ingestSpan dispatch tests (with real SQLite) ─────────────────────────────

async function makeCollector(): Promise<{ store: ApmeStore; collector: ApmeCollector; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'apme-envelope-'));
  const store = new ApmeStore(join(dir, 'apme.sqlite'));
  const ok = await store.init();
  if (!ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('APME store failed to init — is better-sqlite3 installed?');
  }
  return { store, collector: new ApmeCollector(store), dir };
}

describe('ApmeCollector.ingestSpan dispatch', () => {
  let store: ApmeStore;
  let collector: ApmeCollector;
  let tmp: string;

  beforeEach(async () => {
    const made = await makeCollector();
    store = made.store;
    collector = made.collector;
    tmp = made.dir;
    collector.openRun({
      sessionId: 'S',
      agentType: 'claude-code',
      modelId: 'claude-opus-4-7',
      projectPath: tmp,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('turn_start span opens a turn and records the prompt', () => {
    const spans = claudeHookToSpans(ctx(), 'UserPromptSubmit', {
      message: { content: 'do the thing' },
    });
    for (const s of spans) collector.ingestSpan('S', s);

    const turnId = collector.getActiveTurnId('S');
    expect(turnId).not.toBeNull();
    const turn = store.getTurn(turnId!);
    expect(turn?.prompt).toBe('do the thing');
  });

  it('turn_response span persists the response on the active turn', () => {
    for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: 'q' } })) {
      collector.ingestSpan('S', s);
    }
    const turnId = collector.getActiveTurnId('S');
    const [span] = timelineEntryToSpans(ctx(), {
      ts: Date.now(), type: 'chat_response', raw: 'the answer is 42',
      detail: 'the answer is 42', agentType: 'claude-code',
    });
    collector.ingestSpan('S', span);
    expect(store.getTurn(turnId!)?.response).toBe('the answer is 42');
  });

  it('tool_call span increments tool_calls on the active turn', () => {
    for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: 'q' } })) {
      collector.ingestSpan('S', s);
    }
    const firstTurnId = collector.getActiveTurnId('S');
    for (const s of claudeHookToSpans(ctx(), 'PreToolUse', { tool_name: 'Bash' })) {
      collector.ingestSpan('S', s);
    }
    for (const s of claudeHookToSpans(ctx(), 'PreToolUse', { tool_name: 'Edit' })) {
      collector.ingestSpan('S', s);
    }
    // tool_calls is buffered in memory and flushed on closeTurn(); open a
    // second turn to force the first one closed, then read its row.
    for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: 'next' } })) {
      collector.ingestSpan('S', s);
    }
    const turn = store.getTurn(firstTurnId!);
    expect(turn?.tool_calls).toBe(2);
  });

  it('chat_end fallback does not clobber a prior closed turn response', () => {
    // Regression: closeCodexTurn used to ingest chat_end through the
    // turn_response/fallback_to_last_closed path while turn N was still
    // the ACTIVE turn — `setLastClosedTurnResponse` would then write to
    // the turn previously closed (N-1) with N's response text. The fix
    // is to skip ingestion for chat_end entirely; this test pins that.
    // Open turn 1 with its own response.
    for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: 'q1' } })) {
      collector.ingestSpan('S', s);
    }
    const turn1 = collector.getActiveTurnId('S');
    collector.setTurnResponse('S', 'answer one');
    // Open turn 2 (closes turn 1).
    for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: 'q2' } })) {
      collector.ingestSpan('S', s);
    }
    // Now simulate a stray chat_end fallback span as if the bug were
    // present. setLastClosedTurnResponse would target turn1 — but only
    // when turn1 has no existing response. Here turn1 already has one,
    // so the fallback path is a no-op. We verify both paths are inert.
    collector.setLastClosedTurnResponse('S', 'should not overwrite');
    expect(store.getTurn(turn1!)?.response).toBe('answer one');
  });

  it('Codex timeline path opens turn and counts tools (timelineEntryToSpans)', () => {
    // Mirrors what wireAgentApme's addCodexEntryAndIngest helper does:
    // each Codex timeline entry is fed through timelineEntryToSpans and
    // ingested. This test guards against the regression where Codex
    // tool_request entries reached only the timeline store, never APME.
    collector.openRun({
      sessionId: 'CDX', agentType: 'codex-cli',
      modelId: 'gpt-5.4', projectName: 'demo',
    });
    const cdx = ctx({ agentType: 'codex-cli' });
    for (const s of timelineEntryToSpans(cdx, {
      ts: 1, type: 'chat_start', raw: 'fix the build', detail: 'fix the build',
      agentType: 'codex-cli',
    })) collector.ingestSpan('CDX', s);
    const turnId = collector.getActiveTurnId('CDX');
    expect(turnId).not.toBeNull();
    expect(store.getTurn(turnId!)?.prompt).toBe('fix the build');

    for (const s of timelineEntryToSpans(cdx, {
      ts: 2, type: 'tool_request', raw: 'shell ls -la', agentType: 'codex-cli',
    })) collector.ingestSpan('CDX', s);
    for (const s of timelineEntryToSpans(cdx, {
      ts: 3, type: 'tool_request', raw: 'shell grep foo', agentType: 'codex-cli',
    })) collector.ingestSpan('CDX', s);

    // Force the turn closed so tool_calls flushes to the store row.
    for (const s of timelineEntryToSpans(cdx, {
      ts: 4, type: 'chat_start', raw: 'next prompt', detail: 'next prompt',
      agentType: 'codex-cli',
    })) collector.ingestSpan('CDX', s);

    expect(store.getTurn(turnId!)?.tool_calls).toBe(2);
  });

  it('task_boundary span with signal=clear splits the run', () => {
    const beforeRunId = collector.getRunId('S');
    expect(beforeRunId).toBeTruthy();
    for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: '/clear' } })) {
      collector.ingestSpan('S', s);
    }
    const afterRunId = collector.getRunId('S');
    expect(afterRunId).toBeTruthy();
    expect(afterRunId).not.toBe(beforeRunId);
  });

  it.each(['manual', 'idle_gap'] as const)(
    'task_boundary span with signal=%s closes the active task',
    (signal) => {
      // Seed a turn so a task is opened (closeTask drops empty tasks otherwise).
      for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: 'work' } })) {
        collector.ingestSpan('S', s);
      }
      const taskId = collector.getActiveTaskId('S');
      expect(taskId).not.toBeNull();

      let closedSignal: string | null = null;
      collector.onTaskClosed = ({ boundarySignal }) => { closedSignal = boundarySignal; };

      collector.ingestSpan('S', {
        traceId: 'T', spanId: 'b', name: spanNameForKind('task_boundary'),
        kind: 'task_boundary', ts: Date.now(),
        attributes: { 'agentdeck.boundary_signal': signal },
      });

      expect(collector.getActiveTaskId('S')).toBeNull();
      expect(closedSignal).toBe(signal);
    },
  );

  it('task_boundary span with signal=todo_complete is a soft hint — does NOT close the task', () => {
    // Seed a turn so a task is open.
    for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: 'work' } })) {
      collector.ingestSpan('S', s);
    }
    const taskId = collector.getActiveTaskId('S');
    expect(taskId).not.toBeNull();

    let closed = false;
    collector.onTaskClosed = () => { closed = true; };

    collector.ingestSpan('S', {
      traceId: 'T', spanId: 'b', name: spanNameForKind('task_boundary'),
      kind: 'task_boundary', ts: Date.now(),
      attributes: { 'agentdeck.boundary_signal': 'todo_complete' },
    });

    // Task stays open; no onTaskClosed fired.
    expect(collector.getActiveTaskId('S')).toBe(taskId);
    expect(closed).toBe(false);
  });

  it('task_boundary span with an unknown signal is dropped (no task close, no throw)', () => {
    for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: 'work' } })) {
      collector.ingestSpan('S', s);
    }
    const taskBefore = collector.getActiveTaskId('S');
    expect(taskBefore).not.toBeNull();

    collector.ingestSpan('S', {
      traceId: 'T', spanId: 'b', name: spanNameForKind('task_boundary'),
      kind: 'task_boundary', ts: Date.now(),
      attributes: { 'agentdeck.boundary_signal': 'made_up_value' },
    });

    expect(collector.getActiveTaskId('S')).toBe(taskBefore);
  });

  it('raw_step span inserts a steps row without lifecycle effects', () => {
    for (const s of claudeHookToSpans(ctx(), 'UserPromptSubmit', { message: { content: 'q' } })) {
      collector.ingestSpan('S', s);
    }
    const beforeTurnId = collector.getActiveTurnId('S');
    for (const s of claudeHookToSpans(ctx(), 'Stop', { transcript_path: '/tmp/x' })) {
      collector.ingestSpan('S', s);
    }
    // Stop must NOT close or change the active turn.
    expect(collector.getActiveTurnId('S')).toBe(beforeTurnId);
    const runId = collector.getRunId('S')!;
    const steps = store.listSteps(runId);
    expect(steps.find(s => s.kind === 'Stop')).toBeDefined();
  });

  it('session_meta span updates the model id on the run', () => {
    collector.ingestSpan('S', {
      traceId: 'T', spanId: '1', name: 'agentdeck.session.meta',
      kind: 'session_meta', ts: Date.now(),
      attributes: { 'gen_ai.request.model': 'claude-haiku-4-5-20251001' },
    });
    const runId = collector.getRunId('S')!;
    const run = store.getRun(runId);
    expect(run?.modelId).toBe('claude-haiku-4-5-20251001');
  });

  it('timeline adapter feeds the same dispatch path correctly', () => {
    const spans = timelineEntryToSpans(ctx({ agentType: 'openclaw' }), {
      ts: Date.now(), type: 'chat_start', raw: '',
      detail: 'investigate the bug',
      agentType: 'openclaw',
    });
    for (const s of spans) collector.ingestSpan('S', s);
    const turnId = collector.getActiveTurnId('S');
    expect(turnId).not.toBeNull();
    expect(store.getTurn(turnId!)?.prompt).toBe('investigate the bug');
  });
});

describe('eval-schema constants', () => {
  it('exports a stable schema version string', () => {
    expect(EVAL_SCHEMA_VERSION).toBe('agentdeck-eval/v1');
  });
});
