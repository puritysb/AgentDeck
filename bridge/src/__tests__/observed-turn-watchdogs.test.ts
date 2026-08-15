/**
 * Missed-Stop recovery for hook-OBSERVED Claude sessions.
 *
 * The per-session watchdog logic itself is pinned by claude-turn-watchdog.test.ts.
 * What is new here — and what the single-session class cannot express — is the
 * multiplexing: many sessions share one daemon process, so the failures worth
 * pinning are cross-session leakage (one session's Stop silencing another's
 * watchdog) and unbounded per-session timers on a daemon that runs for weeks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WATCHDOG_QUIET_MS, WATCHDOG_POLL_MS } from '../claude-turn-watchdog.js';
import {
  ObservedTurnWatchdogs,
  OBSERVED_WATCHDOG_IDLE_MS,
  type ObservedStopRecovery,
} from '../observed-turn-watchdogs.js';
import type { TurnEndProbe } from '../apme/claude-transcript-reader.js';

const TP_A = '/tmp/a.jsonl';
const TP_B = '/tmp/b.jsonl';

function endTurnNow(): TurnEndProbe {
  return { role: 'assistant', stopReason: 'end_turn', timestampMs: Date.now(), interrupted: false };
}

function make(opts: { probe?: (tp: string) => TurnEndProbe | null; maxSessions?: number } = {}) {
  const fired: ObservedStopRecovery[] = [];
  let mtime = 0;
  const mgr = new ObservedTurnWatchdogs({
    onMissedStop: (r) => fired.push(r),
    probe: opts.probe ?? (() => endTurnNow()),
    mtimeMs: () => ++mtime,
    ...(opts.maxSessions != null ? { maxSessions: opts.maxSessions } : {}),
  });
  return { mgr, fired };
}

/** Enough time for an armed watchdog to clear the quiet gate and poll. */
function elapse(multiplier = 2) {
  vi.advanceTimersByTime(WATCHDOG_QUIET_MS + WATCHDOG_POLL_MS * multiplier);
}

