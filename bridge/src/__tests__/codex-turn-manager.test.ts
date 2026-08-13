import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ApmeStore } from '../apme/store.js';
import { ApmeCollector } from '../apme/collector.js';
import { CodexTurnManager } from '../apme/adapters/codex-turn-manager.js';
import type { TimelineEntry, AdapterHookEvent } from '@agentdeck/shared';

/** Lightweight test harness: a real ApmeStore + ApmeCollector + a fake
 *  core.bridgeTimeline + rollout outcome reader. Tracks the timeline
 *  entries CodexTurnManager emits so tests can assert turn structure. */
async function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'codex-turn-test-'));
  const store = new ApmeStore(join(dir, 'apme.sqlite'));
  const ok = await store.init();
  if (!ok) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('ApmeStore failed to init — is better-sqlite3 installed?');
  }

  const collector = new ApmeCollector(store);
  const sessionId = 'cdx-test';
  collector.openRun({
    sessionId, agentType: 'codex-cli',
    modelId: 'gpt-5.4', projectName: 'demo',
  });

  const entries: TimelineEntry[] = [];
  const fakeCore: any = {
    sessionId,
    bridgeTimeline: {
      addEntry: (e: TimelineEntry) => { entries.push(e); },
      upsertEntry: (e: TimelineEntry) => {
        // Last-write-wins on (ts, type) — matches the production store's
        // behaviour well enough for these tests.
        const idx = entries.findIndex((x) => x.ts === e.ts && x.type === e.type);
        if (idx >= 0) entries[idx] = e;
        else entries.push(e);
      },
    },
    onShutdown: (_cb: () => void) => { /* not exercised */ },
  };

  let rolloutText = '';
  const setTail = (s: string) => { rolloutText = s; };

  const fakeApme: any = {
    collector,
    store,
    runner: { enqueueTurn: vi.fn() },
  };

  const mgr = new CodexTurnManager(
    fakeCore,
    fakeApme,
    sessionId,
    'codex-cli' as any,
    () => ({ text: rolloutText }),
  );
  mgr.onHookEvent({
    source: 'hook',
    event: 'codex_session_start',
    data: { sessionId: '019ff653-5d8e-7610-a8ce-22b1b7f7ebf1' },
  });

  return { mgr, entries, store, collector, dir, setTail };
}

