/**
 * Phase 2 SD+ usage-encoder data builders.
 *
 * The Claude (E2) and Codex (E3) encoders map the shared usage snapshot onto the
 * 200×100 dual-tank renderer. These tests pin the mapping: Claude rides the
 * top-level 5h/7d fields, Codex rides `codexRateLimits`, "waiting" vs "no data"
 * notes are distinct, and stale data suppresses the tanks.
 */
import { describe, it, expect } from 'vitest';
import { buildClaudeUsageEncoder, buildCodexUsageEncoder, availableUsageViews } from '../utility-modes/usage.js';
import { renderUsageEncoderBoth } from '../renderers/usage-gauge.js';

const CODEX_LIMITS = {
  primary: { usedPercent: 30, windowMinutes: 300, resetsAt: '2099-01-01T00:00:00Z' },
  secondary: { usedPercent: 12, windowMinutes: 10080, resetsAt: '2099-01-08T00:00:00Z' },
};

describe('buildClaudeUsageEncoder', () => {
  it('maps the top-level 5h/7d quota to two known tanks', () => {
    const enc = buildClaudeUsageEncoder({ fiveHourPercent: 30, sevenDayPercent: 12 }, true);
    expect(enc.agent).toBe('claude');
    expect(enc.title).toBe('CLAUDE');
    expect(enc.note).toBeUndefined();
    expect(enc.fiveHour).toMatchObject({ label: '5H', usedPercent: 30, known: true });
    expect(enc.sevenDay).toMatchObject({ label: '7D', usedPercent: 12, known: true });
  });

  it('shows "Waiting…" before the first payload', () => {
    const enc = buildClaudeUsageEncoder({}, false);
    expect(enc.note).toBe('Waiting…');
  });

  it('shows "No usage data" when data arrived but the quota is absent', () => {
    const enc = buildClaudeUsageEncoder({}, true);
    expect(enc.note).toBe('No usage data');
    expect(enc.fiveHour.known).toBe(false);
    expect(enc.sevenDay.known).toBe(false);
  });

  it('treats stale data as unknown (suppresses the tanks)', () => {
    const enc = buildClaudeUsageEncoder({ fiveHourPercent: 30, sevenDayPercent: 12, usageStale: true }, true);
    expect(enc.note).toBe('No usage data');
    expect(enc.fiveHour.known).toBe(false);
  });
});

describe('buildCodexUsageEncoder', () => {
  it('maps codexRateLimits primary→5h, secondary→7d', () => {
    const enc = buildCodexUsageEncoder({ codexRateLimits: CODEX_LIMITS }, true);
    expect(enc.agent).toBe('codex');
    expect(enc.title).toBe('CODEX');
    expect(enc.note).toBeUndefined();
    expect(enc.fiveHour).toMatchObject({ label: '5H', usedPercent: 30, known: true });
    expect(enc.sevenDay).toMatchObject({ label: '7D', usedPercent: 12, known: true });
  });

  it('falls back to a muted note when Codex reports no rate limits', () => {
    const enc = buildCodexUsageEncoder({ fiveHourPercent: 50 }, true);
    expect(enc.note).toBe('No Codex usage');
    expect(enc.fiveHour.known).toBe(false);
    expect(enc.sevenDay.known).toBe(false);
  });

  it('shows "Waiting…" before the first payload', () => {
    const enc = buildCodexUsageEncoder({}, false);
    expect(enc.note).toBe('Waiting…');
  });

  it('renders only the windows Codex actually reports (partial)', () => {
    const enc = buildCodexUsageEncoder({ codexRateLimits: { primary: CODEX_LIMITS.primary } }, true);
    expect(enc.note).toBeUndefined();
    expect(enc.fiveHour.known).toBe(true);
    expect(enc.sevenDay.known).toBe(false);
  });
});

/**
 * Single-window companion readout.
 *
 * Codex stopped reporting its 5h rolling window upstream on 2026-07-12 and has
 * reported the weekly cap alone since (verified across every rollout from
 * 2026-07-13 on), so the "one live window" shape is the steady state, not an
 * edge case. The freed half carries the SUBSCRIPTION behind the quota; the
 * window's own countdown stays inside the gauge, where E2 also prints it.
 */
