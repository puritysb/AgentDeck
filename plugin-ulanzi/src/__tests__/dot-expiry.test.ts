import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOT_LIMITS, type DotDeckSnapshot } from '@agentdeck/shared';
import { DotExpiryRefresh } from '../dot-expiry.js';
import { deckSignature } from '../deck-signature.js';

describe('Dot static-key activity lease', () => {
  afterEach(() => vi.useRealTimers());
  function working(): DotDeckSnapshot {
    return { configured: true, hosting: true, reportState: 'working', reportedAt: Date.now(), expiresAt: null };
  }
  it('repaints expired work without another daemon frame or changed payload', () => {
    vi.useFakeTimers(); vi.setSystemTime(1800000000000);
    const dot = working(), input = { dot }, first = deckSignature(input);
    const redraw = vi.fn(() => deckSignature(input));
    const lease = new DotExpiryRefresh(redraw);
    lease.update(dot);
    vi.advanceTimersByTime(DOT_LIMITS.reportFreshMs);
    expect(redraw).toHaveBeenCalledOnce();
    expect(redraw.mock.results[0].value).not.toBe(first);
    lease.update(dot);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not renew report age when the same cached frame is rendered again', () => {
    vi.useFakeTimers(); vi.setSystemTime(1800000000000);
    const dot = working(), redraw = vi.fn(), lease = new DotExpiryRefresh(redraw);
    lease.update(dot);
    vi.advanceTimersByTime(DOT_LIMITS.reportFreshMs / 2);
    lease.update(dot);
    vi.advanceTimersByTime(DOT_LIMITS.reportFreshMs / 2);
    expect(redraw).toHaveBeenCalledOnce();
  });
  it('cancels expiry after completion or disconnect', () => {
    vi.useFakeTimers(); vi.setSystemTime(1800000000000);
    const dot = working(), redraw = vi.fn(), lease = new DotExpiryRefresh(redraw);
    lease.update(dot); lease.update({ ...dot, reportState: 'completed' });
    vi.advanceTimersByTime(DOT_LIMITS.reportFreshMs);
    expect(redraw).not.toHaveBeenCalled();
    dot.reportedAt = Date.now(); lease.update(dot); lease.update(null);
    vi.advanceTimersByTime(DOT_LIMITS.reportFreshMs);
    expect(redraw).not.toHaveBeenCalled();
  });
});
