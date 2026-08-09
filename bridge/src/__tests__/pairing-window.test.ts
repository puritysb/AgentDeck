// The stateful half of the pairing-code path. The verdict rules are tested in
// shared/src/__tests__/pairing-code.test.ts; what is tested here is everything
// a pure function cannot express — that the window actually closes, that a
// refused redemption never touches the credential, and that expiry survives a
// timer which does not fire.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({ log: () => {} }));

import { PAIRING_MAX_FAILED_ATTEMPTS, PAIRING_WINDOW_MS } from '@agentdeck/shared';
import {
  closePairingWindow,
  getPairingWindowStatus,
  openPairingWindow,
  pairingWindowOpen,
  redeemPairingCode,
  resetPairingWindowForTests,
} from '../pairing-window.js';

const PEER = { ip: '192.0.2.55' };
const mintToken = () => 'the-pairing-token';

beforeEach(() => resetPairingWindowForTests());
afterEach(() => {
  resetPairingWindowForTests();
  vi.useRealTimers();
});

describe('window lifecycle', () => {
  it('is closed until the operator opens one', () => {
    expect(pairingWindowOpen()).toBe(false);
    expect(getPairingWindowStatus().open).toBe(false);
  });

  it('mints a code of the documented shape', () => {
    const { code } = openPairingWindow();
    expect(code).toMatch(/^\d{6}$/);
    expect(pairingWindowOpen()).toBe(true);
  });

  it('never repeats a code across many opens (i.e. it is actually random)', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) codes.add(openPairingWindow().code);
    // 200 draws from 10^6; a constant or a low-entropy source collapses this.
    expect(codes.size).toBeGreaterThan(190);
  });

  it('replaces a window rather than leaving two valid secrets running', () => {
    const first = openPairingWindow();
    const second = openPairingWindow();
    expect(second.code).not.toBe(first.code);
    // The code the operator is no longer looking at must not still work.
    expect(redeemPairingCode(first.code, PEER, mintToken).outcome).toBe('mismatch');
  });

  it('closes on the operator asking', () => {
    openPairingWindow();
    closePairingWindow();
    expect(pairingWindowOpen()).toBe(false);
  });

  it('clamps a window length nobody should be able to ask for', () => {
    const now = Date.now();
    const long = openPairingWindow({ ttlMs: 24 * 60 * 60 * 1000 });
    expect(long.expiresAt - now).toBeLessThanOrEqual(600_000 + 50);

    const zero = openPairingWindow({ ttlMs: 0 });
    // A `--ttl 0` typo must not open a window that is already over.
    expect(zero.expiresAt - Date.now()).toBeGreaterThan(1000);
  });

  it('clamps the device count to at least one', () => {
    expect(openPairingWindow({ redemptions: 0 }).redemptions).toBe(1);
    expect(openPairingWindow({ redemptions: -5 }).redemptions).toBe(1);
    expect(openPairingWindow({ redemptions: 999 }).redemptions).toBe(16);
  });
});

