import { describe, expect, it } from 'vitest';
import { PTT_MIN_HOLD_MS, VoicePttHold, voiceCommandForAction } from '../voice-ptt.js';

describe('Stream Deck VOICE hold lifecycle', () => {
  it('maps key-down plus a real hold to begin then end', () => {
    const hold = new VoicePttHold();
    hold.begin('key-1', 'session-1', 1_000);
    expect(voiceCommandForAction('voice-ptt-begin', 'session-1')).toEqual({
      type: 'voice', action: 'start', sessionId: 'session-1',
    });
    expect(hold.release('key-1', 1_000 + PTT_MIN_HOLD_MS)).toEqual({
      action: 'voice-ptt-end', sessionId: 'session-1',
    });
  });

  it('cancels a key-clack tap shorter than the minimum hold', () => {
    const hold = new VoicePttHold();
    hold.begin('key-1', 'session-1', 1_000);
    expect(hold.release('key-1', 1_000 + PTT_MIN_HOLD_MS - 1)).toEqual({
      action: 'voice-ptt-cancel', sessionId: 'session-1',
    });
  });

  it('cancels a held key that disappears during a page or profile switch', () => {
    const hold = new VoicePttHold();
    hold.begin('key-1', 'session-1', 1_000);
    expect(hold.disappear('key-1')).toEqual({
      action: 'voice-ptt-cancel', sessionId: 'session-1',
    });
    expect(hold.release('key-1', 2_000)).toBeNull();
  });

  it('ignores lifecycle events from another action instance', () => {
    const hold = new VoicePttHold();
    hold.begin('key-1', 'session-1', 1_000);
    expect(hold.release('key-2', 2_000)).toBeNull();
    expect(hold.disappear('key-2')).toBeNull();
    expect(hold.release('key-1', 2_000)).toEqual({
      action: 'voice-ptt-end', sessionId: 'session-1',
    });
  });

  it('maps terminal PTT actions to daemon wire commands', () => {
    expect(voiceCommandForAction('voice-ptt-end', 's')).toEqual({ type: 'voice', action: 'stop', sessionId: 's' });
    expect(voiceCommandForAction('voice-ptt-cancel', 's')).toEqual({ type: 'voice', action: 'cancel', sessionId: 's' });
    expect(voiceCommandForAction('refresh-usage', 's')).toBeNull();
  });
});

describe('cancelActive — releases that can never arrive', () => {
  // The capture's lifetime is the keydown/keyUp pair, so the events that make a
  // release undeliverable (host socket closed, daemon link dropped) must end
  // the hold themselves. They carry no key id, which is why `disappear` cannot
  // serve here.
  it('cancels the open hold without knowing which key owns it', () => {
    const hold = new VoicePttHold();
    hold.begin('ctx-a', 'session-1');
    expect(hold.cancelActive()).toEqual({ action: 'voice-ptt-cancel', sessionId: 'session-1' });
  });

  it('is a no-op when nothing is held, so a stray socket close sends nothing', () => {
    expect(new VoicePttHold().cancelActive()).toBeNull();
  });

  it('does not fire twice for one hold', () => {
    const hold = new VoicePttHold();
    hold.begin('ctx-a', 'session-1');
    hold.cancelActive();
    expect(hold.cancelActive()).toBeNull();
    expect(hold.release('ctx-a')).toBeNull();
  });
});
