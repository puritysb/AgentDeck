import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import {
  scanDaemonPortWindow, shouldConcedePortToOccupant, waitForDaemonExit, waitForPortBindable,
  resolveDaemonPortWindow, isDefaultDaemonPortWindow, DEFAULT_DAEMON_PORT_WINDOW,
} from '../session-registry.js';
import { readFileSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// We test session-registry internals by importing and overriding the file path.
// Since the module uses hardcoded paths, we test via the exported functions
// after setting up a temp environment.

// Re-implement the core logic here for unit testing (avoids modifying source
// for testability). This tests the algorithms, not the exact module wiring.

interface SessionEntry {
  id: string;
  port: number;
  pid: number;
  projectName: string;
  tmuxSession?: string;
  startedAt: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function pruneDeadSessions(sessions: SessionEntry[]): SessionEntry[] {
  return sessions.filter((s) => isProcessAlive(s.pid));
}

describe('Session Registry Logic', () => {
  describe('pruneDeadSessions', () => {
    it('keeps alive sessions', () => {
      const entry: SessionEntry = {
        id: randomUUID(),
        port: 9120,
        pid: process.pid, // current process is alive
        projectName: 'test',
        startedAt: new Date().toISOString(),
      };
      const result = pruneDeadSessions([entry]);
      expect(result).toHaveLength(1);
    });

    it('removes sessions with dead PIDs', () => {
      const entry: SessionEntry = {
        id: randomUUID(),
        port: 9120,
        pid: 999999, // almost certainly not running
        projectName: 'test',
        startedAt: new Date().toISOString(),
      };
      const result = pruneDeadSessions([entry]);
      expect(result).toHaveLength(0);
    });

    it('keeps old sessions if PID is alive', () => {
      const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h ago
      const entry: SessionEntry = {
        id: randomUUID(),
        port: 9120,
        pid: process.pid,
        projectName: 'test',
        startedAt: oldDate.toISOString(),
      };
      const result = pruneDeadSessions([entry]);
      expect(result).toHaveLength(1);
    });

    it('handles mix of alive and dead sessions', () => {
      const sessions: SessionEntry[] = [
        {
          id: randomUUID(),
          port: 9120,
          pid: process.pid,
          projectName: 'alive',
          startedAt: new Date().toISOString(),
        },
        {
          id: randomUUID(),
          port: 9121,
          pid: 999999,
          projectName: 'dead',
          startedAt: new Date().toISOString(),
        },
        {
          id: randomUUID(),
          port: 9122,
          pid: process.pid,
          projectName: 'old-but-alive',
          startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        },
      ];
      const result = pruneDeadSessions(sessions);
      expect(result).toHaveLength(2);
      expect(result.map((s) => s.projectName)).toEqual(['alive', 'old-but-alive']);
    });
  });

  describe('port allocation logic', () => {
    const BASE_PORT = 9120;
    const MAX_PORT = 9139;

    function findAvailablePort(usedPorts: Set<number>): number {
      for (let port = BASE_PORT; port <= MAX_PORT; port++) {
        if (!usedPorts.has(port)) {
          return port;
        }
      }
      throw new Error(`All AgentDeck ports (${BASE_PORT}–${MAX_PORT}) are in use. Stop an existing session first.`);
    }

    it('returns base port when no ports are used', () => {
      expect(findAvailablePort(new Set())).toBe(9120);
    });

    it('returns next port when base is taken', () => {
      expect(findAvailablePort(new Set([9120]))).toBe(9121);
    });

    it('skips used ports', () => {
      expect(findAvailablePort(new Set([9120, 9121, 9122]))).toBe(9123);
    });

    it('finds gaps in used ports', () => {
      expect(findAvailablePort(new Set([9120, 9122]))).toBe(9121);
    });

    it('throws when all ports are taken', () => {
      const all = new Set<number>();
      for (let p = BASE_PORT; p <= MAX_PORT; p++) all.add(p);
      expect(() => findAvailablePort(all)).toThrow('All AgentDeck ports');
    });
  });

  describe('atomic write', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `agentdeck-test-${randomUUID()}`);
      mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('write-then-rename produces valid JSON', async () => {
      const { writeFileSync, renameSync } = await import('fs');
      const sessions: SessionEntry[] = [
        {
          id: randomUUID(),
          port: 9120,
          pid: process.pid,
          projectName: 'test',
          startedAt: new Date().toISOString(),
        },
      ];

      const tmpFile = join(tmpDir, `.sessions.${randomUUID()}.tmp`);
      const target = join(tmpDir, 'sessions.json');

      writeFileSync(tmpFile, JSON.stringify(sessions, null, 2), 'utf-8');
      renameSync(tmpFile, target);

      const read = JSON.parse(readFileSync(target, 'utf-8'));
      expect(read).toHaveLength(1);
      expect(read[0].projectName).toBe('test');
      // Temp file should not exist after rename
      expect(existsSync(tmpFile)).toBe(false);
    });
  });

  describe('shouldConcedePortToOccupant (startup-race hardening)', () => {
    const SELF = 4242;
    const alive = () => true;
    const dead = () => false;

    it('does not concede to a non-daemon occupant (session bridge)', () => {
      expect(shouldConcedePortToOccupant({ mode: 'session', pid: 99 }, SELF, alive)).toBe(false);
    });

    it('does not concede when the probe failed (null occupant)', () => {
      expect(shouldConcedePortToOccupant(null, SELF, alive)).toBe(false);
    });

    it('concedes to a daemon backed by a live, distinct PID', () => {
      expect(shouldConcedePortToOccupant({ mode: 'daemon', pid: 1234 }, SELF, alive)).toBe(true);
    });

    it('does NOT concede to a forged/stale daemon whose PID is dead', () => {
      expect(shouldConcedePortToOccupant({ mode: 'daemon', pid: 1234 }, SELF, dead)).toBe(false);
    });

    it('does NOT concede when the reported PID is our own', () => {
      expect(shouldConcedePortToOccupant({ mode: 'daemon', pid: SELF }, SELF, alive)).toBe(false);
    });

    it('trusts the mode when no PID is reported (e.g. Swift App Store daemon)', () => {
      expect(shouldConcedePortToOccupant({ mode: 'daemon' }, SELF, dead)).toBe(true);
    });
  });

  describe('scanDaemonPortWindow / waitForDaemonExit (split-brain guard)', () => {
    // Hermetic window well above the real 9120-9139 range so a daemon running
    // on the dev machine can't leak into the assertions.
    const WINDOW: readonly [number, number] = [29320, 29324];

    function serveHealth(port: number, body: Record<string, unknown>): Promise<http.Server> {
      return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
          if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
          } else {
            res.writeHead(404);
            res.end();
          }
        });
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
      });
    }

    it('finds a Swift daemon sitting on a fallback port inside the window', async () => {
      const server = await serveHealth(WINDOW[0] + 1, { mode: 'daemon', isSwift: true });
      try {
        const found = await scanDaemonPortWindow(new Set(), WINDOW);
        expect(found).toEqual([
          { port: WINDOW[0] + 1, health: { mode: 'daemon', isSwift: true } },
        ]);
      } finally {
        server.close();
      }
    });

    it('ignores non-daemon occupants (session bridges) and skipped ports', async () => {
      const bridge = await serveHealth(WINDOW[0], { mode: 'session' });
      const daemon = await serveHealth(WINDOW[0] + 2, { mode: 'daemon', pid: 1234 });
      try {
        const found = await scanDaemonPortWindow(new Set([WINDOW[0] + 2]), WINDOW);
        expect(found).toEqual([]);
      } finally {
        bridge.close();
        daemon.close();
      }
    });

    it('returns empty when the window is quiet', async () => {
      expect(await scanDaemonPortWindow(new Set(), WINDOW)).toEqual([]);
    });

    it('waitForDaemonExit resolves true once /health stops answering', async () => {
      const server = await serveHealth(WINDOW[0] + 3, { mode: 'daemon', isSwift: true });
      setTimeout(() => server.close(), 300);
      expect(await waitForDaemonExit(WINDOW[0] + 3, 5000)).toBe(true);
    });

    it('waitForDaemonExit resolves false when the daemon never leaves', async () => {
      const server = await serveHealth(WINDOW[0] + 4, { mode: 'daemon', isSwift: true });
      try {
        expect(await waitForDaemonExit(WINDOW[0] + 4, 600)).toBe(false);
      } finally {
        server.close();
      }
    });

    /** Holds the port but answers nothing on /health — a listener mid-teardown. */
    function holdPort(port: number): Promise<http.Server> {
      return new Promise((resolve, reject) => {
        const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
        server.on('error', reject);
        server.listen(port, '0.0.0.0', () => resolve(server));
      });
    }

    it('waitForPortBindable refuses a port that is still bound', async () => {
      // The distinction the takeover path turns on: this port answers nothing
      // on /health — so waitForDaemonExit calls it gone — yet it cannot be
      // bound. A cancelled-but-not-yet-torn-down NWListener looks exactly like
      // this, which is how the CLI landed on a fallback port right after
      // reporting that the app had yielded the canonical one.
      const holder = await holdPort(WINDOW[0] + 5);
      try {
        expect(await waitForDaemonExit(WINDOW[0] + 5, 400)).toBe(true);
        expect(await waitForPortBindable(WINDOW[0] + 5, 400)).toBe(false);
      } finally {
        holder.close();
      }
    });

    it('waitForPortBindable resolves true once the socket is actually released', async () => {
      const holder = await holdPort(WINDOW[0] + 6);
      setTimeout(() => holder.close(), 300);
      expect(await waitForPortBindable(WINDOW[0] + 6, 5000)).toBe(true);
    });

    it('waitForPortBindable resolves true immediately for a free port', async () => {
      expect(await waitForPortBindable(WINDOW[0] + 7, 2000)).toBe(true);
    });
  });
});

