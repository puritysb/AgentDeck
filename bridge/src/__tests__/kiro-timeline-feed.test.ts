/**
 * The producer that puts an observed Kiro session into the LIVE timeline.
 *
 * The bug it fixes is the difference between a pull and a push: #218 taught the
 * per-session query to read Kiro's transcript, so the Detail view filled — and
 * the main strip stayed empty, because that one is a stream every other agent
 * pushes rows into from its hooks. Kiro has no hooks reaching the daemon.
 */

import { describe, it, expect } from 'vitest';
import type { TimelineEntry } from '@agentdeck/shared';
import { KiroTimelineFeed } from '../kiro-timeline-feed.js';

const SID = 'observed:kiro:6b3d3a27-f18e-4276-9438-3491fffe27e7';

function row(ts: number, raw: string): TimelineEntry {
  return { ts, type: 'chat_start', raw, agentType: 'kiro-cli', sessionId: 'x' };
}

/** A fake transcript that grows between ticks, honouring `since` like the real
 *  reader does. */
function reader(rowsBySession: Record<string, TimelineEntry[]>) {
  const calls: Array<{ id: string; since?: number }> = [];
  const read = (id: string, opts: { since?: number; limit?: number }) => {
    calls.push({ id, since: opts.since });
    const all = rowsBySession[id] ?? [];
    const filtered = opts.since === undefined ? all : all.filter((r) => r.ts > opts.since!);
    return filtered.slice(-(opts.limit ?? 8));
  };
  return { read, calls };
}

describe('KiroTimelineFeed', () => {
  it('emits nothing the first time it sees a session', () => {
    // Otherwise every daemon start replays days of an old conversation into a
    // bounded activity log, evicting live rows from other agents to do it.
    const rows = { [SID]: [row(1000, 'old prompt'), row(2000, 'old reply')] };
    const { read } = reader(rows);
    const feed = new KiroTimelineFeed(read);
    expect(feed.pump([SID])).toEqual([]);
  });

  it('emits only what appeared after the first sighting', () => {
    const rows = { [SID]: [row(1000, 'old prompt'), row(2000, 'old reply')] };
    const { read, calls } = reader(rows);
    const feed = new KiroTimelineFeed(read);
    feed.pump([SID]);                              // seed at 2000

    rows[SID].push(row(3000, 'new prompt'), row(4000, 'new reply'));
    expect(feed.pump([SID]).map((r) => r.raw)).toEqual(['new prompt', 'new reply']);
    // Asked for rows AFTER the watermark, not the whole file.
    expect(calls[calls.length - 1].since).toBe(2000);

    // And does not re-emit them on the next tick.
    expect(feed.pump([SID])).toEqual([]);
  });

  it('emits the first row of a session that was empty when first seen', () => {
    // A session observed the moment it starts has no rows yet. Seeding it at
    // "newest row" would be seeding at nothing, and the real first prompt would
    // then look like history and be swallowed.
    const rows: Record<string, TimelineEntry[]> = { [SID]: [] };
    const { read } = reader(rows);
    const feed = new KiroTimelineFeed(read);
    expect(feed.pump([SID])).toEqual([]);

    rows[SID].push(row(5000, 'first ever prompt'));
    expect(feed.pump([SID]).map((r) => r.raw)).toEqual(['first ever prompt']);
  });

  it('forgets a session that is no longer observed', () => {
    const rows = { [SID]: [row(1000, 'a')] };
    const { read } = reader(rows);
    const feed = new KiroTimelineFeed(read);
    feed.pump([SID]);
    expect(feed.size).toBe(1);
    feed.pump([]);                                  // session ended
    expect(feed.size).toBe(0);
    // Re-seen later: seeded again, so its backlog is not replayed.
    expect(feed.pump([SID])).toEqual([]);
  });

  it('orders rows across sessions and survives a reader that throws', () => {
    const good = 'observed:kiro:good';
    const bad = 'observed:kiro:bad';
    const rows: Record<string, TimelineEntry[]> = { [good]: [row(10, 'seed')] };
    const base = reader(rows);
    const read = (id: string, opts: { since?: number; limit?: number }) => {
      if (id === bad) throw new Error('ENOENT');
      return base.read(id, opts);
    };
    const feed = new KiroTimelineFeed(read);
    feed.pump([good, bad]);
    rows[good].push(row(30, 'later'), row(20, 'earlier'));
    // One unreadable session must not cost the other its rows, and the output
    // is chronological regardless of read order.
    expect(feed.pump([good, bad]).map((r) => r.raw)).toEqual(['earlier', 'later']);
  });
});
