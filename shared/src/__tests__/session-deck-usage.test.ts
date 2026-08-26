import { describe, it, expect } from 'vitest';
import { buildSessionDeck } from '../d200h-layout.js';

// Locks the list-view USAGE behaviour of the shared session deck (D200H /
// Ulanzi): with `showUsage`, the three bottom-row keys LEFT of the wide clock
// widget (0_2/1_2/2_2) form a horizontal quota strip. The strip fills from its
// RIGHT end — flush against the clock — so an absent tile frees the LEFTMOST
// key back to sessions instead of holing the row. Four or five logical limits
// compact same-provider 5H+7D pairs rather than dropping a real window.
// Sessions/paging reflow into the remaining keys, and tiles refresh on press.

const POS = ['0_0', '1_0', '2_0', '3_0', '4_0', '0_1', '1_1', '2_1', '3_1', '4_1', '0_2', '1_2', '2_2', '3_2', '4_2'];

// The bottom-row usage strip, left→right. Which tile lands where depends on how
// many tiles exist (the strip fills from STRIP_R backwards).
const STRIP_L = '0_2';
const STRIP_M = '1_2';
const STRIP_R = '2_2';

// Claude-only usage = 2 tiles → they occupy the RIGHT two strip keys; STRIP_L
// stays free for a session.
const C5H = STRIP_M;
const C7D = STRIP_R;
// With Claude-only usage (2 keys reserved on the bottom row), the last free slot
// is the wide-button cell 4_2, where the overflow NEXT→ button lands.
const NEXT_POS = '4_2';

const CLAUDE_MARK = '#C07058';  // terracotta Claude Code mark
const CODEX_MARK = '#6166E0';   // blue Codex mark

const mkSessions = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `s${i}`, alive: true, port: 9121 + i, projectName: `p${i}`,
    agentType: 'claude-code', state: 'idle',
  }));

const baseState = (sessions: number, over: Record<string, unknown> = {}) => ({
  state: 'IDLE',
  allSessions: mkSessions(sessions),
  fiveHourPercent: 42,
  sevenDayPercent: 17,
  usageKnown: true,
  ...over,
});

const usageCells = (deck: Map<string, { svg: string; action: unknown }>) =>
  [...deck.values()].filter(
    (c) => (c.action as { kind?: string } | null)?.kind === 'command'
      && ((c.action as { command?: { type?: string } }).command?.type === 'query_usage'),
  );

