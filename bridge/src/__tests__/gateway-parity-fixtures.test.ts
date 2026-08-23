/**
 * Gateway parity fixtures — validate that every JSON frame under
 * `tests/parity/gateway-frames/` conforms to the `GatewayFrame` union defined
 * in `shared/src/gateway-protocol.ts`.
 *
 * These fixtures are the contract the Node and Swift adapters share. A Swift
 * counterpart (`apple/AgentDeckTests/GatewayParityTests.swift`) will decode
 * the same files with `JSONDecoder` and assert the same invariants.
 *
 * WHY THE ASSERTIONS BELOW GO THROUGH THE PARSERS. This file used to check the
 * envelope and then restate each fixture's own fields back at it — and the
 * fixture, the TypeScript type, and the assertion had all been authored
 * together from one guess about the wire. Three mutually-consistent copies of
 * a guess agree with each other forever; nothing in the loop had ever been
 * compared against OpenClaw. Three fixtures were wrong the whole time
 * (`chat` with a `prompt` and a `tools` array, `session.message` as a flat
 * `{role,text}`, `session.tool` as a flat `{name,status,input,output}`), and
 * the approval fixture still carried the flat shape whose own parser file
 * documents it as disproven, including the `'allow'` decision the Gateway
 * rejects.
 *
 * So a fixture now earns its place by producing the right OUTPUT from the real
 * parser. The `chat` / `session.*` frames were captured off a live Gateway
 * (`openclaw@2026.7.1-2`) during one real turn and then content-scrubbed; the
 * session snapshot each `session.*` frame also carries was trimmed, and every
 * field a parser reads is verbatim.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import type { GatewayFrame, AdapterContext } from '@agentdeck/shared';
import { parseExecApprovalRequest } from '@agentdeck/shared';
import {
  openclawSessionMessageToSpans,
  openclawSessionToolToSpans,
  openclawChatEventToSpans,
} from '../apme/adapters/openclaw-hook.js';

const FIXTURE_DIR = join(__dirname, '../../../tests/parity/gateway-frames');

function loadFixtures(): Array<{ name: string; frame: unknown }> {
  const names = readdirSync(FIXTURE_DIR).filter((n) => n.endsWith('.json'));
  return names.map((name) => ({
    name,
    frame: JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf-8')) as unknown,
  }));
}

describe('Gateway parity fixtures', () => {
  const fixtures = loadFixtures();

  it('fixture set is non-empty', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)('$name carries a valid frame discriminator', ({ frame }) => {
    expect(frame).toBeTypeOf('object');
    const f = frame as { type?: string };
    expect(['req', 'res', 'event']).toContain(f.type);
  });

  it.each(fixtures)('$name conforms to its frame shape', ({ frame }) => {
    const f = frame as GatewayFrame;
    switch (f.type) {
      case 'req': {
        expect(typeof f.id).toBe('string');
        expect(typeof f.method).toBe('string');
        expect(f.params).toBeTypeOf('object');
        break;
      }
      case 'res': {
        expect(typeof f.id).toBe('string');
        expect(typeof f.ok).toBe('boolean');
        if (f.ok) {
          expect(f.payload).toBeDefined();
        } else {
          expect(f.error).toBeDefined();
          expect(typeof f.error?.code).toBe('string');
          expect(typeof f.error?.message).toBe('string');
        }
        break;
      }
      case 'event': {
        expect(typeof f.event).toBe('string');
        expect(f.payload).toBeTypeOf('object');
        break;
      }
    }
  });

  // ─── payload(): the fixture's payload, typed loosely for the parsers ───

  const payloadOf = (name: string): Record<string, unknown> => {
    const fixture = fixtures.find((f) => f.name === name);
    expect(fixture, name).toBeDefined();
    const f = fixture!.frame as GatewayFrame;
    expect(f.type, name).toBe('event');
    if (f.type !== 'event') throw new Error('not an event frame');
    return f.payload as Record<string, unknown>;
  };

  const ctx: AdapterContext = {
    sessionId: 's', agentType: 'openclaw', traceId: 't', cwd: '/tmp',
  };

  it('the chat frame is assistant-only — it carries no prompt and no tools', () => {
    for (const name of ['chat-delta.json', 'chat-final.json']) {
      const p = payloadOf(name);
      // Asserting the ABSENCE of the assumed fields is the part that matters:
      // reading `payload.prompt` is exactly what made the adapter believe it
      // had a prompt, so no turn was ever opened for an OpenClaw-app
      // conversation and every `turn_response` was dropped by
      // `Collector.setTurnResponse` for want of an open turn.
      expect(p, name).not.toHaveProperty('prompt');
      expect(p, name).not.toHaveProperty('tools');
      expect(p, name).not.toHaveProperty('modelId');
      expect((p.message as { role?: string }).role, name).toBe('assistant');
    }
  });

  it('chat final still yields a turn_response once the adapter fills `response`', () => {
    const p = payloadOf('chat-final.json');
    expect(p.state).toBe('final');
    const text = ((p.message as { content: Array<{ text?: string }> }).content ?? [])
      .map((b) => b.text ?? '').join('');
    expect(text.length).toBeGreaterThan(0);
    const spans = openclawChatEventToSpans(ctx, { ...p, response: text } as never);
    // `chat.final` is OpenClaw's stop signal, so it closes the turn too — a
    // single-turn conversation otherwise left its turn open until the run
    // closed, carrying no duration and an unflushed tool tally.
    expect(spans.map((s) => s.kind)).toEqual(['turn_response', 'turn_end']);
    expect(spans[1].attributes['agentdeck.turn_end_source']).toBe('stop');
  });

  it('session.message(user) yields the turn_start nothing else can provide', () => {
    const p = payloadOf('session-message-user.json');
    const spans = openclawSessionMessageToSpans(ctx, p);
    expect(spans.map((s) => s.kind)).toEqual(['turn_start']);
    expect(spans[0].attributes['agentdeck.prompt_text']).toContain('heartbeat-state.json');
  });

  it('a session.message is stamped from the message, not from delivery time', () => {
    const p = payloadOf('session-message-user.json');
    // The frame has no top-level `ts` — its top level is the session snapshot.
    expect(p).not.toHaveProperty('ts');
    const [span] = openclawSessionMessageToSpans(ctx, p);
    expect(span.ts).toBe((p.message as { timestamp: number }).timestamp);
  });

  it('session.message(assistant text) yields per-turn model/provider/usage + response', () => {
    const p = payloadOf('session-message-assistant-text.json');
    const spans = openclawSessionMessageToSpans(ctx, p);
    expect(spans.map((s) => s.kind)).toEqual(['session_meta', 'turn_response']);
    const meta = spans[0].attributes;
    expect(meta['gen_ai.request.model']).toBeTruthy();
    expect(meta['gen_ai.system']).toBeTruthy();
    expect(typeof meta['agentdeck.usage.input_tokens']).toBe('number');
    expect(typeof meta['agentdeck.usage.output_tokens']).toBe('number');
    expect(spans[1].attributes['agentdeck.response_text']).toBeTruthy();
  });

  it('toolCall blocks in an assistant message are not counted as tools', () => {
    // `session.tool` owns the tool axis — it carries the args AND the result.
    // Counting the blocks here too would double every turn's tool tally.
    const p = payloadOf('session-message-assistant-toolcall.json');
    expect(openclawSessionMessageToSpans(ctx, p).map((s) => s.kind)).toEqual(['session_meta']);
  });

  it('session.tool start/result pair into tool_call / tool_result on one call id', () => {
    const start = openclawSessionToolToSpans(ctx, payloadOf('session-tool-start.json'));
    expect(start.map((s) => s.kind)).toEqual(['tool_call']);
    expect(start[0].attributes['gen_ai.tool.name']).toBe('read');
    const startRaw = start[0].attributes['agentdeck.raw_payload'] as Record<string, unknown>;
    expect(startRaw.status).toBe('running');
    expect(startRaw.tool_input).toBeTruthy();

    const result = openclawSessionToolToSpans(ctx, payloadOf('session-tool-result.json'));
    expect(result.map((s) => s.kind)).toEqual(['tool_result']);
    const resultRaw = result[0].attributes['agentdeck.raw_payload'] as Record<string, unknown>;
    expect(resultRaw.status).toBe('success');
    expect(resultRaw.tool_response).toBeTruthy();
    expect(resultRaw.tool_call_id).toBe(startRaw.tool_call_id);
  });

  it('the session.tool facts live under `data`, never at the top level', () => {
    for (const name of ['session-tool-start.json', 'session-tool-result.json']) {
      const p = payloadOf(name);
      expect(p, name).toHaveProperty('data');
      expect(p.name, name).toBeUndefined();
      expect(p.input, name).toBeUndefined();
      expect(p.output, name).toBeUndefined();
    }
  });

  it('an unrecognized tool phase stays pending rather than inventing a completion', () => {
    const p = payloadOf('session-tool-start.json');
    const mutated = { ...p, data: { ...(p.data as object), phase: 'progress' } };
    expect(openclawSessionToolToSpans(ctx, mutated).map((s) => s.kind)).toEqual(['tool_call']);
  });

  it('exec.approval.requested parses into an answerable prompt', () => {
    const p = payloadOf('exec-approval-requested.json');
    // The fixture carried the flat `{tool, command, reason, options}` shape for
    // months AFTER `shared/src/openclaw-approval.ts` was rewritten to document
    // it as disproven — the old assertion here simply read the invented fields
    // back. Going through the parser is what ties this file to reality.
    expect(p).not.toHaveProperty('command');
    expect(p).toHaveProperty('request');
    const prompt = parseExecApprovalRequest(p, 0);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe('rg --files-with-matches TODO src');
    expect(prompt!.question).not.toContain('Approve tool execution');
    // `'allow'` is not in the Gateway's decision vocabulary; every option the
    // prompt offers must be one it will actually accept.
    for (const opt of prompt!.options) {
      expect(['allow-once', 'allow-always', 'deny']).toContain(opt.decision);
    }
    // The session key is what tells a user WHICH conversation is blocked.
    expect(prompt!.sessionKey).toBe('agent:main:eval-a03');
  });
});
