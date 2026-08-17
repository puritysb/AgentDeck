/**
 * Feeds an observed Kiro session's activity into the daemon's live timeline.
 *
 * #218 taught the Detail view to read Kiro's own transcript on demand, which
 * fixed the per-session query and nothing else: the main TIMELINE is not a
 * query, it is a STREAM that hook-driven agents push rows into as they work.
 * Kiro pushes nothing — no `kiro_*` hook has ever reached this daemon — so a
 * Kiro session appeared in the session list (HUD) while the timeline beside it
 * stayed empty. Answering "why is it in one and not the other" is answering
 * "one is pulled, the other is pushed".
 *
 * This is the missing producer. On every passive-observer refresh it reads
 * whatever is new in each Kiro session's transcript and emits it as ordinary
 * timeline rows, so the strip fills the way it does for every other agent.
 *
 * **A first sighting emits the last turn, and only that.** Emitting nothing at
 * all was the first version and it was wrong in practice: a hook-driven agent
 * accumulates rows continuously, so a daemon restart costs it little, while a
 * Kiro session that had been talking for an hour came back with a visible
 * session row and a blank strip beside it — which reads as broken, not as
 * "history you missed". One turn is enough context to say what the session is
 * doing without replaying days of conversation into a bounded activity log.
 */

import type { TimelineEntry } from '@agentdeck/shared';
import { kiroTimelineForSession } from './kiro-transcript-timeline.js';
import { debug } from './logger.js';

/** Rows read per session per tick. A Kiro turn is one prompt + one reply, so
 *  this is many turns' worth of headroom for a poll measured in seconds. */
const ROWS_PER_TICK = 8;

/** Watermarks kept for at most this many sessions, newest-first. A daemon that
 *  runs for weeks must not grow a map keyed by every session it ever saw. */
const MAX_TRACKED = 64;

export type KiroRowReader = (
  sessionId: string,
  opts: { since?: number; limit?: number },
) => TimelineEntry[];

/**
 * The last prompt and everything that answered it.
 *
 * Walks back to the newest `chat_start` rather than taking a fixed count: a
 * Kiro turn is one prompt followed by however many reply records the agent
 * happened to write, and cutting by count would show a reply with no question.
 */
function tailTurn(rows: TimelineEntry[]): TimelineEntry[] {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].type === 'chat_start') return rows.slice(i);
  }
  return rows.slice(-2);
}

export class KiroTimelineFeed {
  /** sessionId → newest row timestamp already accounted for. */
  private readonly watermark = new Map<string, number>();

  constructor(private readonly readRows: KiroRowReader = kiroTimelineForSession) {}

  /**
   * Rows to emit for this tick, oldest-first across all sessions.
   *
   * `sessionIds` is the CURRENT set of observed Kiro sessions; anything absent
   * from it is forgotten, so a finished session's watermark does not outlive it.
   */
  pump(sessionIds: string[]): TimelineEntry[] {
    const live = new Set(sessionIds);
    for (const id of [...this.watermark.keys()]) {
      if (!live.has(id)) this.watermark.delete(id);
    }

    const out: TimelineEntry[] = [];
    for (const id of sessionIds) {
      const since = this.watermark.get(id);
      let rows: TimelineEntry[];
      try {
        rows = this.readRows(id, { since, limit: ROWS_PER_TICK });
      } catch (err) {
        debug('daemon', `kiro-feed read failed for ${id}: ${String(err)}`);
        continue;
      }
      if (rows.length === 0) {
        // Seed an empty session at 0 so its first real row is emitted rather
        // than swallowed as "history".
        if (since === undefined) this.watermark.set(id, 0);
        continue;
      }
      const newest = rows[rows.length - 1].ts;
      if (since === undefined) {
        // First sighting: show the last turn so the strip is not blank beside
        // a live session row, and mark everything older as history.
        this.watermark.set(id, newest);
        const lastTurn = tailTurn(rows);
        debug('daemon', `kiro-feed seeded ${id} at ${newest} (+${lastTurn.length} row(s))`);
        out.push(...lastTurn);
        continue;
      }
      this.watermark.set(id, newest);
      out.push(...rows);
    }
    this.enforceCeiling();
    return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  /** Tracked session count — for tests and diagnostics. */
  get size(): number {
    return this.watermark.size;
  }

  private enforceCeiling(): void {
    if (this.watermark.size <= MAX_TRACKED) return;
    // Oldest watermark first: the least recently active session is the one
    // least likely to produce the next row.
    const byAge = [...this.watermark.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    for (const [id] of byAge) {
      if (this.watermark.size <= MAX_TRACKED) break;
      this.watermark.delete(id);
    }
  }
}
