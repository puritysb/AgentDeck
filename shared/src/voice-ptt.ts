/**
 * Hold-to-talk state and wire mapping for every deck's VOICE key.
 *
 * Shared because the two decks must not disagree about what a press means. The
 * D200H originally used a tap-toggle instead — a press started the capture and
 * a SECOND press was supposed to stop it — which put the stop behind a tile
 * that only flips once the daemon's `voice_state` has come back. A user with
 * Stream Deck muscle memory holds the key instead, so nothing ever stopped the
 * capture and it ran to its 30 s cap (measured on hardware 2026-08-08: keydown
 * 17:35:10.399, key release 17:35:13.298, no second press). Both decks now hold
 * to talk, and neither depends on the tile having flipped.
 *
 * Kept free of SDK types so Vitest can drive it directly: the decorated Stream
 * Deck action class and the Ulanzi main service both only forward events here.
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

  /**
   * Cancel whatever hold is open, whichever key owns it.
   *
   * `disappear` needs the key's id; the events that make a release
   * undeliverable — the host socket closing, the daemon link dropping — do not
   * carry one. Without this the capture would run to the daemon's 30s cap and
   * deliver the room as a prompt.
   */
  cancelActive(): VoicePttDispatch | null {
    if (!this.active) return null;
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
