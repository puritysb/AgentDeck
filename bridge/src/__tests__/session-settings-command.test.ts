import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket from 'ws';
import type { SessionSettingsEvent } from '@agentdeck/shared';
import { handleSessionSettingsRequest, handleSessionSettingsSocketRequest } from '../daemon-server.js';
import { WsServer } from '../ws-server.js';

const targetSessionKey = 'agent:main:dashboard:a';
const query = { type: 'query_session_settings', requestId: 'query-a', sessionId: 'openclaw-gateway' };
const set = { type: 'set_session_setting', requestId: 'set-a', sessionId: 'openclaw-gateway', targetSessionKey, key: 'model', value: 'zai/glm-5.3' };
function fixture() {
  const adapter = {
    isAlive: () => true,
    querySessionSettings: vi.fn(async (key = targetSessionKey) => ({ targetSessionKey: key, settings: [] })),
    setSessionSetting: vi.fn(async () => {}),
  };
  const events: SessionSettingsEvent[] = [];
  return { adapter, events, reply: (event: SessionSettingsEvent) => events.push(event) };
}

describe('actual daemon settings command boundary', () => {
  it('correlates query and explicit-null write without replacing the concrete target', async () => {
    const { adapter, events, reply } = fixture();
    await handleSessionSettingsRequest(query, adapter, reply);
    await handleSessionSettingsRequest({ ...set, value: null }, adapter, reply);
    expect(adapter.setSessionSetting).toHaveBeenCalledWith(targetSessionKey, 'model', null);
    expect(adapter.querySessionSettings).toHaveBeenLastCalledWith(targetSessionKey);
    expect(events.map(event => [event.requestId, event.sessionId, event.targetSessionKey, event.error])).toEqual([
      ['query-a', 'openclaw-gateway', targetSessionKey, undefined],
      ['set-a', 'openclaw-gateway', targetSessionKey, undefined],
    ]);
  });

  it('rejects missing and malformed values rather than clearing an override', async () => {
    for (const value of [undefined, true, 17, {}, [], '', ' ']) {
      const { adapter, events, reply } = fixture();
      await handleSessionSettingsRequest({ ...set, value }, adapter, reply);
      expect(adapter.setSessionSetting).not.toHaveBeenCalled();
      expect(adapter.querySessionSettings).not.toHaveBeenCalled();
      expect(events[0]).toMatchObject({ requestId: 'set-a', targetSessionKey, error: 'Invalid session setting value' });
    }
  });

  it('rejects unknown keys and missing targets before any Gateway IO', async () => {
    for (const override of [{ key: 'thinking' }, { key: null }, { targetSessionKey: undefined }, { targetSessionKey: ' ' }]) {
      const { adapter, events, reply } = fixture();
      await handleSessionSettingsRequest({ ...set, ...override }, adapter, reply);
      expect(adapter.setSessionSetting).not.toHaveBeenCalled();
      expect(adapter.querySessionSettings).not.toHaveBeenCalled();
      expect(events[0].error).toBeTruthy();
      expect(events[0].requestId).toBe('set-a');
    }
  });

  it('does not dispatch an uncorrelated request and keeps unsupported writes explicit', async () => {
    const { adapter, events, reply } = fixture();
    await handleSessionSettingsRequest({ ...set, requestId: undefined }, adapter, reply);
    expect(adapter.setSessionSetting).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    await handleSessionSettingsRequest({ ...set, sessionId: 'claude-sample' }, adapter, reply);
    expect(events[0]).toMatchObject({ requestId: 'set-a', error: 'Session settings are unavailable for this session' });
  });

  it('echoes the refused target and timeout request without falling through to a write', async () => {
    const { adapter, events, reply } = fixture();
    adapter.setSessionSetting.mockRejectedValueOnce(new Error('OpenClaw conversation changed; reopen the picker'));
    await handleSessionSettingsRequest(set, adapter, reply);
    expect(events[0]).toMatchObject({ requestId: 'set-a', targetSessionKey, error: expect.stringContaining('conversation changed') });
    adapter.querySessionSettings.mockRejectedValueOnce(new Error('RPC timeout: sessions.list'));
    await handleSessionSettingsRequest({ ...query, requestId: 'query-timeout' }, adapter, reply);
    expect(events[1]).toMatchObject({ requestId: 'query-timeout', error: 'RPC timeout: sessions.list' });
  });

  it('returns a large catalog only to its requesting socket, never unrelated peers or broadcast hooks', async () => {
    const server = createServer();
    const wsServer = new WsServer(server);
    const { adapter } = fixture();
    adapter.querySessionSettings.mockResolvedValue({ targetSessionKey, settings: [{
      key: 'model', options: Array.from({ length: 100 }, (_, index) => ({ id: `provider/model-${index}`, label: 'Synthetic model '.repeat(8) })),
    }] } as any);
    const broadcast = vi.fn();
    wsServer.onBroadcast(broadcast);
    wsServer.onCommand((command, sender) => {
      void handleSessionSettingsSocketRequest(command, sender, adapter, wsServer);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const requester = new WebSocket(`ws://127.0.0.1:${port}`);
    const otherDashboard = new WebSocket(`ws://127.0.0.1:${port}`);
    const board = new WebSocket(`ws://127.0.0.1:${port}/?clientType=esp32`);
    const unrelated = vi.fn();
    otherDashboard.on('message', unrelated); board.on('message', unrelated);
    try {
      await Promise.all([once(requester, 'open'), once(otherDashboard, 'open'), once(board, 'open')]);
      const result = once(requester, 'message');
      requester.send(JSON.stringify(query));
      const [data] = await result;
      expect(data.toString().length).toBeGreaterThan(4096);
      expect(JSON.parse(data.toString())).toMatchObject({ requestId: query.requestId, targetSessionKey });
      // Drain the socket event loop so a broadcast could not pass unnoticed.
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(unrelated).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
      const malformed = once(requester, 'message');
      requester.send(JSON.stringify({ ...set, requestId: 'missing-value', value: undefined }));
      const [refusal] = await malformed;
      expect(JSON.parse(refusal.toString())).toMatchObject({ requestId: 'missing-value', targetSessionKey, error: 'Invalid session setting value' });
      expect(adapter.setSessionSetting).not.toHaveBeenCalled();
      await handleSessionSettingsSocketRequest(set, undefined, adapter, wsServer);
      expect(adapter.setSessionSetting).not.toHaveBeenCalled();
      board.send(JSON.stringify({ ...set, value: null }));
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(adapter.setSessionSetting).not.toHaveBeenCalled();
    } finally {
      requester.terminate(); otherDashboard.terminate(); board.terminate();
      wsServer.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
