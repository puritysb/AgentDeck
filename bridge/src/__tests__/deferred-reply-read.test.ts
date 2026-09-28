import { describe, it, expect, vi, afterEach } from 'vitest';
import { scheduleDeferredReplyRead, DEFERRED_REPLY_DELAYS_MS } from '../deferred-reply-read.js';

describe('scheduleDeferredReplyRead', () => {
  // Restore even when an assertion fails mid-test, so fake timers never leak.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on the bounded schedule and applies the first non-empty read', () => {
    vi.useFakeTimers();
    const reads = ['', 'the reply'];
    const read = vi.fn(() => reads.shift() ?? '');
    const apply = vi.fn();
    scheduleDeferredReplyRead(read, apply);
    vi.advanceTimersByTime(DEFERRED_REPLY_DELAYS_MS[0]!);
    expect(read).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(DEFERRED_REPLY_DELAYS_MS[1]!);
    expect(read).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledWith('the reply');
    vi.advanceTimersByTime(60_000);
    expect(read).toHaveBeenCalledTimes(2); // no further attempts
  });

  it('gives up silently after the last delay, and a throwing reader counts as empty', () => {
    vi.useFakeTimers();
    const read = vi.fn(() => { throw new Error('unreadable'); });
    const apply = vi.fn();
    scheduleDeferredReplyRead(read, apply, { delays: [10, 20] });
    vi.advanceTimersByTime(100);
    expect(read).toHaveBeenCalledTimes(2);
    expect(apply).not.toHaveBeenCalled();
  });

  it('never holds the process open for the retry timer', () => {
    const unref = vi.fn();
    scheduleDeferredReplyRead(() => 'x', () => {}, { setTimer: () => ({ unref }) });
    expect(unref).toHaveBeenCalled();
  });
});
