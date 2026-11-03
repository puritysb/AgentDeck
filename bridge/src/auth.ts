import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir, hostname, networkInterfaces } from 'os';
import type { IncomingHttpHeaders } from 'http';
import { getLanIp, localTrustVerdict, type LocalTrustVerdict } from '@agentdeck/shared';
import { debug, log } from './logger.js';
import { adoptPairingCredentials, rotatePairingCredentials, pairingCredentialGeneration, type PairingCredentials, type PairingRetirement } from '@agentdeck/shared';
import { closePairingWindow, setPairingCredentialGeneration } from './pairing-window.js';
import { readCredentialState, writeCredentialState, mutateCredentialState } from './pairing-credential-store.js';

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
let cachedCredentials: { dir: string; state: PairingCredentials } | null = null;
function persistedCredentials(): PairingCredentials | null {
  const dir = dataDir();
  if (cachedCredentials?.dir === dir) return cachedCredentials.state;
  let state = readCredentialState(dir);
  if (!state && dir !== LEGACY_DIR && !existsSync(tokenFile(dir))) {
    state = readCredentialState(LEGACY_DIR);
    if (state) writeCredentialState(dir, state);
  }
  if (state) cachedCredentials = { dir, state };
  return state;
}
export function getPairingCredentials(): PairingCredentials {
  const persisted = persistedCredentials();
  if (persisted) return persisted;
  const state: PairingCredentials = { version: 1, revision: 0, eventId: '', token: getOrCreateToken(), accepted: [...getAcceptedTokens()] };
  cachedCredentials = {dir:dataDir(),state};
  return state;
}
export function getPairingRetirement(): PairingRetirement {
  const { version, revision, eventId } = getPairingCredentials();
  return { version, revision, eventId };
}
export function getPairingGeneration(): string | undefined { return pairingCredentialGeneration(getPairingRetirement()); }
setPairingCredentialGeneration(() => getPairingGeneration());
function commitCredentials(state: PairingCredentials): void {
  const dir = dataDir();
  if (state.revision > 0) closePairingWindow();
  cachedCredentials = { dir, state };
  cachedToken = { dir, token: state.token };
  cachedAccepted = { dir, tokens: state.accepted };
}

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
  const state = persistedCredentials();
  if (state) return state.token;
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
  const state = persistedCredentials();
  if (state) return [...state.accepted];
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

/** Every pairing token this machine holds on disk — the served one and the
 *  accepted ring — without minting one when none exists. For scrubbing text
 *  that leaves the machine. */