describe('ObservedTurnWatchdogs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('recovers a dropped Stop and reports the session it belongs to', () => {
    const { mgr, fired } = make();
    mgr.noteHookEvent('sess-a', 'UserPromptSubmit', { transcript_path: TP_A, cwd: '/w/a', project_name: 'alpha' });
    elapse();
    expect(fired).toEqual([
      { sessionId: 'sess-a', transcriptPath: TP_A, reason: 'end_turn', cwd: '/w/a', projectName: 'alpha' },
    ]);
  });

  it('keeps sessions independent — one session\'s Stop must not disarm another', () => {
    // The whole hazard of multiplexing. A shared watchdog would read B's Stop
    // as "the turn ended" and never recover A.
    const { mgr, fired } = make();
    mgr.noteHookEvent('sess-a', 'UserPromptSubmit', { transcript_path: TP_A });
    mgr.noteHookEvent('sess-b', 'UserPromptSubmit', { transcript_path: TP_B });
    mgr.noteHookEvent('sess-b', 'Stop', { transcript_path: TP_B });

    elapse();
    expect(fired.map((f) => f.sessionId)).toEqual(['sess-a']);
    expect(fired[0].transcriptPath).toBe(TP_A);
  });

  it('one session\'s tool traffic does not keep another\'s watchdog quiet', () => {
    // Each session's quiet timer must key on ITS own hooks. Sharing one would
    // mean a busy session permanently suppresses recovery for an idle one.
    const { mgr, fired } = make();
    mgr.noteHookEvent('busy', 'UserPromptSubmit', { transcript_path: TP_B });
    mgr.noteHookEvent('quiet', 'UserPromptSubmit', { transcript_path: TP_A });
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(4_000);
      mgr.noteHookEvent('busy', 'PostToolUse', { transcript_path: TP_B, tool_name: 'Bash' });
    }
    expect(fired.map((f) => f.sessionId)).toEqual(['quiet']);
  });

  it('a real Stop pre-empts recovery for that session', () => {
    const { mgr, fired } = make();
    mgr.noteHookEvent('sess-a', 'UserPromptSubmit', { transcript_path: TP_A });
    mgr.noteHookEvent('sess-a', 'Stop', { transcript_path: TP_A });
    elapse(5);
    expect(fired).toHaveLength(0);
  });

  it('the synthetic Stop it triggers disarms it, so it fires once per turn', () => {
    // The recovery re-enters the daemon's /hooks/Stop, which comes back
    // through noteHookEvent as a normal Stop. Without that feedback the
    // watchdog would re-fire every poll.
    const { mgr, fired } = make();
    mgr.noteHookEvent('sess-a', 'UserPromptSubmit', { transcript_path: TP_A });
    elapse();
    expect(fired).toHaveLength(1);
    mgr.noteHookEvent('sess-a', 'Stop', { transcript_path: TP_A, synthetic_stop: true });
    elapse(10);
    expect(fired).toHaveLength(1);
  });

  it('never closes a genuine wait (transcript still shows tool_use)', () => {
    // A permission prompt or an open AskUserQuestion leaves stop_reason
    // tool_use — force-closing there would answer for the user.
    const { mgr, fired } = make({
      probe: () => ({ role: 'assistant', stopReason: 'tool_use', timestampMs: Date.now(), interrupted: false }),
    });
    mgr.noteHookEvent('sess-a', 'UserPromptSubmit', { transcript_path: TP_A });
    elapse(5);
    expect(fired).toHaveLength(0);
  });

  it('only admits a session that has submitted a prompt', () => {
    // A stray tool/stop hook for a session this daemon never saw start is not
    // worth a watchdog, and admitting it lets hook noise fill the map.
    const { mgr } = make();
    mgr.noteHookEvent('stray', 'PostToolUse', { transcript_path: TP_A });
    mgr.noteHookEvent('stray', 'Stop', { transcript_path: TP_A });
    expect(mgr.size).toBe(0);
    mgr.noteHookEvent('stray', 'UserPromptSubmit', { transcript_path: TP_A });
    expect(mgr.size).toBe(1);
  });

  it('sweep() drops cold sessions so their poll timers cannot outlive them', () => {
    // An observed session that dies mid-turn (terminal closed, machine slept)
    // never sends SessionEnd. Its watchdog stays ARMED, polling every 5s for
    // the life of the daemon, unless the sweep collects it.
    const { mgr, fired } = make({ probe: () => null });
    mgr.noteHookEvent('gone', 'UserPromptSubmit', { transcript_path: TP_A });
    expect(mgr.size).toBe(1);

    vi.advanceTimersByTime(OBSERVED_WATCHDOG_IDLE_MS + 1_000);
    mgr.sweep();
    expect(mgr.size).toBe(0);
    expect(fired).toHaveLength(0);
  });

  it('sweep() leaves a session that is still posting hooks alone', () => {
    const { mgr } = make({ probe: () => null });
    mgr.noteHookEvent('live', 'UserPromptSubmit', { transcript_path: TP_A });
    vi.advanceTimersByTime(OBSERVED_WATCHDOG_IDLE_MS - 1_000);
    mgr.noteHookEvent('live', 'PostToolUse', { transcript_path: TP_A });
    vi.advanceTimersByTime(OBSERVED_WATCHDOG_IDLE_MS - 1_000);
    mgr.sweep();
    expect(mgr.size).toBe(1);
  });

  it('caps tracked sessions, evicting the coldest first', () => {
    // Backstop for a daemon that runs for weeks: without a ceiling the map
    // grows by one entry per session seen between sweeps.
    const { mgr, fired } = make({ maxSessions: 3 });
    for (const sid of ['s1', 's2', 's3']) {
      mgr.noteHookEvent(sid, 'UserPromptSubmit', { transcript_path: TP_A });
      vi.advanceTimersByTime(1_000);
    }
    expect(mgr.size).toBe(3);
    mgr.noteHookEvent('s4', 'UserPromptSubmit', { transcript_path: TP_A });
    expect(mgr.size).toBe(3);

    // s1 was the coldest, so it is the one that went — and eviction means its
    // timer is gone, not merely that it left the map.
    elapse();
    expect(fired.map((f) => f.sessionId).sort()).toEqual(['s2', 's3', 's4']);
  });

  it('stop() (daemon teardown) kills every session timer', () => {
    // A watchdog surviving teardown would keep self-POSTing at a port this
    // daemon no longer owns.
    const { mgr, fired } = make();
    mgr.noteHookEvent('sess-a', 'UserPromptSubmit', { transcript_path: TP_A });
    mgr.noteHookEvent('sess-b', 'UserPromptSubmit', { transcript_path: TP_B });
    mgr.stop();
    expect(mgr.size).toBe(0);
    elapse(10);
    expect(fired).toHaveLength(0);
    // And it stays stopped.
    mgr.noteHookEvent('sess-c', 'UserPromptSubmit', { transcript_path: TP_A });
    expect(mgr.size).toBe(0);
  });
});
