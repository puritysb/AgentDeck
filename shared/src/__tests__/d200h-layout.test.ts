import { describe, it, expect } from 'vitest';
import {
  buildSessionDeck,
  parseState,
  renderUsageButton,
  renderUsageWideSlot,
} from '../d200h-layout.js';

const positions = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${i % 5}_${Math.floor(i / 5)}`);

describe('usage tiles — usageKnown tri-state', () => {
  // Note: svgFrame emits a gradient with offset="0%" coordinates, so assert on the
  // value text element (`…%</text>`) rather than the bare substring "0%".
  it('renders a percent when the quota is known', () => {
    const svg = renderUsageButton('5H', 42, '#28a0b4', true);
    expect(svg).toContain('>42%</text>');
    expect(svg).not.toContain('>—</text>');
  });

  it('renders a muted "—" instead of a confident 0% when unknown', () => {
    const svg = renderUsageButton('5H', 0, '#28a0b4', false);
    expect(svg).toContain('>—</text>');
    expect(svg).not.toContain('%</text>');
  });

  it('defaults to known (percent) when the flag is omitted', () => {
    expect(renderUsageButton('7D', 0, '#2850a0')).toContain('>0%</text>');
  });

  it('wide slot shows "—" for both columns when unknown', () => {
    const svg = renderUsageWideSlot(0, 0, false);
    expect(svg.match(/—/g)?.length).toBe(2);
    expect(svg).not.toContain('%</text>');
  });

  it('wide slot shows percents when known', () => {
    const svg = renderUsageWideSlot(12, 34, true);
    expect(svg).toContain('12%');
    expect(svg).toContain('34%');
  });

  it('parseState infers usageKnown=false when no percent fields are present', () => {
    expect(parseState({ state: 'IDLE' }).usageKnown).toBe(false);
  });

  it('parseState infers usageKnown=true when a percent is present', () => {
    expect(parseState({ state: 'IDLE', fiveHourPercent: 6 }).usageKnown).toBe(true);
  });

  it('parseState honors an explicit usageKnown=false even with a coerced 0 percent', () => {
    expect(parseState({ state: 'IDLE', fiveHourPercent: 0, usageKnown: false }).usageKnown).toBe(false);
  });
});

describe('buildSessionDeck — daemon offline', () => {
  it('renders the OFFLINE hero on the center key for a DISCONNECTED state', () => {
    const pos = positions(13);
    const deck = buildSessionDeck({ state: 'DISCONNECTED', allSessions: [] }, { mode: 'list' }, pos);

    const heroCells = [...deck.values()].filter((c) => c.svg.includes('OFFLINE'));
    expect(heroCells).toHaveLength(1);

    // Hero sits at the center index of the sorted positions, not the corner.
    const sorted = [...deck.keys()].sort((a, b) => {
      const [ac, ar] = a.split('_').map(Number);
      const [bc, br] = b.split('_').map(Number);
      return ar !== br ? ar - br : ac - bc;
    });
    const heroPos = [...deck.entries()].find(([, c]) => c.svg.includes('OFFLINE'))![0];
    expect(heroPos).toBe(sorted[Math.floor(sorted.length / 2)]);
  });

  it('makes EVERY key launch the companion app while offline', () => {
    const deck = buildSessionDeck({ state: 'DISCONNECTED', allSessions: [] }, { mode: 'list' }, positions(14));
    expect(deck.size).toBe(14);
    for (const cell of deck.values()) {
      expect(cell.action).toEqual({ kind: 'launch' });
    }
  });

  it('does not show OFFLINE / launch when the daemon is connected', () => {
    const deck = buildSessionDeck({ state: 'IDLE', allSessions: [] }, { mode: 'list' }, positions(5));
    for (const cell of deck.values()) {
      expect(cell.svg).not.toContain('OFFLINE');
      expect(cell.action).not.toEqual({ kind: 'launch' });
    }
  });

  // Regression: the daemon reports state:'disconnected' whenever no managed /
  // focused session is active — the normal case when only passively-observed
  // sessions exist (e.g. after a managed PTY session ends on sleep). Those
  // sessions still arrive via sessions_list, so the deck must render them, NOT
  // the OFFLINE hero. OFFLINE is reserved for a genuinely empty session list.
  it('shows the session list (not OFFLINE) when state is disconnected but sessions exist', () => {
    const sessions = [
      { id: 'observed:claude:a', agentType: 'claude-code', state: 'processing', modelName: 'claude-opus-4-8', cwd: '/x', projectName: 'x', window: 'x' },
      { id: 'observed:opencode:b', agentType: 'opencode', state: 'idle', cwd: '/y', projectName: 'y', window: 'y' },
    ] as any;
    const deck = buildSessionDeck(
      { state: 'disconnected', focusedSessionId: '', allSessions: sessions },
      { mode: 'list', page: 0 },
      positions(7),
    );
    for (const cell of deck.values()) {
      expect(cell.svg).not.toContain('OFFLINE');
      expect(cell.action).not.toEqual({ kind: 'launch' });
    }
    // The two observed sessions should be openable tiles.
    const openable = [...deck.values()].filter((c) => c.action?.kind === 'open');
    expect(openable.length).toBe(2);
  });
});

describe('buildSessionDeck — selected session isolation', () => {
  it('does not render another agent model while selected-session focus is pending', () => {
    const selectedId = 'claude:enhance-timeline';
    const deck = buildSessionDeck({
      state: 'processing',
      sessionId: 'openclaw-gateway',
      focusedSessionId: 'openclaw-gateway',
      agentType: 'openclaw',
      modelName: 'GLM-5.2 (1M)',
      allSessions: [{
        id: selectedId,
        port: 9121,
        alive: true,
        projectName: 'enhance-timeline',
        agentType: 'claude-code',
        state: 'processing',
      }],
    }, { mode: 'detail', openSessionId: selectedId }, positions(8));

    const svg = [...deck.values()].map((cell) => cell.svg).join('');
    expect(svg).not.toContain('GLM-5.2');
    expect(svg).toContain('enhance-t');
  });
});

describe('buildSessionDeck — per-model scoped caps', () => {
  // The usage region has 3 slots (USAGE_PREFERRED_POS), so 5h + 7d + the worst
  // scoped cap[0] fit; the daemon sends scopedLimits worst-first, so the binding
  // cap is the one that lands in the third slot (extra models overflow).
  it('surfaces the worst ACTIVE scoped cap with the critical ramp', () => {
    const deck = buildSessionDeck(
      {
        state: 'IDLE', allSessions: [], fiveHourPercent: 20, sevenDayPercent: 0,
        scopedLimits: [{ kind: 'weekly_scoped', label: 'Fable', percent: 98, severity: 'critical', active: true }],
      },
      { mode: 'list', showUsage: true },
      positions(15),
    );
    const svg = [...deck.values()].map((cell) => cell.svg).join('\n');
    expect(svg).toContain('FABLE');       // label uppercased + capped
    expect(svg).toContain('#ef4444');     // 98% active → red ramp (5h/7d are green)
    expect(svg).not.toContain('#3ED6E8'); // not the inactive/informational cyan
  });

  it('renders an INACTIVE scoped cap muted (informational cyan), never the ramp', () => {
    const deck = buildSessionDeck(
      {
        state: 'IDLE', allSessions: [], fiveHourPercent: 20, sevenDayPercent: 0,
        scopedLimits: [{ kind: 'weekly_scoped', label: 'Opus', percent: 90, severity: 'normal', active: false }],
      },
      { mode: 'list', showUsage: true },
      positions(15),
    );
    const svg = [...deck.values()].map((cell) => cell.svg).join('\n');
    expect(svg).toContain('OPUS');
    expect(svg).toContain('#3ED6E8');     // inactive 90% → cyan, not critical
    expect(svg).not.toContain('#ef4444'); // never the red ramp
  });

  it('parseState carries scopedLimits through', () => {
    const s = parseState({ state: 'IDLE', scopedLimits: [{ label: 'Fable', percent: 5, active: true }] });
    expect(s.scopedLimits).toHaveLength(1);
    expect(s.scopedLimits?.[0].label).toBe('Fable');
  });
});

// ─── Scoped caps vs the three-key usage strip ──────────────────────────

describe('usage tiles — scoped caps and the three-key strip budget', () => {
  const codexRateLimits = {
    primary: { usedPercent: 55, windowMinutes: 300 },
    secondary: { usedPercent: 20, windowMinutes: 10080 },
  };

  /** All usage-strip SVG text for a state, joined. The strip is three keys wide
   *  (USAGE_PREFERRED_POS) and buildSessionDeck drops tiles past it. */
  function stripText(extra: Record<string, unknown>): string {
    const deck = buildSessionDeck(
      { state: 'IDLE', allSessions: [], fiveHourPercent: 32, sevenDayPercent: 64, codexRateLimits, ...extra },
      { mode: 'list', showUsage: true } as any,
      positions(15),
    );
    return [...deck.values()].map((c) => c?.svg ?? '').join('|');
  }

  it('emits at most ONE scoped tile, however many caps arrive', () => {
    const text = stripText({ scopedLimits: [
      { label: 'Fable', percent: 98, active: true },
      { label: 'Opus', percent: 40, active: false },
      { label: 'Sonnet', percent: 12, active: false },
    ] });
    expect(text).toContain('FABLE');
    // Runners-up page on the SD+ encoder; a second tile here could never reach a
    // key anyway, so it must not be built.
    expect(text).not.toContain('OPUS');
    expect(text).not.toContain('SONNET');
  });

  it('documents the cost: the scoped tile takes the slot Codex 5H used to hold', () => {
    const withScoped = stripText({ scopedLimits: [{ label: 'Fable', percent: 98, active: true }] });
    const withoutScoped = stripText({});
    // 5H + 7D + scoped fills the three-key strip exactly.
    expect(withScoped).toContain('FABLE');
    // Codex's own 5H gauge rides the strip only when no scoped cap is present.
    expect(withoutScoped.match(/>5H</g)?.length).toBe(2);
    expect(withScoped.match(/>5H</g)?.length).toBe(1);
  });

  it('sanitizes and truncates the API label before it reaches SVG text', () => {
    const text = stripText({ scopedLimits: [{ label: ' fa\nble x ', percent: 77, active: true }] });
    expect(text).toContain('FA BLE');
  });

  it('renders no scoped tile when there are none', () => {
    expect(stripText({})).not.toContain('MODEL');
  });
});
