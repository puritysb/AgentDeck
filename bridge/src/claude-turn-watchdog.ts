/**
 * Claude turn watchdog — closes a managed turn whose Stop hook was dropped.
 *
 * The Stop hook is the sole authority that closes a Claude turn (state → IDLE,
 * timeline chat_response/chat_end, APME turn response), but its delivery is
 * not guaranteed: the hook curl is fire-and-forget with a tight budget, and
 * historically it has been observed to drop at a meaningful rate. Since the
 * PTY spinner/ring-buffer fallbacks were removed (1.0.19), a dropped Stop left
 * the session stuck PROCESSING for STUCK_TIMEOUT_MS and the timeline/APME turn
 * open until the next prompt.
 *
 * Doctrine: recovery reads the durable log, not the screen. While a turn is
 * open and the hook channel has been quiet, the watchdog probes the
 * transcript JSONL tail (the same authority the Stop branch itself reads).
 * A tail whose last message-bearing record is `assistant` + `end_turn`,
 * stamped after this turn opened, proves the turn finished — the watchdog
 * then injects a synthetic Stop through the normal adapter event pipe so
 * state machine, timeline, and APME all close through their existing paths.
 *
 * A turn the user CANCELLED (ESC) ends the same way as far as every consumer
 * is concerned, but it never produces an `end_turn` and fires no hook at all,
 * so it would otherwise sit PROCESSING until the stuck timeout and be charged
 * to the dropped-Stop rate. The interrupt marker in the transcript is the only
 * evidence that exists, so it closes the turn too — tagged `interrupted`, kept
 * out of the loss measurement, because no hook was lost here.
 *
 * A third ending has the same shape and used to be invisible: the CLIENT aborts
 * the turn — usage limit reached, auth expired, an API 429/529. Claude Code
 * writes one assistant record with `stop_reason: "stop_sequence"` carrying the
 * message the user sees and fires no Stop hook. Both times this happened in the
 * measured week the turn stayed open for over eight hours (state PROCESSING on
 * every device, the APME run open behind it) until the next morning's prompt
 * displaced it, and each was then filed as a dropped hook. `end_turn` was too
 * narrow a predicate for "the turn is over".
 *
 * False-positive guards:
 *  - `stop_reason: "tool_use"` (permission prompt / AskUserQuestion open,
 *    tools running) never matches, so a genuine wait is never force-closed.
 *  - The end_turn record must be newer than this turn's open time, so the
 *    previous turn's end_turn cannot close a freshly opened turn.
 *  - A transcript mtime older than the last probe skips the read entirely,
 *    so an idle prompt does not re-read 512 KB every poll.
 *  - If a real Stop (or SessionEnd) arrives first, the watchdog disarms; a
 *    synthetic Stop after a real one is deduped downstream
 *    (ccPendingCompletion / transition-table guards).
 */

import { statSync } from 'fs';
import { readTurnEndProbe, CLIENT_ABORT_STOP_REASON, type TurnEndProbe } from './apme/claude-transcript-reader.js';
import { debug } from './logger.js';

/** Hook-channel silence required before the transcript is consulted. */
export const WATCHDOG_QUIET_MS = 10_000;
/** Poll cadence while a turn is open. */
export const WATCHDOG_POLL_MS = 5_000;
/** Clock slack when comparing a record timestamp to the turn-open time. */
const TURN_OPEN_SLACK_MS = 2_000;

/** Why the transcript says the open turn is over. `end_turn` is a Stop that
 *  was dropped in flight; `interrupted` is a turn the user cancelled and
 *  `aborted` one the client ended (usage limit, auth, API error), for neither
 *  of which a Stop was ever due. All three close the turn identically and are
 *  counted apart — only the first is a lost hook. */
export type TurnEndReason = 'end_turn' | 'interrupted' | 'aborted';

export interface ClaudeTurnWatchdogOptions {
  /** Called when the transcript proves the open turn ended without a Stop. */
  onMissedStop: (data: { transcript_path: string; reason: TurnEndReason }) => void;
  quietMs?: number;
  pollMs?: number;
  /** Injectable for tests. */
  now?: () => number;
  probe?: (transcriptPath: string) => TurnEndProbe | null;
  mtimeMs?: (transcriptPath: string) => number | null;
}

