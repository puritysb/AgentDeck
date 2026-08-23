/**
 * OpenClaw chat `error` → timeline row + APME lifecycle.
 *
 * A real one (2026-08-17 10:41): z.ai answered `glm-5.2` with HTTP 429,
 * OpenClaw's failover gave up on that profile and threw
 * `FailoverError: The AI service is temporarily overloaded...`, and the row
 * that reached the timeline was that sentence and nothing else — no duration,
 * no tools, no run id. Diagnosing it meant opening the gateway log by hand.
 * Worse, the turn's APME task was left open: `chat.send` clears the idle-gap
 * timer and only `final` re-armed it, so a prompt that errored and was then
 * abandoned never closed its task at all.
 */
import { describe, it, expect, vi } from 'vitest';

const ingestSpan = vi.fn();
vi.mock('../apme/index.js', () => ({
  getApme: () => ({ collector: { ingestSpan } }),
}));

import { OpenClawAdapter } from '../adapters/openclaw.js';
import type { AdapterEvent, TimelineEntry, TelemetrySpan } from '@agentdeck/shared';

function collectTimeline(adapter: OpenClawAdapter): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  adapter.on('event', (evt: AdapterEvent) => {
    if (evt.source === 'timeline' && evt.entry && !evt.upsert) out.push(evt.entry);
  });
  return out;
}

function gw(adapter: OpenClawAdapter, event: string, payload: Record<string, unknown>): void {
  (adapter as unknown as { handleGatewayEvent(e: string, p: Record<string, unknown>): void })
    .handleGatewayEvent(event, payload);
}

const OVERLOADED = 'The AI service is temporarily overloaded. Please try again in a moment.';

function errorFrame(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'error',
    runId: '95babe45-b6b5-4a19-b199-44ae7956e4d8',
    sessionKey: 's1',
    errorMessage: OVERLOADED,
    errorKind: 'unavailable',
    stopReason: 'error',
    ...extra,
  };
}

describe('OpenClaw chat error → timeline row', () => {
  it('keeps the provider sentence as the row label and puts the turn context in detail', () => {
    const adapter = new OpenClawAdapter({ autoReconnect: false });
    const rows = collectTimeline(adapter);
    (adapter as unknown as { lastPrompt: string | null }).lastPrompt = '오늘 요약해줘';

    gw(adapter, 'chat', { state: 'delta', runId: 'r1', sessionKey: 's1' });
    gw(adapter, 'exec.approval.requested', { id: 'a1', command: 'bash -lc ls' });
    gw(adapter, 'chat', errorFrame());

    const errors = rows.filter((r) => r.type === 'error');
    expect(errors.length).toBe(1);
    expect(errors[0].raw).toBe(OVERLOADED);
    // The gateway's error frame reports no provider and no model, so the row
    // carries what it DOES have — including the run id, which is the join key
    // into the gateway log where the provider/model and HTTP status live.
    expect(errors[0].detail).toContain('kind unavailable');
    expect(errors[0].detail).toContain('stop error');
    expect(errors[0].detail).toContain('run 95babe45');
    expect(errors[0].detail).toContain('1 tool: bash');
    // A failed turn is still a turn: it gets the same time bounds as a close.
    expect(errors[0].startedAt).toBeTypeOf('number');
    expect(errors[0].endedAt).toBeTypeOf('number');
  });

  it('flags an errored gateway-initiated turn automated, like every other close row', () => {
    const adapter = new OpenClawAdapter({ autoReconnect: false });
    const rows = collectTimeline(adapter);

    // No lastPrompt → the delta path flags the chat as automated (cron).
    gw(adapter, 'chat', { state: 'delta', runId: 'r2', sessionKey: 's1' });
    gw(adapter, 'chat', errorFrame({ runId: 'r2' }));

    const err = rows.find((r) => r.type === 'error');
    // Without this an errored cron turn was indistinguishable from a user's.
    expect(err?.automated).toBe(true);
  });

  it('describes a message-less error frame instead of writing the word "unknown"', () => {
    const adapter = new OpenClawAdapter({ autoReconnect: false });
    const rows = collectTimeline(adapter);

    gw(adapter, 'chat', { state: 'error', runId: 'r3', sessionKey: 's1', errorKind: 'unavailable' });

    expect(rows.find((r) => r.type === 'error')?.raw).toBe('Chat error (unavailable)');
  });
});

