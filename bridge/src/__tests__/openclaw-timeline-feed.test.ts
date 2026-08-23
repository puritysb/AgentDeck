/**
 * OpenClawTimelineFeed — the bounds, and why each one is what it is.
 *
 * The feed reads OpenClaw's own store on a poll, so every bound here is a
 * decision about what NOT to put in a bounded activity log that the Gateway
 * stream is already writing to live.
 */
import { describe, it, expect } from 'vitest';
import type { TimelineEntry } from '@agentdeck/shared';
import { OpenClawTimelineFeed, shortSessionKey } from '../openclaw-timeline-feed.js';
import type { OpenClawStoreSession } from '../openclaw-transcript-timeline.js';

const NOW = Date.parse('2026-08-23T00:10:00Z');

function session(key: string, id: string, ageMs: number): OpenClawStoreSession {
  return { sessionKey: key, sessionId: id, agent: 'main', updatedAt: NOW - ageMs };
}

function row(ts: number, raw = 'exec · ls'): TimelineEntry {
  return { ts, type: 'tool_exec', raw, agentType: 'openclaw' };
}

/** A reader whose rows can be swapped between ticks, honouring `since`. */
function reader(byId: Record<string, TimelineEntry[]>) {
  return (id: string, opts: { since?: number; limit?: number }) => {
    const all = byId[id] ?? [];
    const filtered = opts.since === undefined ? all : all.filter((r) => r.ts > opts.since!);
    return opts.limit === undefined ? filtered : filtered.slice(-opts.limit);
  };
}

