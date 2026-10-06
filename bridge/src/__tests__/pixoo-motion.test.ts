// Pixoo64 motion: the simulation clock, the documented multi-frame upload
// shape, and the opt-in baked device loop.
//
// - Integrated motion (school, bubbles, data particles) must follow wall time,
//   not the renderFrame() call rate: the device path renders once per ~2.5 s
//   push, which used to run the school at 1/25 of its designed speed while an
//   open 10 fps preview sped the same shared state back up.
// - A multi-frame upload is one request per frame (shared PicID/PicNum,
//   PicOffset = index, one 12,288-byte frame per PicData) — never every frame
//   concatenated into one body, which is what wedged the device in 2026-06/07.
// - The baked loop closes by construction (palindrome) and stays opt-in.
import { describe, expect, it } from 'vitest';
import {
  consumeSimulationTicks,
  resetSimulationClock,
  PIXOO_SIM_MAX_TICKS_PER_RENDER,
  PIXOO_LOOP,
  pixooLoopOrder,
  renderPixooLoop,
} from '../pixoo/pixoo-renderer.js';
import { buildSendHttpGifCommands, PIXOO_MAX_ANIMATION_FRAMES } from '../pixoo/pixoo-client.js';
import {
  PIXOO_PUSH_POLICY,
  pixooLoopEnabled,
  pixooPushIntervalMs,
  resolvePixooPushMode,
} from '../pixoo/pixoo-bridge.js';
import { State } from '../types.js';
import type { StateUpdateEvent } from '../types.js';
import type { SessionInfo } from '@agentdeck/shared/protocol';

describe('Pixoo simulation clock', () => {
  it('integrates the ticks that elapsed, not one tick per render call', () => {
    resetSimulationClock();
    expect(consumeSimulationTicks(1_000)).toEqual([1_000]);
    // A second render inside the same 100 ms tick (preview + device) adds nothing.
    expect(consumeSimulationTicks(1_000)).toEqual([]);
    // One device push 2.5 s later replays all 25 ticks, in order.
    const ticks = consumeSimulationTicks(1_025);
    expect(ticks).toHaveLength(25);
    expect(ticks[0]).toBe(1_001);
    expect(ticks.at(-1)).toBe(1_025);
  });

  it('caps a long gap so a wake from sleep cannot flush the scene', () => {
    resetSimulationClock();
    consumeSimulationTicks(0);
    const ticks = consumeSimulationTicks(10_000);
    expect(ticks).toHaveLength(PIXOO_SIM_MAX_TICKS_PER_RENDER);
    expect(ticks.at(-1)).toBe(10_000);
  });

  it('treats a clock that went backwards as a fresh start', () => {
    resetSimulationClock();
    consumeSimulationTicks(500);
    expect(consumeSimulationTicks(400)).toEqual([400]);
  });
});

describe('Pixoo SendHttpGif upload shape', () => {
  const frame = (v: number) => new Uint8Array(64 * 64 * 3).fill(v);

  it('sends one request per frame with a shared PicID and per-frame PicOffset', () => {
    const cmds = buildSendHttpGifCommands([frame(0), frame(128), frame(255)], 42, 200);
    expect(cmds).toHaveLength(3);
    cmds.forEach((cmd, i) => {
      expect(cmd).toMatchObject({
        Command: 'Draw/SendHttpGif', PicNum: 3, PicWidth: 64, PicOffset: i, PicID: 42, PicSpeed: 200,
      });
      // Exactly one frame per body — the same size as the proven single-frame push.
      expect(Buffer.from(cmd.PicData as string, 'base64')).toHaveLength(64 * 64 * 3);
    });
  });

  it('keeps the single-frame command identical to the proven path', () => {
    const [cmd] = buildSendHttpGifCommands([frame(10)], 7, 1000);
    expect(cmd).toMatchObject({ PicNum: 1, PicOffset: 0, PicID: 7, PicSpeed: 1000 });
  });
});

describe('Pixoo baked device loop', () => {
  const sessions = [
    { id: 'a', agentType: 'claude-code', state: 'processing', alive: true },
    { id: 'b', agentType: 'codex-cli', state: 'processing', alive: true },
  ] as unknown as SessionInfo[];
  const state = { type: 'state_update', state: State.PROCESSING } as StateUpdateEvent;

  it('is a closed palindrome over the unique frames', () => {
    expect(pixooLoopOrder(4)).toEqual([0, 1, 2, 3, 2, 1]);
    expect(pixooLoopOrder(1)).toEqual([0]);
    const n = PIXOO_LOOP.uniqueFrames;
    const order = pixooLoopOrder(n);
    expect(order).toHaveLength(2 * n - 2);
    expect(order.length).toBeLessThanOrEqual(PIXOO_MAX_ANIMATION_FRAMES);
    // Frame k and frame (len - k) are the same image, so the frame after the
    // last one (frame 0) continues the motion instead of jumping.
    for (let k = 1; k < n; k++) expect(order[order.length - k]).toBe(order[k]);
  });

  it('renders real motion inside the loop and plays it back in real time', () => {
    const frames = renderPixooLoop(state, null, sessions, 1_800_000_000_000);
    expect(frames).toHaveLength(2 * PIXOO_LOOP.uniqueFrames - 2);
    for (let k = 1; k < PIXOO_LOOP.uniqueFrames; k++) {
      expect(Buffer.compare(frames[k], frames[frames.length - k])).toBe(0);
    }
    const moving = frames.slice(1).filter((f) => Buffer.compare(f, frames[0]) !== 0);
    expect(moving.length).toBeGreaterThan(0);
    expect(PIXOO_LOOP.picSpeedMs).toBe(PIXOO_LOOP.tickStep * 100);
  });
});

describe('Pixoo loop push policy', () => {
  it('stays single-frame unless a device opts in', () => {
    expect(pixooLoopEnabled({ ip: '10.0.0.2' }, Date.now())).toBe(false);
    expect(pixooLoopEnabled({ ip: '10.0.0.2', animation: 'single-frame' }, Date.now())).toBe(false);
    expect(pixooLoopEnabled({ ip: '10.0.0.2', animation: 'loop' }, 1_000, 0)).toBe(true);
    // A failed loop upload cools the device down to single frames.
    expect(pixooLoopEnabled({ ip: '10.0.0.2', animation: 'loop' }, 1_000, 5_000)).toBe(false);
  });

  it('uploads a loop rarely and lets the device play it in between', () => {
    expect(resolvePixooPushMode(true, true)).toBe('loop');
    expect(resolvePixooPushMode(false, true)).toBe('idle');
    expect(pixooPushIntervalMs(false, 'loop')).toBe(PIXOO_PUSH_POLICY.loopRefreshMs);
    expect(pixooPushIntervalMs(true, 'loop')).toBe(PIXOO_PUSH_POLICY.loopStateChangeFloorMs);
    expect(PIXOO_PUSH_POLICY.loopRefreshMs).toBeGreaterThan(PIXOO_PUSH_POLICY.activeFrameRefreshMs);
  });
});
