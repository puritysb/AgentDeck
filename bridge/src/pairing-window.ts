/**
 * The daemon's operator-opened pairing window — the mutable half of the pairing
 * code path whose rules live in `@agentdeck/shared` (`pairing-code.ts`).
 *
 * There is at most one window per daemon, it exists only because the operator
 * asked for it, and it closes itself. Everything that decides a verdict is in
 * shared; this module owns only the state, the CSPRNG, and the audit trail the
 * CLI prints back to the operator.
 *
 * Two properties worth keeping when this is touched:
 *
 *  - **A closed window leaves no route behind.** `pairingWindowOpen()` is what
 *    the HTTP gate consults, so with no window `POST /pair` is refused by the
 *    same default-deny branch as any other unauthorized path. Never let the
 *    route answer differently depending on whether a window *used to* exist —
 *    that turns the redemption endpoint into an oracle for "is someone pairing
 *    right now", which is exactly the moment worth attacking.
 *  - **The expiry is enforced on read, not by a timer.** A timer that fires late
 *    (a sleeping laptop, a saturated event loop) would extend the window past
 *    its promise. The timer here only *reports* the close; `getPairingWindow`
 *    re-checks the clock and drops an expired window before anyone sees it.
 */
import { randomInt } from 'crypto';
import {
  DEFAULT_PAIRING_REDEMPTIONS,
  PAIRING_CODE_DIGITS,
  PAIRING_MAX_FAILED_ATTEMPTS,
  PAIRING_WINDOW_MS,
  evaluatePairingRedemption,
  formatPairingCode,
  type PairingRedemptionOutcome,
  type PairingWindowSnapshot,
} from '@agentdeck/shared';
import { log } from './logger.js';

/** One device that successfully redeemed, for the operator's confirmation. */
export interface PairingRedemption {
  at: number;
  ip: string;
  /** Device-supplied label. Untrusted display text — sanitized on the way in. */
  name: string;
  /** Device-supplied kind hint (`android-eink`, `esp32`, …), or 'unknown'. */
  kind: string;
}

interface ActiveWindow extends PairingWindowSnapshot {
  openedAt: number;
  credentialGeneration?: string;
  /** Every wrong-code attempt, so the CLI can show an attack as it happens. */
  failures: Array<{ at: number; ip: string }>;
  redemptions: PairingRedemption[];
  /**
   * ESP32 peers the operator named for adoption, by IP.
   *
   * A board cannot type a code — it has no keyboard — so the code cannot be
   * what authorizes it. What authorizes it is that the operator read this
   * address off the daemon's own refusal log and named it in the command. That
   * keeps the grant addressed to one peer instead of to anything on the LAN
   * claiming `clientType=esp32`, which is a claim nobody can check.
   */
  adoptEsp32Ips: Set<string>;
  timer: NodeJS.Timeout | null;
}

let active: ActiveWindow | null = null;
let generationProvider: () => string | undefined = () => undefined;
export function setPairingCredentialGeneration(getter: () => string | undefined): void { generationProvider = getter; }

/** Fires when a window closes, so the CLI's status stream can end promptly. */
type CloseReason = 'expired' | 'redeemed' | 'attempts-exhausted' | 'operator';
let onCloseCallback: ((reason: CloseReason) => void) | null = null;

export function onPairingWindowClosed(cb: ((reason: CloseReason) => void) | null): void {
  onCloseCallback = cb;
}

/**
 * What the window that just closed achieved, kept after it is gone.
 *
 * The success case closes the window — that is the point of a one-device window
 * — and the operator's `agentdeck pair` learns the outcome by polling. Without
 * this the two race, and the poll that arrives after the redemption reports
 * "closed with nothing paired" for a pairing that in fact worked. The receipt
 * carries no code and no token, only who paired.
 */
interface ClosedWindowReceipt {
  closedAt: number;
  reason: CloseReason;
  redemptions: PairingRedemption[];
  failures: Array<{ at: number; ip: string }>;
}
let receipt: ClosedWindowReceipt | null = null;

/** How long a closed window's receipt stays readable. The CLI polls at 1s. */
const RECEIPT_TTL_MS = 60_000;

function getReceipt(now: number): ClosedWindowReceipt | null {
  if (receipt && now - receipt.closedAt > RECEIPT_TTL_MS) receipt = null;
  return receipt;
}

/**
 * A uniformly random code. `randomInt` is rejection-sampled by Node, so unlike
 * `random() % 10^6` every code is equally likely — the attempt cap's arithmetic
 * assumes a flat distribution.
 */
function mintCode(): string {
  const max = 10 ** PAIRING_CODE_DIGITS;
  return String(randomInt(0, max)).padStart(PAIRING_CODE_DIGITS, '0');
}