export class ClaudeTurnWatchdog {
  private readonly onMissedStop: (data: { transcript_path: string; reason: TurnEndReason }) => void;
  private readonly quietMs: number;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly probe: (transcriptPath: string) => TurnEndProbe | null;
  private readonly mtimeMs: (transcriptPath: string) => number | null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private turnOpenedAt: number | null = null;
  private lastHookAt = 0;
  private transcriptPath = '';
  private lastProbedMtimeMs = -1;
  private stopped = false;

  constructor(opts: ClaudeTurnWatchdogOptions) {
    this.onMissedStop = opts.onMissedStop;
    this.quietMs = opts.quietMs ?? WATCHDOG_QUIET_MS;
    this.pollMs = opts.pollMs ?? WATCHDOG_POLL_MS;
    this.now = opts.now ?? Date.now;
    this.probe = opts.probe ?? readTurnEndProbe;
    this.mtimeMs = opts.mtimeMs ?? defaultMtimeMs;
  }

  /** Feed every hook-sourced adapter event through here (synthetic ones too —
   *  the synthetic Stop closes the turn like a real one). */
  noteHookEvent(eventName: string, data: Record<string, unknown> | undefined): void {
    if (this.stopped) return;
    this.lastHookAt = this.now();
    const tp = data?.transcript_path;
    if (typeof tp === 'string' && tp) this.transcriptPath = tp;

    switch (eventName) {
      case 'UserPromptSubmit':
        this.turnOpenedAt = this.now();
        this.lastProbedMtimeMs = -1;
        this.arm();
        break;
      case 'Stop':
        this.turnOpenedAt = null;
        this.disarm();
        break;
      case 'SessionEnd':
        // Disarm, but do NOT latch `stopped`: Claude Code fires SessionEnd on
        // /clear too (paired with a SessionStart), and the bridge session
        // lives on. A permanent latch here would disable missed-Stop recovery
        // for the rest of the session after the first /clear. Permanent stop
        // is the bridge shutdown path (core.onShutdown → stop()).
        this.turnOpenedAt = null;
        this.disarm();
        break;
      default:
        break;
    }
  }

  stop(): void {
    this.stopped = true;
    this.turnOpenedAt = null;
    this.disarm();
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.check(), this.pollMs);
    // Never hold the process open for the watchdog alone.
    this.timer.unref?.();
  }

  private disarm(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private check(): void {
    if (this.stopped || this.turnOpenedAt == null || !this.transcriptPath) return;
    if (this.now() - this.lastHookAt < this.quietMs) return;

    // Cheap gate: nothing appended since the last probe means the verdict
    // cannot have changed (a genuinely-awaiting prompt writes nothing).
    const mtime = this.mtimeMs(this.transcriptPath);
    if (mtime != null && mtime === this.lastProbedMtimeMs) return;
    if (mtime != null) this.lastProbedMtimeMs = mtime;

    const probe = this.probe(this.transcriptPath);
    if (!probe) return;
    const finished = probe.role === 'assistant' && probe.stopReason === 'end_turn';
    // A client abort is an assistant record too, but with the abort stop
    // reason — mutually exclusive with `end_turn`, never a refinement of it.
    const aborted = probe.role === 'assistant' && probe.stopReason === CLIENT_ABORT_STOP_REASON;
    // The marker is a `user` record, so it can never satisfy `finished` — the
    // three are alternatives, not refinements of one another.
    const reason: TurnEndReason | null = finished ? 'end_turn'
      : probe.interrupted ? 'interrupted'
        : aborted ? 'aborted'
          : null;
    if (!reason) return;
    if (probe.timestampMs == null) return;
    if (probe.timestampMs < this.turnOpenedAt - TURN_OPEN_SLACK_MS) return;

    debug('watchdog', `turn closed from transcript (${reason} @ ${probe.timestampMs})`);
    const transcriptPath = this.transcriptPath;
    this.turnOpenedAt = null;
    this.disarm();
    this.onMissedStop({ transcript_path: transcriptPath, reason });
  }
}

function defaultMtimeMs(transcriptPath: string): number | null {
  try {
    return statSync(transcriptPath).mtimeMs;
  } catch {
    return null;
  }
}