describe('OpenClawTimelineFeed', () => {
  const LIVE = session('agent:main:eval-a03__r2', 'sid-live', 60_000);

  it('emits NOTHING on a first sighting — unlike the Kiro feed, deliberately', () => {
    // Kiro seeds the last turn because a Kiro session otherwise shows a live
    // row beside a blank strip. OpenClaw has no such gap: the Gateway stream is
    // already filling the strip, so seeding here would only inject minutes-old
    // tool calls from finished eval runs on every daemon start.
    const feed = new OpenClawTimelineFeed(
      reader({ 'sid-live': [row(NOW - 90_000), row(NOW - 80_000)] }),
      () => [LIVE],
    );
    expect(feed.pump(NOW)).toEqual([]);
    expect(feed.size).toBe(1);
  });

  it('emits work that arrives after the position it adopted', () => {
    const rows = [row(NOW - 90_000)];
    const feed = new OpenClawTimelineFeed(reader({ 'sid-live': rows }), () => [LIVE]);
    feed.pump(NOW);
    rows.push(row(NOW - 10_000, 'exec · grep -n PORT serve.py'));
    const out = feed.pump(NOW);
    expect(out).toHaveLength(1);
    expect(out[0].raw).toBe('exec · grep -n PORT serve.py');
  });

  it('reads only recently-active sessions — the store never forgets one', () => {
    // 103 sessions on the machine this was built against, nearly all finished.
    const stale = session('agent:main:eval-old__r1', 'sid-stale', 6 * 3600_000);
    const feed = new OpenClawTimelineFeed(
      reader({ 'sid-live': [row(NOW - 60_000)], 'sid-stale': [row(NOW - 6 * 3600_000)] }),
      () => [LIVE, stale],
    );
    feed.pump(NOW);
    expect(feed.size).toBe(1);
  });

  it('forgets a session that falls out of the window, and re-seeds it silently', () => {
    // Re-seeding silently is the point: a session that goes quiet and comes
    // back must not replay everything it did while it was out of view.
    const rows = [row(NOW - 60_000)];
    let live = [LIVE];
    const feed = new OpenClawTimelineFeed(reader({ 'sid-live': rows }), () => live);
    feed.pump(NOW);
    live = [];
    feed.pump(NOW);
    expect(feed.size).toBe(0);
    live = [LIVE];
    rows.push(row(NOW - 5_000));
    expect(feed.pump(NOW)).toEqual([]);
  });

  it('names WHICH OpenClaw session produced each row, at the head of detail', () => {
    // The whole reason this exists: `agent:main:main`, a cron job and a
    // model-eval run all arrive as the single literal "OpenClaw".
    const rows = [row(NOW - 90_000)];
    const feed = new OpenClawTimelineFeed(reader({ 'sid-live': rows }), () => [LIVE]);
    feed.pump(NOW);
    rows.push(row(NOW - 10_000));
    const out = feed.pump(NOW);
    expect(out[0].detail!.split('\n')[0]).toBe('session: eval-a03__r2');
  });

  it('attributes rows to the virtual Gateway session, never to a new one', () => {
    // The deck is sized for sessions and an eval suite opens a fresh session
    // key per run — six in the three hours this was measured over.
    const rows = [row(NOW - 90_000)];
    const feed = new OpenClawTimelineFeed(reader({ 'sid-live': rows }), () => [LIVE]);
    feed.pump(NOW);
    rows.push(row(NOW - 10_000));
    const out = feed.pump(NOW);
    expect(out[0].sessionId).toBe('openclaw-gateway');
    expect(out[0].projectName).toBe('OpenClaw');
    expect(out[0].agentType).toBe('openclaw');
  });

  it('preserves a row detail the parser already wrote, under the session line', () => {
    const rows: TimelineEntry[] = [row(NOW - 90_000)];
    const feed = new OpenClawTimelineFeed(reader({ 'sid-live': rows }), () => [LIVE]);
    feed.pump(NOW);
    rows.push({ ...row(NOW - 10_000), detail: 'ok · exit 0\nmodel: openrouter/stealth/ox-alpha' });
    const lines = feed.pump(NOW)[0].detail!.split('\n');
    expect(lines).toEqual([
      'session: eval-a03__r2',
      'ok · exit 0',
      'model: openrouter/stealth/ox-alpha',
    ]);
  });

  it('returns rows oldest-first across all sessions', () => {
    const a = session('agent:main:a__r1', 'sid-a', 60_000);
    const b = session('agent:main:b__r1', 'sid-b', 60_000);
    const rowsA = [row(NOW - 90_000)];
    const rowsB = [row(NOW - 90_000)];
    const feed = new OpenClawTimelineFeed(
      reader({ 'sid-a': rowsA, 'sid-b': rowsB }),
      () => [a, b],
    );
    feed.pump(NOW);
    rowsA.push(row(NOW - 3_000, 'late'));
    rowsB.push(row(NOW - 9_000, 'early'));
    expect(feed.pump(NOW).map((r) => r.raw)).toEqual(['early', 'late']);
  });

  it('survives a reader that throws, and keeps going for the others', () => {
    const good = session('agent:main:good__r1', 'sid-good', 60_000);
    const bad = session('agent:main:bad__r1', 'sid-bad', 60_000);
    const rows = [row(NOW - 90_000)];
    const feed = new OpenClawTimelineFeed(
      (id, opts) => {
        if (id === 'sid-bad') throw new Error('unreadable');
        return reader({ 'sid-good': rows })(id, opts);
      },
      () => [bad, good],
    );
    feed.pump(NOW);
    rows.push(row(NOW - 10_000, 'still here'));
    expect(feed.pump(NOW).map((r) => r.raw)).toEqual(['still here']);
  });

  it('returns nothing when the store cannot be listed at all', () => {
    const feed = new OpenClawTimelineFeed(reader({}), () => { throw new Error('no store'); });
    expect(feed.pump(NOW)).toEqual([]);
  });
});

describe('shortSessionKey', () => {
  it('drops the constant agent prefix and keeps what says which work this is', () => {
    expect(shortSessionKey('agent:main:eval-full-unified-mlx-2026-08-23-a03__r2'))
      .toBe('eval-full-unified-mlx-2026-08-23-a03__r2');
    expect(shortSessionKey('agent:main:main')).toBe('main');
    expect(shortSessionKey('agent:main:cron:41b100c9')).toBe('cron:41b100c9');
  });

  it('leaves a key it does not recognize alone rather than emptying it', () => {
    expect(shortSessionKey('weird-key')).toBe('weird-key');
    expect(shortSessionKey('agent:main:')).toBe('agent:main:');
  });
});