describe('buildSessionDeck list-view usage tiles', () => {
  it('pins 5H/7D to the bottom strip and wires them to query_usage', () => {
    const deck = buildSessionDeck(baseState(3), { mode: 'list', showUsage: true }, POS);
    const c5 = deck.get(C5H)!;
    const c7 = deck.get(C7D)!;
    expect(c5.svg).toContain('5H');
    // Full-bleed gauge headline is the USED percent (fill rises with usage).
    expect(c5.svg).toContain('>42<'); // 42% used
    expect(c7.svg).toContain('7D');
    expect(c7.svg).toContain('>17<'); // 17% used
    expect(c5.action).toEqual({ kind: 'command', command: { type: 'query_usage' } });
    expect(c7.action).toEqual({ kind: 'command', command: { type: 'query_usage' } });
  });

  it('leaves the upper grid and the clock-side keys entirely to sessions', () => {
    // Regression: usage used to occupy the 2×2 block at cols 3–4 / rows 0–1.
    const deck = buildSessionDeck(baseState(6), { mode: 'list', showUsage: true }, POS);
    for (const pos of ['3_0', '4_0', '3_1', '4_1']) {
      expect(deck.get(pos)!.action).not.toEqual({ kind: 'command', command: { type: 'query_usage' } });
    }
    // All reserved keys live on the bottom strip.
    const reserved = [...deck.entries()]
      .filter(([, c]) => (c.action as { kind?: string } | null)?.kind === 'command')
      .map(([pos]) => pos);
    expect(reserved.sort()).toEqual([STRIP_M, STRIP_R]);
  });

  it('fills the strip from the right, freeing the leftmost key for a session', () => {
    // 2 Claude tiles on a 3-wide strip → 1_2/2_2 (flush against the clock);
    // 0_2 flows back to the session grid rather than holing the row. 11 sessions
    // is what it takes for the reflow to actually reach 0_2 (it is the 11th free
    // key in row-major order), so this proves the key is a real session slot.
    const deck = buildSessionDeck(baseState(11), { mode: 'list', showUsage: true }, POS);
    expect(deck.get(STRIP_L)!.action).toEqual({ kind: 'open', sessionId: 's10' });
    expect(deck.get(STRIP_M)!.svg).toContain('5H');
    expect(deck.get(STRIP_R)!.svg).toContain('7D');
  });

  it('does not reserve usage slots when showUsage is off (regression: full grid)', () => {
    const deck = buildSessionDeck(baseState(3), { mode: 'list' }, POS);
    expect(deck.get(C7D)!.svg).not.toContain('7D');
    // No query_usage command anywhere.
    const cmds = [...deck.values()].map((c) => c.action).filter((a) => a?.kind === 'command');
    expect(cmds).toHaveLength(0);
  });

  it('frees the usage slots (no residue) when usage is unknown', () => {
    // Unlinked usage: no reserved "—" ghost gauges. The whole strip is freed so
    // sessions/agent tiles can use it (hide-if-absent, mirroring Codex).
    const deck = buildSessionDeck(baseState(1, { usageKnown: false, fiveHourPercent: 0, sevenDayPercent: 0 }),
      { mode: 'list', showUsage: true }, POS);
    expect(usageCells(deck)).toHaveLength(0);
    expect(deck.get(C5H)!.svg).not.toContain('5H');
    expect(deck.get(C7D)!.svg).not.toContain('7D');
    expect(deck.get(C5H)!.svg).not.toContain('—');
  });

  it('frees only the Claude slots when Codex-only usage is present (partial)', () => {
    // Claude unlinked but Codex reporting: the Claude tiles reserve nothing, so
    // the two Codex windows take the right of the strip and 0_2 stays a session.
    const deck = buildSessionDeck(
      baseState(1, {
        usageKnown: false, fiveHourPercent: undefined, sevenDayPercent: undefined,
        codexRateLimits: {
          primary: { usedPercent: 30, windowMinutes: 300, resetsAt: undefined },
          secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt: undefined },
          planType: 'plus',
        },
      }),
      { mode: 'list', showUsage: true }, POS);
    // Exactly two usage tiles (both Codex), wired to query_usage.
    expect(usageCells(deck)).toHaveLength(2);
    // Codex mark present, Claude mark absent among the gauges.
    const usageSvgs = usageCells(deck).map((c) => c.svg).join('');
    expect(usageSvgs).toContain(CODEX_MARK);
    expect(usageSvgs).not.toContain(CLAUDE_MARK);
    // The absent Claude tiles reserve nothing: 0_2 is back in the session grid.
    expect(deck.get(STRIP_L)!.action).toBeNull();
    expect(deck.get(STRIP_L)!.svg).not.toContain('5H');
  });

  it('fits sessions into the 13 non-usage keys without paging', () => {
    const deck = buildSessionDeck(baseState(13), { mode: 'list', showUsage: true }, POS);
    const opens = [...deck.values()].filter((c) => c.action?.kind === 'open');
    expect(opens).toHaveLength(13);
    // No NEXT page button — everything fits.
    const pages = [...deck.values()].filter((c) => c.action?.kind === 'page');
    expect(pages).toHaveLength(0);
    // Usage still pinned on the strip.
    expect(deck.get(C5H)!.svg).toContain('5H');
    expect(deck.get(C7D)!.svg).toContain('7D');
  });

  it('paginates when sessions exceed capacity, NEXT→ sits on the last free key', () => {
    // 15 sessions, 15 keys, 2 reserved for usage → cap 13; overflow → 12/page + NEXT.
    const deck = buildSessionDeck(baseState(15), { mode: 'list', showUsage: true }, POS);
    const next = deck.get(NEXT_POS)!;
    expect(next.action).toEqual({ kind: 'page', delta: 1 });
    expect(next.svg).toContain('1/2'); // page indicator
    // 12 sessions on page 1.
    const opens = [...deck.values()].filter((c) => c.action?.kind === 'open');
    expect(opens).toHaveLength(12);
    // Usage tiles still present on the paginated page.
    expect(deck.get(C5H)!.svg).toContain('5H');
    expect(deck.get(C7D)!.svg).toContain('7D');
  });

  it('page 2 keeps the usage tiles pinned and shows the remainder', () => {
    const deck = buildSessionDeck(baseState(15), { mode: 'list', page: 1, showUsage: true }, POS);
    const opens = [...deck.values()].filter((c) => c.action?.kind === 'open');
    expect(opens).toHaveLength(3); // 15 - 12
    expect(deck.get(C5H)!.svg).toContain('5H');
    expect(deck.get(C7D)!.svg).toContain('7D');
  });

  it('shows usage even with zero sessions', () => {
    const deck = buildSessionDeck(baseState(0), { mode: 'list', showUsage: true }, POS);
    expect(deck.get(C5H)!.svg).toContain('5H');
    expect(deck.get(C7D)!.svg).toContain('7D');
  });

  it('compacts the Codex pair so Plus 5H and 7D both fit the 3-key strip', () => {
    // Claude 5H/7D + Codex 5H/7D = 4 logical limits. The two Codex windows
    // share the third physical key, preserving the clock and every limit.
    const codex = {
      codexRateLimits: {
        primary: { usedPercent: 30, windowMinutes: 300, resetsAt: undefined },
        secondary: { usedPercent: 10, windowMinutes: 10080, resetsAt: undefined },
        planType: 'plus',
      },
    };
    const deck = buildSessionDeck(baseState(2, codex), { mode: 'list', showUsage: true }, POS);
    expect(usageCells(deck)).toHaveLength(3);
    // Labels are short ("5H"/"7D") on both agents; the agent is conveyed by the
    // provider LOGO — terracotta-tinted Claude mark, blue Codex mark.
    const claude5 = deck.get(STRIP_L)!.svg;
    const claude7 = deck.get(STRIP_M)!.svg;
    const codexPair = deck.get(STRIP_R)!.svg;
    expect(claude5).toContain('5H');
    expect(claude5).toContain(CLAUDE_MARK);
    expect(claude5).toContain('M20.998 10.949'); // canonical Claude Code robot path
    // Legibility without a dark overlay: subtle toned level fill, no chip.
    expect(claude5).toContain('opacity="0.38"');
    expect(claude5).not.toContain('opacity="0.72"');
    expect(claude7).toContain('7D');
    expect(claude7).toContain(CLAUDE_MARK);
    expect(codexPair).toContain('5H');
    expect(codexPair).toContain('>30<');
    expect(codexPair).toContain('7D');
    expect(codexPair).toContain('>10<');
    expect(codexPair).toContain(CODEX_MARK);
    expect(codexPair).toContain('M8.086.457'); // Codex provider logo path
  });

  it('renders only the Codex window whose datum exists', () => {
    const onlyPrimary = {
      codexRateLimits: { primary: { usedPercent: 25, windowMinutes: 300 } },
    };
    const deck = buildSessionDeck(baseState(2, onlyPrimary), { mode: 'list', showUsage: true }, POS);
    // 3 tiles (Claude 5H/7D + Codex 5H) → the strip fills exactly.
    expect(deck.get(STRIP_R)!.svg).toContain(CODEX_MARK);
    expect(deck.get(STRIP_R)!.svg).toContain('>25<');
    const codexTiles = usageCells(deck).filter((c) => c.svg.includes(CODEX_MARK));
    expect(codexTiles).toHaveLength(1); // only the Codex 5H window
  });

  it('labels the Codex weekly window "7D" when it arrives in the primary slot (secondary null)', () => {
    // Recent Codex reports the weekly (10080-min) window as `primary` with
    // `secondary` null once the 5h window resets — the live case this strip is
    // sized for: Claude 5H/7D + one Codex window = exactly 3 keys. The tile must
    // be labelled by window length, not slot — otherwise it mislabels "5H" and
    // the 7D gauge vanishes entirely.
    const weeklyOnly = {
      codexRateLimits: { primary: { usedPercent: 4, windowMinutes: 10080 }, planType: 'plus' },
    };
    const deck = buildSessionDeck(baseState(2, weeklyOnly), { mode: 'list', showUsage: true }, POS);
    expect(usageCells(deck)).toHaveLength(3);
    expect(deck.get(STRIP_L)!.svg).toContain('5H');   // Claude 5H
    expect(deck.get(STRIP_L)!.svg).toContain(CLAUDE_MARK);
    expect(deck.get(STRIP_M)!.svg).toContain('7D');   // Claude 7D
    expect(deck.get(STRIP_M)!.svg).toContain(CLAUDE_MARK);
    const codexTile = deck.get(STRIP_R)!.svg;         // Codex weekly, flush to the clock
    expect(codexTile).toContain('7D');       // labelled by length, not slot
    expect(codexTile).not.toContain('5H');
    expect(codexTile).toContain('>4<');      // used 4%
    expect(codexTile).toContain(CODEX_MARK);
    // Exactly one Codex gauge (no phantom secondary tile).
    expect(usageCells(deck).filter((c) => c.svg.includes(CODEX_MARK))).toHaveLength(1);
  });

  it('shows a credits tile when Codex reports a credit-based plan (null windows)', () => {
    const credits = {
      codexRateLimits: {
        limitId: 'premium',
        credits: { hasCredits: false, unlimited: false, balance: '0' },
      },
    };
    const deck = buildSessionDeck(baseState(2, credits), { mode: 'list', showUsage: true }, POS);
    // No Codex windows → a single credits readout takes the strip's right key,
    // carrying the limit label + balance + Codex logo.
    const tile = deck.get(STRIP_R)!.svg;
    expect(tile).toContain('PREMIUM');
    expect(tile).toContain('CREDITS');
    expect(tile).toContain('>0<');           // balance
    expect(tile).toContain(CODEX_MARK);      // Codex brand mark
    expect(deck.get(STRIP_R)!.action).toEqual({ kind: 'command', command: { type: 'query_usage' } });
  });

  it('renders ∞ for an unlimited-credits Codex plan', () => {
    const credits = {
      codexRateLimits: { limitId: 'premium', credits: { hasCredits: true, unlimited: true } },
    };
    const deck = buildSessionDeck(baseState(2, credits), { mode: 'list', showUsage: true }, POS);
    expect(deck.get(STRIP_R)!.svg).toContain('∞');
  });

  it('falls back to trailing keys on a tiny deck where the strip is not placed', () => {
    // Only 3 keys placed (none of 0_2/1_2/2_2) → strip empty, so usage falls back
    // to the trailing keys. Old `slots.length >= 6` gate dropped ALL usage here;
    // the adaptive reserve keeps it.
    const tiny = ['0_0', '1_0', '2_0'];
    const deck = buildSessionDeck(baseState(1), { mode: 'list', showUsage: true }, tiny);
    // 2 trailing keys = Claude 5H/7D; first key stays for the session.
    expect(deck.get('1_0')!.svg).toContain('5H');
    expect(deck.get('2_0')!.svg).toContain('7D');
    const opens = [...deck.values()].filter((c) => c.action?.kind === 'open');
    expect(opens.length).toBeGreaterThanOrEqual(1);
  });

  it('never starves the only key on a 1-key deck (usage yields to the session)', () => {
    const deck = buildSessionDeck(baseState(1), { mode: 'list', showUsage: true }, ['0_0']);
    // maxReserve = 0 → no usage tile; the single key shows the session.
    expect(deck.get('0_0')!.action?.kind).toBe('open');
  });
});

