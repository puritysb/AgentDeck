/**
 * A late timer is not a sleep.
 *
 * Measured 2026-09-10 on the maintainer's desk: load average 13–17,
 * `pmset -g log` with zero sleep events all day, and the daemon logging
 * `System wake detected — recovering devices` 123 times, every one to four
 * minutes. The detector compared consecutive 5 s ticks and read any gap over
 * 15 s as a wake — which is exactly what a starved event loop produces. Each
 * false wake ran the full device-recovery storm, which starved the next tick,
 * and left `/health` unanswered long enough for the macOS app to promote
 * itself and stand down again, three times in five minutes.
 *
 * The clocks disagree only across a real suspend: the wall clock jumps, the
 * monotonic clock (CLOCK_MONOTONIC on Darwin/Linux) does not. Under load both
 * advance together. The verdict is therefore the DRIFT, never the gap.
 */
import { describe, it, expect } from 'vitest';
import { classifyClockTick, WAKE_GAP_MS, WAKE_TICK_MS, monotonicNowMs } from '../bridge-core.js';

describe('classifyClockTick', () => {
  it('reads a late tick where both clocks advanced together as lag, not a wake', () => {
    // The 2026-09-10 shape: a 5 s tick landing 30 s late under load.
    expect(classifyClockTick({ wallDeltaMs: 30_000, monoDeltaMs: 30_000, platform: 'darwin' })).toBe('lag');
    expect(classifyClockTick({ wallDeltaMs: 30_000, monoDeltaMs: 29_500, platform: 'linux' })).toBe('lag');
  });

  it('reads a wall-clock jump the monotonic clock did not follow as a wake', () => {
    // A real suspend: wall +10 min, monotonic +5 s (the tick itself).
    expect(classifyClockTick({ wallDeltaMs: 600_000, monoDeltaMs: 5_000, platform: 'darwin' })).toBe('wake');
    expect(classifyClockTick({ wallDeltaMs: 600_000, monoDeltaMs: 5_000, platform: 'linux' })).toBe('wake');
  });

  it('is on schedule below the gap on either clock', () => {
    expect(classifyClockTick({ wallDeltaMs: WAKE_TICK_MS, monoDeltaMs: WAKE_TICK_MS, platform: 'darwin' })).toBe('normal');
    expect(classifyClockTick({ wallDeltaMs: WAKE_GAP_MS, monoDeltaMs: WAKE_GAP_MS, platform: 'darwin' })).toBe('normal');
  });

  it('keeps the gap rule on win32, whose monotonic clock counts through sleep', () => {
    // Documented as the weaker instrument: a late tick there is still a wake,
    // because the drift signal does not exist on that platform.
    expect(classifyClockTick({ wallDeltaMs: 30_000, monoDeltaMs: 30_000, platform: 'win32' })).toBe('wake');
  });

  it('monotonicNowMs is monotonic and in milliseconds', () => {
    const a = monotonicNowMs();
    const b = monotonicNowMs();
    expect(b).toBeGreaterThanOrEqual(a);
    expect(Math.abs(b - Date.now())).toBeGreaterThan(1_000_000); // not the wall clock in disguise
  });
});
