import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeTurnWatchdog, WATCHDOG_QUIET_MS, WATCHDOG_POLL_MS } from '../claude-turn-watchdog.js';
import { CLIENT_ABORT_STOP_REASON, type TurnEndProbe } from '../apme/claude-transcript-reader.js';

const TP = '/tmp/fake-transcript.jsonl';

function makeWatchdog(overrides: {
  probe?: () => TurnEndProbe | null;
  mtimeMs?: () => number | null;
} = {}) {
  const fired: Array<{ transcript_path: string; reason: string }> = [];
  let mtimeCounter = 0;
  const wd = new ClaudeTurnWatchdog({
    onMissedStop: (d) => fired.push(d),
    // Default mtime advances every call so the mtime gate never suppresses
    // probes unless a test overrides it.
    mtimeMs: overrides.mtimeMs ?? (() => ++mtimeCounter),
    probe: overrides.probe ?? (() => null),
  });
  return { wd, fired };
}

function endTurnAt(ts: number): TurnEndProbe {
  return { role: 'assistant', stopReason: 'end_turn', timestampMs: ts, interrupted: false };
}

/** The tail Claude Code leaves after ESC: a `user` record carrying the
 *  interrupt marker, and no assistant `end_turn` anywhere. */
function interruptAt(ts: number): TurnEndProbe {
  return { role: 'user', stopReason: null, timestampMs: ts, interrupted: true };
}

/** The tail Claude Code leaves when the CLIENT ends the turn — usage limit,
 *  expired auth, an API 429/529. An assistant record carrying the message the
 *  user sees, and no Stop hook behind it. */
function abortAt(ts: number): TurnEndProbe {
  return { role: 'assistant', stopReason: CLIENT_ABORT_STOP_REASON, timestampMs: ts, interrupted: false };
}

