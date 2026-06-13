import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  setAwaitingOverlay,
  getAwaitingOverlay,
  clearAwaitingOverlay,
  looksLikePermissionMessage,
  applyAwaitingOverlayToObserved,
  _resetAwaitingOverlay,
} from '../awaiting-overlay.js';

describe('awaiting-overlay', () => {
  beforeEach(() => {
    _resetAwaitingOverlay();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('set then get returns the trimmed question', () => {
    setAwaitingOverlay('sid-1', '  Claude needs your   permission to use Bash  ');
    expect(getAwaitingOverlay('sid-1')).toEqual({ question: 'Claude needs your permission to use Bash', requestId: undefined });
  });

  it('carries an optional requestId (actionable PreToolUse gate)', () => {
    setAwaitingOverlay('sid-1b', 'Allow Bash: npm test?', 'req-123');
    expect(getAwaitingOverlay('sid-1b')).toEqual({ question: 'Allow Bash: npm test?', requestId: 'req-123' });
  });

  it('returns undefined for an unknown session', () => {
    expect(getAwaitingOverlay('nope')).toBeUndefined();
  });

  it('expires after the TTL (5 min)', () => {
    setAwaitingOverlay('sid-2', 'wants to run a command');
    expect(getAwaitingOverlay('sid-2')).toBeDefined();
    vi.advanceTimersByTime(5 * 60_000 + 1);
    expect(getAwaitingOverlay('sid-2')).toBeUndefined();
  });

  it('re-setting refreshes the TTL (a follow-up prompt keeps the overlay alive)', () => {
    setAwaitingOverlay('sid-2b', 'first prompt');
    vi.advanceTimersByTime(4 * 60_000);
    setAwaitingOverlay('sid-2b', 'second prompt');
    // 4 min + 4 min exceeds the original entry's TTL, but the re-set entry is fresh.
    vi.advanceTimersByTime(4 * 60_000);
    expect(getAwaitingOverlay('sid-2b')).toEqual({ question: 'second prompt', requestId: undefined });
  });

  it('clear removes the entry and reports whether one existed', () => {
    setAwaitingOverlay('sid-3', 'permission to use Edit');
    expect(clearAwaitingOverlay('sid-3')).toBe(true);
    expect(getAwaitingOverlay('sid-3')).toBeUndefined();
    expect(clearAwaitingOverlay('sid-3')).toBe(false);
  });

  it('caps question length at 120 chars', () => {
    setAwaitingOverlay('sid-4', 'x'.repeat(300));
    expect(getAwaitingOverlay('sid-4')!.question.length).toBe(120);
  });

  describe('looksLikePermissionMessage', () => {
    it('matches real permission prompts', () => {
      expect(looksLikePermissionMessage('Claude needs your permission to use Bash')).toBe(true);
      expect(looksLikePermissionMessage('Claude is waiting for your input')).toBe(true);
      expect(looksLikePermissionMessage('Claude wants to run npm test')).toBe(true);
    });
    it('rejects idle pings and empty messages', () => {
      expect(looksLikePermissionMessage('')).toBe(false);
      expect(looksLikePermissionMessage('Claude has been idle for 60 seconds')).toBe(false);
    });
  });

  describe('applyAwaitingOverlayToObserved', () => {
    const observed = (id: string, state: string) => ({ id, state });

    it('flips a matching observed session to awaiting_permission with the question', () => {
      setAwaitingOverlay('uuid-abc', 'Claude needs your permission to use Bash');
      const out = applyAwaitingOverlayToObserved([
        observed('observed:claude:uuid-abc', 'processing'),
        observed('observed:claude:uuid-other', 'idle'),
      ]);
      expect(out[0]).toMatchObject({
        state: 'awaiting_permission',
        question: 'Claude needs your permission to use Bash',
      });
      // Unaffected session passes through unchanged.
      expect(out[1]).toEqual({ id: 'observed:claude:uuid-other', state: 'idle' });
    });

    it('matches the uuid after stripping the observed:claude: / observed:codex: prefix', () => {
      setAwaitingOverlay('uuid-xyz', 'wants to run a command');
      const claude = applyAwaitingOverlayToObserved([observed('observed:claude:uuid-xyz', 'processing')]);
      expect(claude[0].state).toBe('awaiting_permission');
      const codex = applyAwaitingOverlayToObserved([observed('observed:codex:uuid-xyz', 'processing')]);
      expect(codex[0].state).toBe('awaiting_permission');
    });

    it('leaves sessions untouched when no overlay exists', () => {
      const input = [observed('observed:claude:fresh', 'processing')];
      expect(applyAwaitingOverlayToObserved(input)).toEqual(input);
    });

    it('propagates the requestId for actionable gates', () => {
      setAwaitingOverlay('uuid-gate', 'Allow Bash: ls?', 'req-xyz');
      const out = applyAwaitingOverlayToObserved([observed('observed:claude:uuid-gate', 'processing')]);
      expect(out[0]).toMatchObject({ state: 'awaiting_permission', question: 'Allow Bash: ls?', requestId: 'req-xyz' });
    });
  });
});