function hookEvt(event: string, data: Record<string, unknown> = {}): AdapterHookEvent {
  return { source: 'hook', event, data };
}
describe('CodexTurnManager (hook-primary path)', () => {
  let harness: Awaited<ReturnType<typeof makeHarness>>;

  beforeEach(async () => {
    harness = await makeHarness();
  });
  afterEach(() => {
    harness.mgr.cleanup();
    harness.store.close();
    rmSync(harness.dir, { recursive: true, force: true });
  });

  it('happy path: UPS → tool_start → tool_end → stop emits one chat', () => {
    const { mgr, entries, setTail } = harness;
    setTail('## Result\nDone in one shot.');

    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', {
      sessionId: '019ff653-5d8e-7610-a8ce-22b1b7f7ebf1',
      message: { content: 'list /tmp' },
    }));
    mgr.onHookEvent(hookEvt('codex_tool_start', {
      tool_name: 'shell', tool_input: { command: 'ls /tmp' },
    }));
    mgr.onHookEvent(hookEvt('codex_tool_end', {
      tool_name: 'shell',
    }));
    mgr.onHookEvent(hookEvt('codex_stop', {}));

    const types = entries.map((e) => e.type);
    expect(types.filter((t) => t === 'chat_start')).toHaveLength(1);
    expect(types.filter((t) => t === 'tool_request')).toHaveLength(1);
    // chat_response present (PTY tail had a real response) and chat_end emitted.
    expect(types).toContain('chat_response');
    expect(types).toContain('chat_end');
  });

  it('a benign `message` on codex_stop is never rendered as an error', () => {
    // Real codex_stop payloads (311 recorded, ≤0.146.0) carry
    // last_assistant_message and never a bare `message`/`error` key — but
    // `message` carries CONTENT on every other Codex event, so if a future
    // build adds it to Stop it must not turn every close row into "Error: …".
    const { mgr, entries, setTail } = harness;
    setTail('');
    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', { message: { content: 'q' } }));
    mgr.onHookEvent(hookEvt('codex_stop', { message: 'turn finished normally' }));
    expect(entries.some((e) => (e.raw ?? '').startsWith('Error:'))).toBe(false);
  });

  it('an explicit `error` on codex_stop renders the error close row', () => {
    const { mgr, entries, setTail } = harness;
    setTail('');
    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', { message: { content: 'q' } }));
    mgr.onHookEvent(hookEvt('codex_stop', { error: 'sandbox denied' }));
    expect(entries.some((e) => (e.raw ?? '').startsWith('Error: sandbox denied'))).toBe(true);
  });

  it('codex_stop does not reset subsequent turn_index numbering', () => {
    const { mgr, collector, store, setTail } = harness;
    setTail('first');

    // Turn 0
    collector.ingestHook('cdx-test', 'UserPromptSubmit', { message: { content: 'q1' } });
    const turn0 = collector.getActiveTurnId('cdx-test')!;
    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', { message: { content: 'q1' } }));
    mgr.onHookEvent(hookEvt('codex_stop', {}));

    // closeTurnForSession ran, so sessionToTurn is empty here. The next
    // UserPromptSubmit must still produce turn_index = 1, not 0.
    setTail('second');
    collector.ingestHook('cdx-test', 'UserPromptSubmit', { message: { content: 'q2' } });
    const turn1 = collector.getActiveTurnId('cdx-test')!;
    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', { message: { content: 'q2' } }));
    mgr.onHookEvent(hookEvt('codex_stop', {}));

    setTail('third');
    collector.ingestHook('cdx-test', 'UserPromptSubmit', { message: { content: 'q3' } });
    const turn2 = collector.getActiveTurnId('cdx-test')!;

    const r0 = store.getTurn(turn0) as Record<string, unknown>;
    const r1 = store.getTurn(turn1) as Record<string, unknown>;
    const r2 = store.getTurn(turn2) as Record<string, unknown>;
    expect(r0.turn_index).toBe(0);
    expect(r1.turn_index).toBe(1);
    expect(r2.turn_index).toBe(2);
    // turn ids unique (regression check on the bug — collisions on index 0
    // would not produce duplicate ids but the test pins both invariants).
    expect(turn0).not.toBe(turn1);
    expect(turn1).not.toBe(turn2);
  });

  it('codex_stop finalizes APME turn (endedAt set, tool_calls flushed)', () => {
    const { mgr, collector, store, setTail } = harness;
    setTail('answer');

    // Need a real ingestSpan path to open the APME turn — go through the
    // hook adapter so the turn_start span lands. (CodexTurnManager hook
    // path is timeline-only by design; it relies on upstream codex hook
    // adapter to open the APME turn.)
    collector.ingestHook('cdx-test', 'UserPromptSubmit', {
      message: { content: 'list /tmp' },
    });
    const turnId = collector.getActiveTurnId('cdx-test');
    expect(turnId).not.toBeNull();

    // Tool counted via PreToolUse (the hook adapter's tool_call → ingestSpan
    // → ingestHook PreToolUse path).
    collector.ingestHook('cdx-test', 'PreToolUse', { tool_name: 'shell' });

    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', {
      message: { content: 'list /tmp' },
    }));
    mgr.onHookEvent(hookEvt('codex_tool_start', { tool_name: 'shell' }));
    mgr.onHookEvent(hookEvt('codex_tool_end', { tool_name: 'shell' }));
    mgr.onHookEvent(hookEvt('codex_stop', {}));

    const turn = store.getTurn(turnId!) as Record<string, unknown>;
    expect(turn?.ended_at).toBeTruthy();
    expect(turn?.response).toBe('answer');
    // tool_calls includes the upstream PreToolUse + the one CodexTurnManager
    // ingested via codex_tool_start → addEntryAndIngest? Wait — hook path's
    // codex_tool_start in the manager is timeline-only, no APME ingest. So
    // the count comes from collector.ingestHook PreToolUse only.
    expect(turn?.tool_calls).toBe(1);
    // After close, the turn is no longer the ACTIVE turn.
    expect(collector.getActiveTurnId('cdx-test')).toBeNull();
  });

  it('next prompt opens a fresh chat_start', () => {
    const { mgr, entries, setTail } = harness;
    setTail('first done');

    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', {
      message: { content: 'first' },
    }));
    mgr.onHookEvent(hookEvt('codex_stop', {}));

    setTail('second done');
    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', {
      message: { content: 'second' },
    }));
    mgr.onHookEvent(hookEvt('codex_stop', {}));

    const startEntries = entries.filter((e) => e.type === 'chat_start');
    expect(startEntries).toHaveLength(2);
    const endEntries = entries.filter((e) => e.type === 'chat_end');
    expect(endEntries).toHaveLength(2);
  });

  it('turn-complete notify closes a turn when codex_stop is absent', () => {
    const { mgr, entries, setTail } = harness;
    setTail('notify fallback response');

    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', {
      sessionId: '019ff653-5d8e-7610-a8ce-22b1b7f7ebf1',
      message: { content: 'do it' },
    }));
    mgr.onHookEvent(hookEvt('codex_turn_complete', {}));

    expect(entries.find((e) => e.type === 'chat_response')).toBeDefined();
    expect(entries.find((e) => e.type === 'chat_end')).toBeDefined();
  });

  it('long-bash: hook tool_start + tool_end keep the same turn open', () => {
    const { mgr, entries, setTail } = harness;
    setTail('# done');
    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', { message: { content: 'q' } }));

    // Bash runs for "30 seconds" — multiple tool_start/end pairs. None
    // should split the turn.
    for (let i = 0; i < 3; i++) {
      mgr.onHookEvent(hookEvt('codex_tool_start', {
        tool_name: 'shell', tool_input: { command: `cmd-${i}` },
      }));
      mgr.onHookEvent(hookEvt('codex_tool_end', { tool_name: 'shell' }));
    }
    mgr.onHookEvent(hookEvt('codex_stop', {}));

    const startEntries = entries.filter((e) => e.type === 'chat_start');
    expect(startEntries).toHaveLength(1);
    const endEntries = entries.filter((e) => e.type === 'chat_end');
    expect(endEntries).toHaveLength(1);
    const toolEntries = entries.filter((e) => e.type === 'tool_request');
    expect(toolEntries).toHaveLength(3);
  });
});

