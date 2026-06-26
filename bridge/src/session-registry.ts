import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { createServer } from 'net';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import http from 'http';
import { debug } from './logger.js';

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
function getDaemonFile(): string { return join(getDataDir(), 'daemon.json'); }
export const DAEMON_DEFAULT_PORT = 9120;
const BASE_PORT = 9120;
const MAX_PORT = 9139;

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
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
export function probeDaemonHealth(port: number): Promise<{ mode?: string; pid?: number } | null> {
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
export async function findDaemonPortAsync(): Promise<{ port: number; httpPort?: number } | null> {
  // 1. Registry first — matches the sync path.
  const info = readDaemonInfo();
  if (info) {
    const probePort = info.httpPort ?? info.port;
    const health = await probeDaemonHealth(probePort);
    if (health?.mode === 'daemon') {
      return { port: info.port, httpPort: info.httpPort };
    }
    // Registry entry was stale (PID alive but server unresponsive).
    // Fall through to port scan.
  }

  // 2. Port scan fallback — covers the "App Store daemon is up but its
  //    daemon.json sits in a dir this process can't read" case. Narrow
  //    range (9120-9139) matches the documented daemon port window.
  for (let p = 9120; p <= 9139; p++) {
    const health = await probeDaemonHealth(p);
    if (health?.mode === 'daemon') {
      return { port: p };
    }
  }

  return null;
}
