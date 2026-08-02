/**
 * Claude per-model scoped usage limits (issue #99).
 *
 * Pins the guardrails puritysb asked for: a dynamic API label is sanitized +
 * truncated for the compact surface; the `active` signal — not the percent —
 * decides whether a cap wears the critical (red) ramp or the calm informational
 * (cyan) one; the worst-sorted cap is selected but staleness suppresses it; and a
 * usage update that omits the key clears a prior scoped set (no phantom latch).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { type ScopedUsageLimit } from '@agentdeck/shared';
import {
  sanitizeScopedLabel,
  splitResetTwoLine,
  pickWorstScopedLimit,
  updateUsageModeData,
  getUsageModeData,
  type UsageModeData,
} from '../utility-modes/usage.js';
import {
  renderUsageLimitGauge,
  renderUsageEncoderTriple,
  INACTIVE_FILL,
  CRITICAL_FILL,
  type UsageEncoderScoped,
} from '../renderers/usage-gauge.js';

// Sourced from the renderer so the test carries no raw hex (design-lint R2).
const ALARM_RED = CRITICAL_FILL;
const INFO_CYAN = INACTIVE_FILL;

const active = (p: number, label = 'Fable'): UsageEncoderScoped =>
  ({ label, usedPercent: p, resetsAt: '2099-01-01T00:00:00Z', known: true, active: true });
const inactive = (p: number, label = 'Fable'): UsageEncoderScoped =>
  ({ label, usedPercent: p, resetsAt: '2099-01-01T00:00:00Z', known: true, active: false });

const scoped = (over: Partial<ScopedUsageLimit> = {}): ScopedUsageLimit => ({
  kind: 'weekly_scoped', label: 'Fable', percent: 98, severity: 'critical',
  resetsAt: '2099-01-01T00:00:00Z', active: true, ...over,
});

describe('sanitizeScopedLabel', () => {
  it('drops control chars / newlines and collapses whitespace', () => {
    expect(sanitizeScopedLabel('Fa\nb\tle')).toBe('Fa b le');
    expect(sanitizeScopedLabel('  Fable   Max  ')).toBe('Fable Max');
    expect(sanitizeScopedLabel('Opus\u0007\u0000')).toBe('Opus');
  });

  it('is null/undefined safe', () => {
    expect(sanitizeScopedLabel(undefined)).toBe('');
    expect(sanitizeScopedLabel(null)).toBe('');
    expect(sanitizeScopedLabel('')).toBe('');
  });
});

describe('splitResetTwoLine', () => {
  it('splits a two-unit countdown at the first boundary', () => {
    expect(splitResetTwoLine('1h45m')).toEqual(['1h', '45m']);
    expect(splitResetTwoLine('2d3h')).toEqual(['2d', '3h']);
  });
  it('leaves a single-unit string on one line', () => {
    expect(splitResetTwoLine('45m')).toEqual(['45m']);
    expect(splitResetTwoLine('now')).toEqual(['now']);
  });
});

describe('pickWorstScopedLimit', () => {
  it('returns the worst-sorted [0] (store keeps active-first, percent-desc)', () => {
    const data: UsageModeData = { scopedLimits: [scoped({ label: 'Fable', active: true, percent: 98 }), scoped({ label: 'Opus', active: false, percent: 40 })] };
    expect(pickWorstScopedLimit(data)?.label).toBe('Fable');
  });
  it('returns undefined when the snapshot is stale (a stale number reads as live)', () => {
    const data: UsageModeData = { usageStale: true, scopedLimits: [scoped()] };
    expect(pickWorstScopedLimit(data)).toBeUndefined();
  });
  it('returns undefined when there are no scoped limits', () => {
    expect(pickWorstScopedLimit({ scopedLimits: [] })).toBeUndefined();
    expect(pickWorstScopedLimit({})).toBeUndefined();
  });
});

describe('scoped gauge treatment — active vs inactive', () => {
  it('an ACTIVE cap at 98% wears the critical red ramp', () => {
    const svg = renderUsageLimitGauge(active(98));
    expect(svg).toContain(ALARM_RED);
    expect(svg).not.toContain(INFO_CYAN);
  });

  it('an INACTIVE cap at 98% wears the calm informational cyan, NOT red', () => {
    const svg = renderUsageLimitGauge(inactive(98));
    expect(svg).toContain(INFO_CYAN);
    expect(svg).not.toContain(ALARM_RED);
  });

  it('the triple view mutes an inactive worst-scoped panel (no red from a 99% inactive cap)', () => {
    const enc = {
      agent: 'claude' as const, title: 'CLAUDE',
      fiveHour: { label: '5H', usedPercent: 10, known: true },
      sevenDay: { label: '7D', usedPercent: 12, known: true },
    };
    const svg = renderUsageEncoderTriple(enc, inactive(99));
    expect(svg).toContain(INFO_CYAN);   // the scoped panel is cyan
    expect(svg).not.toContain(ALARM_RED); // 5h/7d are low, inactive scoped is muted → no red anywhere
  });

  it('renders the unknown tile when there is no scoped cap', () => {
    const svg = renderUsageLimitGauge(undefined);
    expect(svg).toContain('LIMIT');
    expect(svg).not.toContain(ALARM_RED);
    expect(svg).not.toContain(INFO_CYAN);
  });
});

describe('scoped label on the compact gauge', () => {
  it('sanitizes, uppercases and truncates the model label', () => {
    const svg = renderUsageLimitGauge(active(50, 'super\nlong-model-name'));
    // sanitize (newline→space) + uppercase + truncate to 8 code points
    expect(svg).toContain('SUPER LO');
    expect(svg).not.toContain('\n');
  });
});

describe('scoped store merge — omitted key clears', () => {
  beforeEach(() => {
    updateUsageModeData({ scopedLimits: undefined });
  });

  it('an update that omits scopedLimits clears a prior set (no phantom latch)', () => {
    updateUsageModeData({ scopedLimits: [scoped()] });
    expect(getUsageModeData().scopedLimits).toHaveLength(1);
    // plugin.ts always includes the key (possibly undefined) — the spread must overwrite.
    updateUsageModeData({ scopedLimits: undefined });
    expect(getUsageModeData().scopedLimits).toBeUndefined();
    expect(pickWorstScopedLimit(getUsageModeData())).toBeUndefined();
  });
});