describe('CodexTurnManager (stale-turn recovery on prompt-submit)', () => {
  let harness: Awaited<ReturnType<typeof makeHarness>>;

  beforeEach(async () => {
    harness = await makeHarness();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    harness.mgr.cleanup();
    harness.store.close();
    rmSync(harness.dir, { recursive: true, force: true });
  });

  it('missed codex_stop: next prompt closes the stale turn and opens a fresh row', () => {
    const { mgr, entries, setTail } = harness;
    setTail('turn-1 answer');

    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', { message: { content: 'q1' } }));
    mgr.onHookEvent(hookEvt('codex_tool_start', { tool_name: 'shell', tool_input: { command: 'ls' } }));
    // codex_stop and notify are dropped (daemon restart). A subsequent
    // user prompt remains an authoritative boundary for the stale turn.
    vi.advanceTimersByTime(60_000);

    setTail('turn-1 answer\n› q2');
    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', { message: { content: 'q2' } }));

    const startEntries = entries.filter((e) => e.type === 'chat_start');
    expect(startEntries).toHaveLength(2);
    expect(startEntries[1].raw).toBe('q2');
    // Stale turn 1 got a chat_end; turn 2 is still open.
    expect(entries.filter((e) => e.type === 'chat_end')).toHaveLength(1);

    mgr.onHookEvent(hookEvt('codex_stop', {}));
    expect(entries.filter((e) => e.type === 'chat_end')).toHaveLength(2);
  });

  it('late prompt text fills a tool_start-opened turn without splitting it', () => {
    const { mgr, entries } = harness;

    // Hook reorder: tool_start lands first and opens a text-less turn.
    mgr.onHookEvent(hookEvt('codex_tool_start', { tool_name: 'shell', tool_input: { command: 'ls' } }));
    vi.advanceTimersByTime(500);
    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', { message: { content: 'the real prompt' } }));

    const startEntries = entries.filter((e) => e.type === 'chat_start');
    expect(startEntries).toHaveLength(1);
    expect(startEntries[0].raw).toBe('the real prompt');
    expect(entries.filter((e) => e.type === 'chat_end')).toHaveLength(0);
  });

  it('duplicate prompt echo within the window is a no-op', () => {
    const { mgr, entries } = harness;

    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', { message: { content: 'same q' } }));
    vi.advanceTimersByTime(1_000);
    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', { message: { content: 'same q' } }));

    expect(entries.filter((e) => e.type === 'chat_start')).toHaveLength(1);
    expect(entries.filter((e) => e.type === 'chat_end')).toHaveLength(0);
  });

  it('text-less stale turn older than the fill window is closed, not filled', () => {
    const { mgr, entries, setTail } = harness;
    setTail('orphan tool output');

    // Turn opened by tool_start only; its prompt hook never arrived, and
    // neither did codex_stop. Well past the fill window, a new prompt must
    // not be swallowed as a late text fill for that orphan.
    mgr.onHookEvent(hookEvt('codex_tool_start', { tool_name: 'shell', tool_input: { command: 'ls' } }));
    vi.advanceTimersByTime(20_000);

    mgr.onHookEvent(hookEvt('codex_user_prompt_submit', { message: { content: 'q-next' } }));

    const startEntries = entries.filter((e) => e.type === 'chat_start');
    expect(startEntries).toHaveLength(2);
    expect(startEntries[1].raw).toBe('q-next');
    expect(entries.filter((e) => e.type === 'chat_end')).toHaveLength(1);
  });
});
