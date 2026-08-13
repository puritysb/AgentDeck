/**
 * Codex hook-silence warning — detects the "lifecycle channel dead on
 * arrival" failure with zero signal today.
 *
 * Codex lifecycle hooks AND the notify turn-complete fallback ride the same
 * mechanism (a curl POST to this bridge's AGENTDECK_PORT, installed in
 * ~/.codex/config.toml), so they share failure modes: a stale port in the
 * config, a hooks.json/inline-[hooks] layer conflict, or a broken curl kills
 * both at once. Since the PTY fallback state machine was removed (1.0.19), a
 * managed Codex session in that condition is lifecycle-blind silently —
 * no state changes, no timeline, no APME — while the terminal itself works.
 *
 * Detection is deliberately modest: if the PTY has produced real activity but
 * NO codex_* hook or notify event has EVER arrived by the grace deadline, the
 * install is broken — warn once (log + timeline row). The first hook event
 * proves the channel and disarms permanently; mid-session hook death is out
 * of scope (it cannot be distinguished from an idle session without parsing
 * the screen, which lifecycle correctness must not do).
 *
 * `--no-codex-hooks` opted out of lifecycle monitoring explicitly; callers
 * must not arm this warning in that case (cli.ts already prints the
 * degradation notice at startup).
 */

import { debug } from './logger.js';

/** How long after session start to expect the first codex_* event.
 *  codex_session_start fires immediately on launch, so one grace period
 *  covers slow starts without a turn ever being submitted. */
export const CODEX_HOOK_SILENCE_GRACE_MS = 120_000;
/** Minimum PTY activity events before silence is judged — a session that
 *  never rendered anything may simply not have started. */
export const CODEX_HOOK_SILENCE_MIN_ACTIVITY = 10;

export interface CodexHookSilenceOptions {
  onSilent: () => void;
  graceMs?: number;
  minActivity?: number;
}

export class CodexHookSilenceWarning {
  private readonly onSilent: () => void;
  private readonly minActivity: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private activityCount = 0;
  private hookSeen = false;
  private deadlinePassed = false;

  constructor(opts: CodexHookSilenceOptions) {
    this.onSilent = opts.onSilent;
    this.minActivity = opts.minActivity ?? CODEX_HOOK_SILENCE_MIN_ACTIVITY;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deadlinePassed = true;
      this.judge();
    }, opts.graceMs ?? CODEX_HOOK_SILENCE_GRACE_MS);
    this.timer.unref?.();
  }

  /** Any codex_* hook or notify event proves the channel; disarms forever. */
  noteHookEvent(): void {
    if (this.hookSeen) return;
    this.hookSeen = true;
    this.stop();
  }

  /** PTY activity — the terminal is being used. If the grace deadline already
   *  passed with too little activity, late activity re-judges once. */
  noteActivity(): void {
    this.activityCount++;
    if (this.deadlinePassed) this.judge();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.deadlinePassed = false;
  }

  private judge(): void {
    if (this.hookSeen) return;
    if (this.activityCount < this.minActivity) return;
    this.deadlinePassed = false; // fire once
    debug('codex', `hook silence: ${this.activityCount} PTY activity events, zero codex_* hooks`);
    this.onSilent();
  }
}
