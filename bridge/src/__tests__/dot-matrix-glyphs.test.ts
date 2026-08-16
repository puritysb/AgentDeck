import { describe, expect, it } from 'vitest';
import {
  OFFICIAL_DOT_GLYPHS,
  OFFICIAL_DOT_GLYPH_SIZE,
  OFFICIAL_TIMEBOX_GLYPHS,
  OFFICIAL_TIMEBOX_GLYPH_SIZE,
  OFFICIAL_TC001_GLYPHS,
  OFFICIAL_TC001_GLYPH_SIZE,
} from '../pixoo/official-dot-glyphs.generated.js';
import { MICRO_SIZE, paintTimeboxBeacon, type MicroCreature } from '../pixoo/micro-glyphs.js';
import { renderFrame } from '../pixoo/pixoo-renderer.js';
import {
  PIXOO_PUSH_POLICY,
  pixooPushIntervalMs,
  resolvePixooPushMode,
} from '../pixoo/pixoo-bridge.js';

describe('canonical dot-matrix agent masks', () => {
  it('ships every official agent mark at Pixoo/iDotMatrix and TC001 resolutions', () => {
    expect(Object.keys(OFFICIAL_DOT_GLYPHS).sort()).toEqual([
      'antigravity', 'claudeCode', 'codex', 'kiro', 'openClaw', 'openCode',
    ]);
    for (const mask of Object.values(OFFICIAL_DOT_GLYPHS)) {
      expect(mask).toHaveLength(OFFICIAL_DOT_GLYPH_SIZE ** 2);
      expect(Math.max(...mask)).toBe(255);
    }
    for (const mask of Object.values(OFFICIAL_TIMEBOX_GLYPHS)) {
      expect(mask).toHaveLength(OFFICIAL_TIMEBOX_GLYPH_SIZE ** 2);
      expect(mask.some((alpha) => alpha > 0)).toBe(true);
    }
    for (const mask of Object.values(OFFICIAL_TC001_GLYPHS)) {
      expect(mask).toHaveLength(OFFICIAL_TC001_GLYPH_SIZE ** 2);
      expect(mask.some((alpha) => alpha > 0)).toBe(true);
    }
  });

  it('preserves the official negative-space features instead of filled approximations', () => {
    const px = (name: keyof typeof OFFICIAL_DOT_GLYPHS, x: number, y: number) =>
      OFFICIAL_DOT_GLYPHS[name][y * OFFICIAL_DOT_GLYPH_SIZE + x];

    // Claude Code: transparent eye inside a solid robot body.
    expect(px('claudeCode', 6, 9)).toBe(0);
    expect(px('claudeCode', 10, 9)).toBe(255);
    // OpenCode: hollow center inside the rectangular ring.
    expect(px('openCode', 12, 12)).toBe(0);
    expect(px('openCode', 12, 2)).toBe(255);
    // Codex: the > prompt cutout remains visibly lower-alpha than its body.
    expect(px('codex', 6, 9)).toBeLessThan(32);
    expect(px('codex', 10, 9)).toBe(255);
    // Antigravity: the lower arc remains open rather than becoming a triangle.
    expect(px('antigravity', 12, 22)).toBe(0);
    expect(px('antigravity', 1, 22)).toBeGreaterThan(200);
  });
});

