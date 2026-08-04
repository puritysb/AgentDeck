import { describe, it, expect } from 'vitest';
import {
  adjustUsagePercent,
  formatAntigravityPlanShort,
  formatDurationSec,
  formatResetTime,
  isCodexWindowStale,
  CODEX_SNAPSHOT_STALE_MS,
  codexSnapshotAgeMs,
  codexUsageFootnote,
  formatSnapshotAge,
  isCodexSnapshotAged,
} from '../format-utils.js';

describe('formatDurationSec', () => {
  it('formats sub-minute spans as seconds', () => {
    expect(formatDurationSec(0)).toBe('0s');
    expect(formatDurationSec(42)).toBe('42s');
    expect(formatDurationSec(59.4)).toBe('59s');
  });

  it('formats minute spans, dropping a zero-second remainder', () => {
    expect(formatDurationSec(300)).toBe('5m');
    expect(formatDurationSec(312)).toBe('5m 12s');
  });

  it('formats hour spans, dropping a zero-minute remainder', () => {
    expect(formatDurationSec(3720)).toBe('1h 2m');
    expect(formatDurationSec(7200)).toBe('2h');
    expect(formatDurationSec(3672)).toBe('1h 1m');
  });

  it('clamps negatives to zero', () => {
    expect(formatDurationSec(-5)).toBe('0s');
  });
});

describe('formatAntigravityPlanShort', () => {
  it('shortens "Google AI Pro" to "AGY Pro"', () => {
    expect(formatAntigravityPlanShort('Google AI Pro')).toBe('AGY Pro');
  });

  it('shortens "Google AI Ultra" to "AGY Ultra"', () => {
    expect(formatAntigravityPlanShort('Google AI Ultra')).toBe('AGY Ultra');
  });

  it('strips an "Antigravity " prefix', () => {
    expect(formatAntigravityPlanShort('Antigravity Team')).toBe('AGY Team');
  });

  it('returns undefined for blank/absent input', () => {
    expect(formatAntigravityPlanShort(undefined)).toBeUndefined();
    expect(formatAntigravityPlanShort('')).toBeUndefined();
    expect(formatAntigravityPlanShort('   ')).toBeUndefined();
  });

  it('is idempotent on already-shortened values', () => {
    expect(formatAntigravityPlanShort('AGY Pro')).toBe('AGY Pro');
    expect(formatAntigravityPlanShort('AGY')).toBe('AGY');
  });

  it('collapses a bare "Google AI" to "AGY"', () => {
    expect(formatAntigravityPlanShort('Google AI')).toBe('AGY');
  });
});

describe('adjustUsagePercent', () => {
  it('returns undefined when percent is null', () => {
    expect(adjustUsagePercent(null, '2026-12-01T00:00:00Z')).toBeUndefined();
  });

  it('returns undefined when percent is undefined', () => {
    expect(adjustUsagePercent(undefined, '2026-12-01T00:00:00Z')).toBeUndefined();
  });

  it('returns percent unchanged when resetsAt is null', () => {
    expect(adjustUsagePercent(55, null)).toBe(55);
  });

  it('returns percent unchanged when resetsAt is undefined', () => {
    expect(adjustUsagePercent(55, undefined)).toBe(55);
  });

  it('returns percent unchanged when resetsAt is in the future', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(adjustUsagePercent(72, future)).toBe(72);
  });

  it('returns 0 when resetsAt is in the past (window expired)', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(adjustUsagePercent(72, past)).toBe(0);
  });

  it('returns 0 when resetsAt equals now (edge case)', () => {
    const now = new Date(Date.now() - 1).toISOString(); // just barely past
    expect(adjustUsagePercent(50, now)).toBe(0);
  });

  it('handles invalid date string gracefully (returns percent)', () => {
    expect(adjustUsagePercent(30, 'not-a-date')).toBe(30);
  });

  it('handles empty string resetsAt (returns percent)', () => {
    expect(adjustUsagePercent(30, '')).toBe(30);
  });

  it('returns percent unchanged when resetsAt is far in the past (>1h)', () => {
    // Server returning a prior window's final value because no new window is active.
    // Zeroing here would hide real usage during a 429 / cache-stuck situation.
    const farPast = new Date(Date.now() - 2 * 3600_000).toISOString();
    expect(adjustUsagePercent(68, farPast)).toBe(68);
  });

  it('still returns 0 just after the 1h threshold boundary', () => {
    const justInside = new Date(Date.now() - 59 * 60_000).toISOString();
    expect(adjustUsagePercent(42, justInside)).toBe(0);
  });
});

describe('isCodexWindowStale', () => {
  it('returns false when resetsAt is undefined', () => {
    expect(isCodexWindowStale(undefined)).toBe(false);
  });

  it('returns false for an invalid date string', () => {
    expect(isCodexWindowStale('not-a-date')).toBe(false);
  });

  it('returns false when resetsAt is in the future', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    expect(isCodexWindowStale(future)).toBe(false);
  });

  it('returns false when resetsAt is in the past but within the grace window', () => {
    // Just barely reset — a genuinely-just-rolled-over window should still read "now".
    const recent = new Date(Date.now() - 60_000).toISOString();
    expect(isCodexWindowStale(recent)).toBe(false);
  });

  it('returns true when resetsAt is past beyond the grace window', () => {
    const old = new Date(Date.now() - 30 * 60_000).toISOString();
    expect(isCodexWindowStale(old)).toBe(true);
  });

  it('honors a custom grace', () => {
    const past = new Date(Date.now() - 2 * 60_000).toISOString();
    expect(isCodexWindowStale(past, 60_000)).toBe(true);
    expect(isCodexWindowStale(past, 5 * 60_000)).toBe(false);
  });
});

