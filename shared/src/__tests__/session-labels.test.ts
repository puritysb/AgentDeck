import { describe, it, expect } from 'vitest';
import { sessionDeckLabels, sessionLabelText } from '../session-labels.js';
import { buildSessionDeck } from '../d200h-layout.js';
import type { SessionInfo } from '../protocol.js';

const row = (id: string, projectName: string, agentType = 'claude-code'): SessionInfo => ({
  id, port: 0, alive: true, projectName, agentType: agentType as SessionInfo['agentType'], state: 'idle',
  controlMode: 'observed',
});

const positions = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${i % 5}_${Math.floor(i / 5)}`);

describe('sessionDeckLabels (#544)', () => {
  it('leaves a lone session untagged', () => {
    const labels = sessionDeckLabels([row('5f8f5c2a-1111', 'chezmoi'), row('aaaa0000-2222', 'AgentDeck')]);
    expect(labels.get('5f8f5c2a-1111')).toEqual({ name: 'chezmoi' });
    expect(sessionLabelText(labels.get('aaaa0000-2222'))).toBe('AgentDeck');
  });

  it('tags two sessions of one agent in one project with their id prefix', () => {
    const labels = sessionDeckLabels([row('5f8f5c2a-1111', 'chezmoi'), row('b80ccccf-2222', 'chezmoi')]);
    expect(sessionLabelText(labels.get('5f8f5c2a-1111'))).toBe('chezmoi #5f8f');
    expect(sessionLabelText(labels.get('b80ccccf-2222'))).toBe('chezmoi #b80c');
  });

  it('tags the same session identically in either daemon id form', () => {
    const node = sessionDeckLabels([row('observed:claude:5f8f5c2a-1111', 'chezmoi'), row('observed:claude:b80ccccf-2222', 'chezmoi')]);
    const swift = sessionDeckLabels([row('5f8f5c2a-1111', 'chezmoi'), row('b80ccccf-2222', 'chezmoi')]);
    expect(node.get('observed:claude:5f8f5c2a-1111')?.tag).toBe(swift.get('5f8f5c2a-1111')?.tag);
  });

  it('does not tag different agents that share a project — their creatures already differ', () => {
    const labels = sessionDeckLabels([row('5f8f5c2a-1111', 'chezmoi'), row('codex:0199aaaa', 'chezmoi', 'codex-cli')]);
    expect(labels.get('5f8f5c2a-1111')?.tag).toBeUndefined();
    expect(labels.get('codex:0199aaaa')?.tag).toBeUndefined();
  });

  it('grows the tag past a shared prefix (time-ordered ids)', () => {
    const labels = sessionDeckLabels([
      row('opencode:ses_0a1b2c3d4e5f', 'proj', 'opencode'),
      row('opencode:ses_0a1b2c3d9999', 'proj', 'opencode'),
    ]);
    expect(labels.get('opencode:ses_0a1b2c3d4e5f')?.tag).toBe('0a1b2c3d4');
    expect(labels.get('opencode:ses_0a1b2c3d9999')?.tag).toBe('0a1b2c3d9');
  });

  it('is a function of the set, not of its order — activity cannot relabel a key', () => {
    const a = row('5f8f5c2a-1111', 'chezmoi');
    const b = row('5f8f9999-2222', 'chezmoi');
    expect(sessionDeckLabels([a, b])).toEqual(sessionDeckLabels([b, a]));
    expect(sessionDeckLabels([a, b]).get(a.id)?.tag).toBe('5f8f5');
  });

  it('keeps the tag whole when the text must shrink', () => {
    const label = { name: 'chezmoi', tag: '5f8f' };
    expect(sessionLabelText(label, 10)).toBe('che… #5f8f');
    expect(sessionLabelText(label, 13)).toBe('chezmoi #5f8f');
    expect(sessionLabelText({ name: 'a-very-long-project-name' }, 10)).toBe('a-very-long-project-name');
    expect(sessionLabelText(undefined)).toBeUndefined();
  });
});

describe('D200 deck — same-project sessions are distinguishable (#544)', () => {
  it('draws two same-project keys differently and a lone key unchanged', () => {
    const deck = buildSessionDeck(
      {
        state: 'disconnected', daemonConnected: true,
        allSessions: [row('5f8f5c2a-1111', 'chezmoi'), row('b80ccccf-2222', 'chezmoi'), row('aaaa0000-3333', 'solo')],
      },
      { mode: 'list' },
      positions(10),
    );
    const svgs = [...deck.values()].map((c) => c.svg).join('\n');
    expect(svgs).toContain('#5f8f');
    expect(svgs).toContain('#b80c');
    expect(svgs).toContain('>solo<');
    expect(svgs).not.toContain('solo #');
  });

  it('names the tagged session on the detail INFO tile, where the voice tile sends', () => {
    const deck = buildSessionDeck(
      {
        state: 'disconnected', daemonConnected: true,
        allSessions: [row('5f8f5c2a-1111', 'chezmoi'), row('b80ccccf-2222', 'chezmoi')],
      },
      { mode: 'detail', openSessionId: 'b80ccccf-2222' },
      positions(10),
    );
    const svgs = [...deck.values()].map((c) => c.svg).join('\n');
    expect(svgs).toContain('che… #b80c');
  });
});
