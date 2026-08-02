/**
 * Testable hold-to-talk state and wire mapping for the Stream Deck VOICE key.
 *
 * The decorated Stream Deck action class is not loaded by Vitest, so the
 * key-down/key-up/disappear transition logic lives here and the action only
 * forwards SDK events into it.
 */

export const PTT_MIN_HOLD_MS = 250;

export type VoicePttAction = 'voice-ptt-begin' | 'voice-ptt-end' | 'voice-ptt-cancel';

export interface VoicePttDispatch {
  action: VoicePttAction;
  sessionId?: string;
}

interface ActiveHold {
  actionId: string;
  sessionId?: string;
  downAt: number;
}

export class VoicePttHold {
  private active: ActiveHold | null = null;

  begin(actionId: string, sessionId?: string, downAt = Date.now()): void {
    this.active = { actionId, sessionId, downAt };
  }

  release(actionId: string, now = Date.now()): VoicePttDispatch | null {
    if (!this.active || this.active.actionId !== actionId) return null;
    const hold = this.active;
    this.active = null;
    return {
      action: now - hold.downAt < PTT_MIN_HOLD_MS ? 'voice-ptt-cancel' : 'voice-ptt-end',
      sessionId: hold.sessionId,
    };
  }

  disappear(actionId: string): VoicePttDispatch | null {
    if (!this.active || this.active.actionId !== actionId) return null;
    const hold = this.active;
    this.active = null;
    return { action: 'voice-ptt-cancel', sessionId: hold.sessionId };
  }
}

export interface VoiceWireCommand {
  type: 'voice';
  action: 'start' | 'stop' | 'cancel';
  sessionId?: string;
}

export function voiceCommandForAction(action: string, sessionId?: string): VoiceWireCommand | null {
  switch (action) {
    case 'voice-ptt-begin': return { type: 'voice', action: 'start', sessionId };
    case 'voice-ptt-end': return { type: 'voice', action: 'stop', sessionId };
    case 'voice-ptt-cancel': return { type: 'voice', action: 'cancel', sessionId };
    default: return null;
  }
}
