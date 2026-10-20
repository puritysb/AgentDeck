import { describe, it, expect } from 'vitest';
import { buildSessionDeck } from '../d200h-layout.js';

// Ulanzi Studio QA on plugin-ulanzi 1.8.1 (Windows, 2026-10-19) — the layout
// engine half of the fixes. The plugin half (which Studio contexts lay out, the
// sticky first-seen order) is in plugin-ulanzi/src/__tests__.

const ROW0 = ['0_0', '1_0', '2_0', '3_0', '4_0'];

const session = (id: string, agentType: string, projectName: string, extra: Record<string, unknown> = {}) => ({
  id, alive: true, port: 0, projectName, agentType, state: 'idle', ...extra,
});

const openIds = (deck: Map<string, { action: unknown }>, order: string[]) =>
  order.map((pos) => {
    const action = deck.get(pos)?.action as { kind?: string; sessionId?: string } | null | undefined;
    return action?.kind === 'open' ? action.sessionId : null;
  });

describe('buildSessionDeck — one cell per key', () => {
  it('a position listed twice still gets its session, not a later empty cell', () => {
    // Two Studio contexts on one key used to put the key in the position list
    // twice. The deck is a Map keyed by position, so the second pass overwrote
    // the session tile with an empty one and the row went blank.
    const ev = { state: 'IDLE', allSessions: [session('a', 'claude-code', 'alpha'), session('b', 'codex-cli', 'beta')] };
    const deck = buildSessionDeck(ev, { mode: 'list' }, ['0_0', '1_0', '0_0', '1_0']);
    expect(deck.size).toBe(2);
    expect(openIds(deck, ['0_0', '1_0'])).toEqual(['a', 'b']);
  });

  it('the detail view does not shift when a position is duplicated', () => {
    const ev = { state: 'IDLE', allSessions: [session('a', 'claude-code', 'alpha')] };
    const once = buildSessionDeck(ev, { mode: 'detail', openSessionId: 'a' }, ROW0);
    const twice = buildSessionDeck(ev, { mode: 'detail', openSessionId: 'a' }, [...ROW0, '0_0', '4_0']);
    expect([...twice.keys()].sort()).toEqual([...once.keys()].sort());
    for (const pos of ROW0) expect(twice.get(pos)!.svg).toBe(once.get(pos)!.svg);
  });
});

describe('buildSessionDeck — caller-held list order (DeckView.sessionOrder)', () => {
  const codexFirst = session('cx', 'codex-cli', 'zeta');
  const claudeLater = session('cl', 'claude-code', 'alpha');

  it('without an order, keeps the global sortSessions order (other surfaces rely on it)', () => {
    const deck = buildSessionDeck({ state: 'IDLE', allSessions: [codexFirst, claudeLater] }, { mode: 'list' }, ROW0);
    expect(openIds(deck, ROW0).slice(0, 2)).toEqual(['cl', 'cx']);
  });

  it('with an order, a newer session appends instead of jumping ahead by agent kind', () => {
    const deck = buildSessionDeck(
      { state: 'IDLE', allSessions: [claudeLater, codexFirst] },
      { mode: 'list', sessionOrder: ['cx', 'cl'] },
      ROW0,
    );
    expect(openIds(deck, ROW0).slice(0, 2)).toEqual(['cx', 'cl']);
  });

  it('an explicit weight still outranks the caller order', () => {
    const pinned = session('w', 'opencode', 'pinned', { weight: -1 });
    const deck = buildSessionDeck(
      { state: 'IDLE', allSessions: [codexFirst, claudeLater, pinned] },
      { mode: 'list', sessionOrder: ['cx', 'cl', 'w'] },
      ROW0,
    );
    expect(openIds(deck, ROW0).slice(0, 3)).toEqual(['w', 'cx', 'cl']);
  });

  it('a session the caller has not placed yet follows the placed ones', () => {
    const fresh = session('new', 'claude-code', 'aaa');
    const deck = buildSessionDeck(
      { state: 'IDLE', allSessions: [fresh, codexFirst] },
      { mode: 'list', sessionOrder: ['cx'] },
      ROW0,
    );
    expect(openIds(deck, ROW0).slice(0, 2)).toEqual(['cx', 'new']);
  });
});

describe('buildSessionDeck — the detail view names its session on BACK', () => {
  it('BACK carries the session name instead of the generic "sessions"', () => {
    const ev = { state: 'IDLE', allSessions: [session('a', 'claude-code', 'payments-api')] };
    const deck = buildSessionDeck(ev, { mode: 'detail', openSessionId: 'a' }, ROW0);
    const back = deck.get('0_0')!;
    expect(back.action).toEqual({ kind: 'back' });
    expect(back.svg).toContain('BACK');
    expect(back.svg).toContain('payments-api');
    expect(back.svg).not.toContain('>sessions<');
  });

  it('two sessions of one project keep their distinguishing tag on BACK', () => {
    const ev = {
      state: 'IDLE',
      allSessions: [session('11111111-aaaa', 'claude-code', 'web'), session('22222222-bbbb', 'claude-code', 'web')],
    };
    const a = buildSessionDeck(ev, { mode: 'detail', openSessionId: '11111111-aaaa' }, ROW0).get('0_0')!.svg;
    const b = buildSessionDeck(ev, { mode: 'detail', openSessionId: '22222222-bbbb' }, ROW0).get('0_0')!.svg;
    expect(a).not.toBe(b);
  });
});

describe('buildSessionDeck — a usage provider with no data takes no key', () => {
  const POS = ['0_0', '1_0', '2_0', '3_0', '4_0', '0_1', '1_1', '2_1', '3_1', '4_1', '0_2', '1_2', '2_2', '3_2', '4_2'];
  const base = (codexRateLimits: unknown) => ({
    state: 'IDLE', allSessions: [session('a', 'claude-code', 'alpha')], usageKnown: false, codexRateLimits,
  });

  it('a windowless Codex block with only a limit id draws no "CODEX —" tile', () => {
    const deck = buildSessionDeck(base({ limitId: 'codex' }), { mode: 'list', showUsage: true }, POS);
    const svgs = [...deck.values()].map((c) => c.svg).join('');
    expect(svgs).not.toContain('>CODEX<');
    expect(svgs).not.toContain('CREDITS');
  });

  it('a credits object with no balance is no reading either', () => {
    const deck = buildSessionDeck(base({ limitId: 'premium', credits: { hasCredits: false } }), { mode: 'list', showUsage: true }, POS);
    expect([...deck.values()].map((c) => c.svg).join('')).not.toContain('CREDITS');
  });

  it('a real balance still draws the credits readout', () => {
    const deck = buildSessionDeck(base({ limitId: 'premium', credits: { balance: '12' } }), { mode: 'list', showUsage: true }, POS);
    expect([...deck.values()].map((c) => c.svg).join('')).toContain('CREDITS');
  });
});