describe('Timebox Mini Agent Beacon', () => {
  const creatures: MicroCreature[] = ['octopus', 'jellyfish', 'opencode', 'crayfish', 'antigravity', 'kiro'];
  const background = [2, 6, 10];
  const pixel = (frame: Uint8Array, x: number, y: number) =>
    [...frame.slice((y * MICRO_SIZE + x) * 3, (y * MICRO_SIZE + x) * 3 + 3)];

  it.each(creatures)('renders %s from a non-empty official 9×9 mask', (creature) => {
    const frame = new Uint8Array(MICRO_SIZE * MICRO_SIZE * 3);
    paintTimeboxBeacon(frame, creature, 'idle', 0);
    let changed = 0;
    for (let y = 1; y <= 9; y++) for (let x = 1; x <= 9; x++) {
      if (pixel(frame, x, y).some((v, i) => v !== background[i])) changed++;
    }
    expect(changed).toBeGreaterThan(8);
  });

  it('keeps OpenCode hollow and OpenClaw teal-eyed at physical resolution', () => {
    const openCode = new Uint8Array(MICRO_SIZE * MICRO_SIZE * 3);
    const openClaw = new Uint8Array(MICRO_SIZE * MICRO_SIZE * 3);
    paintTimeboxBeacon(openCode, 'opencode', 'idle', 0);
    paintTimeboxBeacon(openClaw, 'crayfish', 'idle', 0);
    expect(pixel(openCode, 5, 5)).toEqual(background);
    expect(pixel(openClaw, 4, 4)).toEqual([0, 211, 188]); // idle intensity 0.92
    expect(pixel(openClaw, 7, 4)).toEqual([0, 211, 188]);
  });

  it('keeps identity fixed and moves only the perimeter rail while processing', () => {
    const a = new Uint8Array(MICRO_SIZE * MICRO_SIZE * 3);
    const b = new Uint8Array(MICRO_SIZE * MICRO_SIZE * 3);
    paintTimeboxBeacon(a, 'jellyfish', 'processing', 0);
    paintTimeboxBeacon(b, 'jellyfish', 'processing', 12);
    for (let y = 1; y <= 9; y++) for (let x = 1; x <= 9; x++) {
      expect(pixel(a, x, y)).toEqual(pixel(b, x, y));
    }
    const borderChanged = Array.from({ length: MICRO_SIZE }, (_, x) => x)
      .some((x) => pixel(a, x, 0).join() !== pixel(b, x, 0).join());
    expect(borderChanged).toBe(true);
  });

  it('renders a device-native standby tide when no agent exists', () => {
    const frame = new Uint8Array(MICRO_SIZE * MICRO_SIZE * 3);
    paintTimeboxBeacon(frame, null, 'idle', 0);
    expect(pixel(frame, 5, 6)).not.toEqual(background);
  });

  it('uses a continuous dim status frame instead of isolated floating pixels', () => {
    const frame = new Uint8Array(MICRO_SIZE * MICRO_SIZE * 3);
    paintTimeboxBeacon(frame, 'octopus', 'idle', 0);
    expect(pixel(frame, 5, 0)).not.toEqual(background);
    expect(pixel(frame, 0, 5)).not.toEqual(background);
  });
});

describe('iDotMatrix native 32×32 stage', () => {
  it('keeps a vivid official mark and four source-keyed telemetry rails', () => {
    const frame = renderFrame(
      { type: 'state_update', state: 'idle', permissionMode: 'default', agentType: 'opencode' } as any,
      {
        type: 'usage_update', sessionDurationSec: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
        fiveHourPercent: 25, sevenDayPercent: 40,
        codexRateLimits: {
          primary: { usedPercent: 50, windowMinutes: 300 },
          secondary: { usedPercent: 75, windowMinutes: 10080 },
        },
      },
      [{ id: 'oc', port: 9120, alive: true, agentType: 'opencode', state: 'idle' }],
      0, 32,
    );
    expect(frame).toHaveLength(32 * 32 * 3);
    const pixel32 = (x: number, y: number) => [...frame.slice((y * 32 + x) * 3, (y * 32 + x) * 3 + 3)];
    expect(Math.max(...frame.slice(0, 28 * 32 * 3))).toBeGreaterThan(240);
    expect(pixel32(0, 30)).toEqual([185, 86, 255]);
    expect(pixel32(3, 30)).toEqual([185, 86, 255]);
    expect(pixel32(3, 31)).toEqual([255, 183, 38]);
  });
});

