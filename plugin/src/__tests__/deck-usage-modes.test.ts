import { describe, expect, it } from 'vitest';
import { buildSessionDeck, nextClaudeWeeklyMode, type ClaudeWeeklyMode } from '@agentdeck/shared';
import { SessionSlotManager, type DeckLayout } from '../session-slot-manager.js';
import { usageDialViews, renderUsageDialView } from '../utility-modes/usage-dial-view.js';
import { availableUsageProviders, buildProviderUsageEncoder, restoreUsageDialPreferences, getUsageDialSelections, resolveE2UsageProvider, selectUsageDialProvider, usageDialPreferences } from '../utility-modes/usage.js';
import { renderUsageEncoderBoth } from '../renderers/usage-gauge.js';

const usage = { fiveHourPercent: 20, sevenDayPercent: 82, scopedLimits: [{ label: 'Fable', percent: 98, active: true }] };
const layout: DeckLayout = { deviceId: 'deck-a', family: 'stream-deck', columns: 5, rows: 3, keyCount: 15 };
const positions = Array.from({ length: 15 }, (_, i) => `${i % 5}_${Math.floor(i / 5)}`);

describe('weekly key display modes', () => {
  it('cycles three views on the same SD key without moving or changing another deck', () => {
    const manager = new SessionSlotManager();
    manager.updateUsage(usage);
    for (const expected of [['7D', 'FABLE'], ['7D'], ['FABLE'], ['7D', 'FABLE']]) {
      const tile = manager.getSlotConfig(14, layout);
      expect(tile.usageWeekly?.map(w => w.label)).toEqual(expected);
      expect(manager.handleSlotPress(14, layout).action).toBe('cycle-weekly-mode');
      expect(manager.getSlotConfig(14, { ...layout, deviceId: 'deck-b' }).usageWeekly).toHaveLength(2);
      manager.cycleWeeklyMode(layout);
    }
  });

  it('retains the preference across quota disappearance, stale snapshots and return', () => {
    const manager = new SessionSlotManager();
    manager.setWeeklyMode('scoped', layout);
    manager.updateUsage(usage);
    expect(manager.getSlotConfig(14, layout).usageWeekly?.[0].label).toBe('FABLE');
    manager.updateUsage({ ...usage, scopedLimits: [] });
    expect(manager.getSlotConfig(14, layout).usageLabel).toBe('7D');
    manager.updateUsage({ ...usage, usageStale: true });
    expect(manager.getSlotConfig(14, layout).type).not.toBe('usage');
    manager.updateUsage({ ...usage, usageStale: false });
    expect(manager.getSlotConfig(14, layout).usageWeekly?.[0].label).toBe('FABLE');
  });

  it.each([0, 13])('D200H shares the weekly key with %i sessions and cycles locally', (count) => {
    const state = { state: 'IDLE', ...usage, allSessions: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, state: 'idle', agentType: 'claude-code', projectName: `p${i}` })) };
    let mode: ClaudeWeeklyMode = 'both';
    let key: string | undefined;
    for (const [weekly, scoped] of [[true, true], [true, false], [false, true], [true, true]]) {
      const deck = buildSessionDeck(state, { mode: 'list', showUsage: true, claudeWeeklyMode: mode }, positions);
      const tiles = [...deck].filter(([, c]) => c.action?.kind === 'weekly-mode');
      expect(tiles).toHaveLength(1);
      key ??= tiles[0][0];
      expect(tiles[0][0]).toBe(key);
      expect(tiles[0][1].svg.includes('>7D<')).toBe(weekly);
      expect(tiles[0][1].svg.includes('FABLE')).toBe(scoped);
      expect([...deck.values()].filter(c => c.svg.includes('FABLE'))).toHaveLength(scoped ? 1 : 0);
      mode = nextClaudeWeeklyMode(mode);
    }
  });

  it('D200H keeps a scoped-only reading when weekly data is absent', () => {
    const deck = buildSessionDeck({ state: 'IDLE', scopedLimits: usage.scopedLimits }, { mode: 'list', showUsage: true, claudeWeeklyMode: '7d' }, positions);
    const svg = [...deck.values()].map(c => c.svg).join('');
    expect(svg).toContain('FABLE');
    expect(svg).not.toContain('>7D<');
  });
});

describe('SD+ independent subscription pages', () => {
  it('offers both Claude overviews on either dial without hiding 7D-only selection', () => {
    expect(usageDialViews(usage, 'claude')).toEqual(['triple', 'both', '5h', '7d', 'scoped:0', 'session']);
    expect(renderUsageDialView(usage, 'claude', true, 'triple')).toContain('FABLE');
    const both = renderUsageDialView(usage, 'claude', true, 'both');
    expect(both).toContain('5H');
    expect(both).toContain('7D');
    expect(both).not.toContain('FABLE');
    expect(usageDialViews({ ...usage, usageStale: true }, 'claude')).not.toContain('triple');
  });

  it('restores duplicate manual choices and leaves the peer alone after every selection', () => {
    const data = { ...usage, codexRateLimits: {}, antigravityStatus: { planName: 'Google AI Pro' } };
    restoreUsageDialPreferences({ e2: 'claude', e3: 'claude' });
    resolveE2UsageProvider(data);
    expect(getUsageDialSelections()).toEqual({ e2: 'claude', e3: 'claude' });
    selectUsageDialProvider('e3', 'antigravity', data);
    selectUsageDialProvider('e2', 'antigravity', data);
    expect(usageDialPreferences()).toEqual({ e2: 'antigravity', e3: 'antigravity' });
  });

  it('makes Antigravity a confirmed plan page, never a credit or percentage gauge', () => {
    expect(availableUsageProviders({ antigravityStatus: { availableCredits: 100 } })).toEqual([]);
    const data = { antigravityStatus: { planName: 'Google AI Ultra', availableCredits: 12345 } };
    expect(availableUsageProviders(data)).toEqual(['antigravity']);
    expect(availableUsageProviders({ subscriptions: [{ name: 'Google AI Pro' }] })).toEqual(['antigravity']);
    expect(usageDialViews(data, 'antigravity')).toEqual(['both']);
    const svg = renderUsageEncoderBoth(buildProviderUsageEncoder('antigravity', data, true));
    expect(svg).toContain('ANTIGRAVITY');
    expect(svg).toContain('Ultra');
    expect(svg).toContain('Usage unavailable');
    expect(svg).not.toContain('12345');
    expect(svg).not.toContain('%');
    expect(svg).not.toContain('5H');
  });
});
