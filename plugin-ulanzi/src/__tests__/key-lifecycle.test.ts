import { describe, expect, it } from 'vitest';
import { buildSessionDeck, State, type BridgeEvent, type SessionInfo } from '@agentdeck/shared';
import { KeyRegistry } from '../key-registry.js';
import { StickySessionOrder } from '../session-order.js';
import { deckViewSignature } from '../deck-signature.js';
import { StateStore, dedupeSessionsById } from '../state-store.js';

/**
 * Ulanzi Studio QA, plugin 1.8.1 on Windows (2026-10-19): row 1 went blank after
 * a fifth key was placed on a new page, and a key placed on a new page showed
 * nothing. Studio names each placed action by a context that ENCODES its key
 * (`uuid___key___actionid`), so two contexts can name one key — another page's
 * key, or the old action during a replace. These cases drive the same
 * registry + signature + layout path `app.ts` renders through.
 */
const ctx = (key: string, actionid: string) => `com.ulanzi.ulanzistudio.agentdeck.key___${key}___${actionid}`;
const view = { mode: 'list' as const, page: 0 };

const sessions = (n: number): SessionInfo[] => Array.from({ length: n }, (_, i) => ({
  id: `s${i}`, port: 0, alive: true, projectName: `p${i}`, agentType: 'claude-code', state: State.IDLE,
}));

/** What renderAll would push: active contexts whose tile differs from their last push. */
function pushes(keys: KeyRegistry, ev: Record<string, unknown>): string[] {
  const deck = buildSessionDeck(ev, view, keys.positions());
  const pushed: string[] = [];
  for (const inst of keys.activeInstances()) {
    const sig = deck.get(inst.key)?.svg ?? '';
    if (sig === inst.lastSig) continue;
    inst.lastSig = sig;
    pushed.push(inst.context);
  }
  return pushed;
}

describe('KeyRegistry — which Studio contexts lay out', () => {
  it('a key on an inactive page does not take a position', () => {
    const keys = new KeyRegistry();
    for (const k of ['0_0', '1_0', '2_0', '3_0']) keys.add(ctx(k, 'page1'), k);
    // The user flips to page 2: Studio deactivates page 1's contexts…
    for (const k of ['0_0', '1_0', '2_0', '3_0']) keys.setActive(ctx(k, 'page1'), k, false);
    // …and the fifth key goes onto page 2 at a key page 1 also uses.
    keys.add(ctx('0_0', 'page2'), '0_0');
    expect(keys.positions()).toEqual(['0_0']);
    const deck = buildSessionDeck({ state: 'IDLE', allSessions: sessions(1) }, view, keys.positions());
    expect((deck.get('0_0')!.action as { kind: string }).kind).toBe('open');
  });

  it('never lists a position twice, even when Studio never sends setactive', () => {
    // The reported blank row: page 1 still "active" by default, page 2 adds the
    // same key. The newest context takes the key; the old one stops laying out.
    const keys = new KeyRegistry();
    for (const k of ['0_0', '1_0', '2_0', '3_0']) keys.add(ctx(k, 'page1'), k);
    const displaced = keys.add(ctx('0_0', 'page2'), '0_0');
    expect(displaced).toEqual([ctx('0_0', 'page1')]);
    expect(keys.positions().sort()).toEqual(['0_0', '1_0', '2_0', '3_0']);
    expect(new Set(keys.positions()).size).toBe(keys.positions().length);
    const ev = { state: 'IDLE', allSessions: sessions(4) };
    const deck = buildSessionDeck(ev, view, keys.positions());
    for (const k of ['0_0', '1_0', '2_0', '3_0']) {
      expect((deck.get(k)!.action as { kind: string }).kind, k).toBe('open');
    }
  });

  it('a setactive race cannot reintroduce a duplicate position', () => {
    const keys = new KeyRegistry();
    keys.add(ctx('0_0', 'a'), '0_0');
    keys.setActive(ctx('0_0', 'b'), '0_0', true);
    keys.setActive(ctx('0_0', 'a'), '0_0', true);
    expect(keys.positions()).toEqual(['0_0']);
    expect(keys.activeInstances().map((i) => i.context)).toEqual([ctx('0_0', 'a')]);
  });

  it('a press on a context that lost its key brings it back (Studio sent no setactive)', () => {
    const keys = new KeyRegistry();
    keys.add(ctx('0_0', 'page1'), '0_0');
    keys.add(ctx('0_0', 'page2'), '0_0');
    // app.ts claimPressedKey: the pressed context is on screen.
    keys.setActive(ctx('0_0', 'page1'), '0_0', true);
    expect(keys.activeInstances().map((i) => i.context)).toEqual([ctx('0_0', 'page1')]);
    expect(keys.get(ctx('0_0', 'page1'))!.lastSig).toBeUndefined();
  });
});

