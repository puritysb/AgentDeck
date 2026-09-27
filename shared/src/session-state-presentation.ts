/**
 * Session state presentation — the one mapping from a wire session state to
 * what every product surface shows for it: a tone, its colour on a dark
 * screen, its colour on paper, and its words. DESIGN.md §2.7.
 *
 * Colours are not literals here: they come from the `Session` group in
 * design/tokens.css (via the TS mirror), so a designer changes a state's
 * colour in one place. `pnpm generate-session-state` emits the Swift, Kotlin
 * and ESP32 C++ mirrors; the shared test gates drift, contrast and the
 * vocabulary. No surface keeps its own state→colour switch.
 */
import { State } from './states.js';
import { Session } from './design-tokens.js';
import { toPaperColor } from './paper-palette.js';

/** What a state means to a person glancing at a surface. The three awaiting
 * states differ in what they ask for, not in how urgent they are. */
export type SessionTone = 'idle' | 'working' | 'awaiting' | 'offline';

export const SESSION_TONES: readonly SessionTone[] = ['idle', 'working', 'awaiting', 'offline'];

export const SESSION_STATE_TONES: Record<State, SessionTone> = {
  [State.IDLE]: 'idle',
  [State.PROCESSING]: 'working',
  [State.AWAITING_PERMISSION]: 'awaiting',
  [State.AWAITING_OPTION]: 'awaiting',
  [State.AWAITING_DIFF]: 'awaiting',
  [State.DISCONNECTED]: 'offline',
};

/** A missing state is "no live information" (offline). An unknown non-empty
 * state from a newer peer is treated as a live, quiet session (idle) rather
 * than painted as broken. */
export function sessionTone(state: string | null | undefined): SessionTone {
  if (!state) return 'offline';
  return (SESSION_STATE_TONES as Record<string, SessionTone>)[state] ?? 'idle';
}

/** Emissive / dark screens. */
export const SESSION_TONE_COLORS: Record<SessionTone, string> = {
  idle: Session.idle,
  working: Session.working,
  awaiting: Session.awaiting,
  offline: Session.offline,
};

/** Paper and light backgrounds (colour e-ink, light popups): the same hue,
 * darkened by the shared paper rule so small text keeps 4.5:1. */
export const SESSION_TONE_PAPER_COLORS: Record<SessionTone, string> = Object.fromEntries(
  SESSION_TONES.map((tone) => [tone, toPaperColor(SESSION_TONE_COLORS[tone])]),
) as Record<SessionTone, string>;

/** Only this tone may animate (DESIGN.md §2.5 / §8). */
export const SESSION_PULSING_TONE: SessionTone = 'awaiting';

export function sessionToneColor(state: string | null | undefined, options: { paper?: boolean } = {}): string {
  const tone = sessionTone(state);
  return (options.paper ? SESSION_TONE_PAPER_COLORS : SESSION_TONE_COLORS)[tone];
}

export interface SessionStateWords {
  /** Sentence case, for rows and cards with room to speak. */
  label: string;
  /** Uppercase pill / key text, at most 7 characters. */
  short: string;
  /** At most 4 characters, for TTY columns and tiny panels. */
  tiny: string;
}

/** The state vocabulary. Awaiting variants name what the person must do. */
export const SESSION_STATE_WORDS: Record<State, SessionStateWords> = {
  [State.IDLE]: { label: 'Idle', short: 'IDLE', tiny: 'IDLE' },
  [State.PROCESSING]: { label: 'Working', short: 'WORKING', tiny: 'WORK' },
  [State.AWAITING_PERMISSION]: { label: 'Needs approval', short: 'APPROVE', tiny: 'PERM' },
  [State.AWAITING_OPTION]: { label: 'Needs a choice', short: 'CHOOSE', tiny: 'OPT' },
  [State.AWAITING_DIFF]: { label: 'Review diff', short: 'REVIEW', tiny: 'DIFF' },
  [State.DISCONNECTED]: { label: 'Offline', short: 'OFFLINE', tiny: 'OFF' },
};

/** Words for a raw wire state; missing → offline, unknown → idle (same rule
 * as the tone). */
export function sessionStateWords(state: string | null | undefined): SessionStateWords {
  if (!state) return SESSION_STATE_WORDS[State.DISCONNECTED];
  return (SESSION_STATE_WORDS as Record<string, SessionStateWords>)[state] ?? SESSION_STATE_WORDS[State.IDLE];
}
