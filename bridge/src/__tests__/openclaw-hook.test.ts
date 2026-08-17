import { describe, it, expect } from 'vitest';
import {
  openclawChatEventToSpans,
  openclawChatErrorLabel,
  openclawChatErrorDetail,
  openclawIdleGapTaskBoundary,
  openclawChatSendToSpan,
  OPENCLAW_IDLE_GAP_MS,
} from '../apme/adapters/openclaw-hook.js';
import { sampleEventToTimeline } from '../apme/sample-to-timeline.js';
import type { AdapterContext, ChatEventPayload, ApmeSampleEventRow } from '@agentdeck/shared';

const ctx: AdapterContext = {
  sessionId: 'sess',
  agentType: 'openclaw',
  cwd: '/tmp/proj',
  traceId: 'trace-1',
  activeTurnId: undefined,
};

describe('openclaw-hook → telemetry spans', () => {
  it('OPENCLAW_IDLE_GAP_MS is conservative (60–180 s) so multi-turn collab stays together', () => {
    expect(OPENCLAW_IDLE_GAP_MS).toBeGreaterThanOrEqual(60_000);
    expect(OPENCLAW_IDLE_GAP_MS).toBeLessThanOrEqual(180_000);
  });

  it('chat.send produces exactly one turn_start span carrying the prompt text', () => {
    const span = openclawChatSendToSpan(ctx, 'fix the bug');
    expect(span.kind).toBe('turn_start');
    expect(span.attributes['agentdeck.prompt_text']).toBe('fix the bug');
    expect(span.attributes['agentdeck.agent_type']).toBe('openclaw');
  });

  it('chat.final with a response + tools yields turn_response + per-tool tool_result spans', () => {
    const payload: ChatEventPayload = {
      state: 'final',
      runId: 'r1',
      sessionKey: 'sk-1',
      response: 'I refactored auth.ts and verified the tests pass.',
      tools: [
        { name: 'bash', input: {}, status: 'success' },
        { name: 'edit', input: {}, status: 'success' },
      ],
    };
    const spans = openclawChatEventToSpans(ctx, payload);
    const kinds = spans.map((s) => s.kind);
    expect(kinds).toContain('turn_response');
    expect(kinds.filter((k) => k === 'tool_result').length).toBe(2);
    const tr = spans.find((s) => s.kind === 'turn_response')!;
    expect(tr.attributes['agentdeck.response_text']).toContain('refactored');
  });

  it('chat.delta emits no spans — deltas are streaming chunks, not eval signals', () => {
    const spans = openclawChatEventToSpans(ctx, {
      state: 'delta',
      runId: 'r1',
      delta: 'partial...',
    });
    expect(spans).toEqual([]);
  });

  it('chat.aborted emits a manual task_boundary so the user gesture closes the task immediately', () => {
    const spans = openclawChatEventToSpans(ctx, {
      state: 'aborted',
      runId: 'r1',
    });
    expect(spans.length).toBe(1);
    expect(spans[0].kind).toBe('task_boundary');
    expect(spans[0].attributes['agentdeck.boundary_signal']).toBe('manual');
  });

  it('chat.error emits an agent_error span — and NOT a task_boundary, the agent may retry', () => {
    const spans = openclawChatEventToSpans(ctx, {
      state: 'error',
      runId: 'r1',
      error: 'rate limited',
    });
    expect(spans.length).toBe(1);
    expect(spans[0].kind).toBe('agent_error');
    expect(spans[0].attributes['agentdeck.error_label']).toBe('rate limited');
    // The failure must not close the task — that stays with the idle-gap timer.
    expect(spans.some((s) => s.kind === 'task_boundary')).toBe(false);
  });

  it('idle-gap task_boundary span carries boundary_signal=idle_gap', () => {
    const span = openclawIdleGapTaskBoundary(ctx);
    expect(span.kind).toBe('task_boundary');
    expect(span.attributes['agentdeck.boundary_signal']).toBe('idle_gap');
    expect(span.attributes['agentdeck.agent_type']).toBe('openclaw');
  });

  it('agent_error carries the turn context the Gateway frame omits', () => {
    const spans = openclawChatEventToSpans(ctx, {
      state: 'error',
      runId: '95babe45-b6b5-4a19-b199-44ae7956e4d8',
      error: 'The AI service is temporarily overloaded. Please try again in a moment.',
      errorKind: 'unavailable',
      stopReason: 'error',
      durationSec: 12,
      toolNames: ['bash', 'read'],
    });
    const detail = spans[0].attributes['agentdeck.error_detail'] as string;
    // Without these the row said only what the provider replied — nothing
    // about this turn — so diagnosing it meant opening the gateway log.
    expect(detail).toContain('failed after 12s');
    expect(detail).toContain('2 tools: bash, read');
    expect(detail).toContain('kind unavailable');
    expect(detail).toContain('stop error');
    // Truncated run id: the join key into the OpenClaw gateway log.
    expect(detail).toContain('run 95babe45');
  });

  it('agent_error falls back to a describable label when the frame carries no message', () => {
    // The previous fallback was the bare word "unknown", which as a whole
    // timeline row told the reader nothing at all.
    expect(openclawChatErrorLabel({ state: 'error', errorKind: 'unavailable' }))
      .toBe('Chat error (unavailable)');
    expect(openclawChatErrorLabel({ state: 'error' })).toBe('Chat error');
  });

  it('omits detail entirely when it would only repeat the label', () => {
    expect(openclawChatErrorDetail({ state: 'error', error: 'boom' })).toBeUndefined();
  });

  it('label is byte-equal to the projected row raw, so the two never render twice', () => {
    // Under AGENTDECK_TIMELINE_PROJECTION=1 the `info` event this span becomes
    // is projected back into an `error` row while the adapter's own row is NOT
    // suppressed (`error` is not in PROJECTED_TYPES). The store's exact-dedup
    // (same type + raw within 8 s) is what collapses them — which only holds
    // while both strings are identical, hence the shared label helper.
    const payload = {
      state: 'error' as const,
      runId: 'r1',
      error: 'x'.repeat(400),
      errorKind: 'unavailable',
    };
    const label = openclawChatErrorLabel(payload);
    const row: ApmeSampleEventRow = {
      taskId: 't1', runId: 'r1', turnIndex: 0, turnId: null, seq: 1,
      ts: 1, kind: 'info', model: null, inputTokens: null, outputTokens: null,
      costUsd: null, latencyMs: null, toolName: null, toolStatus: null,
      toolError: null,
      payload: JSON.stringify({ label, detail: openclawChatErrorDetail(payload) }),
      dedupKey: 'k',
    };
    const projected = sampleEventToTimeline(row, {
      sessionId: 'openclaw-gateway', runId: 'r1', taskId: 't1',
      agentType: 'openclaw', projectName: 'OpenClaw',
    });
    expect(projected?.type).toBe('error');
    expect(projected?.raw).toBe(label);
  });

  it('all emitted spans propagate traceId for run correlation', () => {
    const finalSpans = openclawChatEventToSpans(ctx, {
      state: 'final',
      response: 'ok',
      tools: [{ name: 'bash', status: 'success' }],
    });
    const idle = openclawIdleGapTaskBoundary(ctx);
    const send = openclawChatSendToSpan(ctx, 'hi');
    for (const s of [...finalSpans, idle, send]) {
      expect(s.traceId).toBe('trace-1');
    }
  });
});
