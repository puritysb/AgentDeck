/**
 * #463: the deck's OpenClaw setting switches read the Gateway's own row and
 * catalog, and write through `sessions.patch` on the same session key that
 * `send_prompt` targets.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({ debug: vi.fn(), log: vi.fn(), logError: vi.fn() }));

import { OpenClawAdapter } from '../adapters/openclaw.js';

type Priv = {
  alive: boolean;
  steeringSessionKey: string | null;
  gatewayMethods: Set<string> | null;
  rpcCall: (method: string, params: unknown) => Promise<unknown>;
};

const LEVELS = [{ id: 'off', label: 'off' }, { id: 'medium', label: 'medium' }, { id: 'high', label: 'high' }];

function makeAdapter(rpc: (method: string, params: any) => unknown): { adapter: OpenClawAdapter; calls: Array<[string, unknown]> } {
  const adapter = new OpenClawAdapter({ autoReconnect: false });
  const priv = adapter as unknown as Priv;
  priv.alive = true;
  priv.steeringSessionKey = 'agent:main:dashboard:a';
  const calls: Array<[string, unknown]> = [];
  priv.rpcCall = vi.fn(async (method: string, params: unknown) => { calls.push([method, params]); return rpc(method, params); });
  return { adapter, calls };
}

const listing = {
  defaults: { thinkingDefault: 'high' },
  sessions: [
    { key: 'agent:main:main', thinkingLevel: 'off', thinkingLevels: LEVELS },
    { key: 'agent:main:dashboard:a', thinkingLevel: 'medium', thinkingLevels: LEVELS, thinkingDefault: 'high', modelProvider: 'zai', model: 'glm-5.3' },
  ],
};
const models = { models: [{ id: 'glm-5.3', name: 'GLM-5.3', provider: 'zai', tags: ['default'], available: true }] };

describe('OpenClawAdapter session settings', () => {
  it('reads the targeted session row (not the main session) plus the models.list catalog', async () => {
    const { adapter } = makeAdapter((m) => (m === 'sessions.list' ? listing : models));
    const { settings, targetSessionKey } = await adapter.querySessionSettings();
    expect(targetSessionKey).toBe('agent:main:dashboard:a');
    expect(settings.find((s) => s.key === 'effort')).toEqual({
      key: 'effort', current: 'medium', default: 'high', options: [{ id: 'off' }, { id: 'medium' }, { id: 'high' }],
    });
    expect(settings.find((s) => s.key === 'model')).toMatchObject({ current: 'zai/glm-5.3', default: 'zai/glm-5.3' });
  });

  it('patches the same session key, and null clears the override', async () => {
    const { adapter, calls } = makeAdapter(() => ({}));
    await adapter.setSessionSetting('agent:main:dashboard:a', 'effort', 'high');
    await adapter.setSessionSetting('agent:main:dashboard:a', 'model', null);
    expect(calls).toEqual([
      ['sessions.patch', { key: 'agent:main:dashboard:a', thinkingLevel: 'high' }],
      ['sessions.patch', { key: 'agent:main:dashboard:a', model: null }],
    ]);
  });

  it('refuses instead of guessing when the targeted session is not listed', async () => {
    const { adapter } = makeAdapter(() => ({ sessions: [{ key: 'agent:main:main' }] }));
    await expect(adapter.querySessionSettings()).rejects.toThrow(/not listed/);
  });
});


describe('OpenClaw setting conversation binding', () => {
  it('captures query target before awaits and refuses a stale picker write', async () => {
    let finishList!: (value: unknown) => void;
    const { adapter, calls } = makeAdapter(m => m === 'sessions.list' ? new Promise(done => { finishList = done; }) : models);
    const query = adapter.querySessionSettings();
    (adapter as unknown as Priv).steeringSessionKey = 'agent:main:dashboard:b'; // Background chat moved the active target.
    finishList(listing);
    expect((await query).targetSessionKey).toBe('agent:main:dashboard:a');
    await expect(adapter.setSessionSetting('agent:main:dashboard:a', 'effort', 'high')).rejects.toThrow(/conversation changed/);
    expect(calls.filter(([method]) => method === 'sessions.patch')).toEqual([]);
  });

  it('post-write readback remains on the patched conversation after a chat changes the active key', async () => {
    let adapter!: OpenClawAdapter;
    ({ adapter } = makeAdapter(m => {
      if (m === 'sessions.patch') (adapter as unknown as Priv).steeringSessionKey = 'agent:main:dashboard:b';
      return m === 'sessions.list' ? listing : models;
    }));
    await adapter.setSessionSetting('agent:main:dashboard:a', 'model', 'zai/glm-5.3');
    const readback = await adapter.querySessionSettings('agent:main:dashboard:a');
    expect(readback.targetSessionKey).toBe('agent:main:dashboard:a');
    expect(readback.settings.find(s => s.key === 'effort')?.current).toBe('medium');
  });

  it('refuses malformed keys and values even for direct adapter callers', async () => {
    const { adapter, calls } = makeAdapter(() => ({}));
    await expect(adapter.setSessionSetting('agent:main:dashboard:a', 'unknown' as any, null)).rejects.toThrow(/Unknown/);
    for (const value of [undefined, 123, true, {}, '', ' ']) {
      await expect(adapter.setSessionSetting('agent:main:dashboard:a', 'model', value as any)).rejects.toThrow(/Invalid/);
    }
    expect(calls).toEqual([]);
  });
});
