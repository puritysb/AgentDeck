import { describe, it, expect } from 'vitest';
import { sampleEventToTimeline } from '../apme/sample-to-timeline.js';
import { openclawSessionToolToSpans, openclawSessionMessageToSpans } from '../apme/adapters/openclaw-hook.js';
import type { ApmeSampleEventRow, AdapterContext } from '@agentdeck/shared';

const header = { sessionId: 's', runId: 'r', taskId: 't', agentType: 'openclaw' as const, projectName: 'demo' };

function row(partial: Partial<ApmeSampleEventRow> & { kind: ApmeSampleEventRow['kind'] }): ApmeSampleEventRow {
  return { taskId: 't', runId: 'r', seq: 0, ts: 1000, turnIndex: 0, ...partial };
}

describe('sampleEventToTimeline projection', () => {
  it('projects user_message → chat_start', () => {
    const e = sampleEventToTimeline(row({ kind: 'user_message', payload: JSON.stringify({ text: 'fix bug' }) }), header);
    expect(e).toMatchObject({ type: 'chat_start', raw: 'fix bug', sessionId: 's', taskId: 't' });
  });

  it('projects a text assistant_message → chat_response but skips tool_only', () => {
    const text = sampleEventToTimeline(row({ kind: 'assistant_message', payload: JSON.stringify({ text: 'done', responseKind: 'text' }) }), header);
    expect(text).toMatchObject({ type: 'chat_response', raw: 'done' });
    const toolOnly = sampleEventToTimeline(row({ kind: 'assistant_message', payload: JSON.stringify({ text: '', responseKind: 'tool_only' }) }), header);
    expect(toolOnly).toBeNull();
  });

  it('projects tool → tool_resolved with status mapping + input summary', () => {
    const ok = sampleEventToTimeline(row({ kind: 'tool', toolName: 'Bash', toolStatus: 'success', payload: JSON.stringify({ input: { command: 'pnpm test' } }) }), header);
    expect(ok).toMatchObject({ type: 'tool_resolved', raw: 'Bash · pnpm test', status: 'approved' });
    const err = sampleEventToTimeline(row({ kind: 'tool', toolName: 'Edit', toolStatus: 'error', toolError: 'boom' }), header);
    expect(err).toMatchObject({ type: 'tool_resolved', status: 'denied', detail: 'boom' });
  });

  it('skips model and state events (no standalone row)', () => {
    expect(sampleEventToTimeline(row({ kind: 'model', model: 'claude-opus-4-8' }), header)).toBeNull();
    expect(sampleEventToTimeline(row({ kind: 'state', payload: JSON.stringify({ to: 'processing' }) }), header)).toBeNull();
  });
});

