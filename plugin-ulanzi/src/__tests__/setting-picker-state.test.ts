import { describe, expect, it } from 'vitest';
import type { DeckView, SessionSettingsEvent } from '@agentdeck/shared';
import { settingsPickerAfterResponse } from '../setting-picker-state.js';

const view: DeckView = { mode: 'detail', openSessionId: 'gateway', picker: 'model', page: 2 };
const reply: SessionSettingsEvent = { type: 'session_settings', sessionId: 'gateway', requestId: 'matched', targetSessionKey: 'agent:main', settings: [] };

describe('Ulanzi picker response projection', () => {
  it('returns a refused later-page mutation to the visible error page without closing', () => {
    expect(settingsPickerAfterResponse(view, { ...reply, error: 'refused' }, 'set')).toEqual({ ...view, page: 0 });
  });
  it('closes a matching successful mutation and resets its page', () => {
    expect(settingsPickerAfterResponse(view, reply, 'set')).toEqual({ ...view, picker: undefined, page: 0 });
  });
  it('keeps query answers open and leaves unaccepted or other-session responses alone', () => {
    expect(settingsPickerAfterResponse(view, reply, 'query')).toEqual({ ...view, page: 0 });
    expect(settingsPickerAfterResponse(view, reply, undefined)).toBe(view);
    expect(settingsPickerAfterResponse(view, { ...reply, sessionId: 'other' }, 'set')).toBe(view);
  });
});
