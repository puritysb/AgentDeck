/**
 * Integration test: Timeline pipeline — store, dedup, upsert, broadcast.
 *
 * Tests the BridgeTimelineStore with deduplication, event listeners,
 * and the full enrichment pipeline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BridgeTimelineStore } from '../timeline-store.js';
import type { TimelineEntry } from '../types.js';
import { deduplicateEntry } from '@agentdeck/shared';

function makeEntry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    ts: Date.now() / 1000,
    type: 'tool_request',
    raw: 'Read /src/index.ts',
    ...overrides,
  };
}

// ─── BridgeTimelineStore ────────────────────────────────────────────

describe('BridgeTimelineStore', () => {
  let store: BridgeTimelineStore;

  beforeEach(() => {
    store = new BridgeTimelineStore();
  });

  it('adds and retrieves entries', () => {
    store.addEntry(makeEntry({ ts: 100, raw: 'Read /foo.ts' }));
    store.addEntry(makeEntry({ ts: 200, raw: 'Edit /bar.ts' }));

    const history = store.getHistory();
    expect(history).toHaveLength(2);
    expect(history[0].ts).toBe(100);
    expect(history[1].ts).toBe(200);
  });

  it('filters history by timestamp', () => {
    store.addEntry(makeEntry({ ts: 100, raw: 'Read /a.ts' }));
    store.addEntry(makeEntry({ ts: 200, raw: 'Edit /b.ts' }));
    store.addEntry(makeEntry({ ts: 300, raw: 'Write /c.ts' }));

    const since = store.getHistory(150);
    expect(since).toHaveLength(2);
    expect(since[0].ts).toBe(200);
  });

  it('normalizes OpenClaw cron prompt dumps before storing history', () => {
    store.addEntry(makeEntry({
      ts: 100,
      type: 'model_call',
      raw: '[cron:abc self-improvement-daily-review-2350] 입력 수집:\n1. ls -lt 사용\n2. tail -50 사용',
      detail: '[cron:abc self-improvement-daily-review-2350] 입력 수집:\n1. ls -lt 사용\n2. tail -50 사용',
      agentType: 'openclaw',
      automated: true,
    }));

    const history = store.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      raw: '자동 작업 · self improvement daily review 2350',
      detail: undefined,
      automated: true,
      summaryKind: 'heuristic',
    });
  });

  it('drops low-signal OpenClaw placeholder tool rows before broadcast/history', () => {
    const received: TimelineEntry[] = [];
    store.onEntry((entry) => received.push(entry));
    store.addEntry(makeEntry({
      ts: 100,
      type: 'tool_exec',
      raw: 'tool · failed',
      detail: 'status: failed',
      agentType: 'openclaw',
    }));

    expect(store.getHistory()).toHaveLength(0);
    expect(received).toHaveLength(0);
  });

  it('calls listeners on new entries', () => {
    const received: Array<{ entry: TimelineEntry; upsert?: boolean }> = [];
    store.onEntry((entry, upsert) => received.push({ entry, upsert }));

    store.addEntry(makeEntry({ ts: 100 }));
    expect(received).toHaveLength(1);
    expect(received[0].upsert).toBeUndefined();
  });

  it('upsert updates existing entry with same ts+type', () => {
    store.addEntry(makeEntry({ ts: 100, type: 'chat_end', raw: 'Original' }));

    const received: Array<{ entry: TimelineEntry; upsert?: boolean }> = [];
    store.onEntry((entry, upsert) => received.push({ entry, upsert }));

    store.upsertEntry(makeEntry({ ts: 100, type: 'chat_end', raw: 'Updated', detail: 'LLM summary' }));

    // Should update in place
    const history = store.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].raw).toBe('Updated');
    expect(history[0].detail).toBe('LLM summary');

    // Listener called with upsert=true
    expect(received).toHaveLength(1);
    expect(received[0].upsert).toBe(true);
  });

  it('upsert keeps timeline attribution fields', () => {
    store.addEntry(makeEntry({ ts: 100, type: 'chat_end', raw: 'Original' }));
    store.upsertEntry(makeEntry({
      ts: 100,
      type: 'chat_end',
      raw: 'Updated',
      projectName: 'AgentDeck',
      sessionId: 'session-1',
    }));

    const history = store.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].projectName).toBe('AgentDeck');
    expect(history[0].sessionId).toBe('session-1');
  });

  it('upsert adds new entry when no match exists', () => {
    store.addEntry(makeEntry({ ts: 100, type: 'tool_request' }));
    store.upsertEntry(makeEntry({ ts: 200, type: 'chat_end', raw: 'New entry' }));

    expect(store.getHistory()).toHaveLength(2);
  });

  it('task_end updates in place by taskId and carries judge fields', () => {
    const received: Array<{ entry: TimelineEntry; upsert?: boolean }> = [];
    store.onEntry((entry, upsert) => received.push({ entry, upsert }));

    store.addEntry(makeEntry({
      ts: 1_000,
      type: 'task_end',
      raw: 'Session end · 10s',
      taskId: 'task-1',
      sessionId: 'session-1',
      startedAt: 0,
      endedAt: 1_000,
    }));
    store.addEntry(makeEntry({
      ts: 1_000,
      type: 'task_end',
      raw: 'Session end · 10s',
      taskId: 'task-1',
      sessionId: 'session-1',
      startedAt: 0,
      endedAt: 1_000,
      taskScore: 0.91,
      taskOutcome: 'committed',
      taskCategory: 'code',
      taskSummary: 'Implemented and verified',
    }));

    const history = store.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      taskId: 'task-1',
      taskScore: 0.91,
      taskOutcome: 'committed',
      taskCategory: 'code',
      taskSummary: 'Implemented and verified',
    });
    expect(received).toHaveLength(2);
    expect(received[1].upsert).toBe(true);
  });

  it('updateEntryStatus updates approval status', () => {
    store.addEntry(makeEntry({ ts: 100, type: 'tool_request', approvalId: 'abc-123', status: 'pending' }));

    store.updateEntryStatus('abc-123', 'approved');

    const history = store.getHistory();
    expect(history[0].status).toBe('approved');
  });

  it('getLastEntry returns most recent of given type', () => {
    store.addEntry(makeEntry({ ts: 100, type: 'tool_request', raw: 'First' }));
    store.addEntry(makeEntry({ ts: 200, type: 'chat_end', raw: 'Middle' }));
    store.addEntry(makeEntry({ ts: 300, type: 'tool_request', raw: 'Latest' }));

    const last = store.getLastEntry('tool_request');
    expect(last).not.toBeNull();
    expect(last!.raw).toBe('Latest');
  });

  it('getLastEntry returns null when type not found', () => {
    store.addEntry(makeEntry({ type: 'tool_request' }));
    expect(store.getLastEntry('chat_end')).toBeNull();
  });

  it('removeListener stops notifications', () => {
    let count = 0;
    const cb = () => { count++; };

    store.onEntry(cb);
    store.addEntry(makeEntry({ ts: 100 }));
    expect(count).toBe(1);

    store.removeListener(cb);
    store.addEntry(makeEntry({ ts: 200 }));
    expect(count).toBe(1); // No additional call
  });

  it('enforces MAX_ENTRIES (200) with FIFO', () => {
    for (let i = 0; i < 210; i++) {
      store.addEntry(makeEntry({ ts: i, raw: `Entry ${i}` }));
    }

    const history = store.getHistory();
    expect(history.length).toBeLessThanOrEqual(200);
    // Oldest entries should be trimmed
    expect(history[0].ts).toBeGreaterThanOrEqual(10);
  });
});

// ─── Deduplication pipeline ─────────────────────────────────────────

describe('deduplicateEntry pipeline', () => {
  it('exact duplicate within 8s → skip', () => {
    const now = Date.now() / 1000;
    const entries = [makeEntry({ ts: now, type: 'tool_request', raw: 'Read /foo.ts' })];

    const result = deduplicateEntry(
      makeEntry({ ts: now + 2, type: 'tool_request', raw: 'Read /foo.ts' }),
      entries,
    );

    expect(result.action).toBe('skip');
  });

  it('same type, different content → add', () => {
    const now = Date.now() / 1000;
    const entries = [makeEntry({ ts: now, type: 'tool_request', raw: 'Read /foo.ts' })];

    const result = deduplicateEntry(
      makeEntry({ ts: now + 10, type: 'tool_request', raw: 'Read /bar.ts' }),
      entries,
    );

    expect(result.action).toBe('add');
  });

  it('different type, same raw → add', () => {
    const now = Date.now() / 1000;
    const entries = [makeEntry({ ts: now, type: 'tool_request', raw: 'test' })];

    const result = deduplicateEntry(
      makeEntry({ ts: now + 1, type: 'chat_end', raw: 'test' }),
      entries,
    );

    expect(result.action).toBe('add');
  });

  it('chat_response identical raw 6s apart → skip (PTY/Stop race)', () => {
    // Regression: Stop hook arriving >5s after PTY fallback used to slip past
    // the old 5s exact-dedup window, producing two identical chat_response
    // lines on the dashboard. Window was widened to 8s.
    const now = Date.now();
    const entries = [
      makeEntry({ ts: now, type: 'chat_response', raw: 'GUI freeze 해소 - AuthManager fix 작동' }),
    ];

    const result = deduplicateEntry(
      makeEntry({ ts: now + 6000, type: 'chat_response', raw: 'GUI freeze 해소 - AuthManager fix 작동' }),
      entries,
    );

    expect(result.action).toBe('skip');
  });

  it('chat_response near-duplicate beyond 8s → repetitive merge', () => {
    // When PTY ringbuffer text and transcript JSONL produce SLIGHTLY different
    // raws (markdown markers / whitespace) and arrive >8s apart, exact dedup
    // misses but repetitive dedup (1h window, 60% keyword overlap) catches it.
    const now = Date.now();
    const entries = [
      makeEntry({ ts: now, type: 'chat_response', raw: 'Refactored auth flow and added unit tests for login.' }),
    ];

    const result = deduplicateEntry(
      makeEntry({
        ts: now + 12_000,
        type: 'chat_response',
        raw: 'Refactored auth flow and added unit tests for login.',
      }),
      entries,
    );

    // Same content beyond exact window → repetitive dedup merges
    expect(result.action).toBe('merge');
  });
});

// ─── Storage-time attribution (history replay regression) ─────────
//
// History replay (`timeline_history`) reads from BridgeTimelineStore.entries.
// If attribution only happens at broadcast time, those entries are stored
// without taskId/runId/sessionId/projectName, and reconnecting clients see
// orphaned rows. Fix: BridgeTimelineStore.setAttributor — runs the
// attributor inline at addEntry/upsertEntry time so storage and broadcast
// are byte-identical.

describe('BridgeTimelineStore.setAttributor — history replay attribution', () => {
  it('addEntry passes the entry through the attributor before storage', () => {
    const store = new BridgeTimelineStore();
    store.setAttributor((e) => ({
      ...e,
      sessionId: e.sessionId ?? 'sess-X',
      taskId: e.taskId ?? 'task-X',
      runId: e.runId ?? 'run-X',
      projectName: e.projectName ?? 'AgentDeck',
    }));

    store.addEntry({ ts: 1, type: 'chat_start', raw: 'first prompt' });

    const stored = store.getHistory()[0];
    expect(stored.sessionId).toBe('sess-X');
    expect(stored.taskId).toBe('task-X');
    expect(stored.runId).toBe('run-X');
    expect(stored.projectName).toBe('AgentDeck');
  });

  it('caller-set fields take precedence over attributor (idempotent)', () => {
    const store = new BridgeTimelineStore();
    store.setAttributor((e) => ({ ...e, sessionId: e.sessionId ?? 'fallback', taskId: e.taskId ?? 'fallback-task' }));

    store.addEntry({
      ts: 1, type: 'chat_start', raw: 'x',
      sessionId: 'caller-sid', taskId: 'caller-task',
    });

    const stored = store.getHistory()[0];
    expect(stored.sessionId).toBe('caller-sid');
    expect(stored.taskId).toBe('caller-task');
  });

  it('listener (broadcast) receives the same attributed entry', () => {
    const store = new BridgeTimelineStore();
    store.setAttributor((e) => ({ ...e, taskId: e.taskId ?? 'task-Y' }));
    let observed: { taskId?: string } | null = null;
    store.onEntry((entry) => { observed = { taskId: entry.taskId }; });

    store.addEntry({ ts: 1, type: 'chat_start', raw: 'x' });

    expect(observed).not.toBeNull();
    expect(observed!.taskId).toBe('task-Y');
  });

  it('upsertEntry propagates summaryKind to existing entry (LLM enrichment regression)', () => {
    // First emit: heuristic gave up → summaryKind: 'none' → detail pane is suppressed.
    // Async LLM lands later and upserts with summaryKind: 'llm' + a real summary.
    // Without the fix, upsertEntry's spread didn't include summaryKind, so the
    // dashboard kept seeing 'none' forever and never re-enabled the detail pane.
    const store = new BridgeTimelineStore();
    store.addEntry({
      ts: 1_000, type: 'chat_end',
      raw: 'Completed · 4s',
      detail: 'response body',
      summaryKind: 'none',
    });
    expect(store.getHistory()[0].summaryKind).toBe('none');

    store.upsertEntry({
      ts: 1_000, type: 'chat_end',
      raw: 'Refactored timeline store · 4s',
      summaryKind: 'llm',
    });

    const after = store.getHistory()[0];
    expect(after.summaryKind).toBe('llm');
    expect(after.raw).toBe('Refactored timeline store · 4s');
  });

  it('upsertEntry routes through the attributor too', () => {
    const store = new BridgeTimelineStore();
    store.setAttributor((e) => ({ ...e, taskId: e.taskId ?? 'task-Z', sessionId: e.sessionId ?? 'sess-Z' }));

    // Insert via upsert → no existing match → falls through to addEntryRaw
    store.upsertEntry({ ts: 1, type: 'chat_end', raw: 'done' });
    expect(store.getHistory()[0].taskId).toBe('task-Z');

    // Update via upsert → matches by ts+type within tolerance → in-place update
    store.upsertEntry({ ts: 1, type: 'chat_end', raw: 'done updated' });
    expect(store.getHistory().length).toBe(1);
    expect(store.getHistory()[0].raw).toBe('done updated');
    expect(store.getHistory()[0].taskId).toBe('task-Z');
  });

  it('late upsert preserves the original entry attribution after task rotation (regression)', () => {
    // Scenario: chat_end is added during task-A. Task-A closes and task-B
    // opens. Async LLM summarizer lands the upsert after the rotation. The
    // upsert call site does NOT carry a taskId. The store must keep the
    // entry attributed to task-A (its creation-time task), not silently
    // re-attribute to the now-active task-B.
    const store = new BridgeTimelineStore();
    let activeTaskId = 'task-A';
    store.setAttributor((e) => ({
      ...e,
      sessionId: e.sessionId ?? 'sess-1',
      taskId: e.taskId ?? activeTaskId,
      runId: e.runId ?? 'run-1',
    }));

    // Live emit during task-A
    store.addEntry({ ts: 1_000, type: 'chat_end', raw: 'p1 · 3s' });
    expect(store.getHistory()[0].taskId).toBe('task-A');

    // Task rotates: task-A closes, task-B opens
    activeTaskId = 'task-B';

    // Async LLM summary lands later, upserting the *same* chat_end entry
    // (matches by ts+type within tolerance). Caller did not set taskId.
    store.upsertEntry({
      ts: 1_000, type: 'chat_end',
      raw: 'Refactored timeline store · 3s',
    });

    // Critical assertion: existing entry still belongs to task-A.
    expect(store.getHistory().length).toBe(1);
    expect(store.getHistory()[0].taskId).toBe('task-A');
    expect(store.getHistory()[0].raw).toBe('Refactored timeline store · 3s');
  });

  it('merge path (repetitive dedup) does not re-attribute after task rotation', () => {
    // Same hazard, different code path. addEntry → 'merge' fires for
    // repetitive duplicate chat_starts within the 1h dedup window. If the
    // task rotated between the two calls, the merge must keep the original
    // attribution — re-attributing would jump the row into the wrong task.
    const store = new BridgeTimelineStore();
    let activeTaskId = 'task-A';
    store.setAttributor((e) => ({
      ...e,
      taskId: e.taskId ?? activeTaskId,
      sessionId: e.sessionId ?? 'sess-1',
    }));

    store.addEntry({ ts: 1_000, type: 'chat_start', raw: 'Same prompt' });
    expect(store.getHistory()[0].taskId).toBe('task-A');

    activeTaskId = 'task-B';

    // Same raw, within dedup window → merge path
    store.addEntry({ ts: 2_000, type: 'chat_start', raw: 'Same prompt' });

    expect(store.getHistory().length).toBe(1);
    expect(store.getHistory()[0].taskId).toBe('task-A');
  });

  it('upsert with no existing match falls through to attributor (insert path)', () => {
    // The "stale task" guard only applies to the *update* branch. A brand-
    // new upsert (nothing to match against) is logically a new entry and
    // should pick up the *current* active task via the attributor.
    const store = new BridgeTimelineStore();
    store.setAttributor((e) => ({ ...e, taskId: e.taskId ?? 'task-NEW' }));

    store.upsertEntry({ ts: 1, type: 'eval_result', raw: 'fresh' });

    expect(store.getHistory()[0].taskId).toBe('task-NEW');
  });

  it('caller-set taskId on upsert overrides existing entry attribution', () => {
    // Edge case: caller explicitly re-attributes on update. Respect that.
    const store = new BridgeTimelineStore();
    store.setAttributor((e) => ({ ...e, taskId: e.taskId ?? 'task-A' }));
    store.addEntry({ ts: 1, type: 'chat_end', raw: 'x' });
    expect(store.getHistory()[0].taskId).toBe('task-A');

    store.upsertEntry({ ts: 1, type: 'chat_end', raw: 'x v2', taskId: 'task-OVERRIDE' });
    expect(store.getHistory()[0].taskId).toBe('task-OVERRIDE');
  });

  it('history replay returns entries with taskId/runId set (regression)', () => {
    // The whole point: getHistory() — what `timeline_history` ships — must
    // carry attribution. Earlier code attributed only at broadcast time, so
    // history replay returned bare entries.
    const store = new BridgeTimelineStore();
    store.setAttributor((e) => ({
      ...e,
      sessionId: e.sessionId ?? 'sess-A',
      taskId: e.taskId ?? 'task-A',
      runId: e.runId ?? 'run-A',
    }));

    store.addEntry({ ts: 1, type: 'chat_start', raw: 'p1' });
    store.addEntry({ ts: 2, type: 'tool_request', raw: 'Edit' });
    store.addEntry({ ts: 3, type: 'chat_end', raw: 'p1 · 2s' });

    const replay = store.getHistory();
    expect(replay.length).toBe(3);
    for (const e of replay) {
      expect(e.taskId).toBe('task-A');
      expect(e.runId).toBe('run-A');
      expect(e.sessionId).toBe('sess-A');
    }
  });
});

// ─── Stop hook + PTY fallback race regression ──────────────────────

describe('Stop hook + PTY fallback double-emit (regression)', () => {
  it('identical chat_response from two emit paths is collapsed by store', () => {
    const store = new BridgeTimelineStore();
    const t0 = Date.now();

    // turn boundary
    store.addEntry(makeEntry({ ts: t0, type: 'chat_start', raw: 'Prompt' }));

    // PTY fallback emits at t0+1500ms
    store.addEntry(makeEntry({
      ts: t0 + 1500,
      type: 'chat_response',
      raw: '커밋 완료. 남은 미커밋 변경은 모두 세션 시작 전부터 존재하던 것',
    }));
    store.addEntry(makeEntry({ ts: t0 + 1501, type: 'chat_end', raw: 'Refactor · 3s' }));

    // Stop hook arrives 6s late with identical response text
    store.addEntry(makeEntry({
      ts: t0 + 7500,
      type: 'chat_response',
      raw: '커밋 완료. 남은 미커밋 변경은 모두 세션 시작 전부터 존재하던 것',
    }));
    // chat_end with different duration tag — repetitive dedup must merge it
    store.addEntry(makeEntry({ ts: t0 + 7501, type: 'chat_end', raw: 'Refactor · 9s' }));

    const all = store.getHistory();
    const responses = all.filter((e) => e.type === 'chat_response');
    const ends = all.filter((e) => e.type === 'chat_end');

    expect(responses).toHaveLength(1);
    expect(ends).toHaveLength(1);
  });
});

// ─── Timeline + WS broadcast integration ────────────────────────────

describe('Timeline → WS broadcast pipeline', () => {
  it('store entries trigger broadcast via listener', () => {
    const store = new BridgeTimelineStore();
    const broadcasted: TimelineEntry[] = [];

    // Simulate WS broadcast hook
    store.onEntry((entry) => {
      broadcasted.push(entry);
    });

    store.addEntry(makeEntry({ ts: 100, raw: 'Event 1' }));
    store.addEntry(makeEntry({ ts: 200, raw: 'Event 2' }));

    expect(broadcasted).toHaveLength(2);
    expect(broadcasted[0].raw).toBe('Event 1');
    expect(broadcasted[1].raw).toBe('Event 2');
  });

  it('upsert entries broadcast with upsert flag', () => {
    const store = new BridgeTimelineStore();
    const broadcasted: Array<{ entry: TimelineEntry; upsert?: boolean }> = [];

    store.addEntry(makeEntry({ ts: 100, type: 'chat_end', raw: 'Original' }));

    store.onEntry((entry, upsert) => broadcasted.push({ entry, upsert }));

    store.upsertEntry(makeEntry({ ts: 100, type: 'chat_end', raw: 'Updated' }));

    expect(broadcasted).toHaveLength(1);
    expect(broadcasted[0].upsert).toBe(true);
    expect(broadcasted[0].entry.raw).toBe('Updated');
  });

  it('exact duplicate within 5s is skipped by store', () => {
    const store = new BridgeTimelineStore();
    const now = Date.now() / 1000;

    store.addEntry(makeEntry({ ts: now, type: 'tool_request', raw: 'Read /foo.ts' }));
    store.addEntry(makeEntry({ ts: now + 2, type: 'tool_request', raw: 'Read /foo.ts' }));

    const history = store.getHistory();
    expect(history).toHaveLength(1); // Second was deduped
  });

  it('different content within 5s is NOT deduped', () => {
    const store = new BridgeTimelineStore();
    const now = Date.now() / 1000;

    store.addEntry(makeEntry({ ts: now, type: 'tool_request', raw: 'Read /foo.ts' }));
    store.addEntry(makeEntry({ ts: now + 2, type: 'tool_request', raw: 'Edit /bar.ts' }));

    const history = store.getHistory();
    expect(history).toHaveLength(2); // Different content, both kept
  });
});

// ─── Entry type coverage ────────────────────────────────────────────

describe('TimelineEntry types', () => {
  const validTypes = [
    'tool_request', 'tool_resolved', 'chat_start', 'chat_end',
    'chat_response', 'error', 'scheduled', 'user_action',
    'model_call', 'model_response', 'memory_recall', 'tool_exec',
  ];

  it('common entry types have expected shape', () => {
    for (const type of validTypes) {
      const entry = makeEntry({ type: type as any, raw: `Test ${type}` });
      expect(entry.type).toBe(type);
      expect(typeof entry.ts).toBe('number');
      expect(typeof entry.raw).toBe('string');
    }
  });

  it('entries with status field', () => {
    const entry = makeEntry({
      type: 'tool_request',
      raw: 'Edit /src/main.ts',
      status: 'pending',
      approvalId: 'req-456',
    });

    expect(entry.status).toBe('pending');
    expect(entry.approvalId).toBe('req-456');
  });

  it('entries with detail field', () => {
    const entry = makeEntry({
      type: 'chat_end',
      raw: 'Completed task · 5 tools · 2m',
      detail: '파일 3개를 수정하여 버그를 수정했습니다',
    });

    expect(typeof entry.detail).toBe('string');
    expect(entry.detail!.length).toBeGreaterThan(0);
  });

  it('entries with automated flag', () => {
    const entry = makeEntry({
      type: 'chat_start',
      raw: '자동 작업',
      automated: true,
    });

    expect(entry.automated).toBe(true);
  });
});
