import { describe, expect, it } from 'vitest';
import { getCreatureLayoutSnapshot } from '../pixoo/pixoo-renderer.js';
import { State } from '../types.js';
import type { SessionInfo } from '@agentdeck/shared/protocol';
import type { StateUpdateEvent } from '../types.js';

function session(over: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    port: 9121,
    projectName: 'AgentDeck',
    alive: true,
    agentType: 'codex-cli',
    state: 'idle',
    ...over,
  } as SessionInfo;
}

function stateEvent(over: Partial<StateUpdateEvent> = {}): StateUpdateEvent {
  return {
    type: 'state_update',
    state: State.IDLE,
    permissionMode: 'default',
    agentType: 'claude-code',
    ...over,
  } as StateUpdateEvent;
}

describe('pixoo creature sync — Codex folding', () => {
  it('draws one cloud per project, not one per codex thread', () => {
    // Every Claude Code rescue/stop-gate spawns a fresh codex thread against the
    // same workspace. Unfolded, this lights up 4 clouds for one project.
    const snapshot = getCreatureLayoutSnapshot([
      session({ id: 'codex:1', projectName: 'AgentDeck' }),
      session({ id: 'codex:2', projectName: 'AgentDeck' }),
      session({ id: 'codex:3', projectName: 'AgentDeck' }),
      session({ id: 'codex:4', projectName: 'AgentDeck' }),
    ], null);

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].creatureType).toBe('jellyfish');
  });

  it('keeps separate projects as separate clouds', () => {
    const snapshot = getCreatureLayoutSnapshot([
      session({ id: 'codex:1', projectName: 'AgentDeck' }),
      session({ id: 'codex:2', projectName: 'OpenClaw' }),
    ], null);

    expect(snapshot).toHaveLength(2);
  });

  it('surfaces the busiest state in a folded group', () => {
    // A group where one thread is still working must not read as idle just
    // because the idle sibling sorted first.
    const snapshot = getCreatureLayoutSnapshot([
      session({ id: 'codex:1', projectName: 'AgentDeck', state: 'idle' }),
      session({ id: 'codex:2', projectName: 'AgentDeck', state: 'processing' }),
      session({ id: 'codex:3', projectName: 'AgentDeck', state: 'idle' }),
    ], null);

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].state).toBe('processing');
  });

  it('does NOT fold Claude Code — several octopuses on one project is deliberate', () => {
    const snapshot = getCreatureLayoutSnapshot([
      session({ id: 'a', agentType: 'claude-code', projectName: 'AgentDeck' }),
      session({ id: 'b', agentType: 'claude-code', projectName: 'AgentDeck' }),
      session({ id: 'c', agentType: 'claude-code', projectName: 'AgentDeck' }),
    ], null);

    expect(snapshot).toHaveLength(3);
    expect(snapshot.every(c => c.creatureType === 'octopus')).toBe(true);
  });

  it('ignores dead sessions', () => {
    const snapshot = getCreatureLayoutSnapshot([
      session({ id: 'a', agentType: 'claude-code', alive: true }),
      session({ id: 'b', agentType: 'claude-code', alive: false }),
    ], null);

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].sessionId).toBe('a');
  });
});

describe('pixoo creature sync — per-type bands', () => {
  it('clusters each agent type into its own X band', () => {
    const snapshot = getCreatureLayoutSnapshot([
      session({ id: 'oct', agentType: 'claude-code', projectName: 'P1' }),
      session({ id: 'cloud', agentType: 'codex-cli', projectName: 'P2' }),
      session({ id: 'ring', agentType: 'opencode', projectName: 'P3' }),
    ], null);

    const byId = new Map(snapshot.map(c => [c.sessionId, c]));
    // Octopus band 0.20–0.50, cloud 0.30–0.55, opencode 0.45–0.68.
    expect(byId.get('oct')!.worldX).toBeGreaterThanOrEqual(0.20);
    expect(byId.get('oct')!.worldX).toBeLessThanOrEqual(0.50);
    expect(byId.get('cloud')!.worldX).toBeGreaterThanOrEqual(0.30);
    expect(byId.get('cloud')!.worldX).toBeLessThanOrEqual(0.55);
    expect(byId.get('ring')!.worldX).toBeGreaterThanOrEqual(0.45);
    expect(byId.get('ring')!.worldX).toBeLessThanOrEqual(0.68);
  });

  it('stratifies types vertically so a mixed tank stays readable', () => {
    const snapshot = getCreatureLayoutSnapshot([
      session({ id: 'oct', agentType: 'claude-code', projectName: 'P1', state: 'processing' }),
      session({ id: 'cloud', agentType: 'codex-cli', projectName: 'P2', state: 'processing' }),
    ], null);

    const byId = new Map(snapshot.map(c => [c.sessionId, c]));
    // A working cloud rides near the surface; a working octopus holds mid-water.
    expect(byId.get('cloud')!.worldY).toBeLessThan(byId.get('oct')!.worldY);
    expect(byId.get('cloud')!.worldY).toBeLessThanOrEqual(0.28);
    expect(byId.get('oct')!.worldY).toBeGreaterThanOrEqual(0.40);
  });

  it('shrinks creatures as a band fills up', () => {
    const lone = getCreatureLayoutSnapshot([
      session({ id: 'a', agentType: 'claude-code', projectName: 'P1' }),
    ], null);
    const crowd = getCreatureLayoutSnapshot(
      Array.from({ length: 6 }, (_, i) =>
        session({ id: `s${i}`, agentType: 'claude-code', projectName: `P${i}` })),
      null,
    );

    expect(lone[0].sizeScale).toBeCloseTo(1.0, 6);
    expect(Math.max(...crowd.map(c => c.sizeScale))).toBeLessThan(lone[0].sizeScale);
  });
});