describe('buildCodexUsageEncoder — single live window', () => {
  const WEEKLY_ONLY = { secondary: CODEX_LIMITS.secondary, planType: 'plus' };
  const CHATGPT_SUB = [{ name: 'ChatGPT Plus', until: '2026-08-05T06:21:49Z' }];

  it('shows the subscription tier and its next renewal', () => {
    const enc = buildCodexUsageEncoder({ codexRateLimits: WEEKLY_ONLY, subscriptions: CHATGPT_SUB }, true);
    expect(enc.fiveHour.known).toBe(false);
    expect(enc.sevenDay.known).toBe(true);
    expect(enc.sideCard).toMatchObject({ label: 'CHATGPT', value: 'PLUS' });
    expect(enc.sideCard?.sub).toMatch(/^Renews [A-Z][a-z]{2} \d{1,2}$/);
  });

  it('leaves the countdown to the gauge instead of restating it on the card', () => {
    const enc = buildCodexUsageEncoder({ codexRateLimits: WEEKLY_ONLY, subscriptions: CHATGPT_SUB }, true);
    // The gauge still carries resetsAt, so the card must not repeat that fact.
    expect(enc.sevenDay.resetsAt).toBe(CODEX_LIMITS.secondary.resetsAt);
    expect(enc.sideCard?.label).not.toBe('RESETS');
  });

  it('picks the ChatGPT subscription by name, never by position', () => {
    const enc = buildCodexUsageEncoder(
      { codexRateLimits: WEEKLY_ONLY, subscriptions: [{ name: 'Claude' }, ...CHATGPT_SUB] },
      true,
    );
    expect(enc.sideCard).toMatchObject({ label: 'CHATGPT', value: 'PLUS' });
  });

  it('drops the renewal line when the subscription has no boundary', () => {
    const enc = buildCodexUsageEncoder(
      { codexRateLimits: WEEKLY_ONLY, subscriptions: [{ name: 'ChatGPT Pro' }] },
      true,
    );
    expect(enc.sideCard).toMatchObject({ label: 'CHATGPT', value: 'PRO' });
    expect(enc.sideCard?.sub).toBeUndefined();
  });

  it('falls back to the bare plan tier when no subscription is reported', () => {
    const enc = buildCodexUsageEncoder({ codexRateLimits: WEEKLY_ONLY }, true);
    expect(enc.sideCard).toMatchObject({ label: 'PLAN', value: 'PLUS' });
  });

  it('falls back to the absolute reset instant when even the tier is unknown', () => {
    const enc = buildCodexUsageEncoder(
      { codexRateLimits: { secondary: CODEX_LIMITS.secondary } },
      true,
    );
    // Absolute, not relative — the gauge already prints the countdown. Local-time
    // formatting, so pin the SHAPE; a literal would pass only in one timezone.
    expect(enc.sideCard?.label).toBe('RESETS');
    expect(enc.sideCard?.value).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) \d{2}:\d{2}$/);
  });

  it('adds no card at all when the stale window leaves nothing knowable', () => {
    const enc = buildCodexUsageEncoder(
      { codexRateLimits: { secondary: { usedPercent: 23, windowMinutes: 10080, stale: true } } },
      true,
    );
    expect(enc.sideCard).toBeUndefined();
  });

  it('adds no side card while both windows are live', () => {
    const enc = buildCodexUsageEncoder(
      { codexRateLimits: { ...CODEX_LIMITS, planType: 'plus' }, subscriptions: CHATGPT_SUB },
      true,
    );
    expect(enc.sideCard).toBeUndefined();
  });
});

describe('renderUsageEncoderBoth — single live window', () => {
  it('keeps the lone weekly gauge in its canonical right column, side card on the left', () => {
    const enc = buildCodexUsageEncoder(
      {
        codexRateLimits: { secondary: CODEX_LIMITS.secondary, planType: 'plus' },
        subscriptions: [{ name: 'ChatGPT Plus', until: '2026-08-05T06:21:49Z' }],
      },
      true,
    );
    const svg = renderUsageEncoderBoth(enc);
    // 7D stays in the column E2 puts it in, so both encoders agree on where a
    // window lives. The gauge is identified by its clip (only encPanel clips).
    expect(svg).toContain('<clipPath id="enc-codex-both-solo"><rect x="102"');
    // Side card takes the freed 5H column; no dim "—" ghost panel survives.
    expect(svg).toContain('<rect x="4" y="18" width="94" height="80" rx="7"');
    expect(svg).toContain('CHATGPT');
    expect(svg).toContain('PLUS');
    expect(svg).not.toContain('>—<');
  });

  it('keeps the gauge printing its own countdown, like E2 does', () => {
    const svg = renderUsageEncoderBoth(
      buildCodexUsageEncoder(
        {
          codexRateLimits: { secondary: CODEX_LIMITS.secondary },
          subscriptions: [{ name: 'ChatGPT Plus' }],
        },
        true,
      ),
    );
    // formatResetTime output for a far-future window: "<n>d" or "<n>d<n>h".
    expect(svg).toMatch(/>\d+d(\d+h)?</);
  });

  it('keeps a lone 5h gauge in the left column instead', () => {
    const svg = renderUsageEncoderBoth(
      buildCodexUsageEncoder({ codexRateLimits: { primary: CODEX_LIMITS.primary } }, true),
    );
    expect(svg).toContain('<clipPath id="enc-codex-both-solo"><rect x="4"');
    expect(svg).toContain('<rect x="102" y="18" width="94" height="80" rx="7"');
  });

  it('renders the side card smaller than the gauge percentage', () => {
    const svg = renderUsageEncoderBoth(
      buildCodexUsageEncoder(
        {
          codexRateLimits: { secondary: CODEX_LIMITS.secondary },
          subscriptions: [{ name: 'ChatGPT Plus', until: '2026-08-05T06:21:49Z' }],
        },
        true,
      ),
    );
    // Gauge percentage stays the headline (26); the card is context (18). At
    // gauge weight the card's multi-character value out-read the gauge itself.
    expect(svg).toContain('font-size="26"');
    expect(svg).toContain('font-size="18"');
  });

  it('still renders two gauges when both windows are live', () => {
    const svg = renderUsageEncoderBoth(buildCodexUsageEncoder({ codexRateLimits: CODEX_LIMITS }, true));
    expect(svg).not.toContain('RESETS');
    expect(svg).toContain('5H');
    expect(svg).toContain('7D');
  });
});

describe('availableUsageViews', () => {
  it('drops the zoom stop for a window the provider no longer reports', () => {
    const weekly = buildCodexUsageEncoder({ codexRateLimits: { secondary: CODEX_LIMITS.secondary } }, true);
    expect(availableUsageViews(weekly)).toEqual(['both', '7d', 'session']);
  });

  it('keeps every stop while both windows are live', () => {
    const both = buildCodexUsageEncoder({ codexRateLimits: CODEX_LIMITS }, true);
    expect(availableUsageViews(both)).toEqual(['both', '5h', '7d', 'session']);
  });

  it('leaves only the gauge and session stops when no window exists', () => {
    expect(availableUsageViews(buildCodexUsageEncoder({}, true))).toEqual(['both', 'session']);
  });
});
