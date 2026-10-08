import { describe, expect, it, vi } from 'vitest';
import { CODEX_OTEL_METADATA_RULES } from '@agentdeck/shared';
import {
  ANONYMOUS_OTEL_THREAD_ID,
  CodexOtelTracker,
  CodexOtelSubagentFilter,
  parseCodexSpans,
  spanNameSummary,
} from '../codex-otel.js';
import type { ObservedSession } from '../passive-observer.js';
import { CodexAmbientSessions } from '../codex-ambient-hooks.js';
import { HookCodexSessions } from '../hook-codex-sessions.js';

type AttrValue = string | number | boolean;

function attrs(map: Record<string, AttrValue>): unknown[] {
  return Object.entries(map).map(([key, value]) => ({
    key,
    value: typeof value === 'number'
      ? { intValue: String(value) }
      : typeof value === 'boolean'
        ? { boolValue: value }
        : { stringValue: value },
  }));
}

function envelope(
  spans: { name: string; traceId?: string; attributes?: Record<string, AttrValue> }[],
  resourceAttributes: Record<string, AttrValue> = {},
): unknown {
  return {
    resourceSpans: [{
      resource: { attributes: attrs(resourceAttributes) },
      scopeSpans: [{
        spans: spans.map((s) => ({
          name: s.name,
          ...(s.traceId ? { traceId: s.traceId } : {}),
          attributes: attrs(s.attributes ?? {}),
        })),
      }],
    }],
  };
}

const THREAD = '019dee40-1234-7aaa-bbbb-ccccddddeeee';

