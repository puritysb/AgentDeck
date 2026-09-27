import { describe, it, expect } from 'vitest';
import { Brand } from '../design-tokens.js';
import {
  buildSessionDeck,
  parseState,
  renderUsageButton,
  renderUsagePairGauge,
  renderUsageWideSlot,
  renderLunaReserveTile,
} from '../d200h-layout.js';

const positions = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `${i % 5}_${Math.floor(i / 5)}`);

describe('usage tiles — usageKnown tri-state', () => {
  it('renders Luna Reserve as a large moon tile with remaining percentage', () => {
    const svg = renderLunaReserveTile({ usedPercent: 32, regularResetsAt: new Date(Date.now() + 3600000).toISOString() });
    expect(svg).toContain('LUNA RESERVE');
    expect(svg).toContain('>CODEX</text>');
    expect(svg).toContain('68%');
    expect(svg).toContain('<circle');
  });
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

  it('compact pair preserves both window labels and values in one key', () => {
    const svg = renderUsagePairGauge('codex', [
      { agent: 'codex', window: '5h', label: '5H', usedPercent: 31 },
      { agent: 'codex', window: '7d', label: '7D', usedPercent: 67 },
    ]);
    expect(svg).toContain('5H');
    expect(svg).toContain('>31<');
    expect(svg).toContain('7D');
    expect(svg).toContain('>67<');
    expect(svg).toContain('#6166E0');
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
  it('renders one deck-spanning OFFLINE card for a disconnected daemon', () => {
    const pos = positions(13);
    const deck = buildSessionDeck(
      { state: 'DISCONNECTED', daemonConnected: false, allSessions: [] },
      { mode: 'list' },
      pos,
    );

    const heroCells = [...deck.values()].filter((c) => c.svg.includes('OFFLINE'));
    expect(heroCells).toHaveLength(pos.length);
    expect(deck.get('0_0')?.svg).toContain('translate(0 0)');
    expect(deck.get('4_1')?.svg).toContain('translate(-576 -144)');
  });

  it('makes EVERY key launch the companion app while offline', () => {
    const deck = buildSessionDeck({ state: 'DISCONNECTED', allSessions: [] }, { mode: 'list' }, positions(14));
    expect(deck.size).toBe(14);
    for (const cell of deck.values()) {
      expect(cell.action).toEqual({ kind: 'launch' });
    }
  });

  it('does not show OFFLINE / launch when the daemon is connected', () => {
    const deck = buildSessionDeck(
      { state: 'disconnected', daemonConnected: true, allSessions: [] },
      { mode: 'list' },
      positions(5),
    );
    for (const cell of deck.values()) {
      expect(cell.svg).not.toContain('OFFLINE');
      expect(cell.action).not.toEqual({ kind: 'launch' });
    }
    const svg = [...deck.values()].map((cell) => cell.svg).join('\n');
    expect(svg).toContain('HUB READY');
    expect(svg).toContain('NO SESSION');
    expect(svg).toContain('AgentDeck');
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
    expect(svg).toContain('#FF6B6B');     // 98% active → red ramp (5h/7d are green)
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
    expect(svg).not.toContain('#FF6B6B'); // never the red ramp
  });

  it('parseState carries scopedLimits through', () => {
    const s = parseState({ state: 'IDLE', scopedLimits: [{ label: 'Fable', percent: 5, active: true }] });
    expect(s.scopedLimits).toHaveLength(1);
    expect(s.scopedLimits?.[0].label).toBe('Fable');
  });
});

// ─── Codex snapshot freshness on the tile ──────────────────────────────

/**
 * A Codex gauge is a passive rollout read: its number freezes the moment Codex
 * stops being used, while a weekly window's `resetsAt` keeps counting down for
 * days. The tile must therefore say how OLD the reading is — the shipped bug was
 * a 4h-old 94% rendering byte-identical to a live one.
 */
describe('usage tiles — Codex snapshot freshness', () => {
  const future = new Date(Date.now() + 6 * 24 * 3600_000).toISOString();

  function codexTile(capturedAt: string | undefined, stale = false): string {
    const deck = buildSessionDeck(
      {
        state: 'IDLE',
        allSessions: [],
        codexRateLimits: {
          secondary: { usedPercent: 94, windowMinutes: 10080, resetsAt: stale ? undefined : future, stale: stale || undefined },
          capturedAt,
        },
      } as any,
      { mode: 'list', showUsage: true } as any,
      positions(15),
    );
    return [...deck.values()].map((c) => c?.svg ?? '').join('|');
  }

  it('prints the countdown, undimmed, for a fresh snapshot', () => {
    const svg = codexTile(new Date(Date.now() - 60_000).toISOString());
    expect(svg).toContain('94');
    expect(svg).not.toContain('ago');
    expect(svg).not.toContain('stale');
    expect(svg).toContain('opacity="0.38"'); // full-strength fill
  });

  it('THE REGRESSION: an aged snapshot keeps its % but is dimmed and dated', () => {
    const svg = codexTile(new Date(Date.now() - 4 * 3600_000).toISOString());
    expect(svg).toContain('94');          // never blanked — it is the last true reading
    expect(svg).toContain('4h ago');      // ...and it says so
    expect(svg).toContain('opacity="0.22"'); // dimmed fill
  });

  it('an ended window still reads "stale", not an age', () => {
    const svg = codexTile(new Date(Date.now() - 4 * 3600_000).toISOString(), true);
    expect(svg).toContain('stale');
    expect(svg).not.toContain('ago');
  });

  it('a legacy producer (no capturedAt) renders exactly as before', () => {
    const svg = codexTile(undefined);
    expect(svg).toContain('94');
    expect(svg).not.toContain('ago');
    expect(svg).toContain('opacity="0.38"');
  });
});

// ─── Scoped caps vs the three-key usage strip ──────────────────────────

describe('usage tiles — scoped caps and the three-key strip budget', () => {
  const codexRateLimits = {
    primary: { usedPercent: 55, windowMinutes: 300 },
    secondary: { usedPercent: 20, windowMinutes: 10080 },
  };

  /** All usage-strip SVG text for a state, joined. The strip is three keys wide
   *  (USAGE_PREFERRED_POS), so provider windows are paired before placement. */
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

  it('compacts provider pairs so scoped and Codex limits all remain visible', () => {
    const withScoped = stripText({ scopedLimits: [{ label: 'Fable', percent: 98, active: true }] });
    const withoutScoped = stripText({});
    // Claude pair + scoped + Codex pair fills the three-key strip exactly.
    expect(withScoped).toContain('FABLE');
    expect(withoutScoped.match(/>5H</g)?.length).toBe(2);
    expect(withScoped.match(/>5H</g)?.length).toBe(2);
    expect(withScoped).toContain('>55<');
    expect(withScoped).toContain('>20<');
  });

  it('sanitizes and truncates the API label before it reaches SVG text', () => {
    const text = stripText({ scopedLimits: [{ label: ' fa\nble x ', percent: 77, active: true }] });
    expect(text).toContain('FA BLE');
  });

  it('renders no scoped tile when there are none', () => {
    expect(stripText({})).not.toContain('MODEL');
  });
});

describe('usage tiles — z.ai provider windows', () => {
  const zaiRateLimits = {
    planType: 'max',
    limitId: 'standard',
    capturedAt: new Date().toISOString(),
    primary: { usedPercent: 3, windowMinutes: 300, resetsAt: '2099-01-01T00:00:00Z', quantity: 'tokens' },
    secondary: { usedPercent: 100, windowMinutes: 43200, resetsAt: '2099-01-01T00:00:00Z', quantity: 'mcp' },
  };

  function stripText(extra: Record<string, unknown>): string {
    const deck = buildSessionDeck(
      { state: 'IDLE', allSessions: [], zaiRateLimits, ...extra } as any,
      { mode: 'list', showUsage: true } as any,
      positions(15),
    );
    return [...deck.values()].map((c) => c?.svg ?? '').join('|');
  }

  it('renders a lone z.ai plan with a text identity and a length-derived 30D label', () => {
    const text = stripText({});
    // Identity is the upstream z.ai mark (design/brand/zai.svg) — the Z's
    // diagonal stroke rendered in the brand colour, never a redrawn logo.
    expect(text).toContain('M24.3,7.1L13.14,22.91');
    expect(text).toContain(Brand.zai);
    // The MCP tool-call quota labels by its QUANTITY, not its length.
    expect(text).toContain('>MCP<');
    expect(text).toContain('>3<');
    expect(text).toContain('>100<');
  });

  it('compacts all three providers into pair tiles — six windows, nothing dropped', () => {
    const text = stripText({
      fiveHourPercent: 32,
      sevenDayPercent: 64,
      codexRateLimits: {
        primary: { usedPercent: 55, windowMinutes: 300 },
        secondary: { usedPercent: 20, windowMinutes: 10080 },
      },
    });
    // Every provider's readings survive on the three-key strip.
    expect(text).toContain('>32<');
    expect(text).toContain('>64<');
    expect(text).toContain('>55<');
    expect(text).toContain('>20<');
    expect(text).toContain('>MCP<');
    expect(text).toContain('>100<');
  });

  it('emits no z.ai tiles for a windowless (retired or payg) block', () => {
    const text = stripText({ zaiRateLimits: { limitId: 'payg' } });
    expect(text).not.toContain('M24.3,7.1L13.14,22.91');
    expect(text).not.toContain('>MCP<');
  });
});

describe('VOICE tile — hold-to-talk contract', () => {
  // The capture is started and stopped by the key's own keydown/keyUp in the
  // Ulanzi plugin, NOT by pressing the tile twice. It was a tap toggle until
  // 2026-08-08: the stop lived on a tile that only flips once the daemon's
  // `voice_state` has come back, so a user holding the key — as they would on a
  // Stream Deck — never stopped the capture and it ran to the 30s cap.
  const state = {
    state: 'idle',
    sessions: [
      { id: 'observed:claude:abc', agentType: 'claude-code', state: 'idle', projectName: 'demo' },
    ],
  };
  const view = { mode: 'detail' as const, openSessionId: 'observed:claude:abc' };
  const voiceCell = (voiceState?: 'idle' | 'recording' | 'transcribing' | 'error') => {
    const deck = buildSessionDeck(state, { ...view, voiceState }, positions(15));
    return [...deck.values()].find((c) => /VOICE/.test(c.svg));
  };

  it('tells the user to hold, not to tap', () => {
    const cell = voiceCell('idle');
    expect(cell?.svg).toContain('hold to talk');
    expect(cell?.svg).not.toContain('tap to');
  });

  it('reads as listening while the daemon captures', () => {
    expect(voiceCell('recording')?.svg).toContain('● listening');
  });

  it('still declares the wire commands the layout is responsible for', () => {
    // The plugin drives the capture from the key event, but the cell remains
    // the layout's statement of what this key does — and the daemon accepts
    // exactly these shapes.
    expect(voiceCell('idle')?.action).toMatchObject({
      kind: 'command',
      command: { type: 'voice', action: 'start', sessionId: 'observed:claude:abc' },
    });
    expect(voiceCell('recording')?.action).toMatchObject({
      kind: 'command',
      command: { type: 'voice', action: 'stop', sessionId: 'observed:claude:abc' },
    });
  });

  it('goes inert only while transcribing', () => {
    expect(voiceCell('transcribing')?.action).toBeNull();
  });
});
