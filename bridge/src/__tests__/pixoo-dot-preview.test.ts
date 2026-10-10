import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paintDotPixels, type DotDeckSnapshot } from '@agentdeck/shared';
import {
  broadcastPixoo, getLastFrame, onFrameRendered, offFrameRendered, renderPreviewFrame,
} from '../pixoo/pixoo-bridge.js';

const now = 1_800_000_000_000;
const working: DotDeckSnapshot = {
  configured: true, authorized: true, hosting: true,
  reportState: 'working', reportedAt: now, expiresAt: now + 600_000,
};
function report(dot: DotDeckSnapshot | null) {
  broadcastPixoo({ type: 'sessions_list', sessions: [], dot });
}

describe('Pixoo preview carries the actual Dot report', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); report(null); });
  afterEach(() => { report(null); vi.useRealTimers(); });

  it.each(['standard', 'micro'] as const)('shows working and completed, then removes unlinked Dot (%s)', layout => {
    const baseline = renderPreviewFrame(64, layout).slice();
    report(working);
    const active = getLastFrame(64, layout)!;
    expect(active).not.toEqual(baseline);
    expect(active).toEqual(paintDotPixels(baseline.slice(), 64, working, now));
    const completed: DotDeckSnapshot = { ...working, reportState: 'completed' };
    report(completed);
    expect(getLastFrame(64, layout)).toEqual(paintDotPixels(baseline.slice(), 64, completed, now));
    expect(getLastFrame(64, layout)).not.toEqual(active);
    report({ ...working, authorized: false });
    expect(getLastFrame(64, layout)).toEqual(baseline);
  });

  it('streams the same Dot overlay and removes stale activity', () => {
    const frames: Uint8Array[] = [];
    const listener = (frame: Uint8Array) => frames.push(frame.slice());
    report(working);
    onFrameRendered(listener);
    try {
      vi.advanceTimersByTime(100);
      expect(frames.at(-1)).toEqual(renderPreviewFrame(64));
      const withDot = frames.at(-1)!;
      report({ ...working, reportState: 'stale' });
      // Hold the scene clock still to isolate the reported companion.
      const withoutDot = renderPreviewFrame(64);
      expect(withDot).not.toEqual(withoutDot);
      expect(withDot).toEqual(paintDotPixels(withoutDot.slice(), 64, working, Date.now()));
    } finally { offFrameRendered(listener); }
  });
});
