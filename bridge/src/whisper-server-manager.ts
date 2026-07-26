/**
 * Whisper-server singleton manager.
 *
 * Fixed port 9100 — one server shared across all agentdeck sessions.
 * Info file at ~/.agentdeck/whisper-server.json for discovery.
 * Last session to exit kills the server.
 */

import { spawn } from './proc.js';
import {
  readFileSync, writeFileSync, renameSync, unlinkSync,
  mkdirSync, existsSync,
} from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { listActive } from './session-registry.js';
import { debug } from './logger.js';

export const WHISPER_SERVER_PORT = 9100;

const INFO_DIR = join(homedir(), '.agentdeck');
const INFO_FILE = join(INFO_DIR, 'whisper-server.json');

interface ServerInfo {
  pid: number;
  port: number;
  modelPath: string;
  startedAt: string;
}

function ensureDir(): void {
  if (!existsSync(INFO_DIR)) {
    mkdirSync(INFO_DIR, { recursive: true });
  }
}

function readInfo(): ServerInfo | null {
  try {
    return JSON.parse(readFileSync(INFO_FILE, 'utf-8')) as ServerInfo;
  } catch {
    return null;
  }
}

function writeInfo(info: ServerInfo): void {
  ensureDir();
  const tmp = join(INFO_DIR, `.whisper-server.${randomUUID()}.tmp`);
  writeFileSync(tmp, JSON.stringify(info, null, 2), 'utf-8');
  renameSync(tmp, INFO_FILE);
}

function removeInfo(): void {
  try { unlinkSync(INFO_FILE); } catch { /* already gone */ }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function isServerResponding(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function pollUntilReady(port: number, maxMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await isServerResponding(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Ensure a whisper-server is running on the singleton port.
 * Returns port on success, null if unavailable (binary missing, model missing, etc).
 */
export async function ensureWhisperServer(
  serverBin: string,
  modelPath: string,
): Promise<number | null> {
  if (!existsSync(serverBin)) {
    debug('WhisperMgr', `whisper-server not found at ${serverBin}, skipping`);
    return null;
  }

  // 1. Check existing info file
  const info = readInfo();
  if (info) {
    if (isProcessAlive(info.pid)) {
      // PID alive — check if server is responding
      if (await isServerResponding(info.port)) {
        debug('WhisperMgr', `Reusing existing server (pid=${info.pid}, port=${info.port})`);
        return info.port;
      }
      // PID alive but not responding — model may still be loading, poll 30s
      debug('WhisperMgr', `Server pid=${info.pid} alive but not responding, waiting for model load...`);
      if (await pollUntilReady(info.port, 30_000)) {
        debug('WhisperMgr', `Server became ready (pid=${info.pid}, port=${info.port})`);
        return info.port;
      }
      // Still not responding after 30s — stale
      debug('WhisperMgr', `Server pid=${info.pid} never responded, treating as stale`);
    }
    // PID dead or stale — clean up
    removeInfo();
  }

  // 2. Spawn new server (detached so it survives parent exit)
  debug('WhisperMgr', `Starting whisper-server on port ${WHISPER_SERVER_PORT}...`);
  const args = [
    '--model', modelPath,
    '--port', String(WHISPER_SERVER_PORT),
    '--host', '127.0.0.1',
    '-l', 'auto',
    '--no-timestamps',
    '--convert',
    '--prompt', 'coding, programming, Claude, terminal, git, function, component, API',
  ];

  const proc = spawn(serverBin, args, {
    stdio: 'ignore',
    detached: true,
  });
  proc.unref();

  const pid = proc.pid;
  if (!pid) {
    debug('WhisperMgr', 'Failed to spawn whisper-server (no pid)');
    return null;
  }

  // 3. Brief wait to detect immediate crash (e.g. port conflict)
  await new Promise((r) => setTimeout(r, 200));
  if (!isProcessAlive(pid)) {
    debug('WhisperMgr', `whisper-server died immediately (pid=${pid}), checking for existing server...`);
    // Another process may have won the port race — re-check info file
    const otherInfo = readInfo();
    if (otherInfo && isProcessAlive(otherInfo.pid) && await isServerResponding(otherInfo.port)) {
      debug('WhisperMgr', `Found winner server (pid=${otherInfo.pid}, port=${otherInfo.port})`);
      return otherInfo.port;
    }
    removeInfo();
    return null;
  }

  // 4. Write info file
  writeInfo({ pid, port: WHISPER_SERVER_PORT, modelPath, startedAt: new Date().toISOString() });

  // 5. Poll until ready (up to 30s for model loading)
  if (await pollUntilReady(WHISPER_SERVER_PORT, 30_000)) {
    debug('WhisperMgr', `whisper-server ready on port ${WHISPER_SERVER_PORT} (pid=${pid})`);
    return WHISPER_SERVER_PORT;
  }

  debug('WhisperMgr', 'whisper-server failed to become ready within 30s');
  return null;
}

/**
 * Release the whisper-server if no other sessions remain.
 * Call AFTER deregisterSession() so the count is already decremented.
 */
export function releaseWhisperServer(): void {
  const activeSessions = listActive();
  if (activeSessions.length > 0) {
    debug('WhisperMgr', `Keeping whisper-server alive (${activeSessions.length} session(s) remain)`);
    return;
  }

  const info = readInfo();
  if (!info) return;

  debug('WhisperMgr', `Killing whisper-server (pid=${info.pid})`);
  try { process.kill(info.pid, 'SIGTERM'); } catch { /* already dead */ }
  // Force kill after 3s
  setTimeout(() => {
    try { process.kill(info.pid, 'SIGKILL'); } catch { /* already dead */ }
  }, 3000);
  removeInfo();
}
