import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { sessionDeckLabels, sessionLabelText, normalizeSessionDisplayName, retainSessionDisplayNames } from '../session-labels.js';
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

  it('uses the unique tail when time-ordered ids share a long prefix', () => {
    // A 9-char prefix truncates on a 10-char INFO tile into identical text
    // again (#548 review); the random tail tells them apart in 4.
    const labels = sessionDeckLabels([
      row('opencode:ses_0a1b2c3d4e5f', 'proj', 'opencode'),
      row('opencode:ses_0a1b2c3d9999', 'proj', 'opencode'),
    ]);
    expect(labels.get('opencode:ses_0a1b2c3d4e5f')?.tag).toBe('…4e5f');
    expect(labels.get('opencode:ses_0a1b2c3d9999')?.tag).toBe('…9999');
    expect(sessionLabelText(labels.get('opencode:ses_0a1b2c3d4e5f'), 10)).toBe('pr… #…4e5f');
  });

  it('a short shared prefix still grows as a prefix — it reads like /status', () => {
    const labels = sessionDeckLabels([row('5f8f5c2a-1111', 'chezmoi'), row('5f8f9999-1111', 'chezmoi')]);
    expect(labels.get('5f8f5c2a-1111')?.tag).toBe('5f8f5');
  });

  it('strips a Hermes type word but not a uuid that starts with hex letters', () => {
    const hermes = sessionDeckLabels([
      row('observed:hermes:hermes-3c1d0000aaaa', 'proj', 'hermes'),
      row('observed:hermes:hermes-b7e20000bbbb', 'proj', 'hermes'),
    ]);
    expect(hermes.get('observed:hermes:hermes-3c1d0000aaaa')?.tag).toBe('3c1d');
    const hexy = sessionDeckLabels([row('deadbeef-1111', 'p'), row('cafebabe-2222', 'p')]);
    expect(hexy.get('deadbeef-1111')?.tag).toBe('dead');
  });

  it('never splits a surrogate pair when the name shrinks', () => {
    const text = sessionLabelText({ name: '🐙🐙🐙🐙🐙🐙', tag: '5f8f' }, 10);
    expect(text).toBe('🐙🐙🐙… #5f8f');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(text ?? '')).toBe(false);
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
    expect(svgs).toMatch(/chezmoi[^<]*#5f8f|chezmoi<\/tspan>[\s\S]{0,200}#5f8f/);
    expect(svgs).toMatch(/chezmoi[^<]*#b80c|chezmoi<\/tspan>[\s\S]{0,200}#b80c/);
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


describe('friendly labels (#544)', () => {
  const vectors = JSON.parse(readFileSync(new URL('../../session-display-name-vectors.json', import.meta.url), 'utf8'));
  it('normalizes the same bounded hints as Swift', () => {
    for (const v of vectors) expect(normalizeSessionDisplayName(v.raw)).toBe(v.expected);
  });
  it('retains identity tags for duplicate/renamed hints, and preserves solo projects', () => {
    const a = { ...row('5f8faaaa', 'proj'), displayName: 'Release' };
    const b = { ...row('b80cbbbb', 'proj'), displayName: 'Release' };
    const before = JSON.stringify([a, b]);
    expect(sessionLabelText(sessionDeckLabels([a,b]).get(a.id), 10)).toBe('Rel… #5f8f');
    expect(JSON.stringify([a,b])).toBe(before);
    expect(sessionLabelText(sessionDeckLabels([{...a, displayName:'Renamed'},b]).get(a.id))).toBe('Renamed #5f8f');
    expect(sessionLabelText(sessionDeckLabels([a]).get(a.id))).toBe('proj');
  });
  it('retains only absent hints, clears explicit empty, and drops removed rows', () => {
    const old = [{ id: 'a', displayName: 'Old' }, {id:'removed', displayName:'Gone'}];
    expect(retainSessionDisplayNames([{id:'a'}], old)).toEqual([{id:'a',displayName:'Old'}]);
    expect(retainSessionDisplayNames([{id:'a',displayName:''}], old)).toEqual([{id:'a',displayName:''}]);
  });
});

it('keeps session keys, INFO and VOICE bound to the same ID after friendly rename (#544/#632)', () => {
  const sessions = [{...row('5f8faaaa','proj'),displayName:'Alpha'}, {...row('b80cbbbb','proj'),displayName:'Beta'}];
  const state = {state:'disconnected' as const,daemonConnected:true,allSessions:sessions};
  const list = buildSessionDeck(state,{mode:'list'},positions(15));
  expect([...list.values()].map(c=>c.action).filter(a=>a?.kind==='open')).toEqual([
    {kind:'open',sessionId:'5f8faaaa'},{kind:'open',sessionId:'b80cbbbb'},
  ]);
  for (const session of sessions) {
    const detail = [...buildSessionDeck(state,{mode:'detail',openSessionId:session.id},positions(15)).values()];
    expect(detail[1].svg).toContain(session.id==='5f8faaaa'?'Alp… #5f8f':'Beta #b80c');
    expect(detail[1].svg).not.toContain('>INFO<'); // the corner pill must not paint over the ID
    expect(detail.some(c=>c.action?.kind==='command' && c.action.command.type==='voice' && c.action.command.sessionId===session.id)).toBe(true);
  }
});

describe('sessionLabelText — cmux workspace / surface titles', () => {
  const label = { name: 'hacking papa / accept-cmux', tag: '0e5c' };
  it('keeps the whole title when it fits', () => {
    expect(sessionLabelText(label, 40)).toBe('hacking papa / accept-cmux #0e5c');
  });
  it('drops the workspace before cutting the surface (D200X receipt, #544)', () => {
    expect(sessionLabelText(label, 18)).toBe('accept-cmux #0e5c');
    expect(sessionLabelText(label, 10)).toBe('acc… #0e5c');
  });
  it('leaves a title without a separator to the ordinary cut', () => {
    expect(sessionLabelText({ name: 'hacking papa', tag: '0e5c' }, 10)).toBe('hac… #0e5c');
  });
});
