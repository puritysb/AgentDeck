import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { GatewayLiveActivity, GATEWAY_LIVE_RULES, gatewayToolFoldRaw } from '../gateway-live-activity.js';
// @ts-expect-error generator is deliberately runnable without transpilation
import { emitSwift, output } from '../../../scripts/generate-gateway-live-rules.mjs';
const fixture = JSON.parse(readFileSync(new URL('../../../tests/parity/gateway-live/turn.json', import.meta.url), 'utf8'));
const sessionKey = 'agent:main:test';
const frame = (runId: string, rest: object) => ({ sessionKey, runId, ...rest });
describe('Gateway live activity', () => {
  it('replays captured 2026.9.6 frames: work starts before tools, one prompt/tool/answer', () => {
    const live = new GatewayLiveActivity();
    const rows = [];
    for (const f of fixture) {
      rows.push(...live.ingest(f.event, f.payload, f.observedAt));
      if (f.event === 'session.tool') expect(live.busy).toBe(true);
      if (f.event === 'chat' && f.payload.state === 'status') expect(live.busy).toBe(true);
    }
    expect(live.busy).toBe(false);
    expect(rows.map(r => r.entry.type)).toEqual(['chat_start', 'tool_exec', 'chat_response']);
    expect(rows[0].entry.raw).toContain('sleep 20');
    expect(rows[1].entry.detail).toContain('AGENTDECK_OC_CHAT_TOOL_OK');
    expect(rows[1].entry.endedAt! - rows[1].entry.startedAt!).toBeGreaterThan(20_000);
    expect(rows[2].entry.raw).toBe('AGENTDECK_OC_CHAT_DONE');
    expect(new Set(rows.map(r => r.entry.runId)).size).toBe(1);
    expect(rows.every(r => r.entry.automated === false && r.entry.sessionId === 'openclaw-gateway')).toBe(true);
    expect(fixture.flatMap((f: any) => live.ingest(f.event, f.payload, f.observedAt))).toEqual([]);
    expect(live.busy).toBe(false);
  });
  it('keeps parallel runs busy, ignores lastRunId, and handles explicit settled snapshot', () => {
    const live = new GatewayLiveActivity();
    live.ingest('sessions.changed', { sessionKey, session: { lastRunId: 'old' } }, 1);
    expect(live.busy).toBe(false);
    live.ingest('sessions.changed', { sessionKey, session: { hasActiveRun: true, activeRunIds: ['a','b'] } }, 2);
    live.ingest('chat', frame('a', { state: 'final' }), 3);
    expect(live.busy).toBe(true);
    live.ingest('sessions.changed', { sessionKey: 'other', session: { hasActiveRun: false } }, 4);
    expect(live.busy).toBe(true);
    live.ingest('sessions.changed', { sessionKey, session: { hasActiveRun: false } }, 5);
    expect(live.busy).toBe(false);
  });
  it('deduplicates tool streams, silences successful polling, retains errors and late results', () => {
    const live = new GatewayLiveActivity();
    const tool = (phase: string, extra = {}) => frame('a', { stream: 'tool', data: { phase, name: 'process', toolCallId: 'one', ...extra } });
    live.ingest('session.tool', tool('start', { args: { action: 'poll' } }), 1);
    expect(live.ingest('session.tool', tool('update'), 2)).toEqual([]);
    expect(live.ingest('session.tool', tool('result'), 3)).toEqual([]);
    live.ingest('chat', frame('a', { state: 'final' }), 4);
    const failed = frame('a', { stream: 'tool', data: { phase: 'result', name: 'exec', toolCallId: 'two', isError: true, result: 'failed command' } });
    expect(live.ingest('agent', failed, 5)[0].entry.raw).toContain('failed');
    expect(live.ingest('session.tool', failed, 6)).toEqual([]);
    expect(live.busy).toBe(false);
  });
  it('folds every tool call of a run into one row, updated in place', () => {
    // Measured 2026-10-03: a voice request walked OpenClaw's config with 16
    // `openclaw · <key>` reads in two minutes, one timeline row each.
    const live = new GatewayLiveActivity();
    live.ingest('session.message', frame('a', { message: { role: 'user', content: 'tone the wake word down' } }), 1);
    const call = (id: string, key: string, ts: number, extra = {}) => {
      live.ingest('session.tool', frame('a', { stream: 'tool', data: { phase: 'start', name: 'openclaw', toolCallId: id, args: { path: key } } }), ts);
      return live.ingest('session.tool', frame('a', { stream: 'tool', data: { phase: 'result', name: 'openclaw', toolCallId: id, ...extra } }), ts + 1);
    };
    const first = call('1', 'channels', 10);
    expect(first).toHaveLength(1);
    expect(first[0].upsert).toBeUndefined();
    expect(first[0].entry.raw).toBe('openclaw · channels');
    const second = call('2', 'agents.main', 20);
    expect(second[0]).toMatchObject({ upsert: true, entry: { ts: first[0].entry.ts, runId: 'a', type: 'tool_exec' } });
    call('3', 'messages.groupChat', 30);
    const fourth = call('4', '.', 40, { isError: true });
    expect(fourth[0].entry.raw).toBe('openclaw ×4 · channels, agents.main, messages.groupChat, … · 1 failed');
    expect(fourth[0].entry.detail!.split('\n')).toEqual([
      'openclaw · channels', 'openclaw · agents.main', 'openclaw · messages.groupChat', 'openclaw · . · failed',
    ]);
    expect(fourth[0].entry).toMatchObject({ startedAt: 10, endedAt: 41 });
  });
  it('labels a folded row by its calls', () => {
    expect(gatewayToolFoldRaw(['exec · ls'])).toBe('exec · ls');
    expect(gatewayToolFoldRaw(['exec · ls', 'exec · ls'])).toBe('exec ×2 · ls');
    expect(gatewayToolFoldRaw(['exec · a', 'read · b', 'exec · c', 'openclaw · d · failed']))
      .toBe('4 tools · exec ×2, read, openclaw · 1 failed');
    expect(gatewayToolFoldRaw(['web', 'web'])).toBe('web ×2');
  });
  it('retains dispatched prompt and attributes a pending user message to its run', () => {
    const live = new GatewayLiveActivity();
    const first = live.ingest('session.message', { sessionKey, message: { role: 'user', content: 'hello' } }, 1);
    const attributed = live.ingest('chat', frame('a', { state: 'status' }), 2);
    expect(attributed[0]).toMatchObject({ upsert: true, entry: { ts: first[0].entry.ts, runId: 'a' } });
    live.reset();
    expect(live.busy).toBe(false);
    expect(live.dispatch(sessionKey, 'b', 'from deck', 3.75)[0].entry).toMatchObject({ raw: 'from deck', ts: 3, startedAt: 3 });
  });
  it('does not treat unknown events or historical assistant messages as work', () => {
    const live = new GatewayLiveActivity();
    live.ingest('session.message', frame('old', { message: { role: 'assistant', content: 'history' } }), 1);
    live.ingest('health', { ok: true }, 2);
    live.ingest('session.message', { sessionKey, message: { role: 'user', content: '   ' } }, 3);
    live.ingest('session.tool', { sessionKey, data: { phase: 'start' } }, 4);
    expect(live.busy).toBe(false);
  });
  it('keeps the generated Swift constants and reducer template in sync', () => {
    expect(readFileSync(new URL(`../../../${output}`, import.meta.url), 'utf8')).toBe(emitSwift(GATEWAY_LIVE_RULES));
  });
});
