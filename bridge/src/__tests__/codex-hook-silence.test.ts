import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CodexHookSilenceWarning,
  CODEX_HOOK_SILENCE_GRACE_MS,
  CODEX_HOOK_SILENCE_MIN_ACTIVITY,
} from '../codex-hook-silence.js';

function activity(w: CodexHookSilenceWarning, n: number) {
  for (let i = 0; i < n; i++) w.noteActivity();
}

describe('CodexHookSilenceWarning', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('warns once when the PTY is active but no codex_* event ever arrived', () => {
    const onSilent = vi.fn();
    const w = new CodexHookSilenceWarning({ onSilent });
    activity(w, CODEX_HOOK_SILENCE_MIN_ACTIVITY + 5);
    vi.advanceTimersByTime(CODEX_HOOK_SILENCE_GRACE_MS + 1_000);
    expect(onSilent).toHaveBeenCalledTimes(1);
    // Further activity must not re-warn.
    activity(w, 50);
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when any codex hook event arrives (channel proven)', () => {
    const onSilent = vi.fn();
    const w = new CodexHookSilenceWarning({ onSilent });
    activity(w, 20);
    w.noteHookEvent();
    vi.advanceTimersByTime(CODEX_HOOK_SILENCE_GRACE_MS * 2);
    expect(onSilent).not.toHaveBeenCalled();
  });

  it('stays quiet when the terminal was barely used (session may not have started)', () => {
    const onSilent = vi.fn();
    const w = new CodexHookSilenceWarning({ onSilent });
    activity(w, 2);
    vi.advanceTimersByTime(CODEX_HOOK_SILENCE_GRACE_MS + 1_000);
    expect(onSilent).not.toHaveBeenCalled();
  });

  it('warns late when activity only crosses the threshold after the deadline', () => {
    const onSilent = vi.fn();
    const w = new CodexHookSilenceWarning({ onSilent });
    vi.advanceTimersByTime(CODEX_HOOK_SILENCE_GRACE_MS + 1_000);
    expect(onSilent).not.toHaveBeenCalled();
    activity(w, CODEX_HOOK_SILENCE_MIN_ACTIVITY);
    expect(onSilent).toHaveBeenCalledTimes(1);
  });

  it('stop() disarms (session shutdown)', () => {
    const onSilent = vi.fn();
    const w = new CodexHookSilenceWarning({ onSilent });
    activity(w, 20);
    w.stop();
    vi.advanceTimersByTime(CODEX_HOOK_SILENCE_GRACE_MS * 2);
    expect(onSilent).not.toHaveBeenCalled();
  });
});
