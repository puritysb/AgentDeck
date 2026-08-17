/**
 * What `agentdeck daemon start` does about a daemon already answering on the
 * port it wants.
 *
 * This used to live inline in the CLI action, which made it untestable and hid
 * how much trust it extends: it ADOPTS the incumbent's pairing token and can
 * ask it to stand down or shut down — all on the strength of `/health`
 * answering on 127.0.0.1. That was right when the only two daemons on a
 * machine were the Node CLI and the macOS app belonging to the same human. On
 * a shared host it is a credential leak in one direction and a denial of
 * service in the other: user B's `daemon start` copies user A's token into B's
 * home, then demotes A's daemon (see docs/ENTERPRISE-ROADMAP.md §1.2, §1.3).
 *
 * So the decision now asks who owns the incumbent process before doing either.
 * Everything with an effect is a dependency, which is what lets a test drive
 * this against a foreign-owned incumbent and prove the adopt and the
 * stand-down never happened — a truth table over the ownership predicate would
 * stay green while this function forgot to call it.
 */

import { localPeerOwnership, type LocalPeerOwnership } from './auth.js';
import { log as defaultLog } from './logger.js';

/** The subset of `/health` this decision reads. */
export interface IncumbentHealth {
  mode?: string;
  pid?: number;
  isSwift?: boolean;
  pairingToken?: string;
}

export interface TakeoverDeps {
  ownership?: (pid: number | null | undefined) => LocalPeerOwnership;
  /** Returns true when the served token actually changed. */
  adoptToken?: (token: unknown) => boolean;
  standDown?: (port: number) => Promise<boolean>;
  shutdown?: (port: number) => Promise<void>;
  waitForExit?: (port: number, timeoutMs: number) => Promise<boolean>;
  waitForBindable?: (port: number, timeoutMs: number) => Promise<boolean>;
  log?: (msg: string) => void;
}

export type TakeoverOutcome =
  /** Nothing in the way (or it yielded) — go bind. */
  | 'proceed'
  /** Our own daemon is already serving this port; exit 0. */
  | 'already-running'
  /** The user asked for a port we must not take. Exit 1 with the reason. */
  | 'refuse';

/**
 * True when a daemon answering on this machine belongs to a DIFFERENT OS user,
 * and must therefore be left alone entirely: not evicted, not stood down, not
 * conceded to, not adopted from.
 *
 * The daemon's own startup sweeps the whole port window and shuts down every
 * Swift daemon it finds there, which on a shared host means shutting down a
 * coworker's macOS app the moment this user starts a CLI daemon. Only
 * `other-user` — a definite refusal from the OS — blocks; `unknown` stays
 * permissive for the same reason it does everywhere else (see
 * `localPeerOwnership`), so a peer that reports no pid keeps working exactly
 * as it did before.
 */
export function isForeignDaemon(
  health: { pid?: number } | null | undefined,
  ownership: (pid: number | null | undefined) => LocalPeerOwnership = localPeerOwnership,
): boolean {
  return ownership(health?.pid) === 'other-user';
}

/** 12s: `waitForDaemonExit` only proves the daemon stopped ANSWERING. */
const EXIT_WAIT_MS = 12_000;
/** 30s, and not padding: macOS keeps a NECP reservation on a cancelled
 *  listener's port for ~14s, during which `lsof` shows no sockets at all and
 *  bind() still returns EADDRINUSE (measured 2026-08-06 — bindable at ~17s). */
const BINDABLE_WAIT_MS = 30_000;

