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
    const idleTimer = () => (adapter as unknown as { apmeIdleTimer: NodeJS.Timeout | null }).apmeIdleTimer;

    // `chat.send` clears the timer; that is the state a failing turn starts in.
    (adapter as unknown as { clearIdleGapTimer(): void }).clearIdleGapTimer();
    expect(idleTimer()).toBeNull();

    gw(adapter, 'chat', { state: 'delta', runId: 'r1', sessionKey: 's1' });
    gw(adapter, 'chat', errorFrame());

    const spans = ingestSpan.mock.calls.map((c) => c[1] as TelemetrySpan);
    const err = spans.find((s) => s.kind === 'agent_error');
    expect(err).toBeDefined();
    expect(err!.attributes['agentdeck.error_label']).toBe(OVERLOADED);
    // The failure must not close the task — the agent may retry the prompt.
    expect(spans.some((s) => s.kind === 'task_boundary')).toBe(false);
    // …but the timer that eventually WILL close it has to be running again.
    expect(idleTimer()).not.toBeNull();

    (adapter as unknown as { clearIdleGapTimer(): void }).clearIdleGapTimer();
  });
});
