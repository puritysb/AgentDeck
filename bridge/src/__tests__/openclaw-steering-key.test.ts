/**
 * The deck's prompt, stop and settings go to the user's conversation, not to
 * whichever OpenClaw session spoke last. On the owner's Gateway (2026-10-10)
 * the newest keys are eval runs and cron ticks; the adapter used to retarget
 * `chat.send` at each of them.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ debug: vi.fn(), log: vi.fn(), logError: vi.fn() }));

import { OpenClawAdapter } from '../adapters/openclaw.js';

type Priv = {
  alive: boolean;
  rpcCall: (method: string, params: unknown) => Promise<unknown>;
  fetchSessions(): Promise<void>;
  gatewayMainSessionKey: string | null;
  handleGatewayEvent(e: string, p: Record<string, unknown>): void;
};

function setup(sessions: Array<{ key: string; updatedAt: number }>) {
  const adapter = new OpenClawAdapter({ autoReconnect: false });
  const priv = adapter as unknown as Priv;
  priv.alive = true;
  const calls: Array<[string, Record<string, unknown>]> = [];
  priv.rpcCall = vi.fn(async (method: string, params: unknown) => {
    calls.push([method, params as Record<string, unknown>]);
    return method === 'sessions.list' ? { sessions } : {};
  });
  return { adapter, priv, calls };
}

const sent = (calls: Array<[string, Record<string, unknown>]>, method: string) =>
  calls.filter(([m]) => m === method).map(([, p]) => p.sessionKey);

describe('OpenClaw steering key', () => {
  it('targets the newest conversation at connect, not the newest eval run', async () => {
    const { adapter, priv, calls } = setup([
      { key: 'agent:main:eval-zai-glm-5.3-t07__r2', updatedAt: 300 },
      { key: 'agent:main:cron:abc', updatedAt: 200 },
      { key: 'agent:main:main', updatedAt: 100 },
    ]);
    await priv.fetchSessions();
    adapter.handleCommand({ type: 'send_prompt', text: 'hello' } as never);
    expect(sent(calls, 'chat.send')).toEqual(['agent:main:main']);
  });

  it('a cron tick between two presses does not take the next prompt or the stop', async () => {
    const { adapter, priv, calls } = setup([{ key: 'agent:main:main', updatedAt: 100 }]);
    await priv.fetchSessions();
    priv.handleGatewayEvent('chat', { state: 'delta', runId: 'cron-run', sessionKey: 'agent:main:cron:abc' });
    adapter.handleCommand({ type: 'send_prompt', text: 'next' } as never);
    adapter.handleCommand({ type: 'interrupt' } as never);
    expect(sent(calls, 'chat.send')).toEqual(['agent:main:main']);
    const abort = calls.find(([m]) => m === 'chat.abort')?.[1];
    // The running cron run is not the user's to abort.
    expect(abort).toEqual({ sessionKey: 'agent:main:main' });
  });

  it('the user talking in a dashboard chat moves the deck there', async () => {
    const { adapter, priv, calls } = setup([{ key: 'agent:main:main', updatedAt: 100 }]);
    await priv.fetchSessions();
    priv.handleGatewayEvent('chat', { state: 'delta', runId: 'r1', sessionKey: 'agent:main:dashboard:d1' });
    adapter.handleCommand({ type: 'send_prompt', text: 'more' } as never);
    expect(sent(calls, 'chat.send')).toEqual(['agent:main:dashboard:d1']);
  });

  it('a LINE group answering other people never takes the deck', async () => {
    const { adapter, priv, calls } = setup([{ key: 'agent:main:main', updatedAt: 100 }]);
    await priv.fetchSessions();
    priv.handleGatewayEvent('chat', { state: 'delta', runId: 'g1', sessionKey: 'agent:main:line:group:u754' });
    adapter.handleCommand({ type: 'send_prompt', text: 'private note' } as never);
    expect(sent(calls, 'chat.send')).toEqual(['agent:main:main']);
  });

  it('a page of eval runs with no conversation falls back to the Gateway main key, not an eval run', async () => {
    const { adapter, priv, calls } = setup([
      { key: 'agent:main:eval-a__r1', updatedAt: 300 },
      { key: 'agent:main:eval-a__r2', updatedAt: 200 },
    ]);
    priv.gatewayMainSessionKey = 'agent:main:main';
    await priv.fetchSessions();
    priv.handleGatewayEvent('chat', { state: 'delta', runId: 'e3', sessionKey: 'agent:main:eval-a__r3' });
    adapter.handleCommand({ type: 'send_prompt', text: 'hi' } as never);
    expect(sent(calls, 'chat.send')).toEqual(['agent:main:main']);
  });
});
