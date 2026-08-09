/**
 * Operator-authorized pairing codes — the credential path for a device that can
 * neither scan a QR nor be handed a token over USB.
 *
 * The LAN surface is default-deny and the pairing token is the whole security
 * boundary (issue #145), so a device that arrives with nothing gets closed 4001
 * and — since #149 — is not allowed to redial. That is correct for an intruder
 * and a dead end for an e-ink reader: it has no camera to scan `agentdeck qr`
 * with, its on-screen keyboard makes a 32-hex-character URL a punishment, and
 * the one channel that always works (USB serial) is the one an ESP32 has and a
 * reader does not.
 *
 * A pairing code closes that gap without softening the boundary, because the
 * daemon still never hands a credential to a peer that merely asked:
 *
 *  - The window does not exist until the **operator opens it on the host**. With
 *    no window, `POST /pair` is indistinguishable from any other unauthorized
 *    route — it 401s. There is no always-on pre-auth route.
 *  - It is short-lived ({@link PAIRING_WINDOW_MS}) and hands out at most
 *    {@link DEFAULT_PAIRING_REDEMPTIONS} credentials before closing.
 *  - The secret is a {@link PAIRING_CODE_DIGITS}-digit number the operator reads
 *    off their own screen, so possession proves the person holding the device is
 *    also standing at the daemon.
 *  - Guessing is bounded at {@link PAIRING_MAX_FAILED_ATTEMPTS} wrong codes for
 *    the whole window, not per peer. An attacker on the LAN therefore gets five
 *    tries at one-in-a-million inside two minutes, once, while the operator is
 *    watching the CLI report every attempt.
 *
 * Everything here is pure and shared so both daemons answer a redemption
 * identically — including the HTTP status, which is part of the contract a
 * client's retry policy reads. Code *generation* is deliberately not here: it
 * needs a CSPRNG, and each host has its own (`crypto.randomInt` on Node,
 * `SystemRandomNumberGenerator` in Swift). This module fixes the shape both must
 * produce and the verdict both must reach.
 */

/** Digits in a pairing code. Six is 10^6 — see the attempt cap above. */
export const PAIRING_CODE_DIGITS = 6;

/** How long an operator-opened pairing window stays open. */
export const PAIRING_WINDOW_MS = 120_000;

/**
 * Wrong codes the whole window tolerates before it closes.
 *
 * Deliberately global rather than per-IP: an attacker picks their source
 * address, so a per-peer budget is a budget per attempt.
 */
export const PAIRING_MAX_FAILED_ATTEMPTS = 5;

/** Credentials one window hands out unless the operator asks for more. */
export const DEFAULT_PAIRING_REDEMPTIONS = 1;

/** State a daemon must keep for an open window, and all this module reads. */
export interface PairingWindowSnapshot {
  /** The code the operator is looking at. */
  code: string;
  /** Epoch ms after which the window is closed regardless of state. */
  expiresAt: number;
  /** Wrong codes seen so far. */
  failedAttempts: number;
  /** Credentials this window may still hand out. */
  redemptionsRemaining: number;
}

export type PairingRedemptionOutcome =
  /** Correct code — hand over the token. */
  | 'accepted'
  /** No window is open. Indistinguishable from an unknown route by design. */
  | 'no-window'
  /** Window existed but its deadline passed. */
  | 'expired'
  /** Window ran out of credentials or of patience. */
  | 'exhausted'
  /** Well-formed code, wrong value. Burns one attempt. */
  | 'mismatch'
  /** Not a pairing code at all — a typo, not a guess. Burns nothing. */
  | 'malformed';

export interface PairingRedemptionResult {
  outcome: PairingRedemptionOutcome;
  /**
   * The HTTP status to answer with. Shared because it drives client behaviour:
   * 401 means "ask the human for the code again", 410/429 mean "the window is
   * gone, stop retrying and tell the operator to open a new one".
   */
  status: number;
  /** Wrong codes this window will still tolerate after this call. */
  attemptsRemaining: number;
  /** True when the daemon must drop the window as a result of this call. */
  closes: boolean;
}

/**
 * Reduce a human-entered code to its canonical form, or null if it is not one.
 *
 * Accepts the separators a person actually types or a UI actually renders —
 * spaces, hyphens, the non-breaking spaces a copy-paste from a formatted code
 * carries — because rejecting `482-913` as "malformed" teaches the user nothing.
 */
export function normalizePairingCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const digits = input.replace(/[^0-9]/g, '');
  if (digits.length !== PAIRING_CODE_DIGITS) return null;
  return digits;
}

/** True when `code` is exactly what {@link normalizePairingCode} emits. */
export function isPairingCode(code: unknown): boolean {
  return typeof code === 'string' && normalizePairingCode(code) === code;
}

/**
 * Group a code for display: `482913` → `482 913`.
 *
 * Read aloud and typed on a reader's keyboard, so it is chunked. The chunk is
 * half the code, which for six digits is the same grouping a phone number uses.
 */
export function formatPairingCode(code: string): string {
  const normalized = normalizePairingCode(code);
  if (!normalized) return code;
  const half = PAIRING_CODE_DIGITS / 2;
  return `${normalized.slice(0, half)} ${normalized.slice(half)}`;
}

/** Length-independent compare, so a wrong code cannot be measured digit by digit. */
function codesMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The whole redemption decision, as a pure function of the window and the
 * submitted code.
 *
 * Order matters and is part of the contract. `expired` is decided before the
 * code is looked at, so a stale window cannot be probed for free; `malformed`
 * is decided before `mismatch`, so a typo of the wrong length does not spend
 * one of the operator's five attempts.
 *
 * @param window the open window, or null when none is open
 * @param submitted whatever the peer sent, unvalidated
 * @param now epoch ms — injected, never read from the clock, so this is testable
 */
export function evaluatePairingRedemption(
  window: PairingWindowSnapshot | null,
  submitted: unknown,
  now: number,
): PairingRedemptionResult {
  if (!window) {
    return { outcome: 'no-window', status: 401, attemptsRemaining: 0, closes: false };
  }
  if (now >= window.expiresAt) {
    return { outcome: 'expired', status: 410, attemptsRemaining: 0, closes: true };
  }
  if (window.redemptionsRemaining <= 0 || window.failedAttempts >= PAIRING_MAX_FAILED_ATTEMPTS) {
    return { outcome: 'exhausted', status: 429, attemptsRemaining: 0, closes: true };
  }

  const code = normalizePairingCode(submitted);
  const attemptsBefore = PAIRING_MAX_FAILED_ATTEMPTS - window.failedAttempts;
  if (!code) {
    return { outcome: 'malformed', status: 400, attemptsRemaining: attemptsBefore, closes: false };
  }
  if (!codesMatch(code, window.code)) {
    const attemptsRemaining = attemptsBefore - 1;
    return { outcome: 'mismatch', status: 401, attemptsRemaining, closes: attemptsRemaining <= 0 };
  }

  const redemptionsLeft = window.redemptionsRemaining - 1;
  return {
    outcome: 'accepted',
    status: 200,
    attemptsRemaining: attemptsBefore,
    closes: redemptionsLeft <= 0,
  };
}

/** Seconds left on a window, floored at 0 — for the CLI countdown and UI copy. */
export function pairingWindowSecondsRemaining(window: PairingWindowSnapshot | null, now: number): number {
  if (!window) return 0;
  return Math.max(0, Math.ceil((window.expiresAt - now) / 1000));
}
