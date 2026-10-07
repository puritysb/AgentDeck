// Pixoo64 "Tide" scene: a deterministic, closed 6-frame loop drawn for the
// panel, the marks it shows, and the upload policy that keeps the device's
// loading hourglass away (upload on visible change; otherwise verify, never
// re-upload).
import { describe, expect, it } from 'vitest';
import {
  TIDE_LOOP, TIDE_POLICY, renderTideFrame, renderTideLoop, resolveTideMarks, tideDecision, tideSignature,
} from '../pixoo/pixoo-tide.js';
import { PIXOO_MAX_ANIMATION_FRAMES } from '../pixoo/pixoo-client.js';
import {
  pixooTideEnabled,
  resolvePixooPushMode,
} from '../pixoo/pixoo-bridge.js';
import type { StateUpdateEvent, UsageEvent } from '../types.js';
import type { SessionInfo } from '@agentdeck/shared/protocol';

const state = (s: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'state_update', state: s, ...extra }) as unknown as StateUpdateEvent;
const session = (id: string, agentType: string, s: string, extra: Partial<SessionInfo> = {}) =>
  ({ id, agentType, state: s, alive: true, projectName: id, port: 9121, ...extra }) as unknown as SessionInfo;
const usage = (five: number, seven: number) => ({
  type: 'usage_update', fiveHourPercent: five, sevenDayPercent: seven,
  fiveHourResetsAt: '2030-01-01T02:00:00.000Z', sevenDayResetsAt: '2030-01-04T00:00:00.000Z',
}) as unknown as UsageEvent;