describe('Replace and clear repaint the key', () => {
  const ev = { state: 'IDLE', allSessions: sessions(2) };

  it('replace with add(new) before clear(old): the new context gets an image', () => {
    const keys = new KeyRegistry();
    keys.add(ctx('0_0', 'old'), '0_0');
    keys.add(ctx('1_0', 'x'), '1_0');
    const before = deckViewSignature(ev, view, keys.positions(), keys.layoutContexts());
    pushes(keys, ev);

    keys.add(ctx('0_0', 'new'), '0_0');
    keys.clear([ctx('0_0', 'old')]);
    // The sorted key list is identical — the case that used to return early at
    // `sig === lastDeckSig` and leave the new context blank forever.
    expect(keys.positions().sort()).toEqual(['0_0', '1_0']);
    const after = deckViewSignature(ev, view, keys.positions(), keys.layoutContexts());
    expect(after).not.toBe(before);
    expect(pushes(keys, ev)).toEqual([ctx('0_0', 'new')]);
  });

  it('replace with clear(old) before add(new): the new context gets an image', () => {
    const keys = new KeyRegistry();
    keys.add(ctx('0_0', 'old'), '0_0');
    pushes(keys, ev);
    keys.clear([ctx('0_0', 'old')]);
    keys.add(ctx('0_0', 'new'), '0_0');
    expect(pushes(keys, ev)).toEqual([ctx('0_0', 'new')]);
  });

  it('clear changes the layout and, after invalidation, repaints every remaining key', () => {
    const keys = new KeyRegistry();
    for (const k of ['0_0', '1_0', '2_0']) keys.add(ctx(k, 'a'), k);
    const many = { state: 'IDLE', allSessions: sessions(3) };
    const before = deckViewSignature(many, view, keys.positions(), keys.layoutContexts());
    pushes(keys, many);
    expect(keys.clear([ctx('0_0', 'a')])).toBe(true);
    keys.invalidate();
    expect(deckViewSignature(many, view, keys.positions(), keys.layoutContexts())).not.toBe(before);
    expect(pushes(keys, many).sort()).toEqual([ctx('1_0', 'a'), ctx('2_0', 'a')].sort());
  });

  it('an inactive context is not pushed, and repaints when it comes back', () => {
    const keys = new KeyRegistry();
    keys.add(ctx('0_0', 'a'), '0_0');
    pushes(keys, ev);
    keys.setActive(ctx('0_0', 'a'), '0_0', false);
    expect(pushes(keys, ev)).toEqual([]);
    keys.setActive(ctx('0_0', 'a'), '0_0', true);
    expect(pushes(keys, ev)).toEqual([ctx('0_0', 'a')]);
  });
});

describe('StickySessionOrder — a session keeps the slot it first took', () => {
  const row = (id: string, agentType: string, projectName: string, weight?: number) => ({
    id, port: 0, alive: true, agentType, projectName, state: State.IDLE, ...(weight != null ? { weight } : {}),
  }) as SessionInfo;

  it('seeds the first roster in sortSessions order, then appends newcomers', () => {
    const order = new StickySessionOrder();
    const codex = row('cx', 'codex-cli', 'zeta');
    expect(order.update([codex])).toEqual(['cx']);
    // A Claude session starts later: sortSessions would rank it first.
    const claude = row('cl', 'claude-code', 'alpha');
    const ids = order.update([claude, codex]);
    expect(ids).toEqual(['cx', 'cl']);
    const deck = buildSessionDeck({ state: 'IDLE', allSessions: [claude, codex] }, { ...view, sessionOrder: ids }, ['0_0', '1_0']);
    expect((deck.get('0_0')!.action as { sessionId: string }).sessionId).toBe('cx');
    expect((deck.get('1_0')!.action as { sessionId: string }).sessionId).toBe('cl');
  });

  it('sessions that arrive together are seeded in the global order', () => {
    const order = new StickySessionOrder();
    expect(order.update([row('cx', 'codex-cli', 'a'), row('cl', 'claude-code', 'b')])).toEqual(['cl', 'cx']);
  });

  it('a session that blinks out of one roster returns to its slot', () => {
    const order = new StickySessionOrder();
    order.update([row('a', 'codex-cli', 'a'), row('b', 'codex-cli', 'b')]);
    order.update([row('b', 'codex-cli', 'b')]);
    expect(order.update([row('b', 'codex-cli', 'b'), row('a', 'codex-cli', 'a')])).toEqual(['a', 'b']);
  });

  it('an explicit weight still wins in the layout', () => {
    const order = new StickySessionOrder();
    const first = row('first', 'codex-cli', 'a');
    const pinned = row('pinned', 'claude-code', 'b', -5);
    const ids = order.update([first]);
    const all = order.update([first, pinned]);
    expect(ids).toEqual(['first']);
    const deck = buildSessionDeck({ state: 'IDLE', allSessions: [first, pinned] }, { ...view, sessionOrder: all }, ['0_0', '1_0']);
    expect((deck.get('0_0')!.action as { sessionId: string }).sessionId).toBe('pinned');
  });
});

describe('StateStore — a duplicated sessions_list row is one session', () => {
  it('keeps the last copy of a duplicated id, in first-seen position', () => {
    const rows = [
      { id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'a', v: 2 },
    ];
    expect(dedupeSessionsById(rows)).toEqual([{ id: 'a', v: 2 }, { id: 'b', v: 1 }]);
  });

  it('the deck draws a duplicated session once', () => {
    const store = new StateStore();
    store.setConnected(true);
    const a = { id: 'a', port: 0, alive: true, projectName: 'alpha', agentType: 'claude-code', state: State.IDLE } as SessionInfo;
    const b = { ...a, id: 'b', projectName: 'beta' } as SessionInfo;
    store.apply({ type: 'sessions_list', sessions: [a, b, { ...a, state: State.PROCESSING }] } as BridgeEvent);
    const input = store.toLayoutInput();
    expect((input.allSessions as SessionInfo[]).map((s) => s.id)).toEqual(['a', 'b']);
    expect((input.allSessions as SessionInfo[])[0].state).toBe(State.PROCESSING);
  });
});
