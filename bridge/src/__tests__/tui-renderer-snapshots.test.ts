/**
 * Snapshot tests for TUI gauge and renderer pure functions.
 * Tests blockGauge color thresholds, format functions, layout detection, and spinner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  blockGauge,
  resetTimeStr,
  formatUptime,
  formatTokens,
  activityDensityBar,
} from '../tui/gauge.js';
import {
  getLayout,
  shouldShowTerrarium,
  spinner,
} from '../tui/renderer.js';

let dateNowSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1700000060000);
});

afterEach(() => {
  dateNowSpy.mockRestore();
});

// ===================================================================
// gauge.ts
// ===================================================================

describe('blockGauge snapshots', () => {
  it('0% — all empty, green', () => {
    expect(blockGauge(0, 10)).toMatchSnapshot();
  });

  it('50% — half filled, green', () => {
    expect(blockGauge(50, 10)).toMatchSnapshot();
  });

  it('75% — yellow threshold', () => {
    expect(blockGauge(75, 10)).toMatchSnapshot();
  });

  it('95% — red threshold', () => {
    expect(blockGauge(95, 10)).toMatchSnapshot();
  });

  it('100% — all filled, red', () => {
    expect(blockGauge(100, 10)).toMatchSnapshot();
  });

  it('renders negative as unknown with an empty neutral gauge', () => {
    expect(blockGauge(-10, 6)).toMatchSnapshot();
  });

  it('clamps above 100', () => {
    expect(blockGauge(150, 6)).toMatchSnapshot();
  });
});

describe('resetTimeStr', () => {
  it('returns empty for undefined', () => {
    expect(resetTimeStr()).toBe('');
  });

  it('returns ↻now for past time', () => {
    // 1700000060000 = 2023-11-14T22:14:20Z, so use a date before that
    expect(resetTimeStr('2023-11-14T00:00:00Z')).toBe('↻now');
  });

  it('formats minutes', () => {
    // 30 minutes in the future from mocked now
    const future = new Date(1700000060000 + 30 * 60000).toISOString();
    expect(resetTimeStr(future)).toBe('↻30m');
  });

  it('formats hours and minutes', () => {
    const future = new Date(1700000060000 + 90 * 60000).toISOString();
    expect(resetTimeStr(future)).toBe('↻1h30m');
  });

  it('formats days and hours', () => {
    const future = new Date(1700000060000 + 26 * 3600000).toISOString();
    expect(resetTimeStr(future)).toBe('↻1d2h');
  });
});

describe('formatUptime', () => {
  it('seconds', () => {
    expect(formatUptime(45)).toBe('45s');
  });

  it('minutes', () => {
    expect(formatUptime(125)).toBe('2m');
  });

  it('hours and minutes', () => {
    expect(formatUptime(3700)).toBe('1h1m');
  });
});

describe('formatTokens', () => {
  it('below 1000 unchanged', () => {
    expect(formatTokens(500)).toBe('500');
  });

  it('1k-10k with decimal', () => {
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(9999)).toBe('10.0k');
  });

  it('10k+ rounded', () => {
    expect(formatTokens(12345)).toBe('12k');
    expect(formatTokens(99999)).toBe('100k');
  });
});

describe('activityDensityBar', () => {
  it('empty timestamps — all dim', () => {
    expect(activityDensityBar([], 10)).toMatchSnapshot();
  });

  it('recent burst — bright right side', () => {
    const now = 1700000060000;
    const timestamps = [now - 1000, now - 2000, now - 3000, now - 1500];
    expect(activityDensityBar(timestamps, 20, 60)).toMatchSnapshot();
  });

  it('spread timestamps — distributed density', () => {
    const now = 1700000060000;
    const timestamps = Array.from({ length: 20 }, (_, i) => now - i * 15000);
    expect(activityDensityBar(timestamps, 10)).toMatchSnapshot();
  });
});

// ===================================================================
// renderer.ts
// ===================================================================

describe('getLayout', () => {
  it('wide for 120+ cols', () => {
    expect(getLayout(120, 30)).toBe('wide');
    expect(getLayout(200, 50)).toBe('wide');
  });

  it('standard for 80-119 cols', () => {
    expect(getLayout(80, 25)).toBe('standard');
    expect(getLayout(119, 30)).toBe('standard');
  });

  it('narrow for <80 cols', () => {
    expect(getLayout(60, 20)).toBe('narrow');
    expect(getLayout(79, 15)).toBe('narrow');
  });
});

describe('shouldShowTerrarium', () => {
  it('true for adequate size', () => {
    expect(shouldShowTerrarium(80, 20)).toBe(true);
    expect(shouldShowTerrarium(60, 16)).toBe(true);
  });

  it('false for too narrow', () => {
    expect(shouldShowTerrarium(59, 20)).toBe(false);
  });

  it('false for too short', () => {
    expect(shouldShowTerrarium(80, 15)).toBe(false);
  });
});

describe('spinner', () => {
  it('returns braille characters at different frames', () => {
    const f0 = spinner(0);
    const f5 = spinner(5);
    const f10 = spinner(10);
    expect(f0).toHaveLength(1);
    expect(f5).toHaveLength(1);
    // frame 0 and frame 10 should cycle (10 frames / 2 = 5 frames per cycle)
    expect(f0).not.toBe(f5); // different positions in the cycle
  });

  it('spinner cycles through 10 frames', () => {
    const frames = new Set<string>();
    for (let i = 0; i < 20; i += 2) {
      frames.add(spinner(i));
    }
    expect(frames.size).toBe(10);
  });
});