/** Number of differing bytes between two frames. */
function diff(a: Uint8Array, b: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

const NOW = Date.UTC(2030, 0, 1);

describe('tide loop', () => {
  it('fits one device upload', () => {
    expect(TIDE_LOOP.frames).toBeLessThanOrEqual(PIXOO_MAX_ANIMATION_FRAMES);
    expect(renderTideLoop(null, null, [], NOW)).toHaveLength(TIDE_LOOP.frames);
  });

  it('is deterministic (a renderer output is identity)', () => {
    const sessions = [session('a', 'claude-code', 'processing'), session('b', 'codex-cli', 'awaiting_option')];
    const a = renderTideFrame(state('processing'), usage(40, 10), sessions, NOW, 5);
    const b = renderTideFrame(state('processing'), usage(40, 10), sessions, NOW + 99_999, 5);
    expect(diff(a, b)).toBe(0);
  });

  it('closes: the step from the last frame back to the first is no bigger than any other step', () => {
    const scenes: Array<[string, SessionInfo[]]> = [
      ['working', [session('a', 'claude-code', 'processing')]],
      ['asking', [session('a', 'codex-cli', 'awaiting_option'), session('b', 'claude-code', 'processing')]],
      ['idle', [session('a', 'opencode', 'idle'), session('b', 'kiro-cli', 'idle'), session('c', 'claude-code', 'idle')]],
      ['empty', []],
    ];
    for (const [name, sessions] of scenes) {
      const frames = renderTideLoop(state('processing'), usage(40, 10), sessions, NOW);
      const steps = frames.map((f, i) => diff(f, frames[(i + 1) % frames.length]));
      const wrap = steps[steps.length - 1];
      const others = Math.max(...steps.slice(0, -1));
      expect(wrap, `${name}: wrap step ${wrap} vs largest ${others}`).toBeLessThanOrEqual(others * 1.25);
      // ...and the scene really moves (a frozen loop would pass the check above).
      expect(Math.min(...steps), `${name}: frozen step`).toBeGreaterThan(0);
    }
  });

  it('tick wraps modulo the loop', () => {
    const sessions = [session('a', 'claude-code', 'processing')];
    expect(diff(
      renderTideFrame(state('processing'), null, sessions, NOW, 0),
      renderTideFrame(state('processing'), null, sessions, NOW, TIDE_LOOP.frames),
    )).toBe(0);
  });
});

describe('tide marks', () => {
  it('shows the loudest first and counts what does not fit', () => {
    const sessions = [
      session('i1', 'claude-code', 'idle'), session('i2', 'opencode', 'idle'), session('i3', 'kiro-cli', 'idle'),
      session('p1', 'claude-code', 'processing'), session('w1', 'claude-code', 'awaiting_option'),
    ];
    const { marks, overflow } = resolveTideMarks(null, sessions);
    expect(marks.map(m => m.id)).toEqual(['w1', 'p1', 'i1', 'i2']);
    expect(overflow).toBe(1);
  });

  it('draws an unknown agentType as nothing, never as another agent', () => {
    const { marks } = resolveTideMarks(null, [session('x', 'future-agent', 'processing')]);
    expect(marks).toEqual([]);
  });

  it('ignores dead sessions and folds a project’s codex rows', () => {
    const { marks } = resolveTideMarks(null, [
      session('dead', 'claude-code', 'processing', { alive: false }),
      session('c1', 'codex-cli', 'idle', { projectName: 'p' }),
      session('c2', 'codex-cli', 'idle', { projectName: 'p' }),
    ]);
    expect(marks.map(m => m.glyph)).toEqual(['codex']);
  });

  it('stands the state event in for one session only while sessions were never received', () => {
    expect(resolveTideMarks(state('processing', { agentType: 'claude-code' }), null).marks).toHaveLength(1);
    expect(resolveTideMarks(state('processing', { agentType: 'claude-code' }), []).marks).toHaveLength(0);
  });

  it('keeps the OpenClaw mark for a gateway session', () => {
    const { marks } = resolveTideMarks(state('idle', { gatewayHasError: true }), [session('o', 'openclaw', 'idle')]);
    expect(marks.map(m => m.glyph)).toContain('openClaw');
    expect(marks.find(m => m.glyph === 'openClaw')?.sick).toBe(true);
  });

  it('different states look different (amber ring vs sweep vs rest)', () => {
    const f = (s: string) => renderTideFrame(state('idle'), null, [session('a', 'claude-code', s)], NOW, 3);
    expect(diff(f('idle'), f('processing'))).toBeGreaterThan(0);
    expect(diff(f('idle'), f('awaiting_option'))).toBeGreaterThan(0);
  });
});

describe('tide keeps the usage HUD independent of the scene', () => {
  it('changing only a usage percentage changes HUD rows and nothing above them', () => {
    const sessions = [session('a', 'claude-code', 'idle')];
    const lo = renderTideFrame(state('idle'), usage(10, 10), sessions, NOW, 0);
    const hi = renderTideFrame(state('idle'), usage(90, 90), sessions, NOW, 0);
    const split = 64 * 3 * 50;                    // two providers would own rows 50-63; one owns 57-63
    expect(diff(lo.subarray(0, split), hi.subarray(0, split))).toBe(0);
    expect(diff(lo.subarray(split), hi.subarray(split))).toBeGreaterThan(0);
  });

  it('gives the scene the whole panel when there is no usage', () => {
    const none = renderTideFrame(state('idle'), null, [], NOW, 0);
    const withHud = renderTideFrame(state('idle'), usage(40, 10), [], NOW, 0);
    expect(diff(none, withHud)).toBeGreaterThan(0);
  });
});

describe('tide upload policy', () => {
  const sig = (scene: string, hud = 'h') => ({ scene, hud });
  const T0 = 1_000_000;

  it('is selected per device and never falls back to single frames', () => {
    expect(pixooTideEnabled({ ip: '1.2.3.4', animation: 'tide' })).toBe(true);
    expect(pixooTideEnabled({ ip: '1.2.3.4' })).toBe(false);
    expect(pixooTideEnabled({ ip: '1.2.3.4', animation: 'loop' })).toBe(false);
    expect(resolvePixooPushMode(true, true, true)).toBe('tide');
    expect(resolvePixooPushMode(true, true, false)).toBe('loop');
  });

  it('uploads first, then only verifies while nothing visible changed', () => {
    expect(tideDecision(sig('a'), undefined, 0, 0, T0)).toBe('upload');
    const up = { sig: sig('a'), at: T0 };
    expect(tideDecision(sig('a'), up, T0, 0, T0 + 5_000)).toBe('wait');
    expect(tideDecision(sig('a'), up, T0, 0, T0 + TIDE_POLICY.verifyMs)).toBe('verify');
  });

  it('lets a flapping scene buy at most one upload per floor', () => {
    const up = { sig: sig('a'), at: T0 };
    expect(tideDecision(sig('b'), up, T0, 0, T0 + 3_000)).toBe('wait');
    expect(tideDecision(sig('b'), up, T0, 0, T0 + TIDE_POLICY.sceneFloorMs)).toBe('upload');
  });

  it('treats a usage-only change as slow-moving', () => {
    const up = { sig: sig('a', 'h1'), at: T0 };
    expect(tideDecision(sig('a', 'h2'), up, T0, 0, T0 + TIDE_POLICY.sceneFloorMs)).not.toBe('upload');
    expect(tideDecision(sig('a', 'h2'), up, T0, 0, T0 + TIDE_POLICY.hudFloorMs)).toBe('upload');
  });

  it('backs off after a failed upload instead of retrying every tick', () => {
    expect(tideDecision(sig('a'), undefined, T0, T0 + TIDE_POLICY.retryMs, T0 + 1_000)).toBe('wait');
    expect(tideDecision(sig('a'), undefined, T0, T0 + TIDE_POLICY.retryMs, T0 + TIDE_POLICY.retryMs)).toBe('upload');
  });

  it('keeps the loop short enough to ingest quickly', () => {
    expect(TIDE_LOOP.frames).toBeLessThanOrEqual(6);
    expect(TIDE_LOOP.frames * TIDE_LOOP.picSpeedMs).toBe(3000);
  });
});

describe('tide signature', () => {
  const sessions = [session('a', 'claude-code', 'processing'), session('b', 'codex-cli', 'idle')];

  it('ignores a session the panel cannot show and a usage-only difference in the scene part', () => {
    const base = tideSignature(null, usage(40, 10), sessions);
    const hidden = tideSignature(null, usage(41, 10), [...sessions, session('z', 'future-agent', 'processing')]);
    expect(hidden.scene).toBe(base.scene);
    expect(hidden.hud).not.toBe(base.hud);
  });

  it('changes when a shown mark changes state', () => {
    const a = tideSignature(null, null, sessions);
    const b = tideSignature(null, null, [session('a', 'claude-code', 'awaiting_option'), sessions[1]]);
    expect(b.scene).not.toBe(a.scene);
  });
});
