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
});