describe('ClaudeTurnWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('closes a turn whose Stop was dropped once the transcript shows end_turn', () => {
    let probeResult: TurnEndProbe | null = null;
    const { wd, fired } = makeWatchdog({ probe: () => probeResult });

    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    // Turn finishes in the transcript shortly after, but no Stop arrives.
    probeResult = endTurnAt(Date.now() + 3_000);

    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 2);
    expect(fired).toEqual([{ transcript_path: TP, reason: 'end_turn' }]);
  });

  it('fires at most once per turn', () => {
    const { wd, fired } = makeWatchdog({ probe: () => endTurnAt(Date.now()) });
    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 10);
    expect(fired).toHaveLength(1);
  });

  it('ignores the previous turn\'s end_turn (timestamp before turn open)', () => {
    const stale = endTurnAt(Date.now() - 60_000);
    const { wd, fired } = makeWatchdog({ probe: () => stale });
    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 3);
    expect(fired).toHaveLength(0);
  });

  it('closes a turn the user cancelled, tagged as an interrupt rather than a loss', () => {
    // ESC produces NO hook of any kind and no assistant end_turn, so a
    // watchdog that only looked for end_turn left the session PROCESSING
    // until the stuck timeout and charged the turn to the dropped-Stop rate.
    let probeResult: TurnEndProbe | null = null;
    const { wd, fired } = makeWatchdog({ probe: () => probeResult });

    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    probeResult = interruptAt(Date.now() + 3_000);

    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 2);
    expect(fired).toEqual([{ transcript_path: TP, reason: 'interrupted' }]);
  });

  it('closes a turn the client aborted (usage limit / auth / API error)', () => {
    // Claude Code writes one assistant record with the abort stop reason and
    // fires no Stop hook, so `end_turn` alone left these turns open for hours
    // — PROCESSING on every device, the APME run open behind them — until the
    // next prompt displaced them and filed them as dropped hooks.
    let probeResult: TurnEndProbe | null = null;
    const { wd, fired } = makeWatchdog({ probe: () => probeResult });

    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    probeResult = abortAt(Date.now() + 3_000);

    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 2);
    expect(fired).toEqual([{ transcript_path: TP, reason: 'aborted' }]);
  });

  it('ignores the previous turn\'s abort', () => {
    const stale = abortAt(Date.now() - 60_000);
    const { wd, fired } = makeWatchdog({ probe: () => stale });
    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 3);
    expect(fired).toHaveLength(0);
  });

  it('ignores the previous turn\'s interrupt marker', () => {
    // Same guard as the stale end_turn: a cancel from before this turn opened
    // is evidence about the previous turn, and closing on it would end a live
    // turn the moment it started.
    const stale = interruptAt(Date.now() - 60_000);
    const { wd, fired } = makeWatchdog({ probe: () => stale });
    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 3);
    expect(fired).toHaveLength(0);
  });

  it('a plain user record is not an interrupt', () => {
    // The marker flag is the whole signal — a `user` tail is otherwise the
    // normal mid-turn shape (a tool_result), which must never force-close.
    const { wd, fired } = makeWatchdog({
      probe: () => ({ role: 'user', stopReason: null, timestampMs: Date.now(), interrupted: false }),
    });
    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 5);
    expect(fired).toHaveLength(0);
  });

  it('never closes a genuine wait (stop_reason tool_use)', () => {
    const { wd, fired } = makeWatchdog({
      probe: () => ({ role: 'assistant', stopReason: 'tool_use', timestampMs: Date.now(), interrupted: false }),
    });
    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 5);
    expect(fired).toHaveLength(0);
  });

  it('does not probe while the hook channel is active', () => {
    const probe = vi.fn(() => endTurnAt(Date.now()));
    const { wd, fired } = makeWatchdog({ probe });
    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    // Tool hooks keep arriving every 4s — quieter than quietMs never elapses.
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(4_000);
      wd.noteHookEvent('PostToolUse', { transcript_path: TP, tool_name: 'Bash' });
    }
    expect(probe).not.toHaveBeenCalled();
    expect(fired).toHaveLength(0);
  });

  it('disarms when the real Stop arrives', () => {
    const probe = vi.fn(() => endTurnAt(Date.now()));
    const { wd, fired } = makeWatchdog({ probe });
    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    wd.noteHookEvent('Stop', { transcript_path: TP });
    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 5);
    expect(fired).toHaveLength(0);
  });

  it('skips the transcript read when mtime has not advanced', () => {
    const probe = vi.fn(() => null);
    const { wd } = makeWatchdog({ probe, mtimeMs: () => 42 });
    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 6);
    // First eligible poll reads once; identical mtime suppresses the rest.
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('disarms on SessionEnd without killing later recovery (/clear fires SessionEnd mid-session)', () => {
    const { wd, fired } = makeWatchdog({ probe: () => endTurnAt(Date.now()) });
    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    wd.noteHookEvent('SessionEnd', {});
    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 5);
    expect(fired).toHaveLength(0);
    // /clear pairs SessionEnd with SessionStart and the bridge session lives
    // on — the next turn's missed Stop must still be recoverable.
    wd.noteHookEvent('SessionStart', { transcript_path: TP });
    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 2);
    expect(fired).toHaveLength(1);
  });

  it('stop() (bridge shutdown) disarms permanently', () => {
    const { wd, fired } = makeWatchdog({ probe: () => endTurnAt(Date.now()) });
    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    wd.stop();
    wd.noteHookEvent('UserPromptSubmit', { transcript_path: TP });
    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 5);
    expect(fired).toHaveLength(0);
  });

  it('waits without a transcript path and recovers once one is learned', () => {
    const { wd, fired } = makeWatchdog({ probe: () => endTurnAt(Date.now()) });
    wd.noteHookEvent('UserPromptSubmit', {});
    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 2);
    expect(fired).toHaveLength(0);
    // A later hook supplies the path (all Claude hook payloads carry it).
    wd.noteHookEvent('PostToolUse', { transcript_path: TP });
    vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * 2);
    expect(fired).toEqual([{ transcript_path: TP, reason: 'end_turn' }]);
  });
});
