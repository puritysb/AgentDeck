/**
 * OpenClaw: a run is opened by a span that can record, not by a non-empty
 * span list (#300).
 *
 * Measured on the live daemon over the week to 2026-09-09: of 113 OpenClaw
 * runs, 87 held zero sample_events, and 82 of those held zero `steps` rows as
 * well — 25 scoped to a session key, 57 to the Gateway connection. Every one
 * was tagged `_empty` and then held open until the 30-minute orphan reaper.
 *
 * The cause is that `ingestApmeSpans` asked "are there spans?" when the honest
 * question is "is there a span that will actually be recorded?". An assistant
 * `session.message` always builds a `session_meta` span (it carries
 * model/provider/usage) and, when it has text, a `turn_response` too — so the
 * array is never empty. With no turn open the collector discards both:
 * `setTurnResponse` returns on a missing turn id and `updateTurnIdentity` /
 * `addUsageIncrement` are no-ops. The run had already been opened to hold them.
 *
 * The frames below are the captured live-Gateway fixtures, driven through the
 * real parser — see `tests/parity/gateway-frames/README.md`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const ingestSpan = vi.fn();
vi.mock('../apme/index.js', () => ({
  getApme: () => ({ collector: { ingestSpan } }),
}));

import { readFileSync } from 'fs';
import { join } from 'path';
import { OpenClawAdapter } from '../adapters/openclaw.js';
import { ApmeCollector } from '../apme/collector.js';
import type { TelemetrySpan, TelemetrySpanKind } from '@agentdeck/shared';

const FIXTURE_DIR = join(__dirname, '../../../tests/parity/gateway-frames');

function frame(name: string): { event: string; payload: Record<string, unknown> } {
  const f = JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8')) as
    { event: string; payload: Record<string, unknown> };
  return f;
}

function gw(adapter: OpenClawAdapter, event: string, payload: Record<string, unknown>): void {
  (adapter as unknown as { handleGatewayEvent(e: string, p: Record<string, unknown>): void })
    .handleGatewayEvent(event, payload);
}

/** Adapter wired the way the daemon wires it, with both openers spied. */
function wired() {
  const openKey = vi.fn((key: string) => `openclaw:${key}`);
  const openFallback = vi.fn(() => 'openclaw-conn');
  const adapter = new OpenClawAdapter({ autoReconnect: false });
  adapter.setApmeSession('openclaw-conn', '/tmp/project', openFallback);
  adapter.setApmeRunResolver(openKey);
  return { adapter, openKey, openFallback };
}

const kinds = (): TelemetrySpanKind[] =>
  ingestSpan.mock.calls.map((c) => (c[1] as TelemetrySpan).kind);

describe('OpenClaw APME run opening', () => {
  beforeEach(() => { ingestSpan.mockClear(); });

  it('an assistant message alone opens no run for its session key', () => {
    const { adapter, openKey, openFallback } = wired();
    const f = frame('session-message-assistant-text.json');

    gw(adapter, f.event, f.payload);

    // The spans exist — that was never the question.
    expect(openKey).not.toHaveBeenCalled();
    expect(openFallback).not.toHaveBeenCalled();
    expect(ingestSpan).not.toHaveBeenCalled();
  });

  it('the user message that starts the turn is what opens it, and later assistant messages then land', () => {
    const { adapter, openKey } = wired();
    const user = frame('session-message-user.json');
    const assistant = frame('session-message-assistant-text.json');

    gw(adapter, user.event, user.payload);
    expect(openKey).toHaveBeenCalledTimes(1);
    expect(openKey).toHaveBeenCalledWith('agent:main:agentdeck-probe');
    expect(kinds()).toContain('turn_start');

    // Same key, run already open: nothing is gated any more.
    ingestSpan.mockClear();
    gw(adapter, assistant.event, assistant.payload);
    expect(openKey).toHaveBeenCalledTimes(1);
    expect(kinds()).toContain('session_meta');
    expect(ingestSpan.mock.calls.every((c) => c[0] === 'openclaw:agent:main:agentdeck-probe')).toBe(true);
  });

  it('a tool span opens a run — it inserts a step row with no turn open', () => {
    const { adapter, openKey } = wired();
    const f = frame('session-tool-start.json');

    gw(adapter, f.event, f.payload);

    expect(openKey).toHaveBeenCalledTimes(1);
    expect(kinds()).toContain('tool_call');
  });

  it('the connection-scoped fallback run is opened by the same rule, not at connect', () => {
    const { adapter, openFallback } = wired();
    // A frame the Gateway sent without a session key. The adapter routes these
    // to the connection-scoped run deliberately (a mis-scoped record beats no
    // record); the question here is only whether it OPENS one.
    const assistant = frame('session-message-assistant-text.json');
    delete (assistant.payload as Record<string, unknown>).sessionKey;
    gw(adapter, assistant.event, assistant.payload);
    expect(openFallback).not.toHaveBeenCalled();

    const user = frame('session-message-user.json');
    delete (user.payload as Record<string, unknown>).sessionKey;
    gw(adapter, user.event, user.payload);
    expect(openFallback).toHaveBeenCalledTimes(1);
    expect(kinds()).toContain('turn_start');

    // Opened once, then reused.
    gw(adapter, user.event, user.payload);
    expect(openFallback).toHaveBeenCalledTimes(1);
  });
});

describe('ApmeCollector.spanCanOpenRun', () => {
  it('is true exactly for the kinds whose ingestSpan branch reaches ingestHook', () => {
    // ingestHook inserts a `steps` row unconditionally once the run exists,
    // and turn_start additionally opens the turn and task.
    for (const k of ['turn_start', 'tool_call', 'tool_result', 'raw_step'] as TelemetrySpanKind[]) {
      expect(ApmeCollector.spanCanOpenRun(k), k).toBe(true);
    }
    // These all resolve an open turn or task first and return early without one.
    for (const k of ['turn_response', 'turn_end', 'session_meta', 'task_boundary', 'agent_error'] as TelemetrySpanKind[]) {
      expect(ApmeCollector.spanCanOpenRun(k), k).toBe(false);
    }
  });
});