/** Device-supplied strings are display text from an unauthenticated peer. */
function sanitizeLabel(value: unknown, fallback: string, maxLength = 40): string {
  if (typeof value !== 'string') return fallback;
  // Strip control characters before this reaches a log line (which is a
  // terminal) from a peer that has not authenticated yet, then collapse runs.
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return fallback;
  return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength - 1)}…` : cleaned;
}

function closeActive(reason: CloseReason): void {
  if (!active) return;
  if (active.timer) clearTimeout(active.timer);
  receipt = {
    closedAt: Date.now(),
    reason,
    redemptions: [...active.redemptions],
    failures: [...active.failures],
  };
  active = null;
  onCloseCallback?.(reason);
}

/**
 * Open a pairing window, replacing any window already open.
 *
 * Replacing rather than refusing is deliberate: an operator who runs
 * `agentdeck pair` twice wants the code on their screen to be the live one, and
 * a stale window left running beside it would be a second valid secret nobody
 * is watching.
 */
export function openPairingWindow(opts: {
  ttlMs?: number;
  redemptions?: number;
  /** ESP32 peer IPs the operator named for cable-free re-arming. */
  adoptEsp32Ips?: string[];
} = {}): {
  code: string;
  expiresAt: number;
  redemptions: number;
  adoptEsp32Ips: string[];
} {
  closeActive('operator');
  // A fresh window starts with a fresh receipt: the previous run's redemptions
  // must not be reported back to the operator as if this window had paired them.
  receipt = null;

  const now = Date.now();
  // Clamped, not trusted: the window length is the exposure, so a caller cannot
  // ask for an hour. The floor keeps a typo (`--ttl 0`) from opening a window
  // that expires before the operator can read the code.
  const ttlMs = Math.min(Math.max(Math.trunc(opts.ttlMs ?? PAIRING_WINDOW_MS), 15_000), 600_000);
  const redemptions = Math.min(Math.max(Math.trunc(opts.redemptions ?? DEFAULT_PAIRING_REDEMPTIONS), 1), 16);

  // Only well-formed addresses, so a typo cannot become a wildcard and the set
  // is safe to log. Bounded like every other operator-supplied quantity here.
  const adoptEsp32Ips = new Set(
    (opts.adoptEsp32Ips ?? [])
      .filter((ip): ip is string => typeof ip === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(ip))
      .slice(0, 16),
  );

  const window: ActiveWindow = {
    code: mintCode(),
    expiresAt: now + ttlMs,
    failedAttempts: 0,
    redemptionsRemaining: redemptions,
    openedAt: now,
    credentialGeneration: generationProvider(),
    failures: [],
    redemptions: [],
    adoptEsp32Ips,
    timer: null,
  };
  window.timer = setTimeout(() => {
    // Reports the close; getPairingWindow is what actually enforces expiry.
    if (active === window) closeActive('expired');
  }, ttlMs);
  window.timer.unref?.();
  active = window;

  log(`[agentdeck] Pairing window open for ${Math.round(ttlMs / 1000)}s — code ${formatPairingCode(window.code)}`
    + `, ${redemptions} device(s). Enter it on the device to pair without USB or a QR scan.`);
  if (adoptEsp32Ips.size > 0) {
    log(`[agentdeck] Also re-arming ESP32 board(s) at ${[...adoptEsp32Ips].join(', ')} on their next connect.`);
  }
  return {
    code: window.code,
    expiresAt: window.expiresAt,
    redemptions,
    adoptEsp32Ips: [...adoptEsp32Ips],
  };
}

/**
 * Whether an ESP32 peer at `ip` may be re-armed over the socket it just opened.
 *
 * A board has no keyboard, so a pairing code cannot authorize it. The operator
 * naming its address does — they read that address off this daemon's own refusal
 * log. Deliberately NOT "any peer claiming clientType=esp32 while a window is
 * open": that claim is unverifiable, and a window opened to pair a phone would
 * then hand the token to anything on the segment that asked for it.
 *
 * The grant is still bounded by the window: it expires with it, and it survives
 * no longer than the operator's attention.
 */
export function mayAdoptEsp32(ip: string, now = Date.now()): boolean {
  const window = getActive(now);
  if (!window) return false;
  return window.adoptEsp32Ips.has(ip);
}

/**
 * Record that a board was re-armed, and stop offering to do it again.
 *
 * Removed from the set on success so a board that keeps reconnecting is not
 * re-provisioned on every dial — the second push would be indistinguishable
 * from the first failing, which is exactly the signal the operator needs.
 */
export function noteEsp32Adopted(ip: string, board: string | undefined, now = Date.now()): void {
  const window = getActive(now);
  if (!window) return;
  window.adoptEsp32Ips.delete(ip);
  window.redemptions.push({
    at: now,
    ip,
    name: sanitizeLabel(board, 'esp32 board', 24),
    kind: 'esp32',
  });
  log(`[agentdeck] Re-armed ${board ?? 'ESP32 board'} at ${ip} over WiFi — no cable needed.`);
  if (window.adoptEsp32Ips.size === 0 && window.redemptionsRemaining <= 0) {
    closeActive('redeemed');
  }
}

/** Close the window early (operator cancelled, daemon shutting down). */
export function closePairingWindow(): void {
  if (active) log('[agentdeck] Pairing window closed.');
  closeActive('operator');
}

/**
 * The live window, or null. Enforces expiry on read — see the module note on
 * why a late timer must not be able to extend the promise.
 */
function getActive(now = Date.now()): ActiveWindow | null {
  if (!active) return null;
  if (active.credentialGeneration !== generationProvider()) { closeActive('operator'); return null; }
  if (now >= active.expiresAt) {
    closeActive('expired');
    return null;
  }
  return active;
}

/** True when `POST /pair` is a route at all. Consulted by the HTTP gate. */
export function pairingWindowOpen(now = Date.now()): boolean {
  return getActive(now) !== null;
}

/** Operator-facing status: never includes the code, which the opener already has. */
export function getPairingWindowStatus(now = Date.now()): {
  open: boolean;
  expiresAt: number | null;
  secondsRemaining: number;
  attemptsRemaining: number;
  redemptionsRemaining: number;
  redemptions: PairingRedemption[];
  failures: Array<{ at: number; ip: string }>;
  /** ESP32 peers still awaiting a re-arm on their next connect. */
  adoptEsp32Pending: string[];
} {
  const window = getActive(now);
  if (!window) {
    // Report the receipt of the window that just closed, so a poller that
    // arrives one tick after a successful pairing still sees the pairing.
    const closed = getReceipt(now);
    return {
      open: false,
      expiresAt: null,
      secondsRemaining: 0,
      attemptsRemaining: 0,
      redemptionsRemaining: 0,
      redemptions: closed ? [...closed.redemptions] : [],
      failures: closed ? [...closed.failures] : [],
      adoptEsp32Pending: [],
    };
  }
  return {
    open: true,
    expiresAt: window.expiresAt,
    secondsRemaining: Math.max(0, Math.ceil((window.expiresAt - now) / 1000)),
    attemptsRemaining: PAIRING_MAX_FAILED_ATTEMPTS - window.failedAttempts,
    redemptionsRemaining: window.redemptionsRemaining,
    redemptions: [...window.redemptions],
    failures: [...window.failures],
    adoptEsp32Pending: [...window.adoptEsp32Ips],
  };
}

export interface RedeemResult {
  outcome: PairingRedemptionOutcome;
  status: number;
  attemptsRemaining: number;
  /** Present only on `accepted`. */
  token?: string;
}

/**
 * Redeem a submitted code for the pairing token.
 *
 * `mintToken` is injected rather than imported so this module never reaches for
 * a credential it did not hand out — and so the test can assert that a refused
 * redemption never calls it at all.
 */
export function redeemPairingCode(
  submitted: unknown,
  peer: { ip: string; name?: unknown; kind?: unknown },
  mintToken: () => string,
  now = Date.now(),
): RedeemResult {
  const window = getActive(now);
  const verdict = evaluatePairingRedemption(window, submitted, now);

  if (verdict.outcome === 'accepted' && window) {
    const name = sanitizeLabel(peer.name, 'unnamed device');
    const kind = sanitizeLabel(peer.kind, 'unknown', 24);
    window.redemptions.push({ at: now, ip: peer.ip, name, kind });
    window.redemptionsRemaining -= 1;
    const token = mintToken();
    log(`[agentdeck] Paired ${name} (${kind}) at ${peer.ip} with a pairing code.`);
    // A window has two halves — a code for devices with a keyboard, and an adopt
    // list for boards that have none — and it may only close when BOTH are done.
    // Closing on the code alone abandons a board the operator is still waiting
    // on, and a board that dials once a minute will always lose that race.
    if (verdict.closes && window.adoptEsp32Ips.size === 0) closeActive('redeemed');
    return { outcome: verdict.outcome, status: verdict.status, attemptsRemaining: verdict.attemptsRemaining, token };
  }

  if (verdict.outcome === 'mismatch' && window) {
    window.failedAttempts += 1;
    window.failures.push({ at: now, ip: peer.ip });
    log(`[agentdeck] Pairing code refused for ${peer.ip} — ${verdict.attemptsRemaining} attempt(s) left.`);
    if (verdict.closes) {
      log('[agentdeck] Pairing window closed after too many wrong codes. Run "agentdeck pair" again if that was you.');
      closeActive('attempts-exhausted');
    }
  } else if (verdict.closes) {
    closeActive(verdict.outcome === 'expired' ? 'expired' : 'attempts-exhausted');
  }

  return { outcome: verdict.outcome, status: verdict.status, attemptsRemaining: verdict.attemptsRemaining };
}

/** @internal Test seam — drops any window without logging an operator action. */
export function resetPairingWindowForTests(): void {
  if (active?.timer) clearTimeout(active.timer);
  active = null;
  receipt = null;
  onCloseCallback = null;
}
