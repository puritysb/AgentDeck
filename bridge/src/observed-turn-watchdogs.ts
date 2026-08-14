/**
 * Missed-Stop recovery for hook-OBSERVED Claude sessions.
 *
 * `ClaudeTurnWatchdog` (bridge/src/claude-turn-watchdog.ts) recovers a dropped
 * Stop hook for a session the bridge owns a PTY for — one bridge process, one
 * session, one watchdog. That covers `agentdeck claude` and nothing else.
 *
 * The far more common shape is a user running plain `claude` in their own
 * terminal: the daemon never sees a PTY, only the hook POSTs, and every such
 * session lands in ONE process multiplexed by `session_id`. So the recovery
 * that shipped in 1.0.20 did not cover a single one of them — measured against
 * the live APME database, 100% of recorded Claude turns were observed sessions
 * and therefore had no missed-Stop recovery at all. This class is the
 * multiplexed counterpart: one `ClaudeTurnWatchdog` per observed session,
 * created on that session's first prompt and swept when the session goes cold.
 *
 * Recovery re-enters the daemon's real `/hooks/Stop` handler rather than
 * calling the pieces directly. That branch does six separate things (state
 * machine, timeline chat_response/chat_end, APME response capture + turn
 * close, model recovery from the transcript, steering lifecycle, session
 * liveness), and a second in-process copy of it would drift from the first —
 * the recovered path must be the same path, not a parallel one.
 */

import { ClaudeTurnWatchdog } from './claude-turn-watchdog.js';
import type { TurnEndProbe } from './apme/claude-transcript-reader.js';
import { debug } from './logger.js';

/** How long a session may go without any hook before its watchdog is dropped.
 *  A disarmed watchdog costs nothing, but an ARMED one polls every 5s forever
 *  — an observed session that dies mid-turn (terminal closed, machine slept)
 *  never sends SessionEnd, so without this its timer outlives it. */
export const OBSERVED_WATCHDOG_IDLE_MS = 30 * 60_000;

/** Hard ceiling on tracked sessions, so a daemon that has seen thousands of
 *  sessions over weeks cannot grow the map without bound between sweeps. The
 *  coldest entries go first — they are the ones least likely to be mid-turn. */
export const OBSERVED_WATCHDOG_MAX_SESSIONS = 64;

export interface ObservedStopRecovery {
  sessionId: string;
  transcriptPath: string;
  cwd?: string;
  projectName?: string;
}

export interface ObservedTurnWatchdogsOptions {
  /** Fired when a session's transcript proves its open turn already ended. */
  onMissedStop: (recovery: ObservedStopRecovery) => void;
  quietMs?: number;
  pollMs?: number;
  idleMs?: number;
  maxSessions?: number;
  /** Injectable for tests. */
  now?: () => number;
  probe?: (transcriptPath: string) => TurnEndProbe | null;
  mtimeMs?: (transcriptPath: string) => number | null;
}

interface Tracked {
  watchdog: ClaudeTurnWatchdog;
  lastSeenAt: number;
  cwd?: string;
  projectName?: string;
}

export class ObservedTurnWatchdogs {
  private readonly sessions = new Map<string, Tracked>();
  private readonly opts: ObservedTurnWatchdogsOptions;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly maxSessions: number;
  private stopped = false;

  constructor(opts: ObservedTurnWatchdogsOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? OBSERVED_WATCHDOG_IDLE_MS;
    this.maxSessions = opts.maxSessions ?? OBSERVED_WATCHDOG_MAX_SESSIONS;
  }

  /** Feed every Claude hook POST through here, PascalCase event name as
   *  received. Non-Claude agents must NOT be fed: the probe reads Claude's
   *  transcript JSONL, and Codex/OpenCode have their own turn-end signals.
   *
   *  A session is only tracked once it submits a prompt — a tool or stop hook
   *  for a session this daemon never saw start is not worth a watchdog, and
   *  admitting it would let a burst of stray hooks fill the map. */
  noteHookEvent(sessionId: string, eventName: string, data: Record<string, unknown>): void {
    if (this.stopped || !sessionId) return;
    let entry = this.sessions.get(sessionId);
    if (!entry) {
      if (eventName !== 'UserPromptSubmit') return;
      entry = { watchdog: this.makeWatchdog(sessionId), lastSeenAt: this.now() };
      this.sessions.set(sessionId, entry);
      this.enforceCeiling();
    }
    entry.lastSeenAt = this.now();
    if (typeof data.cwd === 'string' && data.cwd) entry.cwd = data.cwd;
    if (typeof data.project_name === 'string' && data.project_name) entry.projectName = data.project_name;
    entry.watchdog.noteHookEvent(eventName, data);
  }

  /** Drop watchdogs for sessions that have gone cold. Call from an existing
   *  periodic tick — this class deliberately owns no timer of its own, so it
   *  cannot keep the daemon's event loop alive or double up on the sweep the
   *  daemon already runs. */
  sweep(): void {
    if (this.stopped) return;
    const cutoff = this.now() - this.idleMs;
    for (const [sid, entry] of this.sessions) {
      if (entry.lastSeenAt <= cutoff) this.drop(sid, entry);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const [sid, entry] of this.sessions) this.drop(sid, entry);
  }

  /** Tracked session count — for tests and diagnostics. */
  get size(): number {
    return this.sessions.size;
  }

  private makeWatchdog(sessionId: string): ClaudeTurnWatchdog {
    return new ClaudeTurnWatchdog({
      onMissedStop: ({ transcript_path }) => {
        const entry = this.sessions.get(sessionId);
        debug('watchdog', `observed session ${sessionId.slice(0, 8)} missed Stop — injecting synthetic Stop`);
        this.opts.onMissedStop({
          sessionId,
          transcriptPath: transcript_path,
          cwd: entry?.cwd,
          projectName: entry?.projectName,
        });
      },
      ...(this.opts.quietMs != null ? { quietMs: this.opts.quietMs } : {}),
      ...(this.opts.pollMs != null ? { pollMs: this.opts.pollMs } : {}),
      ...(this.opts.now ? { now: this.opts.now } : {}),
      ...(this.opts.probe ? { probe: this.opts.probe } : {}),
      ...(this.opts.mtimeMs ? { mtimeMs: this.opts.mtimeMs } : {}),
    });
  }

  private drop(sessionId: string, entry: Tracked): void {
    entry.watchdog.stop();
    this.sessions.delete(sessionId);
  }

  private enforceCeiling(): void {
    if (this.sessions.size <= this.maxSessions) return;
    const byAge = [...this.sessions.entries()].sort((a, b) => {
      if (a[1].lastSeenAt !== b[1].lastSeenAt) return a[1].lastSeenAt < b[1].lastSeenAt ? -1 : 1;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });
    for (const [sid, entry] of byAge) {
      if (this.sessions.size <= this.maxSessions) break;
      this.drop(sid, entry);
    }
  }
}