describe('pixoo creature sync — the `_primary` fallback', () => {
  it('synthesizes a creature before the first sessions list arrives', () => {
    const snapshot = getCreatureLayoutSnapshot(null, stateEvent({ state: State.PROCESSING }));

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].sessionId).toBe('_primary');
    expect(snapshot[0].state).toBe('processing');
  });

  it('draws an empty tank once an empty list is known', () => {
    // Regression guard for the ghost octopus: with only non-creature agents live
    // (e.g. OpenClaw), a received-but-empty list must not resurrect a creature.
    expect(getCreatureLayoutSnapshot([], stateEvent())).toHaveLength(0);
  });

  it('does not synthesize a creature for a non-creature agent', () => {
    expect(getCreatureLayoutSnapshot(null, stateEvent({ agentType: 'openclaw' as never }))).toHaveLength(0);
  });

  it('does not stamp the stateEvent onto a real session', () => {
    // stateEvent.sessionId can name a row that folding already collapsed;
    // applying it to the representative would downgrade a busy group.
    const snapshot = getCreatureLayoutSnapshot([
      session({ id: 'codex:1', projectName: 'AgentDeck', state: 'processing' }),
      session({ id: 'codex:2', projectName: 'AgentDeck', state: 'idle' }),
    ], stateEvent({ agentType: 'codex-cli', state: State.IDLE, sessionId: 'codex:2' }));

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].state).toBe('processing');
  });
});

describe('pixoo creature sync — unknown agent types', () => {
  // The daemon and every dashboard/device renderer ship separately, so this
  // renderer WILL be handed agentType values it predates. The rule is: a
  // neutral default or nothing — never another agent's creature. `octopus` is
  // Claude's, and `creatureTypeFor` falls back to it, so the guard that matters
  // is the allow-list in front of it.
  it('draws no creature for an agent type it has never heard of', () => {
    const snapshot = getCreatureLayoutSnapshot([
      session({ id: 'future:1', agentType: 'some-future-agent' }),
    ], null);

    expect(snapshot).toHaveLength(0);
  });

  it('does not let an unknown agent become a Claude octopus alongside real ones', () => {
    const snapshot = getCreatureLayoutSnapshot([
      session({ id: 'claude:1', agentType: 'claude-code', projectName: 'AgentDeck' }),
      session({ id: 'future:1', agentType: 'some-future-agent', projectName: 'AgentDeck' }),
    ], null);

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].creatureType).toBe('octopus');
  });

  it('gives every known agent type its own creature', () => {
    const expected: Array<[string, string]> = [
      ['claude-code', 'octopus'],
      ['codex-cli', 'jellyfish'],
      ['codex-app', 'jellyfish'],
      ['opencode', 'opencode'],
      ['antigravity', 'antigravity'],
      ['kiro-cli', 'kiro'],
      ['kiro-ide', 'kiro'],
    ];
    for (const [agentType, creatureType] of expected) {
      const snapshot = getCreatureLayoutSnapshot([
        session({ id: `s:${agentType}`, agentType, projectName: agentType }),
      ], null);
      expect(snapshot, `${agentType} should produce a creature`).toHaveLength(1);
      expect(snapshot[0].creatureType, `${agentType} creature`).toBe(creatureType);
    }
  });
});