describe('Pixoo64 provider usage HUD', () => {
  it('renders Claude and Codex as matching percentage-plus-reset bands', () => {
    const primaryReset = new Date(Date.now() + 90 * 60_000).toISOString();
    const secondaryReset = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
    const frame = renderFrame(
      { type: 'state_update', state: 'idle', permissionMode: 'default', agentType: 'claude-code' } as any,
      {
        type: 'usage_update', sessionDurationSec: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
        fiveHourPercent: 25, fiveHourResetsAt: primaryReset,
        sevenDayPercent: 40, sevenDayResetsAt: secondaryReset,
        codexRateLimits: {
          primary: { usedPercent: 50, windowMinutes: 300, resetsAt: primaryReset },
          secondary: { usedPercent: 75, windowMinutes: 10080, resetsAt: secondaryReset },
        },
      },
      [{ id: 'cc', port: 9120, alive: true, agentType: 'claude-code', state: 'idle' }],
      0, 64,
    );
    const pixel64 = (x: number, y: number) => [...frame.slice((y * 64 + x) * 3, (y * 64 + x) * 3 + 3)];
    const markerPixels = (top: number, brand: number[]) => Array.from({ length: 7 * 9 }, (_, index) => {
      const y = top + Math.floor(index / 9);
      return pixel64(index % 9, y).join() === brand.join();
    }).filter(Boolean).length;
    expect(markerPixels(50, [255, 112, 76])).toBeGreaterThan(3);
    expect(markerPixels(57, [126, 116, 255])).toBeGreaterThan(3);
    const markerBounds = (top: number, brand: number[]) => {
      const points: Array<{ x: number; y: number }> = [];
      for (let y = top; y < top + 7; y++) for (let x = 0; x < 9; x++) {
        if (pixel64(x, y).join() === brand.join()) points.push({ x, y });
      }
      return {
        minX: Math.min(...points.map((point) => point.x)),
        maxX: Math.max(...points.map((point) => point.x)),
        minY: Math.min(...points.map((point) => point.y)),
        maxY: Math.max(...points.map((point) => point.y)),
      };
    };
    const claudeBounds = markerBounds(50, [255, 112, 76]);
    expect(claudeBounds.minX).toBe(1);
    expect(claudeBounds.maxX).toBe(7);
    expect(claudeBounds.maxY - claudeBounds.minY + 1).toBeLessThan(7);
    const codexBounds = markerBounds(57, [126, 116, 255]);
    expect(codexBounds.minX).toBe(1);
    expect(codexBounds.maxX).toBe(7);
    // TC001-style usage fill occupies the full band height, not only y=56.
    expect(pixel64(10, 50)).not.toEqual(pixel64(35, 50));
    expect(pixel64(10, 56)).not.toEqual(pixel64(35, 56));
    const resetColor = [0x60, 0x70, 0x80].join();
    const resetPixels = (top: number) => Array.from({ length: 7 * 64 }, (_, index) => {
      const y = top + Math.floor(index / 64);
      return pixel64(index % 64, y).join();
    }).filter((value) => value === resetColor).length;
    expect(resetPixels(50)).toBeGreaterThan(0);
    expect(resetPixels(57)).toBeGreaterThan(0);
  });

  it('uses the empty Codex primary zone for the subscription date', () => {
    const frame = renderFrame(
      { type: 'state_update', state: 'idle', permissionMode: 'default', agentType: 'codex-cli' } as any,
      {
        type: 'usage_update', sessionDurationSec: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
        codexSubscriptionActiveUntil: '2099-12-31T00:00:00Z',
        codexRateLimits: {
          secondary: { usedPercent: 50, windowMinutes: 10080 },
        },
      },
      [{ id: 'cx', port: 9120, alive: true, agentType: 'codex-cli', state: 'idle' }],
      0, 64,
    );
    const pixel64 = (x: number, y: number) => [...frame.slice((y * 64 + x) * 3, (y * 64 + x) * 3 + 3)];
    const timeColor = [0x60, 0x70, 0x80].join();
    const datePixels = Array.from({ length: 7 }, (_, row) => row + 57)
      .flatMap((y) => Array.from({ length: 27 }, (_, x) => pixel64(x + 9, y)))
      .filter((pixel) => pixel.join() === timeColor).length;
    expect(datePixels).toBeGreaterThan(0);
    // The 7D fill remains isolated to the right half beside that date.
    expect(pixel64(38, 57)).not.toEqual(pixel64(63, 57));
  });
});

describe('Pixoo adaptive push policy', () => {
  it('separates state latency from stable animation cadence', () => {
    expect(pixooPushIntervalMs(true, 'single-frame')).toBe(PIXOO_PUSH_POLICY.stateChangeFloorMs);
    expect(pixooPushIntervalMs(false, 'single-frame')).toBe(PIXOO_PUSH_POLICY.activeFrameRefreshMs);
    expect(pixooPushIntervalMs(false, 'idle')).toBe(PIXOO_PUSH_POLICY.idleRefreshMs);
  });

  it('uses safe moving single frames for active Pixoo states', () => {
    expect(resolvePixooPushMode(true)).toBe('single-frame');
    expect(pixooPushIntervalMs(false, 'single-frame')).toBe(PIXOO_PUSH_POLICY.activeFrameRefreshMs);
    expect(resolvePixooPushMode(false)).toBe('idle');
  });

  it('keeps the safe active cadence at 2.5 seconds', () => {
    expect(PIXOO_PUSH_POLICY.activeFrameRefreshMs).toBe(2_500);
  });
});