export async function negotiateIncumbentDaemon(
  args: { port: number; incumbent: IncumbentHealth | null; portWasExplicit: boolean },
  deps: TakeoverDeps = {},
): Promise<TakeoverOutcome> {
  const { port, incumbent, portWasExplicit } = args;
  if (incumbent?.mode !== 'daemon') return 'proceed';

  const log = deps.log ?? defaultLog;
  const ownership = (deps.ownership ?? localPeerOwnership)(incumbent.pid);

  if (ownership === 'other-user') {
    // Neither half of the handover is available across users. Adopting would
    // copy their credential into this user's home; standing them down would
    // let any local account demote any other's daemon. Both are refused
    // together — a daemon we may not talk to is also one we may not take the
    // port from.
    log(`Port ${port} is held by a daemon belonging to another user on this machine.`);
    log(`Not adopting its pairing token and not asking it to stand down — a daemon is per-user.`);
    if (portWasExplicit) {
      log(`Choose another port with -p, or ask that user to stop their daemon.`);
      return 'refuse';
    }
    log(`Starting on a free port instead; clients of yours resolve it from your own daemon.json.`);
    return 'proceed';
  }

  if (ownership === 'unknown') {
    // Permissive on purpose (see `localPeerOwnership`), but never silently:
    // this is the branch where a token crosses a process boundary without
    // proof of who is on the other side.
    log(`Could not confirm which user owns the daemon on port ${port} (it reports no pid) — `
      + `proceeding as if it were yours.`);
  }

  // Take over the fleet's credential along with the port. The app's daemon
  // keeps its token inside its sandbox container, unreadable from here, so
  // this loopback answer is the only place we can learn what every paired
  // board is currently holding. Adopting it BEFORE the stand-down means the
  // handover costs no device its pairing.
  if ((deps.adoptToken ?? (() => false))(incumbent.pairingToken)) {
    log(`Adopted the incumbent daemon's pairing token so paired devices survive the handover.`);
  }

  if (!incumbent.isSwift) {
    log(`Daemon already running on port ${port}. Use 'agentdeck daemon stop' first.`);
    return 'already-running';
  }

  // Reverse two-tier upgrade path: the macOS app may already own the canonical
  // port with its in-process Swift daemon (Tier 1 — limited: no ADB devices,
  // no subscription usage, …). A plain "already running → exit" would strand
  // the user on Tier 1. Ask it to STAND DOWN (demote to client, app keeps
  // running) so this CLI daemon can take over with the full feature set.
  log(`AgentDeck app's in-process daemon holds port ${port} — requesting stand-down to take over with the full CLI feature set…`);
  // Prefer /stand-down (clean demote: the app stays running as a client).
  // Fall back to /shutdown for older app builds that predate the endpoint.
  let acked = await (deps.standDown ?? (async () => false))(port);
  if (!acked) {
    await (deps.shutdown ?? (async () => {}))(port);
    acked = true; // shutdown is best-effort (no ack body); rely on the exit wait
  }

  // Two conditions, not one. `waitForDaemonExit` proves the app stopped
  // answering; `waitForBindable` proves the socket is actually gone. The app
  // releases the port with NWListener.cancel(), which returns before the
  // teardown completes — binding on the first signal alone is what silently
  // demoted this daemon to the 9121 fallback and left the canonical port
  // ownerless. The app's takeover-yield window is longer (45s), so it stays
  // off the port until well after this wait has claimed it.
  const yielded = acked
    && await (deps.waitForExit ?? (async () => false))(port, EXIT_WAIT_MS)
    && await (deps.waitForBindable ?? (async () => false))(port, BINDABLE_WAIT_MS);
  if (yielded) {
    log(`App daemon yielded port ${port}. Starting CLI daemon…`);
    return 'proceed';
  }

  // The app yielded but the PORT did not come back, and that is often not the
  // app's doing: a WiFi device that has gone to sleep with bytes still queued
  // leaves its socket in LAST_ACK on this port, and TCP holds that until it
  // exhausts retransmits — minutes, sometimes. Network.framework exposes no
  // SO_LINGER, so the app cannot RST out of it (measured 2026-08-06: two
  // sleeping ESP32 boards, 11901 and 4 bytes queued, were the only things left
  // on 9120).
  //
  // Carry on rather than exiting. The daemon binds a fallback port and writes
  // it to daemon.json, which is what every client resolves through and what the
  // app itself re-reads when its yield window ends — so the deck keeps working.
  // What must NOT happen is this being silent, which is how the canonical port
  // ended up owned by nobody with the CLI reporting success.
  log(`The AgentDeck app yielded port ${port} but the port has not been released `
    + `(usually a sleeping WiFi device holding a half-closed socket on it).`);
  if (portWasExplicit) {
    // The port was ASKED for, not defaulted to. Quietly binding a different one
    // would answer a question the user did not ask; an explicit choice fails
    // loudly instead.
    log(`Quit the AgentDeck app and retry, or choose another port.`);
    return 'refuse';
  }
  log(`Starting on a fallback port instead — clients resolve it from daemon.json. `
    + `For the canonical port, quit the AgentDeck app and retry, or pass -p.`);
  return 'proceed';
}