// The scoped per-model cap (e.g. the weekly "Fable" limit) shares the fixed
// usage strip with Codex. The Stream Deck keypad applies the shared inclusion
// and ordering rules, then compacts provider windows rather than dropping them.
describe('buildSessionDeck scoped cap within the fixed usage strip', () => {
  const FABLE = { label: 'Fable', percent: 98, active: true };
  const FABLE_IDLE = { label: 'Fable', percent: 61, active: false };
  const codexWeekly = {
    codexRateLimits: {
      secondary: { usedPercent: 10, windowMinutes: 10080 },
      planType: 'plus',
    },
  };
  // What a free ChatGPT tier reaches the deck as: the account tier survives so
  // surfaces can still name the plan, but there are no rolling windows at all.
  const codexFree = { codexRateLimits: { planType: 'free' } };

  const svgs = (state: Record<string, unknown>) =>
    usageCells(buildSessionDeck(baseState(2, state), { mode: 'list', showUsage: true }, POS))
      .map((c) => c.svg);

  it('gives the key Codex vacated to the scoped cap on a free ChatGPT tier', () => {
    const tiles = svgs({ ...codexFree, scopedLimits: [FABLE_IDLE] });
    expect(tiles).toHaveLength(3);
    expect(tiles.join('')).not.toContain(CODEX_MARK);
    expect(tiles[2]).toContain('FABLE');
    expect(tiles[2]).toContain('>61<');
  });

  it('keeps an ACTIVE cap and the live Codex window by compacting Claude', () => {
    const tiles = svgs({ ...codexWeekly, scopedLimits: [FABLE] });
    expect(tiles).toHaveLength(3);
    expect(tiles[0]).toContain(CLAUDE_MARK);
    expect(tiles[0]).toContain('>42<');
    expect(tiles[0]).toContain('>17<');
    expect(tiles[1]).toContain('FABLE');
    expect(tiles[1]).toContain('>98<');
    expect(tiles[2]).toContain(CODEX_MARK);
    expect(tiles[2]).toContain('>10<');
  });

  it('compacts both providers when an active scoped cap would otherwise overflow', () => {
    const bothWindows = {
      codexRateLimits: {
        primary: { usedPercent: 30, windowMinutes: 300 },
        secondary: { usedPercent: 10, windowMinutes: 10080 },
        planType: 'plus',
      },
    };
    const tiles = svgs({ ...bothWindows, scopedLimits: [FABLE] });
    // Claude pair, FABLE, Codex pair: five logical readings in three keys.
    expect(tiles).toHaveLength(3);
    expect(tiles[0]).toContain(CLAUDE_MARK);
    expect(tiles[0]).toContain('>42<');
    expect(tiles[0]).toContain('>17<');
    expect(tiles[1]).toContain('FABLE');
    expect(tiles[2]).toContain(CODEX_MARK);
    expect(tiles[2]).toContain('>30<');
    expect(tiles[2]).toContain('>10<');
  });

  it('keeps an INACTIVE cap without displacing a live Codex window', () => {
    const tiles = svgs({ ...codexWeekly, scopedLimits: [FABLE_IDLE] });
    expect(tiles).toHaveLength(3);
    expect(tiles[1]).toContain(CODEX_MARK);
    expect(tiles[2]).toContain('FABLE');
  });

  it('shows nothing but Claude when neither Codex nor a scoped cap exists', () => {
    expect(svgs(codexFree)).toHaveLength(2);
  });
});
