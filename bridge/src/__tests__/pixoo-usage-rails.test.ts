// Locks the space the usage readout is allowed to take on the two smallest
// panels, which is where a provider that reports nothing is most expensive:
//
//  - iDotMatrix (32×32, `renderCompact32Frame`): one-pixel telemetry rails. Each
//    rail is 3% of the entire display, so a reserved-but-empty row was a dead
//    black stripe. Present rails only, anchored to the bottom edge.
//  - Pixoo64 (`drawUsageHUD`): a seven-row band per provider. A provider with no
//    windows claims no band, and with none at all the tank keeps the full height.
//
// The case that motivated both: a lapsed ChatGPT subscription. The account tier
// reaches the wire as a windowless `codexRateLimits` (it has to — clients merge
// retain-on-absent, so the block is the only way to RETRACT a retired plan's
// gauge), and neither renderer may read that as "draw a Codex row".
import { describe, expect, it } from 'vitest';
import { renderFrame } from '../pixoo/pixoo-renderer.js';
import type { UsageEvent } from '../types.js';

const usage = (over: Partial<UsageEvent> = {}): UsageEvent => ({
  type: 'usage_update',
  sessionDurationSec: 0,
  inputTokens: 0,
  outputTokens: 0,
  toolCalls: 0,
  ...over,
} as UsageEvent);

/** Rows (0-31) of a 32×32 frame that carry the rails' dark backing plate. */
function railRows(buf: Uint8Array): number[] {
  const rows: number[] = [];
  for (let y = 0; y < 32; y++) {
    // The backing plate is painted across the full width; sample a column the
    // gauge fill never reaches (x=2 sits between the 2px source key and the
    // 29px track) so a 100%-used rail is still detected as a rail.
    const i = (y * 32 + 2) * 3;
    if (buf[i] === 5 && buf[i + 1] === 8 && buf[i + 2] === 14) rows.push(y);
  }
  return rows;
}

const compact32 = (u: UsageEvent | null) => renderFrame(null, u, [], 1_000, 32);

describe('iDotMatrix 32×32 telemetry rails', () => {
  it('draws GLM credits independently and retracts stale or removed windows', () => {
    expect(railRows(compact32(usage({ zaiRateLimits: { primary: { usedPercent: 36, windowMinutes: 300 } } })))).toEqual([31]);
    expect(railRows(compact32(usage({ zaiRateLimits: { primary: { usedPercent: 36, windowMinutes: 300, stale: true } } })))).toEqual([]);
    expect(railRows(compact32(usage({ zaiRateLimits: {} })))).toEqual([]);
  });

  it('spends no row on a provider that reports nothing', () => {
    // Claude-only: two rails, not four with two dead stripes.
    expect(railRows(compact32(usage({ fiveHourPercent: 42, sevenDayPercent: 17 })))).toEqual([30, 31]);
  });

  it('reads a windowless free-tier Codex block as no Codex rows', () => {
    const frame = compact32(usage({
      fiveHourPercent: 42,
      sevenDayPercent: 17,
      codexRateLimits: { planType: 'free' },
    }));
    expect(railRows(frame)).toEqual([30, 31]);
  });

  it('still fills all four rows when both providers report both windows', () => {
    const frame = compact32(usage({
      fiveHourPercent: 42,
      sevenDayPercent: 17,
      codexRateLimits: {
        primary: { usedPercent: 30, windowMinutes: 300 },
        secondary: { usedPercent: 12, windowMinutes: 10080 },
      },
    }));
    expect(railRows(frame)).toEqual([28, 29, 30, 31]);
  });

  it('gives the panel back entirely when no provider reports usage', () => {
    // The App-Store-daemon-only shape: no Claude quota path, free-tier Codex.
    expect(railRows(compact32(usage({ codexRateLimits: { planType: 'free' } })))).toEqual([]);
    expect(railRows(compact32(null))).toEqual([]);
  });

  it('keeps a stale (ended) Codex window off the rails, not on a blank row', () => {
    const frame = compact32(usage({
      fiveHourPercent: 42,
      sevenDayPercent: 17,
      codexRateLimits: { secondary: { usedPercent: 94, windowMinutes: 10080, stale: true } },
    }));
    expect(railRows(frame)).toEqual([30, 31]);
  });
});

const CLAUDE_BRAND: [number, number, number] = [255, 112, 76];
const CODEX_BRAND: [number, number, number] = [126, 116, 255];

/** Rows carrying a provider's identity dock — the official mark drawn at full
 *  brand intensity in the band's 9px left slot. Present iff that provider got a
 *  band, which is exactly the question these tests ask. (No sessions are passed,
 *  so no creature can put a brand pixel in the tank.) */
function bandRows(buf: Uint8Array, brand: [number, number, number]): number[] {
  const rows: number[] = [];
  for (let y = 0; y < 64; y++) {
    for (let x = 1; x < 8; x++) {
      const i = (y * 64 + x) * 3;
      if (buf[i] === brand[0] && buf[i + 1] === brand[1] && buf[i + 2] === brand[2]) {
        rows.push(y);
        break;
      }
    }
  }
  return rows;
}

describe('Pixoo64 usage HUD bands', () => {
  const pixoo = (u: UsageEvent | null) => renderFrame(null, u, [], 1_000, 64);

  it('shows all three providers simultaneously and reserves a band for a seven-day-only Claude sample', () => {
    const frame = pixoo(usage({ sevenDayPercent: 17,
      codexRateLimits: { secondary: { usedPercent: 30, windowMinutes: 10080 } },
      zaiRateLimits: { primary: { usedPercent: 36, windowMinutes: 300 } },
    }));
    const bands = [CLAUDE_BRAND, CODEX_BRAND, [31, 99, 236] as [number, number, number]].map(b => bandRows(frame, b));
    expect(bands.every(rows => rows.length > 0)).toBe(true);
    expect(Math.max(...bands[0])).toBeLessThan(Math.min(...bands[1]));
    expect(Math.max(...bands[1])).toBeLessThan(Math.min(...bands[2]));
    expect(Math.min(...bands[0])).toBeGreaterThanOrEqual(43);
  });

  it('drops the Codex band for a windowless free-tier block, and the lone Claude band slides down', () => {
    const both = pixoo(usage({
      fiveHourPercent: 42,
      sevenDayPercent: 17,
      codexRateLimits: { secondary: { usedPercent: 94, windowMinutes: 10080 } },
    }));
    expect(bandRows(both, CODEX_BRAND).length).toBeGreaterThan(0);

    const free = pixoo(usage({
      fiveHourPercent: 42,
      sevenDayPercent: 17,
      codexRateLimits: { planType: 'free' },
    }));
    expect(bandRows(free, CODEX_BRAND)).toEqual([]);
    // Two providers start at row 50; a lone one sits on 57-63, giving the tank
    // back the seven rows Codex was holding.
    expect(Math.min(...bandRows(both, CLAUDE_BRAND))).toBeLessThan(57);
    expect(Math.min(...bandRows(free, CLAUDE_BRAND))).toBeGreaterThanOrEqual(57);
  });

  it('draws no HUD at all when neither provider reports usage', () => {
    // The App-Store-daemon-only shape: no Claude quota path, free-tier Codex.
    const frame = pixoo(usage({ codexRateLimits: { planType: 'free' } }));
    expect(bandRows(frame, CLAUDE_BRAND)).toEqual([]);
    expect(bandRows(frame, CODEX_BRAND)).toEqual([]);
  });
});
