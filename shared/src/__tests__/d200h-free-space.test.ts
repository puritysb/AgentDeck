// Free-space usage expansion (#349): when the session roster leaves keys free,
// the usage area grows into them — one window per key instead of compacted
// pairs — and never at the cost of a session key.
import { describe, it, expect } from 'vitest';
import { buildSessionDeck } from '../d200h-layout.js';

const positions = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${i % 5}_${Math.floor(i / 5)}`);

const ALL_THREE = {
  state: 'IDLE',
  fiveHourPercent: 32,
  sevenDayPercent: 64,
  codexRateLimits: {
    primary: { usedPercent: 55, windowMinutes: 300 },
    secondary: { usedPercent: 20, windowMinutes: 10080 },
  },
  zaiRateLimits: {
    planType: 'max',
    limitId: 'standard',
    primary: { usedPercent: 3, windowMinutes: 300, quantity: 'tokens' },
    secondary: { usedPercent: 100, windowMinutes: 43200, quantity: 'mcp' },
  },
};

const oneSession = [{
  id: 'observed:claude:a', agentType: 'claude-code', state: 'idle',
  projectName: 'solo', cwd: '/x', window: 'x',
}];

function deckSvg(state: any): string {
  const deck = buildSessionDeck(state, { mode: 'list', showUsage: true } as any, positions(15));
  return [...deck.values()].map((c) => c?.svg ?? '').join('|');
}

/** The empty-slot placeholder is `svgFrame('#0a0a0a', '')` — identified by its
 *  fill. No other tile on this deck uses that exact background color. */
const renderEmptyMarker = 'fill="#0a0a0a"';

describe('usage free-space expansion', () => {
  it('uncompacts into keys the roster leaves free — six windows, six keys', () => {
    const svg = deckSvg({ ...ALL_THREE, allSessions: oneSession });
    // One session on a 15-key grid leaves 11 spare: every provider keeps its
    // own two tiles (no pair gauges), and all six readings render.
    const claude5h = svg.match(/>5H</g)?.length ?? 0;
    const claude7d = svg.match(/>7D</g)?.length ?? 0;
    expect(claude5h).toBeGreaterThanOrEqual(2); // claude 5H + codex 5H
    expect(claude7d).toBeGreaterThanOrEqual(1);
    expect(svg).toContain('>MCP<');
    // The pair gauge (two readings sharing one key) is the compaction shape —
    // with this much space none should remain.
    expect(svg).not.toContain('usage-pair');
  });

  it('keeps every session key — expansion only takes keys the roster cannot use', () => {
    // 10 sessions on 15 keys: strip 3 + 10 sessions = 13, spare 2 → budget 5.
    // Expansion grows usage to 5 keys (claude unpaired + codex pair + zai
    // unpaired) and all 10 sessions still keep their keys — the growth only
    // consumed the two keys no session could use.
    const ten = Array.from({ length: 10 }, (_, i) => ({
      id: `observed:claude:${i}`, agentType: 'claude-code', state: 'idle',
      projectName: `p${i}`, cwd: '/x', window: 'x',
    }));
    const deck = buildSessionDeck(
      { ...ALL_THREE, allSessions: ten },
      { mode: 'list', showUsage: true } as any,
      positions(15),
    );
    const svgs = [...deck.values()].map((c) => c?.svg ?? '').join('|');
    for (let i = 0; i < 10; i++) expect(svgs).toContain(`p${i}<`);
    expect(svgs).toContain('>MCP<'); // the spare key hosts the MCP gauge whole
    expect(svgs).not.toContain(renderEmptyMarker); // no empty slots left
  });

  it.each([undefined, 64])('keeps all providers and the cap in three keys (Claude weekly: %s)', (sevenDayPercent) => {
    const sessions = Array.from({ length: 12 }, (_, i) => ({ ...oneSession[0], id: `s${i}`, projectName: `p${i}` }));
    const deck = buildSessionDeck({ ...ALL_THREE, sevenDayPercent, allSessions: sessions,
      scopedLimits: [{ label: 'Fable', percent: 97, active: true }],
    }, { mode: 'list', showUsage: true } as any, positions(15));
    const svg = [...deck.values()].map((c) => c.svg).join('|');
    expect(svg).toContain('>FABLE<');
    expect(svg).toContain('>MCP<');
    expect(svg).toContain('>55<');
    expect(svg).toContain('>20<');
    for (let i = 0; i < 12; i++) expect(svg).toContain(`p${i}<`);
  });

  it('no spare (roster fills the grid) — usage stays the compacted strip', () => {
    // 12 sessions fill every non-strip key: spare 0 by construction, the strip
    // stays three pair tiles and the zai MCP window rides its pair.
    const twelve = Array.from({ length: 12 }, (_, i) => ({
      id: `observed:claude:${i}`, agentType: 'claude-code', state: 'idle',
      projectName: `q${i}`, cwd: '/x', window: 'x',
    }));
    const deck = buildSessionDeck(
      { ...ALL_THREE, allSessions: twelve },
      { mode: 'list', showUsage: true } as any,
      positions(15),
    );
    const svgs = [...deck.values()].map((c) => c?.svg ?? '').join('|');
    for (let i = 0; i < 12; i++) expect(svgs).toContain(`q${i}<`);
    // Compacted: 6 windows on 3 keys — the zai MCP gauge only exists inside
    // its pair tile, never as its own full gauge tile.
    expect(svgs).not.toContain('ugauge-zai-7d');
  });
});

describe('folded z.ai key (5H + MCP on one key, press cycles the view)', () => {
  // 11 sessions on 15 keys leave one spare key: a four-key usage budget for
  // six readings. Codex pairs first, then z.ai — Claude keeps 5H and 7D apart.
  const eleven = Array.from({ length: 11 }, (_, i) => ({
    id: `observed:claude:s${i}`, agentType: 'claude-code', state: 'idle', projectName: `p${i}`, cwd: `/p${i}`, window: 'x',
  }));
  const usageKeys = (zaiPairMode?: 'both' | 'first' | 'second') => {
    const deck = buildSessionDeck({ ...ALL_THREE, allSessions: eleven } as any,
      { mode: 'list', showUsage: true, zaiPairMode } as any, positions(15));
    return [...deck.values()].filter((c) => {
      const a = c?.action as { kind?: string; command?: { type?: string } } | null;
      return a?.kind === 'zai-mode' || a?.kind === 'weekly-mode' || a?.command?.type === 'query_usage';
    });
  };

  it('folds z.ai before Claude and makes that key cycle', () => {
    const keys = usageKeys();
    expect(keys).toHaveLength(4);
    const zai = keys.filter((c) => (c.action as { kind?: string }).kind === 'zai-mode');
    expect(zai).toHaveLength(1);
    expect(zai[0].svg).toContain('>MCP<');
    expect(zai[0].svg).toContain('>3<');
    expect(zai[0].svg).toContain('>100<');
    // Claude's two windows stay on their own keys.
    expect(keys.filter((c) => c.svg.includes('>32<') && !c.svg.includes('>64<'))).toHaveLength(1);
  });

  it('shows only the selected z.ai reading in 5H and MCP modes', () => {
    const zaiKey = (mode: 'first' | 'second') =>
      usageKeys(mode).find((c) => (c.action as { kind?: string }).kind === 'zai-mode')!.svg;
    expect(zaiKey('first')).toContain('>3<');
    expect(zaiKey('first')).not.toContain('>MCP<');
    expect(zaiKey('second')).toContain('>MCP<');
    expect(zaiKey('second')).not.toContain('>3<');
  });

  it('keeps one z.ai window per key, with no cycle, when there is room', () => {
    const deck = buildSessionDeck({ ...ALL_THREE, allSessions: oneSession } as any,
      { mode: 'list', showUsage: true } as any, positions(15));
    expect([...deck.values()].some((c) => (c?.action as { kind?: string } | null)?.kind === 'zai-mode')).toBe(false);
  });
});