describe('codex OTLP span parser', () => {
  it('reads a full turn from dotted span names', () => {
    const events = parseCodexSpans(envelope([
      { name: 'codex.turn.start', attributes: { 'thread.id': THREAD, 'turn.id': 't1', cwd: '/repo/app' } },
      { name: 'codex.tool.call', attributes: { 'thread.id': THREAD, 'turn.id': 't1', 'tool.name': 'exec_command' } },
      { name: 'codex.tool.result', attributes: { 'thread.id': THREAD, 'turn.id': 't1' } },
      { name: 'codex.turn.end', attributes: { 'thread.id': THREAD, 'turn.id': 't1' } },
    ]));

    expect(events).toEqual([
      { kind: 'turnStart', threadId: THREAD, turnId: 't1', cwd: '/repo/app' },
      { kind: 'toolCall', threadId: THREAD, turnId: 't1', tool: 'exec_command', cwd: '/repo/app' },
      { kind: 'toolResult', threadId: THREAD, turnId: 't1' },
      { kind: 'turnEnd', threadId: THREAD, turnId: 't1' },
    ]);
  });

  it('normalizes underscore and slash span-name variants', () => {
    const events = parseCodexSpans(envelope([
      { name: 'turn/start', attributes: { thread_id: THREAD, turn_id: 't7' } },
      { name: 'build_tool_call', attributes: { thread_id: THREAD, turn_id: 't7', tool: 'apply_patch' } },
    ]));
    expect(events.map((e) => e.kind)).toEqual(['turnStart', 'toolCall']);
  });

  it('rejects short numeric ids and prefers the durable alias on the same span', () => {
    // Codex emits BOTH a turn-scoped counter and the real thread UUID; taking
    // the first non-empty alias would pick the counter and spawn ghost rows.
    const events = parseCodexSpans(envelope([
      { name: 'codex.turn.start', attributes: { 'codex.thread_id': 11, 'thread.id': THREAD, 'turn.id': 't1' } },
    ]));
    expect(events).toEqual([{ kind: 'turnStart', threadId: THREAD, turnId: 't1', cwd: undefined }]);

    // With only the short id, the span has no usable identity — it falls back
    // to the anonymous trace key rather than inventing `codex:11`.
    const shortOnly = parseCodexSpans(envelope([
      { name: 'codex.turn.start', traceId: 'abc123', attributes: { 'thread.id': 11 } },
    ]));
    expect(shortOnly[0]?.threadId).toBe(ANONYMOUS_OTEL_THREAD_ID);
  });

  it('ignores a tool span own cwd but inherits the thread-scoped one', () => {
    // `process.cwd` on an exec span is the subprocess's directory; adopting it
    // would lock the session's project label onto /tmp.
    const events = parseCodexSpans(envelope([
      { name: 'codex.turn.start', attributes: { 'thread.id': THREAD, cwd: '/repo/app' } },
      { name: 'codex.tool.call', attributes: { 'thread.id': THREAD, 'process.cwd': '/tmp/build' } },
    ]));
    expect(events[1]).toMatchObject({ kind: 'toolCall', cwd: '/repo/app' });

    const loneTool = parseCodexSpans(envelope([
      { name: 'codex.tool.call', attributes: { 'thread.id': THREAD, 'process.cwd': '/tmp/build' } },
    ]));
    expect(loneTool[0]).toMatchObject({ kind: 'toolCall', cwd: undefined });
  });

  it('falls through to resource-level attributes', () => {
    const events = parseCodexSpans(envelope(
      [{ name: 'codex.turn.start', attributes: { 'turn.id': 't1' } }],
      { 'thread.id': THREAD, cwd: '/repo/app' },
    ));
    expect(events).toEqual([{ kind: 'turnStart', threadId: THREAD, turnId: 't1', cwd: '/repo/app' }]);
  });

  it('drops unknown spans and spans with no identity at all', () => {
    expect(parseCodexSpans(envelope([{ name: 'garbage.collect', attributes: { 'thread.id': THREAD } }]))).toEqual([]);
    expect(parseCodexSpans(envelope([{ name: 'codex.turn.start' }]))).toEqual([]);
    expect(parseCodexSpans({})).toEqual([]);
    expect(parseCodexSpans(null)).toEqual([]);
  });

  it('summarizes span names for diagnostics', () => {
    const summary = spanNameSummary(envelope([{ name: 'receiving' }, { name: 'handle_responses' }]));
    expect(summary).toBe('receiving,handle_responses');
  });

  it('finds no durable identity in a live ChatGPT.app Codex batch', () => {
    // Captured 2026-08-04 from ChatGPT.app 150.0.7871.182 (service.name
    // `codex-app-server` 0.146.0-alpha.9.2, telemetry sdk 0.31.0) — trimmed,
    // attribute shapes verbatim. This build's `thread.id` is the tokio worker
    // thread, NOT a conversation id, and it emits no turn-boundary span, so
    // every span folds onto the anonymous key and drives no session state.
    // The rollout the passive observer already reads carries the identity this
    // batch lacks; if a future build starts emitting `codex.thread_id` UUIDs or
    // `turn/start`, this test is where that change will show up first.
    const live = envelope([
      {
        name: 'handle_tool_call_with_source',
        traceId: '5d0e27fa9d4edb90419b1e56345a143d',
        attributes: {
          'code.module.name': 'codex_core::tools::parallel',
          'thread.id': 6,
          'thread.name': 'tokio-rt-worker',
          target: 'codex_core::tools::parallel',
          busy_ns: 165667,
        },
      },
      {
        name: 'run_sampling_request',
        traceId: '5d0e27fa9d4edb90419b1e56345a143d',
        attributes: {
          'thread.id': 11,
          'thread.name': 'tokio-rt-worker',
          turn_id: '019fc9ef-8a88-7bf1-aaf7-1a7479387855',
          model: 'gpt-5.6-sol',
          cwd: '/Users/puritysb/github/BabelForge',
        },
      },
      {
        name: 'receiving',
        traceId: '5d0e27fa9d4edb90419b1e56345a143d',
        attributes: { 'thread.id': 3, 'thread.name': 'tokio-rt-worker' },
      },
    ], {
      'service.name': 'codex-app-server',
      'service.version': '0.146.0-alpha.9.2',
      'telemetry.sdk.name': 'opentelemetry',
    });

    const events = parseCodexSpans(live);
    // `run_sampling_request` is a mid-turn model call, not a turn boundary — it
    // is deliberately not in the dispatch table.
    expect(events.map((e) => e.kind)).toEqual(['toolCall', 'activity']);
    expect(events.every((e) => e.threadId === ANONYMOUS_OTEL_THREAD_ID)).toBe(true);

    // …and the tracker therefore holds nothing: anonymous spans never create,
    // rename, or drive a session row.
    const tracker = new CodexOtelTracker();
    tracker.ingest(live);
    expect(tracker.snapshot()).toEqual([]);
  });
});