describe('daemon port window', () => {
  // The window is a discovery contract every client scans, and the singleton
  // guard sweeps it to refuse a second daemon. Both are correct for the one
  // real daemon and are exactly what made a throwaway daemon unstartable:
  // neither AGENTDECK_DATA_DIR nor an explicit -p moved the sweep off 9120.
  // Overriding it is therefore allowed, but a MALFORMED override must fall
  // back to the default rather than widen, narrow or disable the guard.
  it('defaults when unset or blank', () => {
    expect(resolveDaemonPortWindow(undefined)).toEqual(DEFAULT_DAEMON_PORT_WINDOW);
    expect(resolveDaemonPortWindow('')).toEqual(DEFAULT_DAEMON_PORT_WINDOW);
    expect(resolveDaemonPortWindow('   ')).toEqual(DEFAULT_DAEMON_PORT_WINDOW);
  });

  it('accepts a well-formed range', () => {
    expect(resolveDaemonPortWindow('9200-9209')).toEqual([9200, 9209]);
    expect(resolveDaemonPortWindow(' 9200 - 9209 ')).toEqual([9200, 9209]);
    expect(resolveDaemonPortWindow('1024-65535')).toEqual([1024, 65535]);
  });

  it('falls back to the default for anything it cannot trust', () => {
    for (const bad of [
      'nonsense',
      '9200',            // not a range
      '9209-9200',       // inverted
      '80-90',           // below the privileged-port floor
      '9200-70000',      // above the port ceiling
      '9200-',           // truncated
      '-9209',
      '9200-9209-9210',
      '0x2400-0x2409',
    ]) {
      expect(resolveDaemonPortWindow(bad), bad).toEqual(DEFAULT_DAEMON_PORT_WINDOW);
    }
  });

  it('reports whether the resolved window is the documented one', () => {
    expect(isDefaultDaemonPortWindow(DEFAULT_DAEMON_PORT_WINDOW)).toBe(true);
    expect(isDefaultDaemonPortWindow([9200, 9209])).toBe(false);
    // A malformed override reads as default — the CLI relies on this to know
    // it should say "not parseable" rather than announce a custom window.
    expect(isDefaultDaemonPortWindow(resolveDaemonPortWindow('nonsense'))).toBe(true);
  });
});
