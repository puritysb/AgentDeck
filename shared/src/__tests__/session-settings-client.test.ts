import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionSettingsRequestTracker } from '../session-settings-client.js';
import { SESSION_SETTINGS_RULES } from '../session-settings.js';
import type { SessionSettingsEvent } from '../protocol.js';

const settings = [{ key: 'effort' as const, options: [{ id: 'high' }] }];
const answer = (request: { sessionId: string; requestId: string }, patch: Partial<SessionSettingsEvent> = {}): SessionSettingsEvent => ({ ...request, type: 'session_settings', targetSessionKey: 'agent:main', settings, ...patch });

describe('settings client request lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  it('bounds silence, notifies the renderer, and rejects late replies', () => {
    vi.useFakeTimers();
    const tracker = new SessionSettingsRequestTracker();
    tracker.onChanged = vi.fn();
    const query = tracker.query('gateway');
    vi.advanceTimersByTime(SESSION_SETTINGS_RULES.requestTimeoutMs - 1);
    expect(tracker.snapshot('gateway')?.pending).toBe('query');
    vi.advanceTimersByTime(1);
    expect(tracker.snapshot('gateway')).toMatchObject({ error: 'No response from daemon', pending: undefined });
    expect(tracker.onChanged).toHaveBeenCalledWith('gateway');
    expect(tracker.accept(answer(query))).toBeUndefined();
  });

  it('rejects stale, foreign-session and wrong-target responses', () => {
    const tracker = new SessionSettingsRequestTracker();
    const old = tracker.query('gateway');
    const query = tracker.query('gateway');
    expect(tracker.accept(answer(old))).toBeUndefined();
    expect(tracker.accept(answer(query, { sessionId: 'other' }))).toBeUndefined();
    expect(tracker.accept(answer(query))).toBe('query');
    const set = tracker.set('gateway', 'effort', null)!;
    expect(set).toMatchObject({ value: null, targetSessionKey: 'agent:main' });
    expect(set.requestId).not.toBe(query.requestId);
    expect(tracker.set('gateway', 'effort', 'high')).toBeUndefined();
    expect(tracker.accept(answer(set, { targetSessionKey: 'agent:new' }))).toBeUndefined();
    expect(tracker.snapshot('gateway')?.pending).toBe('set');
    expect(tracker.accept(answer(set, { error: 'refused' }))).toBe('set');
    expect(tracker.snapshot('gateway')).toMatchObject({ error: 'refused', settings });
    expect(tracker.snapshot('gateway')?.pending).toBeUndefined();
    tracker.disconnect();
  });

  it('cancels closed/disconnected pickers and never treats undefined as DEFAULT', () => {
    const tracker = new SessionSettingsRequestTracker();
    const query = tracker.query('gateway');
    tracker.cancel();
    expect(tracker.accept(answer(query))).toBeUndefined();
    const fresh = tracker.query('gateway');
    tracker.accept(answer(fresh));
    expect(tracker.set('gateway', 'effort', undefined as unknown as null)).toBeUndefined();
    expect(tracker.set('gateway', 'effort', 'x'.repeat(SESSION_SETTINGS_RULES.maxValueLength + 1))).toBeUndefined();
    const set = tracker.set('gateway', 'effort', 'high')!;
    tracker.disconnect();
    expect(tracker.accept(answer(set))).toBeUndefined();
    expect(tracker.snapshot('gateway')).toBeUndefined();
  });
});
