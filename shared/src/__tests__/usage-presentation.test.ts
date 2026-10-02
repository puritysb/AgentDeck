import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { USAGE_PRESENTATION, USAGE_TIER_SEPARATORS, usageLunaActive, selectedLunaReserve, usageSubscriptionProvider, usageSubscriptionTier, usageCreditsActive, selectedCodexCredits, codexCreditBalance, formatCreditBalance, CREDIT_BALANCE_UNITS } from '../usage-presentation.js';
// @ts-expect-error executable generator has no TypeScript declaration
import { outputs } from '../../../scripts/generate-usage-presentation.mjs';
const window = (usedPercent: number, stale = false) => ({ usedPercent, stale, windowMinutes: 300 });
describe('shared usage display policy', () => {
  it('keeps regular windows until exhausted, then restores them after reset', () => {
    const lunaReserve = { usedPercent: 32 };
    expect(selectedLunaReserve({ primary: window(99), lunaReserve })).toBeUndefined();
    expect(selectedLunaReserve({ secondary: window(100), lunaReserve })).toEqual(lunaReserve);
    expect(selectedLunaReserve({ primary: window(0), lunaReserve })).toBeUndefined();
    expect(selectedLunaReserve({ secondary: window(100, true), lunaReserve })).toBeUndefined();
    expect(selectedLunaReserve({ lunaReserve })).toBeUndefined();
    expect(selectedLunaReserve({ primary: window(100), lunaReserve: { usedPercent: 100, available: false } })).toBeDefined();
  });
  it('expires reserve and regular windows independently', () => {
    const now = Date.parse('2026-09-24T00:00:00Z');
    expect(selectedLunaReserve({ primary: window(100), lunaReserve: { usedPercent: 32, resetsAt: '2026-09-23T23:00:00Z' } }, now)).toBeUndefined();
    expect(selectedLunaReserve({ primary: { ...window(100), resetsAt: '2026-09-23T23:00:00Z' }, lunaReserve: { usedPercent: 32 } }, now)).toBeUndefined();
  });
  it('attributes reported subscription metadata without inventing a provider', () => {
    for (const [name, index] of [['Claude Max',0], ['ChatGPT Pro',1], ['GLM Coding Plan · Lite',2], ['Google AI Pro',3], ['AGY Ultra',3], ['Unknown plan',-1]] as const) {
      expect(usageSubscriptionProvider(name)).toBe(index);
    }
  });
  it('prints the plan tier beside the brand mark, never the provider twice', () => {
    // A live daemon reports Claude's subscription as the bare name "Claude".
    for (const [name, tier] of [['Claude Max','Max'], ['ChatGPT Pro','Pro'], ['GLM Coding Plan · Lite','Lite'], ['Google AI Ultra','Ultra'], ['Claude',''], ['Claude ',''], ['Unknown plan','Unknown plan']] as const) {
      expect(usageSubscriptionTier(name)).toBe(tier);
    }
  });
  it('generates the firmware predicate and provider table from the actual source', () => {
    for (const [target, emit] of outputs) expect(readFileSync(new URL(`../../../${target}`, import.meta.url), 'utf8')).toBe(emit(USAGE_PRESENTATION, usageLunaActive.toString(), USAGE_TIER_SEPARATORS, usageCreditsActive.toString(), CREDIT_BALANCE_UNITS));
  });
  describe('Codex credits after an exhausted plan window', () => {
    const vectors = JSON.parse(readFileSync(new URL('../../credit-balance-vectors.json', import.meta.url), 'utf8'));
    const num = (v: number | string) => (v === 'inf' ? Infinity : (v as number));
    it('formats the balance from the shared vectors', () => {
      for (const [balance, text] of vectors.format) expect(formatCreditBalance(num(balance))).toBe(text);
    });
    it('gates on an exhausted window and a positive balance', () => {
      for (const [p, s, b, active] of vectors.active) expect(usageCreditsActive(p, s, num(b))).toBe(active);
    });
    it('reads the wire balance, treating hasCredits:false as zero', () => {
      expect(codexCreditBalance(undefined)).toBe(-1);
      expect(codexCreditBalance({ hasCredits: true, unlimited: false, balance: '62500' })).toBe(62500);
      expect(codexCreditBalance({ hasCredits: false, unlimited: false, balance: '0' })).toBe(0);
      expect(codexCreditBalance({ hasCredits: true, unlimited: true })).toBe(Infinity);
      expect(codexCreditBalance({ hasCredits: true, unlimited: false, balance: 'n/a' })).toBe(-1);
      // Padding is trimmed the same way on every mirror; a blank balance is unknown, not zero.
      expect(codexCreditBalance({ hasCredits: true, unlimited: false, balance: ' 62500 ' })).toBe(62500);
      expect(codexCreditBalance({ hasCredits: true, unlimited: false, balance: '  ' })).toBe(-1);
    });
    it('shows credits only while a live window is exhausted and a balance remains', () => {
      const now = Date.parse('2026-10-01T00:00:00Z');
      const credits = { hasCredits: true, unlimited: false, balance: '62500' };
      const weekly = (usedPercent: number, extra = {}) => ({ usedPercent, windowMinutes: 10080, resetsAt: '2026-10-03T00:00:00Z', ...extra });
      // The measured Pro shape: weekly at 94% with 62,500 purchased credits.
      expect(selectedCodexCredits({ primary: weekly(94), credits }, now)).toBeUndefined();
      expect(selectedCodexCredits({ primary: weekly(100), credits }, now)).toEqual({ balance: 62500, regularResetsAt: '2026-10-03T00:00:00Z' });
      // Exhausted but nothing to spend: hidden, never "0".
      expect(selectedCodexCredits({ primary: weekly(100), credits: { hasCredits: false, unlimited: false, balance: '0' } }, now)).toBeUndefined();
      // An ended or stale window is unknown, not exhausted.
      expect(selectedCodexCredits({ primary: weekly(100, { stale: true }), credits }, now)).toBeUndefined();
      expect(selectedCodexCredits({ primary: weekly(100, { resetsAt: '2026-09-30T00:00:00Z' }), credits }, now)).toBeUndefined();
      // Credit-only plans (no windows) keep their own readout, not this one.
      expect(selectedCodexCredits({ credits }, now)).toBeUndefined();
    });
    it('reports the latest exhausted reset as the end of credit spending', () => {
      const now = Date.parse('2026-10-01T00:00:00Z');
      const out = selectedCodexCredits({
        primary: { usedPercent: 100, windowMinutes: 300, resetsAt: '2026-10-01T03:00:00Z' },
        secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-10-05T00:00:00Z' },
        credits: { hasCredits: true, unlimited: false, balance: '12' },
      }, now);
      expect(out?.regularResetsAt).toBe('2026-10-05T00:00:00Z');
    });
    it('ignores an unparseable reset instead of letting it win the sort', () => {
      const now = Date.parse('2026-10-01T00:00:00Z');
      const out = selectedCodexCredits({
        primary: { usedPercent: 100, windowMinutes: 300, resetsAt: 'garbage' },
        secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-10-05T00:00:00Z' },
        credits: { hasCredits: true, unlimited: false, balance: '12' },
      }, now);
      expect(out?.regularResetsAt).toBe('2026-10-05T00:00:00Z');
    });
  });
});

