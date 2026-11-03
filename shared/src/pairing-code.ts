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

/** Quiet period before a native client retries its selected host after exhaustion
 * or authentication refusal. A host may change daemon owners without changing
 * its Bonjour record; retries must not depend on another discovery emission.
 * This never grants access: every new socket still passes the normal auth gate.
 */
export const CLIENT_RECONNECT_COOLDOWN_MS = 30_000;

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
/**
 * The daemon port a bare address means, mirroring the canonical port the daemon
 * prefers. Typing an address is the fallback for a device that cannot discover
 * one, and on that path nobody is around to notice a port typo — so the default
 * has to be the port the daemon actually wants, not a guess.
 */
/**
 * Handshake header a client uses to say WHICH device it is.
 *
 * Approval needs an identity, and until now the only one available was the
 * source address: the decision happens at the WebSocket upgrade, before any
 * frame, so `client_register` — where a device says its name — has not arrived
 * yet. On a LAN an address is a weak but non-trivial identity. Behind NAT it
 * stops being an identity at all: every device shares one source address, so
 * approving one approves all of them. That is the failure this closes.
 *
 * A header rather than a query parameter so it stays out of URLs, which get
 * logged, copied into bug reports, and pasted into chat.
 *
 * What this is NOT: proof. The link is plaintext `ws://`, so anything in the
 * handshake is replayable by a passive observer on the same segment — exactly
 * as true of the existing `?token=`, which every paired device already carries
 * that way. So this is no weaker than what ships today, and it buys the two
 * things an address cannot: devices behind one NAT are told apart, and one
 * device can be revoked without rotating the token the whole fleet shares.
 * Making it unforgeable needs a challenge-response over a channel that is not
 * plaintext; that is a separate piece of work and this does not pretend to it.
 */
export const DEVICE_ID_HEADER = 'x-agentdeck-device';

/** Characters in a device id — 128 bits, the same shape as the auth token. */
export const DEVICE_ID_LENGTH = 32;

/**
 * Reduce a client-supplied device id to its canonical form, or null.
 *
 * Strict because this string is a map key on the daemon and a row the operator
 * approves: accepting a loose one would let a client vary its own identity
 * between connects (case, padding) and appear as several devices, which is
 * noise in the approval list and a way to outlive a revocation.
 */
export function normalizeDeviceId(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length !== DEVICE_ID_LENGTH) return null;
  return /^[0-9a-f]+$/.test(trimmed) ? trimmed : null;
}

/** Short form for a row the operator reads — never used as a key. */
export function shortDeviceId(id: string): string {
  const normalized = normalizeDeviceId(id);
  return normalized ? normalized.slice(0, 8) : id;
}

export const DEFAULT_DAEMON_PORT = 9120;

export interface DaemonAddress {
  host: string;
  port: number;
}

/**
 * Parse an operator-typed daemon address into host + port.
 *
 * This exists because the pairing CODE path is gated on discovery: a client
 * spends a code against a daemon it found over mDNS, so on a network where
 * multicast is filtered — which is the normal state of a guest SSID, an
 * isolating AP, or a segmented VLAN — the six-digit path is unreachable by
 * exactly the camera-less devices it was built for. Letting the address be
 * typed restores it without reintroducing the 32-character token those devices
 * were stuck copying.
 *
 * Shared rather than written per client because the two surfaces must agree on
 * what a bare `192.168.1.5` means. If Android defaulted to 9120 and iOS to
 * something else, the same string typed on two devices in the same room would
 * reach different daemons, and the failure would look like a bad code.
 *
 * Deliberately permissive about what it strips (scheme, path, query) and strict
 * about what it accepts (a non-empty host, a port in range): people paste the
 * URL they were shown, and a rejected paste is a dead end on a device with a
 * bad keyboard.
 */
export function parseDaemonAddress(input: unknown): DaemonAddress | null {
  if (typeof input !== 'string') return null;
  let text = input.trim();
  if (!text) return null;

  const scheme = text.indexOf('://');
  if (scheme >= 0) text = text.slice(scheme + 3);
  // Anything after the authority is not ours to interpret — notably `?token=`,
  // which someone pasting the QR window's URL will bring along.
  for (const cut of ['/', '?', '#']) {
    const at = text.indexOf(cut);
    if (at >= 0) text = text.slice(0, at);
  }
  if (!text) return null;

  let host = text;
  let port = DEFAULT_DAEMON_PORT;

  if (text.startsWith('[')) {
    // Bracketed IPv6 literal: `[::1]` or `[::1]:9120`.
    const close = text.indexOf(']');
    if (close < 0) return null;
    host = text.slice(1, close);
    const rest = text.slice(close + 1);
    if (rest.startsWith(':')) {
      const parsed = parsePort(rest.slice(1));
      if (parsed === null) return null;
      port = parsed;
    } else if (rest.length > 0) {
      return null;
    }
  } else {
    const colons = text.split(':').length - 1;
    if (colons === 1) {
      const at = text.lastIndexOf(':');
      const parsed = parsePort(text.slice(at + 1));
      if (parsed === null) return null;
      host = text.slice(0, at);
      port = parsed;
    } else if (colons > 1) {
      // A bare IPv6 literal carries colons of its own and no port, so a
      // trailing `:9120` here is indistinguishable from part of the address.
      // Treat the whole thing as the host and take the default port.
      host = text;
    }
  }

  if (!host) return null;
  return { host, port };
}

function parsePort(text: string): number | null {
  if (!/^[0-9]{1,5}$/.test(text)) return null;
  const value = Number(text);
  return value >= 1 && value <= 65535 ? value : null;
}

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