describe('OpenClaw chat error → APME lifecycle', () => {
  it('records the failure and re-arms the idle-gap timer so the task can still close', () => {
    ingestSpan.mockClear();
    const adapter = new OpenClawAdapter({ autoReconnect: false });
    adapter.setApmeSession('openclaw-gateway', '/tmp/proj');
    // No run resolver installed: a frame's session key falls back to the
    // connection-scoped run, which is the pre-split behaviour and must keep
    // working rather than dropping the record.
    const fallbackTimer = () =>
      (adapter as unknown as { apmeFallbackIdleTimer: NodeJS.Timeout | null }).apmeFallbackIdleTimer;
    const clear = () =>
      (adapter as unknown as { clearIdleGapTimer(k?: string | null): void }).clearIdleGapTimer();

    // `chat.send` clears the timer; that is the state a failing turn starts in.
    clear();
    expect(fallbackTimer()).toBeNull();

    gw(adapter, 'chat', { state: 'delta', runId: 'r1', sessionKey: 's1' });
    gw(adapter, 'chat', errorFrame());

    const spans = ingestSpan.mock.calls.map((c) => c[1] as TelemetrySpan);
    const err = spans.find((s) => s.kind === 'agent_error');
    expect(err).toBeDefined();
    expect(err!.attributes['agentdeck.error_label']).toBe(OVERLOADED);
    // The failure must not close the task — the agent may retry the prompt.
    expect(spans.some((s) => s.kind === 'task_boundary')).toBe(false);
    // …but the timer that eventually WILL close it has to be running again.
    expect(fallbackTimer()).not.toBeNull();

    clear();
  });

  it('opens no run for a key whose frames record nothing', () => {
    ingestSpan.mockClear();
    const adapter = new OpenClawAdapter({ autoReconnect: false });
    adapter.setApmeSession('openclaw-gateway', '/tmp/proj');
    const opened: string[] = [];
    adapter.setApmeRunResolver((key) => { opened.push(key); return `openclaw:${key}`; });

    // Measured on live traffic 2026-08-23: a real `agent:main:main:heartbeat`
    // key opened a run holding 0 turns, 0 steps and 0 events, because the run
    // was opened while BUILDING the context — which happens for every frame,
    // including ones that parse to nothing. The Gateway filters heartbeat
    // message pairs out of `session.message`, so such frames are routine. That
    // is the same empty-run noise the per-key split exists to remove.
    gw(adapter, 'session.message', { sessionKey: 'agent:main:main:heartbeat', message: {} });
    gw(adapter, 'session.message', {
      sessionKey: 'agent:main:main:heartbeat',
      message: { role: 'user', content: '   ' },
    });
    gw(adapter, 'session.tool', { sessionKey: 'agent:main:main:heartbeat', data: { phase: 'start' } });

    expect(opened).toEqual([]);
    expect(ingestSpan).not.toHaveBeenCalled();

    // …and the first frame that DOES record something opens it.
    gw(adapter, 'session.message', {
      sessionKey: 'agent:main:main:heartbeat',
      message: { role: 'user', content: 'real work', timestamp: 1 },
    });
    expect(opened).toEqual(['agent:main:main:heartbeat']);
    expect(ingestSpan.mock.calls[0][0]).toBe('openclaw:agent:main:main:heartbeat');

    (adapter as unknown as { clearAllIdleGapTimers(): void }).clearAllIdleGapTimers();
  });

  it('scopes the run — and the idle-gap timer — per Gateway session key', () => {
    ingestSpan.mockClear();
    const adapter = new OpenClawAdapter({ autoReconnect: false });
    adapter.setApmeSession('openclaw-gateway', '/tmp/proj');
    const opened: string[] = [];
    adapter.setApmeRunResolver((key) => { opened.push(key); return `openclaw:${key}`; });

    // A user chat and a cron job, interleaved the way one Gateway connection
    // actually sees them.
    gw(adapter, 'session.message', {
      sessionKey: 'agent:main:main',
      message: { role: 'user', content: 'why is the build red?', timestamp: 1000 },
    });
    gw(adapter, 'session.message', {
      sessionKey: 'agent:main:cron:hb',
      message: { role: 'user', content: 'heartbeat', timestamp: 1001 },
    });

    expect(opened).toEqual(['agent:main:main', 'agent:main:cron:hb']);
    // Each span must be ingested against ITS OWN run, or the two conversations
    // land in one trajectory under one model id.
    const targets = ingestSpan.mock.calls.map((c) => c[0] as string);
    expect(targets).toEqual(['openclaw:agent:main:main', 'openclaw:agent:main:cron:hb']);
    expect(targets).not.toContain('openclaw-gateway');

    // The cron turn's boundary timer must not be the chat's. A heartbeat
    // firing every few minutes would otherwise keep resetting the user chat's
    // idle gap, and a task that never closes is never evaluated.
    const timers = (adapter as unknown as {
      apmeBySessionKey: Map<string, { idleTimer: NodeJS.Timeout | null }>;
    }).apmeBySessionKey;
    expect([...timers.keys()]).toEqual(['agent:main:main', 'agent:main:cron:hb']);

    gw(adapter, 'session.message', {
      sessionKey: 'agent:main:cron:hb',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], timestamp: 1002 },
    });
    expect(timers.get('agent:main:cron:hb')!.idleTimer).not.toBeNull();
    expect(timers.get('agent:main:main')!.idleTimer).toBeNull();

    (adapter as unknown as { clearAllIdleGapTimers(): void }).clearAllIdleGapTimers();
  });
});
