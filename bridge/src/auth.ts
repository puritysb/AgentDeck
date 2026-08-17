import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, networkInterfaces } from 'os';
import { getLanIp } from '@agentdeck/shared';
import { debug } from './logger.js';

const LEGACY_DIR = join(homedir(), '.agentdeck');
const TOKEN_LENGTH = 32; // 32 hex chars = 16 bytes
/** Bounded so a long-lived machine cannot accumulate an unbounded key ring. */
const MAX_ACCEPTED_TOKENS = 4;

/**
 * Every other module resolves its state through
 * `AGENTDECK_DATA_DIR || ~/.agentdeck`; this one used to hardcode the home
 * path, so a daemon started with a custom data dir kept its pairing token
 * somewhere else than the rest of its state.
 */
function dataDir(): string {
  return process.env.AGENTDECK_DATA_DIR || LEGACY_DIR;
}
function tokenFile(dir = dataDir()): string {
  return join(dir, 'auth-token');
}
/**
 * Tokens this daemon still ACCEPTS but no longer hands out — the credential it
 * held before adopting a peer daemon's one (see `adoptPeerToken`). Without it,
 * convergence itself would lock out every device that was provisioned a moment
 * earlier, which is the failure this whole path exists to prevent.
 */
function acceptedFile(dir = dataDir()): string {
  return join(dir, 'auth-token-accepted');
}

// Cached per resolved directory, so pointing AGENTDECK_DATA_DIR somewhere else
// re-reads instead of serving the previous directory's credential.
let cachedToken: { dir: string; token: string } | null = null;
let cachedAccepted: { dir: string; tokens: string[] } | null = null;

function readTokenFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const token = readFileSync(path, 'utf-8').trim();
    return token.length >= TOKEN_LENGTH ? token : null;
  } catch {
    return null;
  }
}

/** Read existing token or generate a new one. */
export function getOrCreateToken(): string {
  const dir = dataDir();
  if (cachedToken?.dir === dir) return cachedToken.token;

  let token = readTokenFile(tokenFile(dir));
  // A custom data dir that has no token yet inherits the legacy one rather than
  // minting a fresh one: generating here would silently un-pair every device
  // the machine already has.
  const inherited = token === null && dir !== LEGACY_DIR
    ? readTokenFile(tokenFile(LEGACY_DIR))
    : null;
  if (inherited) token = inherited;

  const generated = token === null;
  if (token === null) token = randomBytes(TOKEN_LENGTH / 2).toString('hex');

  if (generated || inherited) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(tokenFile(dir), token + '\n', { mode: 0o600 });
      debug('auth', generated
        ? `Generated new auth token → ${tokenFile(dir)}`
        : `Carried the existing auth token into ${tokenFile(dir)}`);
    } catch (err) {
      debug('auth', `Failed to write token file: ${err}`);
    }
  }

  cachedToken = { dir, token };
  return token;
}

/** Shape check for a token handed to us by someone else. */
function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && token.trim().length >= TOKEN_LENGTH;
}

/** Tokens accepted for authentication but never handed out. */
export function getAcceptedTokens(): string[] {
  const dir = dataDir();
  if (cachedAccepted?.dir === dir) return cachedAccepted.tokens;
  let tokens: string[] = [];
  try {
    if (existsSync(acceptedFile(dir))) {
      tokens = readFileSync(acceptedFile(dir), 'utf-8')
        .split('\n')
        .map(line => line.trim())
        .filter(isWellFormedToken)
        .slice(0, MAX_ACCEPTED_TOKENS);
    }
  } catch {
    tokens = [];
  }
  cachedAccepted = { dir, tokens };
  return tokens;
}

function writeAcceptedTokens(tokens: string[]): void {
  const dir = dataDir();
  const bounded = tokens.slice(0, MAX_ACCEPTED_TOKENS);
  cachedAccepted = { dir, tokens: bounded };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(acceptedFile(dir), bounded.map(t => t + '\n').join(''), { mode: 0o600 });
  } catch (err) {
    debug('auth', `Failed to write accepted-token file: ${err}`);
  }
}

/**
 * Adopt the pairing token of a daemon that is already serving this machine.
 *
 * A machine has ONE fleet of paired devices but can be served by either the
 * Node CLI daemon or the macOS app's in-process Swift daemon, and the two keep
 * their token in different files — the sandboxed app cannot read
 * `~/.agentdeck/auth-token` and this process must not poke at the app's
 * container. So the credential travels over the one channel both can always
 * use: the incumbent's loopback `/health`, which carries `pairingToken` to
 * same-machine callers only. Whoever starts second adopts what the incumbent
 * is already serving, so a later handover in EITHER direction is
 * credential-neutral and start order stops mattering.
 *
 * The token we were holding moves to the accepted list rather than being
 * dropped: devices provisioned under it must keep working until they are
 * re-armed.
 *
 * No new trust is granted — `probeDaemonHealth` dials 127.0.0.1, and
 * same-machine peers are already fully trusted by this daemon's access model.
 *
 * Returns true when the served token actually changed.
 */
