import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { createServer } from 'net';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import http from 'http';
import { debug, logError } from './logger.js';

/** Allow tests to override the data directory via env var */
function getDataDir(): string {
  return process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
}

/**
 * Ordered list of data directories this process should READ from.
 *
 * The App Store macOS build writes its `daemon.json` / `sessions.json`
 * inside its sandbox container, whereas the Node CLI writes to
 * `~/.agentdeck`. Older App Store candidates used an App Group container,
 * so reads keep that path as a legacy fallback.
 * Without cross-reads, `agentdeck claude` launched from Terminal can't
 * see the Swift daemon that's already listening on 9120, and session
 * bridges end up orphaned.
 *
 * Order:
 *   1. `AGENTDECK_DATA_DIR` env override (tests, explicit pinning)
 *   2. `~/.agentdeck`                   (CLI / Homebrew / Node default)
 *   3. App Store sandbox container      (macOS App Store build)
 *   4. Legacy App Store group container (pre-1.0 App Store candidates)
 *
 * Writes stay in the process's own dir via `getDataDir()`. Only reads
 * iterate this list.
 */
export function getCandidateDataDirs(): string[] {
  if (process.env.AGENTDECK_DATA_DIR) return [process.env.AGENTDECK_DATA_DIR];
  const dirs = [join(homedir(), '.agentdeck')];
  if (process.platform === 'darwin') {
    // Avoid reading the App Store sandbox container directly from non-sandboxed
    // Node CLI/daemon, as macOS TCC will block the process and cause it to hang
    // waiting for a permissions dialog that never shows.
    // Instead, rely on port scan/health checks for cross-talk.
    const groupContainer = join(
      homedir(),
      'Library/Group Containers/group.bound.serendipity.agent.deck',
    );
    if (!dirs.includes(groupContainer)) dirs.push(groupContainer);
  }
  return dirs;
}

/**
 * Absolute paths of `daemon.json` files this process should read, in the
 * order defined by `getCandidateDataDirs`. Exposed so hook installers can
 * generate a shell snippet with the same discovery order.
 */
export function getCandidateDaemonJsonPaths(): string[] {
  return getCandidateDataDirs().map((d) => join(d, 'daemon.json'));
}

function getSessionsFile(): string { return join(getDataDir(), 'sessions.json'); }
/** Where THIS process persists the device timeline. Reads may come from any
 *  candidate dir (see `latestTimelinePath`), but the daemon writes only here. */
export function getOwnTimelineFile(): string { return join(getDataDir(), 'timeline.json'); }
function getDaemonFile(): string { return join(getDataDir(), 'daemon.json'); }
export const DAEMON_DEFAULT_PORT = 9120;
const BASE_PORT = 9120;
const MAX_PORT = 9139;
/** Documented daemon port window (docs/daemon.md) — scanned for cross-implementation discovery. */
export const DAEMON_PORT_WINDOW: readonly [number, number] = [BASE_PORT, MAX_PORT];

export interface DaemonInfo {
  port: number;
  pid: number;
  startedAt: string;
  httpPort?: number;  // Swift daemon: HTTP server port (may differ from WS port)
}

export interface SessionEntry {
  id: string;
  port: number;
  pid: number;
  projectName: string;
  agentType?: string;
  tmuxSession?: string;
  tty?: string;
  parentTty?: string;
  startedAt: string;
  /** Explicit deck/tab sort override (default 0); lower sorts first. Set via
   *  `agentdeck <agent> --weight <n>`. See shared sortSessions. */
  weight?: number;
}

