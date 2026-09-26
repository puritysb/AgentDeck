import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenClawAdapter } from '../adapters/openclaw.js';
import { startPersonalVoiceTurn } from '../personal-voice-turn.js';
import type { AdapterEvent } from '@agentdeck/shared';

function setup() {
  const adapter = new OpenClawAdapter({ autoReconnect: false });
  const internal = adapter as unknown as {
    rpcCall: (...args: unknown[]) => Promise<{ runId: string }>;
    handleGatewayEvent: (event: string, payload: Record<string, unknown>) => void;
  };
  const rpc = vi.spyOn(internal, 'rpcCall').mockResolvedValue({ runId: 'voice' });
  const states: string[] = [];
  adapter.on('event', (event: AdapterEvent) => {
    if (event.source === 'parser') states.push(event.event);
  });
  const chat = (runId: string, state: string, sessionKey = 'agent:main:voice') =>
    internal.handleGatewayEvent('chat', { runId, state, sessionKey,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Done' }] } });
  return { adapter, internal, rpc, states, chat };
}
afterEach(() => vi.useRealTimers());

describe('personal voice activity on the real adapter', () => {
  it('shows work before any delta and closes a final-only response', async () => {
    const { adapter, states, chat } = setup();
    const turn = await startPersonalVoiceTurn(adapter, 'hello', 'agent:main:voice');
    expect(states.at(-1)).toBe('spinner_start');
    chat('voice', 'final');
    await turn.completion;
    expect(states.at(-1)).toBe('idle');
  });

  it('does not let a cron final hide the voice model thinking interval', async () => {
    const { adapter, states, chat } = setup();
    const turn = await startPersonalVoiceTurn(adapter, 'hello', 'agent:main:voice');
    chat('cron', 'final', 'agent:main:cron:job');
    expect(states.at(-1)).toBe('spinner_start');
    chat('voice', 'final'); await turn.completion;
    expect(states.at(-1)).toBe('idle');
  });

  it('keeps a second voice request visible when the first finishes', async () => {
    const { adapter, rpc, states, chat } = setup();
    const first = await startPersonalVoiceTurn(adapter, 'first', 'agent:main:voice');
    rpc.mockResolvedValue({ runId: 'second' });
    const second = await startPersonalVoiceTurn(adapter, 'second', 'agent:main:voice');
    chat('voice', 'final'); await first.completion;
    expect(states.at(-1)).toBe('spinner_start');
    chat('second', 'final'); await second.completion;
    expect(states.at(-1)).toBe('idle');
  });

  it('clears activity on refusal and on the voice deadline', async () => {
    const { adapter, rpc, states } = setup();
    rpc.mockRejectedValueOnce(new Error('offline'));
    await expect(startPersonalVoiceTurn(adapter, 'hello')).rejects.toThrow('offline');
    expect(states.at(-1)).toBe('idle');
    vi.useFakeTimers();
    const turn = await startPersonalVoiceTurn(adapter, 'hello', undefined, 100);
    const rejected = expect(turn.completion).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(101); await rejected;
    expect(states.at(-1)).toBe('idle');
  });

  it('preserves a permission prompt while voice work is pending', async () => {
    const { adapter, internal, states, chat } = setup();
    internal.handleGatewayEvent('exec.approval.requested', {
      id: 'approval', createdAtMs: Date.now(), request: { command: 'ls', allowedDecisions: ['allow-once', 'deny'] },
    });
    const turn = await startPersonalVoiceTurn(adapter, 'hello', 'agent:main:voice');
    expect(states.at(-1)).toBe('permission_prompt');
    internal.handleGatewayEvent('exec.approval.resolved', { id: 'approval', decision: 'allow-once' });
    chat('voice', 'final'); await turn.completion;
  });

  it('handles a final that arrives before the acknowledgement', async () => {
    const { adapter, rpc, states, chat } = setup();
    rpc.mockImplementation(async () => { chat('voice', 'final'); return { runId: 'voice' }; });
    const turn = await startPersonalVoiceTurn(adapter, 'hello', 'agent:main:voice');
    await turn.completion;
    expect(states.at(-1)).toBe('idle');
  });
});