export function readKnownTokens(): string[] {
  const state = readCredentialState(dataDir());
  if (state) return [state.token, ...state.accepted];
  const served = readTokenFile(tokenFile());
  return [...(served ? [served] : []), ...getAcceptedTokens()];
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
 * Returns true when the served token or retirement fence changed.
 */
export function adoptPeerToken(peerToken: unknown, retirement?: unknown): boolean {
  // Missing/invalid tokens remain a no-op for legacy health frames. Retirement
  // refusal is consequential: callers must not continue a stale handover.
  if (!isWellFormedToken(peerToken)) {
    if (retirement !== undefined) throw new Error('Pairing credential state unavailable; handover refused');
    return false;
  }
  const before = getPairingCredentials();
  const transform = (current: PairingCredentials) => {
    const result = adoptPairingCredentials(current, peerToken.trim(), retirement);
    if (result.kind === 'refused') throw new Error(`Pairing credential handover refused: ${result.reason}`);
    return result.state;
  };
  const proposed = transform(before);
  if (proposed === before) return false;
  let state: PairingCredentials;
  try { state = mutateCredentialState(dataDir(), before, transform); }
  catch (error) {
    // Native SQLite is optional for ordinary legacy convergence. If no atomic
    // authority has ever existed, keep the old mirrors-only path. This branch
    // cannot create/overwrite retirement state and is never used by rotation.
    if (before.revision !== 0 || proposed.revision !== 0 || readCredentialState(dataDir())) throw error;
    mkdirSync(dataDir(), {recursive:true});
    writeFileSync(acceptedFile(), proposed.accepted.map(t => t + '\n').join(''), {mode:0o600});
    writeFileSync(tokenFile(), proposed.token + '\n', {mode:0o600});
    state = proposed;
    debug('auth', 'Legacy convergence persisted without retirement storage; rotation remains unavailable');
  }
  commitCredentials(state);
  if (state.token === before.token && state.revision === before.revision) return false;
  debug('auth', state.revision > 0 ? 'Adopted current pairing retirement; previous credentials refused' : 'Adopted peer pairing token; previous token retained');
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
    // Windows has no POSIX signals: libuv implements this as OpenProcess, which
    // is refused for an ELEVATED process of the same user as readily as for
    // another user's. Reading that as `other-user` would break the ordinary
    // "daemon runs elevated, CLI does not" case — a real regression in exchange
    // for a protection Windows cannot express here anyway.
    if (code === 'EPERM' && process.platform !== 'win32') return 'other-user';
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

/** The parts of a Node request that same-machine trust reads. */
export interface LocalTrustRequestLike {
  method?: string;
  headers: IncomingHttpHeaders;
  socket: { localPort?: number };
}

/**
 * Whether a request from this machine may skip the pairing token: the rule in
 * `shared/src/local-trust.ts`. A web page in a browser here connects from this
 * machine as well, and its `Host` and `Origin` headers are what tell it apart
 * from a local program. The port is the one the request arrived on, which is
 * the port this server's own pages carry in their origin.
 */
export function localTrustOf(req: LocalTrustRequestLike, upgrade = false): LocalTrustVerdict {
  return localTrustVerdict(
    {
      method: req.method ?? 'GET',
      upgrade,
      origin: firstHeader(req.headers.origin),
      host: firstHeader(req.headers.host),
    },
    { port: req.socket.localPort ?? 0, isLocalAddress: isLocalConnection, hostNames: [hostname()] },
  );
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const LOCAL_TRUST_REFUSAL_LOG_MS = 60_000;
const localTrustRefusalLoggedAt = new Map<string, number>();

/**
 * Say why a same-machine request had to authenticate like a LAN peer: once a
 * minute per surface and reason, so a page retrying in a loop cannot flood the
 * log. The header came from a web page, so it is clipped and reduced to URL
 * characters before it reaches a terminal.
 */
export function logLocalTrustRefusal(
  surface: string,
  verdict: Exclude<LocalTrustVerdict, 'trusted'>,
  req: LocalTrustRequestLike,
  now = Date.now(),
): void {
  const key = `${surface}:${verdict}`;
  if (now - (localTrustRefusalLoggedAt.get(key) ?? 0) < LOCAL_TRUST_REFUSAL_LOG_MS) return;
  localTrustRefusalLoggedAt.set(key, now);
  const header = verdict === 'foreign-host' ? 'Host' : 'Origin';
  const value = firstHeader(verdict === 'foreign-host' ? req.headers.host : req.headers.origin) ?? '';
  const shown = value.replace(/[^a-zA-Z0-9:/._\-[\]%]/g, '').slice(0, 80) || '(empty)';
  log(`[agentdeck] A same-machine ${surface} request with ${header} ${shown} is a web page, not a local program; `
    + 'it was answered as a LAN peer (pairing token required)');
}

/**
 * Replace the stored pairing token with a freshly generated one and return it.
 * Every paired client (companion apps, provisioned ESP32 boards, remote
 * workers) must be re-paired/re-provisioned afterwards — the caller owns
 * telling the user that. Added for issue #145 so a leaked token can be
 * retired without hand-editing the file.
 */
export function rotateToken(minimumRevision = 0): string {
  const state = mutateCredentialState(dataDir(), getPairingCredentials(), current =>
    rotatePairingCredentials(current, randomBytes(TOKEN_LENGTH / 2).toString('hex'), randomBytes(16).toString('hex'), minimumRevision));
  commitCredentials(state);
  debug('auth', 'Rotated pairing credentials and persisted retirement');
  return state.token;
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
export function validateToken(token: unknown): boolean {
  if (typeof token !== 'string') return false;
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