function ensureDir(): void {
  const dir = getDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function readSessions(): SessionEntry[] {
  // Read sessions.json from each candidate dir and merge — App Store Swift
  // daemon + CLI Node daemon can coexist, and a session bridge started from
  // one world needs to see entries written by the other (so it can avoid
  // port collisions and recognize existing daemons).
  const merged: SessionEntry[] = [];
  const seen = new Set<string>();
  for (const dir of getCandidateDataDirs()) {
    try {
      const data = readFileSync(join(dir, 'sessions.json'), 'utf-8');
      const parsed = JSON.parse(data) as SessionEntry[];
      for (const entry of parsed) {
        if (!entry?.id || seen.has(entry.id)) continue;
        seen.add(entry.id);
        merged.push(entry);
      }
    } catch {
      // Directory missing or unreadable — normal, skip.
    }
  }
  return merged;
}

/** Atomic write: write to temp file then rename to prevent corruption */
function writeSessions(sessions: SessionEntry[]): void {
  ensureDir();
  const dir = getDataDir();
  const tmpFile = join(dir, `.sessions.${randomUUID()}.tmp`);
  writeFileSync(tmpFile, JSON.stringify(sessions, null, 2), 'utf-8');
  renameSync(tmpFile, getSessionsFile());
}

/** Check if a PID is alive */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether a daemon that just lost the bind race for its requested port
 * should concede (exit) to the process currently answering `/health` there.
 *
 * Concede ONLY when the occupant is a verified, distinct, live daemon:
 *  - `mode !== 'daemon'` → a non-daemon (e.g. a session bridge) holds it; do
 *    not concede (caller falls back to a fresh port, preserving prior behavior).
 *  - `mode === 'daemon'` with a numeric `pid` → concede only if that PID is a
 *    live process other than ourselves. A forged or stale `mode:'daemon'`
 *    response with a dead/own/missing-but-claimed PID must NOT evict us.
 *  - `mode === 'daemon'` with no `pid` → trust the mode (e.g. the Swift App
 *    Store daemon omits `pid`), so cross-implementation coexistence still
 *    hands the port over.
 *
 * `aliveCheck` is injectable for tests; defaults to the real PID liveness probe.
 */
export function shouldConcedePortToOccupant(
  occupant: { mode?: string; pid?: number } | null,
  selfPid: number,
  aliveCheck: (pid: number) => boolean = isProcessAlive,
): boolean {
  if (occupant?.mode !== 'daemon') return false;
  const pid = typeof occupant.pid === 'number' ? occupant.pid : null;
  if (pid === null) return true;
  return pid !== selfPid && aliveCheck(pid);
}

/** Remove dead sessions (PID no longer alive) */
function pruneDeadSessions(sessions: SessionEntry[]): SessionEntry[] {
  return sessions.filter((s) => isProcessAlive(s.pid));
}

export function register(entry: SessionEntry): void {
  const sessions = pruneDeadSessions(readSessions());
  // Remove any stale entry with same id
  const filtered = sessions.filter((s) => s.id !== entry.id);
  filtered.push(entry);
  writeSessions(filtered);
  debug('SessionRegistry', `Registered session ${entry.id} on port ${entry.port}`);
}

export function deregister(id: string): void {
  const sessions = readSessions();
  const filtered = sessions.filter((s) => s.id !== id);
  writeSessions(filtered);
  // Clear cached sibling state so stale data doesn't linger
  import('./session-aggregator.js').then(m => m.clearSiblingStateCache(id)).catch(() => {});
  debug('SessionRegistry', `Deregistered session ${id}`);
}

export function removeDaemonSession(entry: Pick<SessionEntry, 'pid' | 'port'>): void {
  const sessions = readSessions();
  const filtered = sessions.filter((s) =>
    !(s.agentType === 'daemon' && s.pid === entry.pid && s.port === entry.port)
  );
  if (filtered.length !== sessions.length) {
    writeSessions(filtered);
    debug('SessionRegistry', `Removed stale daemon session on port ${entry.port} pid=${entry.pid}`);
  }
}

export function listActive(): SessionEntry[] {
  const sessions = readSessions();
  const alive = pruneDeadSessions(sessions);
  // Write back pruned list if any were removed
  if (alive.length !== sessions.length) {
    writeSessions(alive);
  }
  return alive;
}

/** Find an existing live daemon session, if any */
export function findExistingDaemon(): SessionEntry | null {
  const sessions = listActive(); // prunes dead PIDs
  return sessions.find((s) => s.agentType === 'daemon') ?? null;
}

/**
 * Try to bind a TCP server to a port to verify it's actually free.
 * Binds on 0.0.0.0 (all interfaces) — the same address the WebSocket server uses —
 * so a port held by another process on any interface is correctly detected as busy.
 * The original 127.0.0.1 bind missed ports already occupied on 0.0.0.0 (e.g. zombie
 * session bridges), causing findAvailablePort to hand out ports that immediately
 * caused EADDRINUSE on the real server start.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '0.0.0.0');
  });
}

export async function findAvailablePort(opts?: { reserveDaemon?: boolean }): Promise<number> {
  const sessions = listActive();
  const usedPorts = new Set(sessions.map((s) => s.port));
  // Session bridges start from BASE_PORT+1 to reserve 9120 for the daemon.
  const startPort = opts?.reserveDaemon ? BASE_PORT + 1 : BASE_PORT;
  for (let port = startPort; port <= MAX_PORT; port++) {
    if (!usedPorts.has(port) && await isPortFree(port)) {
      return port;
    }
  }
  // All ports exhausted — throw instead of silently colliding
  throw new Error(`All AgentDeck ports (${BASE_PORT}–${MAX_PORT}) are in use. Stop an existing session first.`);
}

/** Detect tmux session name if running inside tmux */
export function detectTmuxSession(): string | undefined {
  if (!process.env.TMUX) return undefined;
  try {
    const result = execSync('tmux display-message -p "#S:#I"', {
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

// ===== daemon.json — daemon port discovery =====

/** Write daemon.json so clients can discover the daemon port */
export function writeDaemonInfo(info: DaemonInfo): void {
  ensureDir();
  const dir = getDataDir();
  const tmpFile = join(dir, `.daemon.${randomUUID()}.tmp`);
  writeFileSync(tmpFile, JSON.stringify(info, null, 2), 'utf-8');
  renameSync(tmpFile, getDaemonFile());
  debug('SessionRegistry', `Wrote daemon.json: port=${info.port} pid=${info.pid}`);
}

/**
 * Restore this daemon's discovery file when an external process deleted or
 * corrupted it while the daemon itself is still healthy.
 *
 * A second live daemon must win ownership of an existing file: overwriting
 * that record would hide a real split-brain instead of resolving it. The
 * caller therefore repairs only missing/malformed records, stale PIDs, or a
 * record for its own PID whose bound port changed.
 *
 * Returns true when the file was rewritten.
 */
export function ensureDaemonInfo(info: DaemonInfo): boolean {
  try {
    const current = JSON.parse(readFileSync(getDaemonFile(), 'utf-8')) as Partial<DaemonInfo>;
    if (
      current.pid === info.pid
      && current.port === info.port
      && (current.httpPort ?? null) === (info.httpPort ?? null)
    ) {
      return false;
    }
    if (
      typeof current.pid === 'number'
      && current.pid !== info.pid
      && isProcessAlive(current.pid)
    ) {
      return false;
    }
  } catch {
    // Missing or malformed — rewrite below.
  }

  writeDaemonInfo(info);
  return true;
}

/** Remove daemon.json on shutdown — try every candidate dir in case a stale
 *  file lingers in a sibling world (e.g. Swift died before cleanup). */
export function removeDaemonInfo(): void {
  let removed = false;
  for (const dir of getCandidateDataDirs()) {
    try {
      unlinkSync(join(dir, 'daemon.json'));
      removed = true;
    } catch {
      // Not present — normal.
    }
  }
  if (removed) debug('SessionRegistry', 'Removed daemon.json');
}

/**
 * Read daemon.json from the first candidate dir that has a valid, live
 * entry. Iterates `getCandidateDataDirs()` so CLI processes can discover
 * an App Store Swift daemon's info in the group container, and vice
 * versa. Stale entries (dead PID) are pruned from the dir that owned
 * them — never cross-dir — to avoid deleting the other world's live file.
 */
export function readDaemonInfo(): DaemonInfo | null {
  for (const dir of getCandidateDataDirs()) {
    const path = join(dir, 'daemon.json');
    try {
      const data = readFileSync(path, 'utf-8');
      const info = JSON.parse(data) as DaemonInfo;
      if (info.pid && isProcessAlive(info.pid)) {
        return info;
      }
      // Stale entry — only prune if this is our own dir. Cross-dir write
      // is risky (permission boundaries, group container sandbox).
      if (dir === getDataDir()) {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
    } catch {
      // Missing or unparseable — fall through to next candidate.
    }
  }
  return null;
}

/**
 * Probe a port's /health endpoint to check if a daemon is already running there.
 * Returns the health JSON if it's a daemon, null otherwise.
 * Timeout: 2s.
 *
 * The Swift App Store daemon serves its HTTP endpoints (including `/health`)
 * on a dedicated port that may differ from the WS port. Callers should pass
 * `httpPort` from `DaemonInfo` when available; otherwise the same `port` is
 * used (Node daemon unifies HTTP + WS on one port).
 */
export function probeDaemonHealth(port: number): Promise<{ mode?: string; pid?: number; isSwift?: boolean; sameSocketControl?: boolean } | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          resolve(json);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Sweep the daemon port window for live daemons that file-based discovery
 * cannot see. Two blind spots make this necessary:
 *  - The App Store Swift daemon writes `daemon.json` into its private sandbox
 *    container, which `getCandidateDataDirs()` cannot read.
 *  - Transient 9120 contention can bump a daemon to a fallback port (9121+),
 *    where the default-port probe never looks.
 * Probes all window ports concurrently (localhost refusals resolve instantly)
 * and returns every occupant whose `/health` reports `mode: 'daemon'`.
 */
export async function scanDaemonPortWindow(
  skip: ReadonlySet<number> = new Set(),
  window: readonly [number, number] = DAEMON_PORT_WINDOW,
): Promise<Array<{ port: number; health: { mode?: string; pid?: number; isSwift?: boolean } }>> {
  const ports: number[] = [];
  for (let p = window[0]; p <= window[1]; p++) {
    if (!skip.has(p)) ports.push(p);
  }
  const probes = await Promise.all(
    ports.map(async (port) => ({ port, health: await probeDaemonHealth(port) })),
  );
  return probes.filter((r): r is { port: number; health: NonNullable<typeof r.health> } =>
    r.health?.mode === 'daemon');
}

/**
 * Poll a port's `/health` until the daemon there stops answering, or the
 * timeout expires. Used after `requestDaemonShutdown()` instead of a fixed
 * sleep: the Swift daemon tears down device modules (serial, ADB reverse,
 * BLE) during shutdown, and taking over before it finishes leaves two owners
 * briefly contending for the same tty / adb reverse mapping.
 * Returns true once the daemon is gone.
 */
export async function waitForDaemonExit(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await probeDaemonHealth(port))) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** One bind attempt. Resolves true when the port accepted a listener. */
function probePortBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    // Match the daemon's own bind (IPv4 loopback-reachable, not ::1) so the
    // probe answers the question the daemon will actually ask.
    probe.listen(port, '0.0.0.0');
  });
}

/**
 * Poll until `port` can actually be bound, or the timeout expires.
 *
 * `waitForDaemonExit` proves something different and weaker: that the daemon
 * stopped ANSWERING. Between "stopped answering" and "port is free" sits the
 * socket close, and on the Swift side that gap is real — its servers release
 * the port with `NWListener.cancel()`, which returns immediately and tears down
 * asynchronously. Binding into that gap is not a hypothetical: on 2026-08-06
 * `agentdeck daemon start` reported "App daemon yielded port 9120", bound
 * ~300ms later, hit EADDRINUSE, and fell back to 9121 — leaving the canonical
 * port owned by nobody and every client that resolves 9120 blind.
 *
 * Returns true once a bind succeeded.
 */
export async function waitForPortBindable(port: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probePortBindable(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * Request another daemon to shutdown (used to clear Swift daemon when CLI starts)
 */
export function requestDaemonShutdown(port: number): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/shutdown',
      method: 'POST',
      timeout: 2000
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => { resolve(); });
    });
    req.on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.end();
  });
}