describe('CodexOtelTracker', () => {
  const observedCodex: ObservedSession = {
    id: `observed:codex:${THREAD}`,
    port: 0,
    pid: 4321,
    projectName: 'app',
    agentType: 'codex-cli',
    alive: true,
    state: 'idle',
    controlMode: 'observed',
    currentTask: 'exec_command pnpm build',
  };

  function turn(kind: 'turnStart' | 'turnEnd', turnId: string, extra: Record<string, AttrValue> = {}): unknown {
    return envelope([{
      name: kind === 'turnStart' ? 'codex.turn.start' : 'codex.turn.end',
      attributes: { 'thread.id': THREAD, 'turn.id': turnId, ...extra },
    }]);
  }

  it('overlays state and tool onto the matching observed row instead of duplicating it', () => {
    const tracker = new CodexOtelTracker();
    tracker.ingest(turn('turnStart', 't1', { cwd: '/repo/app' }), 1_000);
    tracker.ingest(envelope([{
      name: 'codex.tool.call',
      attributes: { 'thread.id': THREAD, 'turn.id': 't1', 'tool.name': 'apply_patch' },
    }]), 1_100);

    const rows = tracker.applyTo([observedCodex], 1_200);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `observed:codex:${THREAD}`,
      state: 'processing',
      currentTask: 'apply_patch',
    });
  });

  it('synthesizes a codex-app row only when the process scan found nothing', () => {
    const tracker = new CodexOtelTracker();
    tracker.ingest(turn('turnStart', 't1', { cwd: '/repo/app' }), 1_000);

    const rows = tracker.applyTo([], 1_100);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: `observed:codex-app:${THREAD}`,
      agentType: 'codex-app',
      state: 'processing',
      controlMode: 'observed',
      cwd: '/repo/app',
      projectName: 'app',
    });
  });

  // Live 2026-09-29, Codex 0.156 `codex exec`: the hook row went idle on Stop,
  // then the process exported its spans in one batch on exit and the fallback
  // re-labelled the finished CLI session `observed:codex-app:<id>` / `Codex`.
  describe('hook-owned Codex threads', () => {
    function wired(): { tracker: CodexOtelTracker; hooks: HookCodexSessions; rows: (now: number) => ObservedSession[] } {
      const hooks = new HookCodexSessions(() => null);
      const tracker = new CodexOtelTracker();
      tracker.isHookOwnedThread = (threadId) => hooks.knows(threadId);
      // The daemon's composition order (daemon-server.ts).
      return { tracker, hooks, rows: (now) => hooks.applyTo(tracker.applyTo([], now), now) };
    }

    it('keeps the hook row when a finished exec session\'s spans arrive late', () => {
      const { tracker, hooks, rows } = wired();
      const payload = { sessionId: THREAD, cwd: '/repo/app' };
      hooks.note('codex_session_start', payload, 1_000);
      hooks.note('codex_user_prompt_submit', payload, 1_100);
      hooks.note('codex_stop', payload, 5_000);
      tracker.ingest(envelope([
        { name: 'codex.turn.start', attributes: { 'thread.id': THREAD, 'turn.id': 't1' } },
        { name: 'codex.turn.end', attributes: { 'thread.id': THREAD, 'turn.id': 't1' } },
      ]), 7_000);

      expect(rows(7_100)).toEqual([expect.objectContaining({
        id: `observed:codex:${THREAD}`, agentType: 'codex-cli', projectName: 'app', state: 'idle',
      })]);
      // After the hook row is reaped, the tombstone still keeps the OTel
      // fallback from resurrecting the session as an app row.
      expect(rows(5_000 + 61_000)).toEqual([]);
    });

    it('still synthesizes a row for a thread no hook has reported', () => {
      const { tracker, rows } = wired();
      tracker.ingest(turn('turnStart', 't1', { cwd: '/repo/app' }), 1_000);
      expect(rows(1_100)).toEqual([expect.objectContaining({ id: `observed:codex-app:${THREAD}` })]);
    });
  });

  // Live 2026-09-29: Codex Desktop's memory-consolidation and ambient-suggestion
  // safety threads had their hooks dropped, yet their spans synthesized a
  // cwd-less `Codex` row next to the user's real session.
  describe('Codex background threads', () => {
    function wired(): { tracker: CodexOtelTracker; ambient: CodexAmbientSessions } {
      const ambient = new CodexAmbientSessions(30 * 60_000, undefined);
      const tracker = new CodexOtelTracker();
      tracker.isBackgroundThread = (threadId) => ambient.isAmbient(threadId);
      return { tracker, ambient };
    }

    it('never synthesizes a row for a thread the hook classifier already dropped', () => {
      const { tracker, ambient } = wired();
      ambient.classify('codex_session_start', { session_id: THREAD, cwd: '/Users/me/.codex/memories' }, 1_000);
      tracker.ingest(turn('turnStart', 't1'), 1_100);
      expect(tracker.applyTo([], 1_200)).toEqual([]);
      expect(tracker.snapshot()).toEqual([]);
    });

    it('retracts a row its spans opened before the identifying hook arrived', () => {
      const { tracker, ambient } = wired();
      let changes = 0;
      tracker.onChanged = () => { changes += 1; };
      tracker.ingest(turn('turnStart', 't1'), 1_000);
      expect(tracker.applyTo([], 1_050)).toHaveLength(1);

      const verdict = ambient.classify('codex_user_prompt_submit', {
        session_id: THREAD,
        prompt: 'You are an expert at upholding safety and compliance standards for Codex ambient suggestions.',
      }, 1_100);
      expect(verdict.firstSeen).toBe(true);
      tracker.forget(THREAD);
      expect(changes).toBe(2);

      tracker.ingest(turn('turnEnd', 't1'), 1_200);
      expect(tracker.applyTo([], 1_300)).toEqual([]);
    });

    it('leaves the user\'s own thread alone', () => {
      const { tracker, ambient } = wired();
      ambient.classify('codex_session_start', { session_id: THREAD, cwd: '/repo/app' }, 1_000);
      tracker.ingest(turn('turnStart', 't1', { cwd: '/repo/app' }), 1_100);
      expect(tracker.applyTo([], 1_200)).toHaveLength(1);
    });
  });

  it('rejects a superseded turnEnd so a stale span cannot close the live turn', () => {
    const tracker = new CodexOtelTracker();
    tracker.ingest(turn('turnStart', 't1'), 1_000);
    tracker.ingest(turn('turnStart', 't2'), 2_000);
    tracker.ingest(turn('turnEnd', 't1'), 2_100); // late close for the previous turn

    expect(tracker.snapshot()[0]).toMatchObject({ state: 'processing', servicedTurnId: 't2' });

    tracker.ingest(turn('turnEnd', 't2'), 2_200);
    expect(tracker.snapshot()[0]).toMatchObject({ state: 'idle' });
  });

  it('lets a follow-up turn revive a thread its own turnEnd retired', () => {
    const tracker = new CodexOtelTracker();
    tracker.ingest(turn('turnStart', 't1'), 1_000);
    tracker.ingest(turn('turnEnd', 't1'), 2_000);
    tracker.ingest(turn('turnStart', 't2'), 3_000);
    expect(tracker.snapshot()[0]).toMatchObject({ state: 'processing', terminalAt: undefined });
  });

  it('expires a finished thread, and a quiet one, instead of pinning a creature', () => {
    const tracker = new CodexOtelTracker();
    tracker.ingest(turn('turnStart', 't1'), 1_000);
    tracker.ingest(turn('turnEnd', 't1'), 2_000);
    expect(tracker.applyTo([], 2_000 + 59_000)).toHaveLength(1);
    expect(tracker.applyTo([], 2_000 + 61_000)).toHaveLength(0);

    const quiet = new CodexOtelTracker();
    quiet.ingest(turn('turnStart', 't1'), 1_000);
    expect(quiet.applyTo([], 1_000 + 4 * 60_000)).toHaveLength(1);
    expect(quiet.applyTo([], 1_000 + 6 * 60_000)).toHaveLength(0);
  });

  it('stops overriding observer state once its own observation goes stale', () => {
    const tracker = new CodexOtelTracker();
    tracker.ingest(turn('turnStart', 't1'), 1_000);
    // Inside the overlay window OTel wins; past it the rollout tail is fresher.
    expect(tracker.applyTo([observedCodex], 60_000)[0]).toMatchObject({ state: 'processing' });
    expect(tracker.applyTo([observedCodex], 200_000)[0]).toMatchObject({ state: 'idle' });
  });

  it('never lets progress-only activity spans open or revive a thread', () => {
    const tracker = new CodexOtelTracker();
    tracker.ingest(envelope([{ name: 'receiving', attributes: { 'thread.id': THREAD } }]), 1_000);
    expect(tracker.snapshot()).toEqual([]);

    tracker.ingest(turn('turnStart', 't1'), 1_000);
    tracker.ingest(turn('turnEnd', 't1'), 2_000);
    tracker.ingest(envelope([{ name: 'receiving', attributes: { 'thread.id': THREAD } }]), 2_500);
    expect(tracker.snapshot()[0]).toMatchObject({ state: 'idle', lastEventAt: 2_000 });
  });

  it('leaves non-codex rows untouched', () => {
    const tracker = new CodexOtelTracker();
    tracker.ingest(turn('turnStart', 't1'), 1_000);
    const claude: ObservedSession = { ...observedCodex, id: 'observed:claude:x', agentType: 'claude-code' };
    const rows = tracker.applyTo([claude], 1_100);
    expect(rows[0]).toBe(claude);
  });
});


