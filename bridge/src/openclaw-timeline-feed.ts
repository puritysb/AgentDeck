/**
 * Feeds OpenClaw's own transcript into the daemon's live timeline.
 *
 * The Gateway stream says that OpenClaw answered; it does not say what it did
 * to answer. Only tools that needed approval ever reached the strip, which is a
 * biased sample rather than a log. This is the producer for the rest, read off
 * the store OpenClaw writes anyway (`openclaw-transcript-timeline.ts`).
 *
 * Three bounds, each for a measured reason:
 *
 *  - **Only recently-active sessions are read.** The store keeps every session
 *    forever — 103 of them on the machine this was built against, most long
 *    finished. Sessions are polled by `updatedAt`, newest first, inside
 *    `ACTIVE_WINDOW_MS`.
 *
 *  - **A first sighting emits NOTHING.** This is the opposite of
 *    `KiroTimelineFeed`, deliberately: Kiro seeds the last turn because a Kiro
 *    session otherwise shows a live row beside a blank strip, which reads as
 *    broken. OpenClaw has no such gap — the Gateway stream is already filling
 *    the strip live — so seeding here would only inject minutes-old tool calls
 *    from finished eval runs into an activity log, competing with the live
 *    rows it is meant to supplement.
 *
 *  - **Rows land on the existing `openclaw-gateway` row, not on new sessions.**
 *    One OpenClaw instance is one session everywhere else in AgentDeck, the
 *    deck is sized for sessions, and an eval suite opens a fresh session key
 *    per run — six in the three hours this was measured over. Which session key
 *    produced a row rides its `detail` instead, since that is the fact that
 *    distinguishes the chat the user is looking at from a cron job and from a
 *    model-eval run.
 */

import type { TimelineEntry } from '@agentdeck/shared';
import { OPENCLAW_SESSION_ID } from './openclaw-session.js';
import {
  listOpenClawSessions,
  openClawTimelineForSession,
  type OpenClawStoreSession,
} from './openclaw-transcript-timeline.js';
import { debug } from './logger.js';

/** How recently a session must have been written to be worth reading. */
const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
/** Sessions read per tick, newest-first. An eval suite runs a handful at once. */
const MAX_SESSIONS_PER_TICK = 8;
/** Rows read per session per tick — measured traffic was 28 tool calls / 3 h. */
const ROWS_PER_TICK = 12;
/** Watermarks kept at most, newest-first: the store never forgets a session. */
const MAX_TRACKED = 64;

export type OpenClawRowReader = (
  sessionId: string,
  opts: { since?: number; limit?: number },
) => TimelineEntry[];
export type OpenClawSessionLister = () => OpenClawStoreSession[];

/**
 * The human-facing half of a session key.
 *
 * `agent:main:eval-full-unified-mlx-2026-08-23-a03__openrouter-stealth-ox-alpha__r2`
 * is what the store holds and it does not fit anywhere. The leading
 * `agent:<agent>:` is constant for a given install and carries nothing, so it
 * is dropped; what remains is the part that says which KIND of work this is.
 */
export function shortSessionKey(sessionKey: string): string {
  const stripped = sessionKey.replace(/^agent:[^:]+:/, '');
  return stripped || sessionKey;
}

export class OpenClawTimelineFeed {
  /** sessionId → newest row timestamp already accounted for. */
  private readonly watermark = new Map<string, number>();

  constructor(
    private readonly readRows: OpenClawRowReader = openClawTimelineForSession,
    private readonly listSessions: OpenClawSessionLister = listOpenClawSessions,
  ) {}

  /**
   * Rows to emit for this tick, oldest-first across all sessions.
   *
   * `now` is injectable so a test can drive the activity window without a clock.
   */
  pump(now: number = Date.now()): TimelineEntry[] {
    let sessions: OpenClawStoreSession[];
    try {
      sessions = this.listSessions();
    } catch (err) {
      debug('daemon', `openclaw-feed session list failed: ${String(err)}`);
      return [];
    }

    const active = sessions
      .filter((s) => now - s.updatedAt <= ACTIVE_WINDOW_MS)
      .slice(0, MAX_SESSIONS_PER_TICK);
    const live = new Set(active.map((s) => s.sessionId));
    for (const id of [...this.watermark.keys()]) {
      if (!live.has(id)) this.watermark.delete(id);
    }

    const out: TimelineEntry[] = [];
    for (const session of active) {
      const since = this.watermark.get(session.sessionId);
      let rows: TimelineEntry[];
      try {
        rows = this.readRows(session.sessionId, { since, limit: ROWS_PER_TICK });
      } catch (err) {
        debug('daemon', `openclaw-feed read failed for ${session.sessionId}: ${String(err)}`);
        continue;
      }
      if (rows.length === 0) {
        // Seed an empty/unreadable session at 0 so its first real row is
        // emitted rather than swallowed as history.
        if (since === undefined) this.watermark.set(session.sessionId, 0);
        continue;
      }
      const newest = rows[rows.length - 1].ts;
      this.watermark.set(session.sessionId, newest);
      if (since === undefined) {
        // First sighting: adopt the position, emit nothing. See the header —
        // the Gateway stream is already filling this session's strip.
        debug('daemon', `openclaw-feed seeded ${session.sessionId} at ${newest} (silent)`);
        continue;
      }
      for (const row of rows) out.push(this.attribute(row, session));
    }
    this.enforceCeiling();
    return out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  }

  /** Tracked session count — for tests and diagnostics. */
  get size(): number {
    return this.watermark.size;
  }

  /**
   * Stamp the row with the virtual Gateway session and say which OpenClaw
   * session key produced it.
   *
   * The key leads `detail`: everything below it (the tool's own output, the
   * model) is context, while "this came from a model-eval run and not from your
   * chat" is the part that reorients the reader.
   */
  private attribute(row: TimelineEntry, session: OpenClawStoreSession): TimelineEntry {
    const head = `session: ${shortSessionKey(session.sessionKey)}`;
    return {
      ...row,
      sessionId: OPENCLAW_SESSION_ID,
      agentType: 'openclaw',
      projectName: 'OpenClaw',
      detail: [head, row.detail].filter(Boolean).join('\n'),
    };
  }

  private enforceCeiling(): void {
    if (this.watermark.size <= MAX_TRACKED) return;
    const byAge = [...this.watermark.entries()].sort((a, b) => a[1] - b[1]);
    for (const [id] of byAge) {
      if (this.watermark.size <= MAX_TRACKED) break;
      this.watermark.delete(id);
    }
  }
}