/**
 * Ask an app-owned Swift in-process daemon to YIELD the canonical port (POST
 * /stand-down) so this CLI daemon can take over with the full feature set.
 * Unlike `/shutdown`, this keeps the macOS app running — it just demotes its
 * daemon to a client of the incoming CLI daemon. Returns true if the daemon
 * acknowledged (HTTP 2xx). The caller should then `waitForDaemonExit()` for the
 * port to clear before binding.
 */
export function requestDaemonStandDown(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/stand-down',
      method: 'POST',
      timeout: 2000,
    }, (res) => {
      res.on('data', () => {});
      res.on('end', () => { resolve((res.statusCode ?? 500) < 300); });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Find the daemon port for client connections.
 * Priority: daemon.json (fast) → sessions.json fallback.
 */
export function findDaemonPort(): number | null {
  // 1. daemon.json — authoritative, includes fallback port
  const info = readDaemonInfo();
  if (info) return info.port;

  // 2. sessions.json — legacy fallback
  const daemon = findExistingDaemon();
  if (daemon) return daemon.port;

  return null;
}

/**
 * Async daemon discovery with /health probe fallback.
 *
 * Used by long-lived clients (session bridge `DaemonWsClient`) that can
 * afford one extra probe round when the registry is empty — typical when
 * the Swift daemon is running but its `daemon.json` lives in a world this
 * process's `getCandidateDataDirs()` couldn't read (e.g. the group
 * container entitlement isn't shared, or the file was written in a
 * different sandbox). Respects `httpPort` so Swift's split WS/HTTP layout
 * is probed correctly.
 *
 * Returns `{ port, httpPort? }` for callers that need both (WS connects
 * on `port`, hook HTTP posts target `httpPort ?? port`).
 */
export async function findDaemonPortAsync(): Promise<{ port: number; httpPort?: number; sameSocketControl?: boolean } | null> {
  // 1. Registry first — matches the sync path.
  const info = readDaemonInfo();
  if (info) {
    const probePort = info.httpPort ?? info.port;
    const health = await probeDaemonHealth(probePort);
    if (health?.mode === 'daemon') {
      return { port: info.port, httpPort: info.httpPort, sameSocketControl: health.sameSocketControl === true };
    }
    // Registry entry was stale (PID alive but server unresponsive).
    // Fall through to port scan.
  }

  // 2. Port scan fallback — covers the "App Store daemon is up but its
  //    daemon.json sits in a dir this process can't read" case. Narrow
  //    range (9120-9139) matches the documented daemon port window.
  for (let p = DAEMON_PORT_WINDOW[0]; p <= DAEMON_PORT_WINDOW[1]; p++) {
    const health = await probeDaemonHealth(p);
    if (health?.mode === 'daemon') {
      return { port: p, sameSocketControl: health.sameSocketControl === true };
    }
  }

  return null;
}

// ===== Remote daemon attach (mDNS / explicit host) =====

/** True if a host string refers to this machine's loopback. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** Bracket bare IPv6 literals so they're valid in an http(s)/ws URL authority. */
export function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Probe `/health` at an arbitrary host:port (not just 127.0.0.1). Returns the
 * full health JSON (so callers can read `mode` and `pairingToken`) or null.
 */
export function probeHealthAt(host: string, port: number, timeoutMs = 2000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const req = http.get(`http://${formatHostForUrl(host)}:${port}/health`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/** A resolved daemon endpoint, possibly on another machine. */
export interface DaemonTarget {
  host: string;
  port: number;
  /** Pairing token — required when `host` is not this machine. */
  token?: string;
  httpPort?: number;
  /**
   * Whether the daemon's `/health` advertises same-socket reverse control
   * (`sameSocketControl: true`). The worker only sends `remoteAttach` in its
   * push registration when the daemon can actually drive the session back down
   * the socket — a daemon without the capability (e.g. the Swift App Store
   * daemon) gets a plain local-style registration instead.
   */
  sameSocketControl?: boolean;
}

/** Parse a `host` or `host:port` (or `[v6]:port`) hint into host + port. */
export function parseHostHint(hint: string): { host: string; port: number } {
  const trimmed = hint.trim();
  // [v6]:port
  const bracket = /^\[(.+)\]:(\d+)$/.exec(trimmed);
  if (bracket) return { host: bracket[1], port: parseInt(bracket[2], 10) };
  // [v6]  (no port)
  const bracketOnly = /^\[(.+)\]$/.exec(trimmed);
  if (bracketOnly) return { host: bracketOnly[1], port: DAEMON_DEFAULT_PORT };
  // host:port — only treat trailing :digits as a port (leaves bare IPv6 alone)
  const hp = /^(.+):(\d+)$/.exec(trimmed);
  if (hp && !hp[1].includes(':')) return { host: hp[1], port: parseInt(hp[2], 10) };
  return { host: trimmed, port: DAEMON_DEFAULT_PORT };
}

/**
 * Injectable dependencies for {@link resolveDaemonTarget}. Production uses the
 * real module functions; tests substitute fakes to assert the precedence and —
 * critically — the opt-in gate, without touching the network. `warn` defaults
 * to a once-per-key `logError` ({@link warnRemoteOnce}; keys are `host:port`,
 * prefixed `local:` for the loopback branch — the only PTY-visible log
 * primitive; this resolver re-runs on every `DaemonWsClient` reconnect
 * backoff, so an unguarded warning would scribble over the agent TUI every
 * ≤30s forever).
 */
export interface ResolveDaemonDeps {
  findLocal: () => Promise<{ port: number; httpPort?: number; sameSocketControl?: boolean } | null>;
  probeHealth: (host: string, port: number) => Promise<Record<string, unknown> | null>;
  discover: () => Promise<Array<{ host: string; port: number; token?: string; sameSocketControl?: boolean }>>;
  warn: (key: string, message: string) => void;
}

/**
 * Derive the remote-attach inputs from CLI flags + env — the single source that
 * both `cli.ts` (pre-PTY "ignored" warning) and `index.ts` (target resolution)
 * consume, so the two derivations cannot drift. `--remote-daemon` /
 * `AGENTDECK_REMOTE_DAEMON=1` is THE opt-in; a host given without it
 * (`ignoredHostHint`) is inert and the CLI warns before the PTY starts
 * (post-PTY, stdout logging is swallowed).
 */
export function deriveRemoteAttachOpts(
  cliOpts: { remoteDaemon?: boolean; daemonHost?: string; daemonToken?: string },
  env: NodeJS.ProcessEnv = process.env,
): { remote: boolean; hostHint?: string; tokenHint?: string; ignoredHostHint: boolean } {
  const remote = !!cliOpts.remoteDaemon || env.AGENTDECK_REMOTE_DAEMON === '1';
  const hostHint = cliOpts.daemonHost
    || env.AGENTDECK_DAEMON_HOST
    || env.AGENTDECK_REMOTE_DAEMON_HOST
    || undefined;
  // Pairing token for the remote hub. Since issue #145 the daemon no longer
  // hands its token to unauthenticated LAN peers (/health) or discovery
  // broadcasts (mDNS TXT / UDP), so the worker must be provisioned with it
  // explicitly — the value lives at ~/.agentdeck/auth-token on the hub machine.
  const tokenHint = cliOpts.daemonToken || env.AGENTDECK_DAEMON_TOKEN || undefined;
  return { remote, hostHint, tokenHint, ignoredHostHint: !remote && hostHint !== undefined };
}

const remoteWarnedHosts = new Set<string>();

/**
 * Default `warn` dep: log a remote-attach warning at most once per key. The
 * resolver re-runs on every reconnect backoff, and an unguarded warning would
 * scribble over the agent TUI every few seconds forever.
 * @internal Exported for tests only — the module-level Set has no reset, so
 * tests must use keys unique to themselves.
 */
export function warnRemoteOnce(key: string, message: string): void {
  if (remoteWarnedHosts.has(key)) return;
  remoteWarnedHosts.add(key);
  logError(message);
}

/**
 * Resolve which daemon a session bridge should attach to, optionally on another
 * machine. Precedence:
 *   1. Local daemon (unchanged behavior — always preferred, never opt-in gated).
 *   2. Explicit `hostHint` (cross-subnet / SSH where mDNS doesn't propagate).
 *   3. mDNS browse on the LAN.
 *
 * OPT-IN INVARIANT (security boundary): `--remote-daemon` /
 * `AGENTDECK_REMOTE_DAEMON=1` (`remote === true`) is THE opt-in switch, and it
 * gates BOTH remote paths. `--daemon-host` / `AGENTDECK_DAEMON_HOST` only names
 * the endpoint — without the switch it is ignored (the CLI warns pre-PTY).
 * Nothing below the local check ever leaves the machine unless `remote === true`:
 * with the switch absent the function returns local-or-null and the session
 * stays local-only — byte-for-byte the pre-remote behavior.
 *
 * Within `remote === true`, EVERY accepted target must advertise the
 * `sameSocketControl` capability — including a loopback one. An ssh -L
 * forward of a remote daemon is indistinguishable from a genuine local
 * daemon by IP, so the local-first step enforces the capability too rather
 * than silently accepting a tunnel to a daemon that can never drive the
 * session (plain registration: acked but unlistable/unfocusable):
 *   - Capable local daemon ⇒ returned (a hostHint is NOT consulted — the
 *     ordinary local-preferred behavior).
 *   - Incapable local daemon + hostHint ⇒ fall through to the explicit-host
 *     step: the user named a node, so probe THAT instead of dead-ending.
 *   - Incapable local daemon, no hostHint ⇒ one-shot warning + null. No mDNS
 *     fallthrough: a deliberately-built tunnel must not silently roam to
 *     some other LAN daemon.
 *   - An explicit host that is unreachable, not a daemon, or lacks the
 *     capability returns null WITHOUT falling through to mDNS — the user
 *     named a specific node and expects to hear about failure.
 *   - mDNS selection is limited to daemons advertising `sameSocketControl`
 *     (the discover step filters), so an unsupported daemon (e.g. Swift App
 *     Store) is never selected as a remote target.
 *
 * Remote targets need the hub's pairing `token`; local targets need none (the
 * daemon treats same-machine connections as authenticated). Token sourcing
 * (issue #145): explicit `tokenHint` (`--daemon-token` / AGENTDECK_DAEMON_TOKEN)
 * first, then whatever a legacy daemon still advertises in `/health` — current
 * daemons no longer serve their token to unauthenticated LAN peers.
 */
export async function resolveDaemonTarget(
  opts?: { remote?: boolean; hostHint?: string; tokenHint?: string },
  deps?: Partial<ResolveDaemonDeps>,
): Promise<DaemonTarget | null> {
  const findLocal = deps?.findLocal ?? findDaemonPortAsync;
  const probeHealth = deps?.probeHealth ?? probeHealthAt;
  const discover = deps?.discover
    ?? (async () => {
      const { discoverDaemons } = await import('./mdns-discover.js');
      return discoverDaemons();
    });
  const warn = deps?.warn ?? warnRemoteOnce;

  // 1. Local first. Without the opt-in switch this is identical to the
  //    pre-remote behavior (returned unconditionally). Under remote intent the
  //    local daemon must ALSO advertise sameSocketControl: an ssh -L forward
  //    of a remote daemon arrives on loopback, and accepting an incapable one
  //    would silently produce a plain registration (acked but never listable
  //    or focusable) instead of the refusal the user can act on.
  const local = await findLocal();
  if (local) {
    if (opts?.remote !== true || local.sameSocketControl === true) {
      return {
        host: '127.0.0.1', port: local.port, httpPort: local.httpPort,
        sameSocketControl: local.sameSocketControl,
      };
    }
    // Remote intent + incapable loopback daemon. If the user named a host,
    // probe that instead of dead-ending here (step 2 applies its own
    // capability refusal — for a tunnel the hint is typically 127.0.0.1 and
    // probes this same daemon). With no hint: warn once and refuse; no mDNS
    // fallthrough — a deliberately-built tunnel must not silently roam.
    if (!opts?.hostHint) {
      warn(`local:127.0.0.1:${local.port}`,
        `Daemon at 127.0.0.1:${local.port} does not support remote attach (no sameSocketControl capability — Node CLI daemon required). Not attaching. Rerun without --remote-daemon for a local-only session, or pass --daemon-host <host> to name a capable hub.`);
      return null;
    }
  }

  // Everything below leaves the machine — hard-gated on the opt-in switch.
  if (opts?.remote !== true) return null;

  // 2. Explicit host. If given but unreachable or incapable, do NOT silently
  //    fall through to mDNS — the user named a specific node and expects to
  //    hear about failure.
  if (opts?.hostHint) {
    const { host, port } = parseHostHint(opts.hostHint);
    const health = await probeHealth(host, port);
    if (health?.mode === 'daemon') {
      if (health.sameSocketControl !== true) {
        warn(`${host}:${port}`,
          `Daemon at ${host}:${port} does not support remote attach (no sameSocketControl capability — Node CLI daemon required); session stays local-only.`);
        return null;
      }
      const advertised = typeof health.pairingToken === 'string' ? health.pairingToken : undefined;
      const token = opts?.tokenHint ?? advertised;
      if (!token) {
        warn(`token:${host}:${port}`,
          `No pairing token for remote daemon ${host}:${port} — it will reject this session. Pass --daemon-token <token> or set AGENTDECK_DAEMON_TOKEN (the value is in ~/.agentdeck/auth-token on the hub machine).`);
      }
      return { host, port, token, sameSocketControl: true };
    }
    return null;
  }

  // 3. mDNS browse. The discover step's /health confirm already filtered out
  //    daemons lacking sameSocketControl, so anything returned is capable.
  const found = await discover();
  if (found.length > 0) {
    const d = found[0];
    const token = opts?.tokenHint ?? d.token;
    if (!token) {
      warn(`token:${d.host}:${d.port}`,
        `No pairing token for remote daemon ${d.host}:${d.port} — it will reject this session. Pass --daemon-token <token> or set AGENTDECK_DAEMON_TOKEN (the value is in ~/.agentdeck/auth-token on the hub machine).`);
    }
    return { host: d.host, port: d.port, token, sameSocketControl: d.sameSocketControl === true };
  }

  return null;
}
