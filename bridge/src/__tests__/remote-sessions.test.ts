import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerRemoteSession,
  updateRemoteSessionState,
  getRemoteSession,
  removeRemoteSession,
  hasRemoteSessions,
  listRemoteEnriched,
} from '../remote-sessions.js';

const ID = 'remote-sess-1';

function cleanup() {
  removeRemoteSession(ID);
  removeRemoteSession('a');
  removeRemoteSession('b');
}

describe('remote-sessions registry', () => {
  beforeEach(cleanup);

  it('registers a remote session with display host/port', () => {
    expect(hasRemoteSessions()).toBe(false);
    registerRemoteSession({
      sessionId: ID, host: '192.168.1.42', port: 9125,
      agentType: 'claude-code', projectName: 'demo',
    });
    const s = getRemoteSession(ID);
    expect(s).toMatchObject({ host: '192.168.1.42', port: 9125, projectName: 'demo' });
    expect(hasRemoteSessions()).toBe(true);
  });

  it('keeps startedAt stable but refreshes target on re-register', () => {
    registerRemoteSession({ sessionId: ID, host: '192.168.1.42', port: 9125 });
    const first = getRemoteSession(ID)!.startedAt;
    registerRemoteSession({ sessionId: ID, host: '192.168.1.99', port: 9126 });
    const s = getRemoteSession(ID)!;
    expect(s.startedAt).toBe(first);
    expect(s.host).toBe('192.168.1.99');
    expect(s.port).toBe(9126);
  });

  it('re-register swaps the sender; the old socket cannot remove or overwrite', () => {
    const oldSock = { tag: 'old' } as unknown as import('ws').WebSocket;
    const newSock = { tag: 'new' } as unknown as import('ws').WebSocket;
    registerRemoteSession({ sessionId: ID, host: 'h', port: 1, sender: oldSock });
    registerRemoteSession({ sessionId: ID, host: 'h', port: 1, sender: newSock });
    expect(getRemoteSession(ID)!.sender).toBe(newSock);
    // Stale close handler: removal keyed to the OLD socket is a no-op.
    removeRemoteSession(ID, oldSock);
    expect(getRemoteSession(ID)).toBeDefined();
    // Stale state push: guarded update from the OLD socket is dropped.
    updateRemoteSessionState(ID, 'processing', undefined, undefined, undefined, oldSock);
    expect(getRemoteSession(ID)!.state).toBeUndefined();
    updateRemoteSessionState(ID, 'processing', undefined, undefined, undefined, newSock);
    expect(getRemoteSession(ID)!.state).toBe('processing');
    // The live socket may remove.
    removeRemoteSession(ID, newSock);
    expect(getRemoteSession(ID)).toBeUndefined();
  });

  it('updates state only for known sessions', () => {
    updateRemoteSessionState('unknown', 'processing'); // no throw, no-op
    registerRemoteSession({ sessionId: ID, host: 'h', port: 1 });
    updateRemoteSessionState(ID, 'awaiting_option', 'opus-4', 'high', 'acceptEdits');
    expect(getRemoteSession(ID)).toMatchObject({
      state: 'awaiting_option',
      modelName: 'opus-4',
      effortLevel: 'high',
      permissionMode: 'acceptEdits',
    });
  });

  it('renders enriched rows marked alive/managed', () => {
    registerRemoteSession({
      sessionId: 'a',
      host: 'h',
      port: 1,
      projectName: 'pa',
      agentType: 'codex-cli',
      weight: 7,
    });
    registerRemoteSession({ sessionId: 'b', host: 'h', port: 2 });
    updateRemoteSessionState('a', 'idle');
    const rows = listRemoteEnriched();
    const a = rows.find(r => r.id === 'a')!;
    expect(a).toMatchObject({
      id: 'a',
      port: 1,
      projectName: 'pa',
      agentType: 'codex-cli',
      alive: true,
      controlMode: 'managed',
      state: 'idle',
      weight: 7,
    });
    // Missing projectName falls back to a sane label.
    expect(rows.find(r => r.id === 'b')!.projectName).toBe('remote');
  });

  it('normalizes remote weight and preserves it for legacy re-registration', () => {
    registerRemoteSession({ sessionId: ID, host: 'h', port: 1, weight: 2 ** 40 });
    const normalized = getRemoteSession(ID)!.weight;
    expect(normalized).toBeTypeOf('number');
    expect(normalized).toBeLessThan(2 ** 40);

    registerRemoteSession({ sessionId: ID, host: 'h2', port: 2 });
    expect(getRemoteSession(ID)!.weight).toBe(normalized);
  });

  it('removes a session', () => {
    registerRemoteSession({ sessionId: ID, host: 'h', port: 1 });
    removeRemoteSession(ID);
    expect(getRemoteSession(ID)).toBeUndefined();
    expect(hasRemoteSessions()).toBe(false);
  });
});