describe('Codex OTel rollout subagent exclusion', () => {
  const span = () => envelope([{ name: 'codex.turn.start', attributes: { 'thread.id': THREAD, 'turn.id': 'sample-turn' } }]);
  it('retracts a late-classified phantom and does not promote later spans', async () => {
    let resolve!: (value: boolean) => void;
    const lookup = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
    const tracker = new CodexOtelTracker(lookup);
    const changed = vi.fn(); tracker.onChanged = changed;
    tracker.ingest(span(), 1000);
    expect(lookup).not.toHaveBeenCalled(); // First span does not execute the resolver.
    expect(tracker.applyTo([], 1001)).toHaveLength(1); // Unknown stays permissive.
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    resolve(true);
    await vi.waitFor(() => expect(tracker.snapshot()).toEqual([]));
    expect(changed).toHaveBeenCalledTimes(2); // Admission and late retraction.
    tracker.ingest(span(), 2000);
    expect(tracker.applyTo([], 2001)).toEqual([]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it.each([false, undefined])('retains standalone or unreadable metadata (%s)', async verdict => {
    const lookup = vi.fn(async () => verdict);
    const tracker = new CodexOtelTracker(lookup);
    tracker.ingest(span(), 1000);
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(1));
    expect(tracker.applyTo([], 1100)).toHaveLength(1);
    tracker.ingest(span(), 2000);
    expect(tracker.applyTo([], 2100)).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it('retries only unknown metadata after the canonical retry period', async () => {
    const lookup = vi.fn(async () => undefined as boolean | undefined);
    const filter = new CodexOtelSubagentFilter(lookup);
    filter.check(THREAD, 1000);
    await vi.waitFor(() => expect(filter.pendingCount).toBe(0));
    filter.check(THREAD, 1000 + CODEX_OTEL_METADATA_RULES.retryMs - 1);
    expect(lookup).toHaveBeenCalledTimes(1);
    lookup.mockResolvedValueOnce(true);
    filter.check(THREAD, 1000 + CODEX_OTEL_METADATA_RULES.retryMs);
    await vi.waitFor(() => expect(filter.check(THREAD, 1001 + CODEX_OTEL_METADATA_RULES.retryMs)).toBe(true));
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it('bounds concurrent reads and cached identities', async () => {
    const lookup = vi.fn(() => new Promise<boolean | undefined>(() => {}));
    const filter = new CodexOtelSubagentFilter(lookup);
    for (let i = 0; i < CODEX_OTEL_METADATA_RULES.maxCachedThreads * 2; i++) filter.check(`sample-thread-${i}`, 1000);
    expect(lookup).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(lookup).toHaveBeenCalledTimes(CODEX_OTEL_METADATA_RULES.maxInFlight);
    expect(filter.pendingCount).toBe(CODEX_OTEL_METADATA_RULES.maxInFlight);
    expect(filter.cachedCount).toBe(CODEX_OTEL_METADATA_RULES.maxCachedThreads);
  });
});