export function adoptPeerToken(peerToken: unknown): boolean {
  if (!isWellFormedToken(peerToken)) return false;
  const adopted = peerToken.trim();
  const current = getOrCreateToken();
  if (adopted === current) return false;

  const accepted = [current, ...getAcceptedTokens().filter(t => t !== current && t !== adopted)];
  writeAcceptedTokens(accepted);

  const dir = dataDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tokenFile(dir), adopted + '\n', { mode: 0o600 });
  } catch (err) {
    debug('auth', `Failed to persist adopted token: ${err}`);
  }
  cachedToken = { dir, token: adopted };
  debug('auth', 'Adopted the incumbent daemon\'s pairing token; previous one still accepted');
  return true;
}

/**
 * Who owns the process behind a same-machine daemon.
 *
 * `isLocalConnection` answers "is this the same machine", which used to be
 * treated as "is this us". On a shared box those are different questions, and
 * every privileged same-machine interaction rides on the second one: adopting
 * an incumbent's pairing token (`adoptPeerToken`), asking it to stand down or
 * shut down, and attaching a session to a daemon found by port scan. A
 * coworker's daemon answers `/health` on 127.0.0.1 exactly like ours does.
 *
 * Three values, and the third is not a rounding of the other two:
 *
 *  - `same-user`  the caller may signal the process, so it runs as this user
 *                 (or this process is root, which may signal anyone — root is
 *                 already unconstrained and needs no protection from itself).
 *  - `other-user` the OS refused permission. That refusal IS the answer.
 *  - `unknown`    no pid was reported, the process is already gone, or the
 *                 probe failed some other way.
 *
 * **`unknown` stays permissive**, deliberately. The alternative — refuse
 * whenever ownership cannot be proven — would break the documented
 * one-machine-one-token convergence against any peer that reports no pid, and
 * a fleet that cannot authenticate is a far likelier and far worse outcome
 * than a token adopted across users on a shared host. Both current daemons
 * report `pid` in their full `/health`, so `unknown` means an old build or a
 * dead process, not an attacker's choice; call sites log when they proceed on
 * it. See docs/ENTERPRISE-ROADMAP.md §1.2 for what this does NOT cover: any
 * local process can still READ the token from `/health`, because a TCP socket
 * carries no peer credentials.
 *
 * The Swift daemon mirrors this CONTRACT, not this syscall — it is sandboxed,
 * where a denied `kill` would mean "the sandbox said no", not "another user
 * owns it", so it compares uids through `proc_pidinfo` and reports `unknown`
 * on any failure. Same three values, same permissive `unknown`.
 */
export type LocalPeerOwnership = 'same-user' | 'other-user' | 'unknown';

export function localPeerOwnership(pid: number | null | undefined): LocalPeerOwnership {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return 'unknown';
  try {
    // Signal 0 performs the permission check and delivers nothing. POSIX: the
    // sender's real or effective uid must match the target's real or saved
    // uid, so EPERM is precisely "a different user owns this process".
    process.kill(pid, 0);
    return 'same-user';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM') return 'other-user';
    // ESRCH (gone) or anything else: no information.
    return 'unknown';
  }
}

/** Check if a connection originates from this machine (localhost or own LAN IPs). */
export function isLocalConnection(ip: string): boolean {
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return true;

  // Check if ip matches any of this machine's network interfaces
  const nets = networkInterfaces();
  for (const addrs of Object.values(nets)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.address === ip || `::ffff:${a.address}` === ip) return true;
    }
  }
  return false;
}

/**
 * Replace the stored pairing token with a freshly generated one and return it.
 * Every paired client (companion apps, provisioned ESP32 boards, remote
 * workers) must be re-paired/re-provisioned afterwards — the caller owns
 * telling the user that. Added for issue #145 so a leaked token can be
 * retired without hand-editing the file.
 */
export function rotateToken(): string {
  const token = randomBytes(TOKEN_LENGTH / 2).toString('hex');
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(tokenFile(dir), token + '\n', { mode: 0o600 });
  cachedToken = { dir, token };
  // Retiring a leaked token has to retire the key ring with it, or the leaked
  // one survives in the accepted list and rotation buys nothing.
  writeAcceptedTokens([]);
  debug('auth', `Rotated auth token → ${tokenFile(dir)}`);
  return token;
}

function matchesToken(candidate: string, stored: string): boolean {
  // Constant-time comparison to prevent timing attacks
  if (candidate.length !== stored.length) return false;
  let result = 0;
  for (let i = 0; i < candidate.length; i++) {
    result |= candidate.charCodeAt(i) ^ stored.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Validate a token against the one we serve, then against the ones we still
 * accept (a token superseded by `adoptPeerToken`). Every candidate is compared
 * — no early exit — so the answer costs the same whichever key matched.
 */
export function validateToken(token: string): boolean {
  let ok = matchesToken(token, getOrCreateToken());
  for (const accepted of getAcceptedTokens()) {
    ok = matchesToken(token, accepted) || ok;
  }
  return ok;
}

/** Build a ws:// URL with auth token for QR code pairing. */
export function getWsUrl(port: number): string {
  const ip = getLanIp();
  const token = getOrCreateToken();
  return `ws://${ip}:${port}?token=${token}`;
}