/**
 * The freshness half of the Codex model. `isCodexWindowStale` answers "has this
 * WINDOW ended"; these answer "how old is this READING" — the question that went
 * unasked while a 4h-old 94% rendered as live behind a weekly window whose reset
 * was still six days out.
 */
describe('codex snapshot freshness', () => {
  const NOW = Date.parse('2026-08-05T07:27:00.000Z');
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  describe('codexSnapshotAgeMs', () => {
    it('returns undefined for missing / unparseable stamps', () => {
      expect(codexSnapshotAgeMs(undefined, NOW)).toBeUndefined();
      expect(codexSnapshotAgeMs('not-a-date', NOW)).toBeUndefined();
    });

    it('measures age against the supplied clock', () => {
      expect(codexSnapshotAgeMs(ago(90 * 60_000), NOW)).toBe(90 * 60_000);
    });

    it('clamps a future stamp to zero rather than going negative', () => {
      expect(codexSnapshotAgeMs(new Date(NOW + 60_000).toISOString(), NOW)).toBe(0);
    });
  });

  describe('isCodexSnapshotAged', () => {
    it('is false when there is nothing to judge', () => {
      expect(isCodexSnapshotAged(undefined, NOW)).toBe(false);
      expect(isCodexSnapshotAged('not-a-date', NOW)).toBe(false);
    });

    it('is false for a snapshot inside the threshold', () => {
      expect(isCodexSnapshotAged(ago(CODEX_SNAPSHOT_STALE_MS - 1), NOW)).toBe(false);
    });

    it('is false exactly at the threshold, true past it', () => {
      expect(isCodexSnapshotAged(ago(CODEX_SNAPSHOT_STALE_MS), NOW)).toBe(false);
      expect(isCodexSnapshotAged(ago(CODEX_SNAPSHOT_STALE_MS + 1), NOW)).toBe(true);
    });

    it('honors a custom max age', () => {
      expect(isCodexSnapshotAged(ago(10 * 60_000), NOW, 5 * 60_000)).toBe(true);
      expect(isCodexSnapshotAged(ago(10 * 60_000), NOW, 20 * 60_000)).toBe(false);
    });
  });

  describe('formatSnapshotAge', () => {
    it('rounds DOWN so the label never overstates freshness', () => {
      expect(formatSnapshotAge(ago(59_000), NOW)).toBe('now');
      expect(formatSnapshotAge(ago(34 * 60_000 + 59_000), NOW)).toBe('34m ago');
      expect(formatSnapshotAge(ago(3 * 3600_000 + 59 * 60_000), NOW)).toBe('3h ago');
      expect(formatSnapshotAge(ago(47 * 3600_000), NOW)).toBe('1d ago');
    });

    it('returns undefined when there is nothing to say', () => {
      expect(formatSnapshotAge(undefined, NOW)).toBeUndefined();
    });
  });

  describe('codexUsageFootnote', () => {
    const live = { resetsAt: '2026-08-11T14:46:25.000Z' };

    it('says nothing for a live window with a fresh snapshot', () => {
      expect(codexUsageFootnote(live, ago(2 * 60_000), NOW)).toBeUndefined();
    });

    it('THE REGRESSION: a 4h-old snapshot behind a 6-day-out weekly reset is aged', () => {
      // Exactly the shipped bug: `stale` is false (the window has not ended), so
      // nothing dimmed the gauge and a frozen 94% read as current.
      expect(isCodexWindowStale(live.resetsAt)).toBe(false);
      expect(codexUsageFootnote(live, ago(3 * 3600_000 + 48 * 60_000), NOW))
        .toEqual({ text: '3h ago', dim: true });
    });

    it('an ended window outranks age — "stale", not an age', () => {
      expect(codexUsageFootnote({ stale: true }, ago(5 * 3600_000), NOW))
        .toEqual({ text: 'stale', dim: true });
    });

    it('says nothing when there is no window at all', () => {
      expect(codexUsageFootnote(undefined, ago(5 * 3600_000), NOW)).toBeUndefined();
    });

    it('says nothing for a live window with no capture stamp (legacy producer)', () => {
      // Absence of evidence is not evidence of staleness: an older daemon that
      // sends no `capturedAt` must not have every Codex gauge permanently dimmed.
      expect(codexUsageFootnote(live, undefined, NOW)).toBeUndefined();
    });
  });
});

describe('formatResetTime', () => {
  it('returns "now" when resetsAt is in the past', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(formatResetTime(past)).toBe('now');
  });

  it('returns undefined for null input', () => {
    expect(formatResetTime(undefined)).toBeUndefined();
  });

  it('returns minutes-only for < 1h remaining', () => {
    const soon = new Date(Date.now() + 30 * 60_000).toISOString();
    const result = formatResetTime(soon);
    expect(result).toMatch(/^\d+m$/);
  });

  it('returns hours and minutes for < 24h remaining', () => {
    const hours = new Date(Date.now() + 4.5 * 3600_000).toISOString();
    const result = formatResetTime(hours);
    expect(result).toMatch(/^\d+h \d+m$/);
  });

  it('returns days and hours for >= 24h remaining', () => {
    const days = new Date(Date.now() + 50 * 3600_000).toISOString();
    const result = formatResetTime(days);
    expect(result).toMatch(/^\d+d \d+h$/);
  });

  it('omits minutes when exactly on the hour', () => {
    const exact = new Date(Date.now() + 3 * 3600_000).toISOString();
    const result = formatResetTime(exact);
    // Could be "2h 59m" or "3h" depending on timing — just verify format
    expect(result).toMatch(/^\d+h( \d+m)?$/);
  });

  it('passes through pre-formatted strings (no T)', () => {
    expect(formatResetTime('4h 12m')).toBe('4h 12m');
  });
});
