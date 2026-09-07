import { describe, expect, it } from 'vitest';
import { BridgeTimelineStore } from '../timeline-store.js';
import type { TimelineEntry } from '@agentdeck/shared';

/**
 * The turn watchdog fired every 60 s for 17 days (10,603 times, measured
 * 2026-09-07) and never actually closed the row it kept finding. Its
 * back-dated `chat_end` was swallowed by the exact-dedup, whose 8-second
 * window only bounded entries OLDER than the incoming one — so the whole
 * newer tail of the buffer was compared against it, and any earlier
 * `Interrupted · –` close matched.
 */
describe('orphan chat_start reaper', () => {
  const t0 = Date.parse('2026-09-06T11:03:39.746Z');
  const day = 24 * 3600_000;

  const start = (ts: number, sessionId: string): TimelineEntry => ({
    ts, type: 'chat_start', raw: `prompt ${sessionId}`, sessionId, agentType: 'claude-code',
  } as TimelineEntry);

  it('closes an orphan even when an identical close already sits NEWER in the buffer', () => {
    const store = new BridgeTimelineStore();
    // The orphan, and a day-newer close of a different turn that renders with
    // the byte-identical text every orphan close uses.
    store.addEntry(start(t0, 'A'));
    store.addEntry({
      ts: t0 + day, type: 'chat_end', raw: 'Interrupted · –', sessionId: 'B',
      startedAt: t0 + day - 1000,
    } as TimelineEntry);

    const now = t0 + day + 3600_000;
    expect(store.reapOrphanChatStarts(3 * 60_000, now, new Set())).toBe(1);

    // The close must actually be in the buffer, paired with THIS turn…
    const closes = store.getHistory().filter((e: TimelineEntry) => e.type === 'chat_end' && e.sessionId === 'A');
    expect(closes).toHaveLength(1);
    expect(closes[0].ts).toBeGreaterThan(t0);

    // …and the next sweep must find nothing. Before the fix it found the same
    // row again, forever, once a minute.
    expect(store.reapOrphanChatStarts(3 * 60_000, now + 60_000, new Set())).toBe(0);
  });

  it('does not collapse two different turns that close with the same text', () => {
    const store = new BridgeTimelineStore();
    store.addEntry(start(t0, 'A'));
    store.addEntry(start(t0 + 2_000, 'B'));
    const now = t0 + day;
    // Both orphans close, 2 s apart, with identical raw text.
    expect(store.reapOrphanChatStarts(3 * 60_000, now, new Set())).toBe(2);
    expect(store.getHistory().filter((e: TimelineEntry) => e.type === 'chat_end')).toHaveLength(2);
    expect(store.reapOrphanChatStarts(3 * 60_000, now + 60_000, new Set())).toBe(0);
  });

  it('still absorbs a duplicate emit of the same close', () => {
    const store = new BridgeTimelineStore();
    const close = {
      ts: t0, type: 'chat_end', raw: 'Interrupted · –', sessionId: 'A', startedAt: t0 - 5_000,
    } as TimelineEntry;
    store.addEntry(close);
    store.addEntry({ ...close, ts: t0 + 1_000 });
    expect(store.getHistory().filter((e: TimelineEntry) => e.type === 'chat_end')).toHaveLength(1);
  });
});