describe('OpenClaw session.tool / session.message → spans', () => {
  const ctx: AdapterContext = { agentType: 'openclaw', sessionId: 'sess', traceId: 'trace', activeTurnId: undefined, cwd: '/tmp/p' };

  // These cases used to be written against a flat `{name, status, input}` /
  // `{role, text}` shape that the Gateway has never sent. They passed for
  // months because the parser, the wire type and the fixture were all authored
  // from the same guess — and the events themselves never arrived, because
  // nothing had called `sessions.subscribe`. The shapes below are the real
  // ones; `gateway-parity-fixtures.test.ts` pins them against frames captured
  // off a live Gateway.

  it('maps a tool start to a tool_call span carrying the args', () => {
    const spans = openclawSessionToolToSpans(ctx, {
      sessionKey: 'agent:main:main',
      data: { phase: 'start', name: 'Bash', toolCallId: 'c1', args: { cmd: 'ls' } },
    });
    expect(spans.length).toBe(1);
    expect(spans[0].kind).toBe('tool_call');
    expect(spans[0].attributes['agentdeck.tool_name']).toBe('Bash');
    const raw = spans[0].attributes['agentdeck.raw_payload'] as Record<string, unknown>;
    expect(raw.tool_input).toEqual({ cmd: 'ls' });
    expect(raw.status).toBe('running');
  });

  it('maps a tool result to a tool_result span carrying the output', () => {
    const spans = openclawSessionToolToSpans(ctx, {
      data: { phase: 'result', name: 'Bash', toolCallId: 'c1', isError: false, result: 'ok' },
    });
    expect(spans[0].kind).toBe('tool_result');
    const raw = spans[0].attributes['agentdeck.raw_payload'] as Record<string, unknown>;
    expect(raw.tool_response).toBe('ok');
    expect(raw.status).toBe('success');
  });

  it('reports an errored tool as a result, not as a success', () => {
    const spans = openclawSessionToolToSpans(ctx, {
      data: { phase: 'result', name: 'Bash', isError: true, result: 'boom' },
    });
    expect(spans[0].kind).toBe('tool_result');
    expect((spans[0].attributes['agentdeck.raw_payload'] as Record<string, unknown>).status).toBe('error');
  });

  it("treats phase 'error' as a failure even when isError is absent", () => {
    // The Gateway can signal failure with the phase alone. Deriving status from
    // `isError` only recorded such a frame as a SUCCESSFUL tool result — a
    // silent wrong answer that also feeds the tool tally the APME judge scores,
    // and it disagreed with the Swift adapter, which classified the same frame
    // as an error. The two daemons take turns owning `timeline.json`.
    const spans = openclawSessionToolToSpans(ctx, {
      data: { phase: 'error', name: 'Bash', result: 'boom' },
    });
    expect(spans[0].kind).toBe('tool_result');
    expect((spans[0].attributes['agentdeck.raw_payload'] as Record<string, unknown>).status).toBe('error');
  });

  it('maps a user message to turn_start — the prompt no other channel carries', () => {
    const u = openclawSessionMessageToSpans(ctx, {
      sessionKey: 'agent:main:main',
      message: { role: 'user', content: 'hello', timestamp: 5000 },
    });
    expect(u.map((x) => x.kind)).toEqual(['turn_start']);
    expect(u[0].attributes['agentdeck.prompt_text']).toBe('hello');
    expect(u[0].ts).toBe(5000);
  });

  it('maps an assistant message to session_meta + turn_response', () => {
    const a = openclawSessionMessageToSpans(ctx, {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi back' }],
        provider: 'zai', model: 'glm-5.2',
        usage: { input: 10, output: 2, cost: { total: 0.5 } },
      },
    });
    expect(a.map((x) => x.kind)).toEqual(['session_meta', 'turn_response']);
    expect(a[0].attributes['gen_ai.request.model']).toBe('glm-5.2');
    expect(a[0].attributes['gen_ai.system']).toBe('zai');
    expect(a[0].attributes['agentdeck.usage.input_tokens']).toBe(10);
    expect(a[0].attributes['agentdeck.usage.cost_usd']).toBe(0.5);
    expect(a[1].attributes['agentdeck.response_text']).toBe('hi back');
  });

  it('does not count an assistant toolCall block as a tool', () => {
    // `session.tool` owns that axis and carries the result too; counting the
    // block here as well would double every turn's tool tally.
    const a = openclawSessionMessageToSpans(ctx, {
      message: {
        role: 'assistant', model: 'glm-5.2',
        content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: '/x' } }],
      },
    });
    expect(a.map((x) => x.kind)).toEqual(['session_meta']);
  });

  it('drops a toolResult message — session.tool already reported it', () => {
    expect(openclawSessionMessageToSpans(ctx, {
      message: { role: 'toolResult', content: [{ type: 'text', text: 'out' }] },
    })).toEqual([]);
  });

  it('drops empty/blank messages and nameless tools', () => {
    expect(openclawSessionMessageToSpans(ctx, { message: { role: 'user', content: '   ' } })).toEqual([]);
    expect(openclawSessionMessageToSpans(ctx, {})).toEqual([]);
    expect(openclawSessionToolToSpans(ctx, { data: { phase: 'start' } })).toEqual([]);
    expect(openclawSessionToolToSpans(ctx, {})).toEqual([]);
  });
});
