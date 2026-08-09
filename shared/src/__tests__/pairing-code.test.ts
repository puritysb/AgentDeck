import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PAIRING_REDEMPTIONS,
  PAIRING_CODE_DIGITS,
  PAIRING_MAX_FAILED_ATTEMPTS,
  PAIRING_WINDOW_MS,
  evaluatePairingRedemption,
  formatPairingCode,
  isPairingCode,
  normalizePairingCode,
  pairingWindowSecondsRemaining,
  type PairingWindowSnapshot,
} from '../pairing-code.js';

const NOW = 1_700_000_000_000;

function openWindow(over: Partial<PairingWindowSnapshot> = {}): PairingWindowSnapshot {
  return {
    code: '482913',
    expiresAt: NOW + PAIRING_WINDOW_MS,
    failedAttempts: 0,
    redemptionsRemaining: DEFAULT_PAIRING_REDEMPTIONS,
    ...over,
  };
}

describe('normalizePairingCode', () => {
  it('accepts a bare code', () => {
    expect(normalizePairingCode('482913')).toBe('482913');
  });

  it('accepts the separators a human or a formatted display introduces', () => {
    for (const typed of ['482 913', '482-913', ' 482913 ', '482 913', '4 8 2 9 1 3']) {
      expect(normalizePairingCode(typed)).toBe('482913');
    }
  });

  it('rejects anything that is not exactly the code length', () => {
    for (const bad of ['48291', '4829134', '', 'abcdef', '48291a']) {
      expect(normalizePairingCode(bad)).toBeNull();
    }
  });

  it('rejects non-strings rather than coercing them', () => {
    for (const bad of [482913, null, undefined, {}, ['482913']]) {
      expect(normalizePairingCode(bad)).toBeNull();
    }
  });

  it('isPairingCode only accepts the canonical form', () => {
    expect(isPairingCode('482913')).toBe(true);
    expect(isPairingCode('482 913')).toBe(false);
    expect(isPairingCode(482913)).toBe(false);
  });
});

describe('formatPairingCode', () => {
  it('groups the code in half for reading aloud', () => {
    expect(formatPairingCode('482913')).toBe('482 913');
  });

  it('normalizes before grouping, so formatting is idempotent', () => {
    expect(formatPairingCode(formatPairingCode('482913'))).toBe('482 913');
  });

  it('passes through anything it cannot parse instead of mangling it', () => {
    expect(formatPairingCode('nope')).toBe('nope');
  });
});

