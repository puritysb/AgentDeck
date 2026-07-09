import { describe, it, expect } from 'vitest';
import { DaemonWsClient } from '../daemon-ws-client.js';
import { SESSION_WEIGHT_MAX } from '@agentdeck/shared';

/**
 * Regression for the Node-session → Swift-daemon discovery shape: the Swift
 * daemon cannot read the CLI's sessions.json, so `session_push_register` is the
 * only path a managed session's weight can reach the App Store dashboards.
 * The frame must always carry a concrete integer weight — receivers merge
 * retain-on-absent, so an omitted key would make a weight settable but never
 * resettable (the usageStale latch bug class).
 */
describe('DaemonWsClient register frame', () => {
  it('always includes an explicit integer weight (unweighted ⇒ 0, never omitted)', () => {
    const client = new DaemonWsClient('sess-1', 9121, 'claude-code', 'AgentDeck');
    const frame = client.buildRegisterFrame();
    expect(frame).toMatchObject({
      type: 'session_push_register',
      sessionId: 'sess-1',
      port: 9121,
      agentType: 'claude-code',
      projectName: 'AgentDeck',
      weight: 0,
    });
    expect(Object.prototype.hasOwnProperty.call(frame, 'weight')).toBe(true);
    client.close();
  });

  it('carries the launch-time --weight value', () => {
    const client = new DaemonWsClient('sess-2', 9122, 'codex-cli', 'AgentDeck', 2);
    expect(client.buildRegisterFrame().weight).toBe(2);
    client.close();
  });

  it('normalizes garbage weights so the wire only ever sees in-range integers', () => {
    const client = new DaemonWsClient('sess-3', 9123, 'claude-code', 'AgentDeck', 2 ** 40);
    expect(client.buildRegisterFrame().weight).toBe(SESSION_WEIGHT_MAX);
    client.close();
  });
});