describe('redemption', () => {
  it('hands over the token for the right code and closes a one-device window', () => {
    const { code } = openPairingWindow();
    const result = redeemPairingCode(code, { ...PEER, name: 'Crema S', kind: 'android-eink' }, mintToken);
    expect(result.outcome).toBe('accepted');
    expect(result.token).toBe('the-pairing-token');
    expect(pairingWindowOpen()).toBe(false);
  });

  it('reads the token live, so a handover reaches a device pairing right now', () => {
    // adoptPeerToken can replace the machine's token mid-window; the mint
    // callback exists so this path cannot capture a stale one.
    const { code } = openPairingWindow();
    let current = 'first-token';
    expect(redeemPairingCode(code, PEER, () => current).token).toBe('first-token');

    current = 'adopted-token';
    const { code: code2 } = openPairingWindow();
    expect(redeemPairingCode(code2, PEER, () => current).token).toBe('adopted-token');
  });

  it('never mints a token for a refused redemption', () => {
    const mint = vi.fn(mintToken);
    const { code } = openPairingWindow();

    redeemPairingCode('000000', PEER, mint);          // mismatch
    redeemPairingCode('nope', PEER, mint);            // malformed
    redeemPairingCode(undefined, PEER, mint);         // malformed
    expect(mint).not.toHaveBeenCalled();

    redeemPairingCode(code, PEER, mint);              // accepted
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('refuses everything once the window is closed', () => {
    const { code } = openPairingWindow();
    closePairingWindow();
    const result = redeemPairingCode(code, PEER, mintToken);
    expect(result.outcome).toBe('no-window');
    expect(result.token).toBeUndefined();
  });

  it('pairs several devices from one window, then closes', () => {
    const { code } = openPairingWindow({ redemptions: 3 });
    for (let i = 0; i < 3; i++) {
      expect(redeemPairingCode(code, { ip: `192.0.2.${i}` }, mintToken).outcome).toBe('accepted');
    }
    expect(pairingWindowOpen()).toBe(false);
    expect(redeemPairingCode(code, PEER, mintToken).outcome).toBe('no-window');
  });

  it('closes the window after the attempt budget, across peers', () => {
    // The budget is global on purpose: an attacker picks their source address,
    // so a per-IP budget would be a budget per attempt.
    const { code } = openPairingWindow();
    for (let i = 0; i < PAIRING_MAX_FAILED_ATTEMPTS; i++) {
      expect(redeemPairingCode('000000', { ip: `192.0.2.${i}` }, mintToken).outcome).toBe('mismatch');
    }
    expect(pairingWindowOpen()).toBe(false);
    // And the right code is worthless now.
    expect(redeemPairingCode(code, PEER, mintToken).outcome).toBe('no-window');
  });

  it('does not spend the budget on malformed submissions', () => {
    const { code } = openPairingWindow();
    for (let i = 0; i < 50; i++) redeemPairingCode('nope', PEER, mintToken);
    expect(getPairingWindowStatus().attemptsRemaining).toBe(PAIRING_MAX_FAILED_ATTEMPTS);
    expect(redeemPairingCode(code, PEER, mintToken).outcome).toBe('accepted');
  });

  it('accepts the code with the separators the display added', () => {
    const { code } = openPairingWindow();
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
    expect(redeemPairingCode(spaced, PEER, mintToken).outcome).toBe('accepted');
  });
});

describe('expiry is enforced on read, not by the timer', () => {
  it('refuses a window whose deadline passed even if no timer ran', () => {
    vi.useFakeTimers();
    openPairingWindow({ ttlMs: 20_000 });
    // Advance the clock WITHOUT running timers — a sleeping laptop or a
    // saturated event loop is exactly this: the deadline passes, the callback
    // has not fired. The window must already be closed to any reader.
    vi.setSystemTime(Date.now() + 21_000);
    expect(pairingWindowOpen()).toBe(false);
    expect(getPairingWindowStatus().open).toBe(false);
  });

  it('refuses the right code after expiry', () => {
    vi.useFakeTimers();
    const { code } = openPairingWindow({ ttlMs: 20_000 });
    vi.setSystemTime(Date.now() + 21_000);
    const result = redeemPairingCode(code, PEER, mintToken);
    expect(result.outcome).toBe('no-window');
    expect(result.token).toBeUndefined();
  });

  it('is still open one millisecond before the deadline', () => {
    vi.useFakeTimers();
    const { code } = openPairingWindow({ ttlMs: 20_000 });
    vi.setSystemTime(Date.now() + 19_999);
    expect(redeemPairingCode(code, PEER, mintToken).outcome).toBe('accepted');
  });
});

describe('operator status', () => {
  it('never contains the code — the opener already has it, nothing else needs it', () => {
    const { code } = openPairingWindow();
    expect(JSON.stringify(getPairingWindowStatus())).not.toContain(code);
  });

  it('reports who paired and who guessed wrong', () => {
    const { code } = openPairingWindow({ redemptions: 2 });
    redeemPairingCode('000000', { ip: '192.0.2.9' }, mintToken);
    redeemPairingCode(code, { ip: '192.0.2.50', name: 'Crema S', kind: 'android-eink' }, mintToken);

    const status = getPairingWindowStatus();
    expect(status.failures).toHaveLength(1);
    expect(status.failures[0].ip).toBe('192.0.2.9');
    expect(status.redemptions).toHaveLength(1);
    expect(status.redemptions[0]).toMatchObject({ ip: '192.0.2.50', name: 'Crema S', kind: 'android-eink' });
    expect(status.attemptsRemaining).toBe(PAIRING_MAX_FAILED_ATTEMPTS - 1);
    expect(status.redemptionsRemaining).toBe(1);
  });

  it('sanitizes the device label, which is untrusted text from an unpaired peer', () => {
    const { code } = openPairingWindow();
    // An unauthenticated peer names itself, and that name lands in a log line
    // on a terminal: a bare ESC would be a control sequence, not a label.
    const hostile = 'evil\u001b[2Jname\nsecond line';
    redeemPairingCode(code, { ...PEER, name: hostile, kind: 'x'.repeat(200) }, mintToken);

    const [redemption] = getPairingWindowStatus().redemptions;
    expect(redemption.name).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(redemption.name).toBe('evil [2Jname second line');
    expect(redemption.kind.length).toBeLessThanOrEqual(24);
  });

  it('falls back to a placeholder rather than an empty or non-string label', () => {
    const { code } = openPairingWindow();
    redeemPairingCode(code, { ...PEER, name: '   ', kind: 42 }, mintToken);
    const [redemption] = getPairingWindowStatus().redemptions;
    expect(redemption.name).toBe('unnamed device');
    expect(redemption.kind).toBe('unknown');
  });

  it('still reports the pairing after the window closed on it', () => {
    // A one-device window closes the instant it succeeds, and `agentdeck pair`
    // learns the outcome by polling — so without a receipt the poll that lands
    // after the redemption reports "closed with nothing paired" for a pairing
    // that worked. This is the whole success path of the CLI.
    const { code } = openPairingWindow();
    redeemPairingCode(code, { ip: '192.0.2.50', name: 'Crema S', kind: 'android-eink' }, mintToken);

    const status = getPairingWindowStatus();
    expect(status.open).toBe(false);
    expect(status.redemptions).toHaveLength(1);
    expect(status.redemptions[0].name).toBe('Crema S');
  });

  it('does not report a previous run\'s pairings to the next window', () => {
    const first = openPairingWindow();
    redeemPairingCode(first.code, { ip: '192.0.2.50', name: 'Crema S' }, mintToken);
    expect(getPairingWindowStatus().redemptions).toHaveLength(1);

    openPairingWindow();
    expect(getPairingWindowStatus().redemptions).toEqual([]);
  });

  it('forgets the receipt rather than keeping it for the life of the daemon', () => {
    vi.useFakeTimers();
    const { code } = openPairingWindow();
    redeemPairingCode(code, { ip: '192.0.2.50', name: 'Crema S' }, mintToken);
    vi.setSystemTime(Date.now() + 61_000);
    expect(getPairingWindowStatus().redemptions).toEqual([]);
  });

  it('the receipt carries no code and no token', () => {
    const { code } = openPairingWindow();
    redeemPairingCode(code, { ip: '192.0.2.50', name: 'Crema S' }, mintToken);
    const flat = JSON.stringify(getPairingWindowStatus());
    expect(flat).not.toContain(code);
    expect(flat).not.toContain('the-pairing-token');
  });

  it('counts down in whole seconds and never shows 0 while open', () => {
    openPairingWindow({ ttlMs: PAIRING_WINDOW_MS });
    const status = getPairingWindowStatus();
    expect(status.secondsRemaining).toBeGreaterThan(0);
    expect(status.secondsRemaining).toBeLessThanOrEqual(PAIRING_WINDOW_MS / 1000);
  });
});