describe('evaluatePairingRedemption', () => {
  it('accepts the right code and closes a single-redemption window', () => {
    const result = evaluatePairingRedemption(openWindow(), '482913', NOW);
    expect(result.outcome).toBe('accepted');
    expect(result.status).toBe(200);
    expect(result.closes).toBe(true);
  });

  it('keeps a multi-device window open until its last credential', () => {
    const two = evaluatePairingRedemption(openWindow({ redemptionsRemaining: 2 }), '482913', NOW);
    expect(two.outcome).toBe('accepted');
    expect(two.closes).toBe(false);

    const last = evaluatePairingRedemption(openWindow({ redemptionsRemaining: 1 }), '482913', NOW);
    expect(last.closes).toBe(true);
  });

  it('accepts a code that arrives with the separators it was displayed with', () => {
    expect(evaluatePairingRedemption(openWindow(), '482 913', NOW).outcome).toBe('accepted');
  });

  it('answers 401 with no window, so a closed daemon looks like an unknown route', () => {
    const result = evaluatePairingRedemption(null, '482913', NOW);
    expect(result.outcome).toBe('no-window');
    expect(result.status).toBe(401);
    expect(result.closes).toBe(false);
  });

  it('decides expiry before it looks at the code', () => {
    const expired = openWindow({ expiresAt: NOW });
    // Right code, expired window: still refused, and refused as expired rather
    // than as a mismatch — a stale window must not be probeable for free.
    const result = evaluatePairingRedemption(expired, '482913', NOW);
    expect(result.outcome).toBe('expired');
    expect(result.status).toBe(410);
    expect(result.closes).toBe(true);
  });

  it('treats the expiry instant as closed, not as the last open millisecond', () => {
    expect(evaluatePairingRedemption(openWindow({ expiresAt: NOW }), '482913', NOW).outcome).toBe('expired');
    expect(evaluatePairingRedemption(openWindow({ expiresAt: NOW + 1 }), '482913', NOW).outcome).toBe('accepted');
  });

  it('burns one attempt per well-formed wrong code and closes on the last one', () => {
    for (let failed = 0; failed < PAIRING_MAX_FAILED_ATTEMPTS; failed++) {
      const result = evaluatePairingRedemption(openWindow({ failedAttempts: failed }), '000000', NOW);
      expect(result.outcome).toBe('mismatch');
      expect(result.status).toBe(401);
      expect(result.attemptsRemaining).toBe(PAIRING_MAX_FAILED_ATTEMPTS - failed - 1);
      expect(result.closes).toBe(failed === PAIRING_MAX_FAILED_ATTEMPTS - 1);
    }
  });

  it('refuses a window whose attempts are already spent, even for the right code', () => {
    const spent = openWindow({ failedAttempts: PAIRING_MAX_FAILED_ATTEMPTS });
    const result = evaluatePairingRedemption(spent, '482913', NOW);
    expect(result.outcome).toBe('exhausted');
    expect(result.status).toBe(429);
    expect(result.closes).toBe(true);
  });

  it('refuses a window with no credentials left', () => {
    const result = evaluatePairingRedemption(openWindow({ redemptionsRemaining: 0 }), '482913', NOW);
    expect(result.outcome).toBe('exhausted');
    expect(result.closes).toBe(true);
  });

  it('does not spend an attempt on a malformed submission', () => {
    for (const bad of ['', '123', 'abcdef', null, 482913]) {
      const result = evaluatePairingRedemption(openWindow(), bad, NOW);
      expect(result.outcome).toBe('malformed');
      expect(result.status).toBe(400);
      expect(result.attemptsRemaining).toBe(PAIRING_MAX_FAILED_ATTEMPTS);
      expect(result.closes).toBe(false);
    }
  });

  it('gives an attacker at most PAIRING_MAX_FAILED_ATTEMPTS guesses per window', () => {
    // Drive the real accounting the way a daemon does — decrementing state on
    // each verdict — so the cap is proven end to end rather than per call.
    let window: PairingWindowSnapshot | null = openWindow();
    let guesses = 0;
    for (let i = 0; i < 100; i++) {
      const result = evaluatePairingRedemption(window, '000000', NOW);
      if (result.outcome !== 'mismatch') break;
      guesses++;
      window = result.closes ? null : { ...window!, failedAttempts: window!.failedAttempts + 1 };
    }
    expect(guesses).toBe(PAIRING_MAX_FAILED_ATTEMPTS);
    expect(window).toBeNull();
  });
});

describe('pairingWindowSecondsRemaining', () => {
  it('rounds up so a countdown never shows 0 while the window is still open', () => {
    expect(pairingWindowSecondsRemaining(openWindow({ expiresAt: NOW + 1 }), NOW)).toBe(1);
    expect(pairingWindowSecondsRemaining(openWindow({ expiresAt: NOW + 1500 }), NOW)).toBe(2);
  });

  it('floors at zero for an expired or absent window', () => {
    expect(pairingWindowSecondsRemaining(openWindow({ expiresAt: NOW - 5000 }), NOW)).toBe(0);
    expect(pairingWindowSecondsRemaining(null, NOW)).toBe(0);
  });
});

describe('constants', () => {
  it('keeps the code long enough that the attempt cap is the real defence', () => {
    // 5 guesses out of 10^6 per window. If either constant moves, this is the
    // line that should make someone re-do that arithmetic.
    expect(PAIRING_CODE_DIGITS).toBe(6);
    expect(PAIRING_MAX_FAILED_ATTEMPTS).toBe(5);
    expect(PAIRING_CODE_DIGITS % 2).toBe(0); // formatPairingCode splits in half
  });

  it('keeps the window short enough to be an operator action, not a mode', () => {
    expect(PAIRING_WINDOW_MS).toBeGreaterThanOrEqual(30_000);
    expect(PAIRING_WINDOW_MS).toBeLessThanOrEqual(300_000);
  });
});
