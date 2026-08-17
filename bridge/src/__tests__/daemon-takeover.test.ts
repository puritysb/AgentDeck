/**
 * A daemon on this machine is not necessarily a daemon of THIS USER's.
 *
 * `isLocalConnection` is a pure IP test, so every same-machine privilege the
 * daemon lifecycle takes — adopting the incumbent's pairing token, asking it to
 * stand down, shutting it down, joining it as a session — used to extend to any
 * account on a shared host (docs/ENTERPRISE-ROADMAP.md §1.2–§1.4).
 *
 * These tests drive the real decision paths, not the ownership predicate. A
 * truth table over `localPeerOwnership` stays green while a call site forgets
 * to call it, which is the failure that actually ships. The predicate itself
 * cannot be exercised for real here: proving "another user owns this pid"
 * requires a process owned by another user, and creating one requires root. So
 * ownership is injected and the assertions are about what the call site DID —
 * whether it POSTed a stand-down, whether it took a token, which port it
 * returned.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { negotiateIncumbentDaemon, isForeignDaemon } from '../daemon-takeover.js';
import { findDaemonPortAsync } from '../session-registry.js';
import { localPeerOwnership } from '../auth.js';

/** Every side effect the takeover can have, recorded. */
function spies(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      adoptToken: vi.fn(() => { calls.push('adopt'); return true; }),
      standDown: vi.fn(async () => { calls.push('stand-down'); return true; }),
      shutdown: vi.fn(async () => { calls.push('shutdown'); }),
      waitForExit: vi.fn(async () => true),
      waitForBindable: vi.fn(async () => true),
      log: vi.fn(),
      ...overrides,
    },
  };
}

const FOREIGN = () => 'other-user' as const;
const MINE = () => 'same-user' as const;
const UNPROVEN = () => 'unknown' as const;

describe('negotiateIncumbentDaemon', () => {
  it('takes neither the token nor the port from another user\'s daemon', async () => {
    const { calls, deps } = spies();
    const outcome = await negotiateIncumbentDaemon(
      { port: 9120, incumbent: { mode: 'daemon', pid: 4242, isSwift: true, pairingToken: 'a'.repeat(32) }, portWasExplicit: false },
      { ...deps, ownership: FOREIGN },
    );
    // Starts anyway — on a port of our own. Refusing to run at all would
    // punish this user for a colleague's daemon.
    expect(outcome).toBe('proceed');
    expect(calls).toEqual([]);
  });

  it('refuses loudly when that port was asked for by name', async () => {
    const { calls, deps } = spies();
    const outcome = await negotiateIncumbentDaemon(
      { port: 9120, incumbent: { mode: 'daemon', pid: 4242, isSwift: false, pairingToken: 'a'.repeat(32) }, portWasExplicit: true },
      { ...deps, ownership: FOREIGN },
    );
    expect(outcome).toBe('refuse');
    expect(calls).toEqual([]);
  });

  it('still hands the port over between two daemons of the same user', async () => {
    // The two-tier upgrade path (app daemon → CLI daemon) is the whole reason
    // this negotiation exists; the ownership gate must not cost it.
    const { calls, deps } = spies();
    const outcome = await negotiateIncumbentDaemon(
      { port: 9120, incumbent: { mode: 'daemon', pid: 4242, isSwift: true, pairingToken: 'a'.repeat(32) }, portWasExplicit: false },
      { ...deps, ownership: MINE },
    );
    expect(outcome).toBe('proceed');
    expect(calls).toEqual(['adopt', 'stand-down']);
  });

  it('proceeds when ownership cannot be proven, because absence is not evidence', async () => {
    // An incumbent that reports no pid is an old build, not an attacker's
    // choice — and refusing here would break the one-machine-one-token
    // convergence that keeps a paired fleet authenticating.
    const { calls, deps } = spies();
    const outcome = await negotiateIncumbentDaemon(
      { port: 9120, incumbent: { mode: 'daemon', isSwift: true, pairingToken: 'a'.repeat(32) }, portWasExplicit: false },
      { ...deps, ownership: UNPROVEN },
    );
    expect(outcome).toBe('proceed');
    expect(calls).toEqual(['adopt', 'stand-down']);
    // …but never silently: this is the branch where a credential crosses a
    // process boundary without proof of who is on the other side.
    expect(deps.log.mock.calls.flat().join(' ')).toMatch(/[Cc]ould not confirm which user/);
  });

  it('falls back to /shutdown when the app is too old for /stand-down', async () => {
    const { calls, deps } = spies({ standDown: vi.fn(async () => false) });
    const outcome = await negotiateIncumbentDaemon(
      { port: 9120, incumbent: { mode: 'daemon', pid: 1, isSwift: true }, portWasExplicit: false },
      { ...deps, ownership: MINE },
    );
    expect(outcome).toBe('proceed');
    expect(calls).toContain('shutdown');
  });

  it('a live Node daemon of ours means "already running", not a takeover', async () => {
    const { calls, deps } = spies();
    const outcome = await negotiateIncumbentDaemon(
      { port: 9120, incumbent: { mode: 'daemon', pid: 1, isSwift: false }, portWasExplicit: false },
      { ...deps, ownership: MINE },
    );
    expect(outcome).toBe('already-running');
    expect(calls).not.toContain('stand-down');
  });

  it('an empty port is not a negotiation', async () => {
    const { calls, deps } = spies();
    expect(await negotiateIncumbentDaemon(
      { port: 9120, incumbent: null, portWasExplicit: false }, { ...deps, ownership: FOREIGN },
    )).toBe('proceed');
    // A session bridge on the port is not a daemon either.
    expect(await negotiateIncumbentDaemon(
      { port: 9120, incumbent: { mode: 'session', pid: 1 }, portWasExplicit: false }, { ...deps, ownership: MINE },
    )).toBe('proceed');
    expect(calls).toEqual([]);
  });
});

describe('findDaemonPortAsync port scan', () => {
  // An empty data dir, so the developer's own running daemon cannot answer the
  // registry half of this lookup and hide the scan these tests are about.
  let dir: string;
  let previousDataDir: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-scan-'));
    previousDataDir = process.env.AGENTDECK_DATA_DIR;
    process.env.AGENTDECK_DATA_DIR = dir;
  });
  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.AGENTDECK_DATA_DIR;
    else process.env.AGENTDECK_DATA_DIR = previousDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  it('will not join another user\'s daemon, and says so instead of failing silently', async () => {
    // The scan is the one path that attaches a session to a daemon nobody
    // named. On a shared host the first answer in the window can be a
    // coworker's, and registering there hands them a session their Stream Deck
    // can focus and type into.
    const probed: number[] = [];
    const found = await findDaemonPortAsync({
      probe: async (port) => {
        probed.push(port);
        return port === 9121 ? { mode: 'daemon', pid: 4242 } : null;
      },
      ownership: FOREIGN,
    });
    expect(found).toBeNull();
    // The whole window was still swept — one foreign daemon must not end the
    // search, since ours may be sitting further along.
    expect(probed.length).toBeGreaterThan(10);
  });

  it('joins a daemon of ours found by the same scan', async () => {
    const found = await findDaemonPortAsync({
      probe: async (port) => (port === 9121 ? { mode: 'daemon', pid: 4242, sameSocketControl: true } : null),
      ownership: MINE,
    });
    expect(found).toEqual({ port: 9121, sameSocketControl: true });
  });

  it('joins a daemon whose ownership is unproven', async () => {
    const found = await findDaemonPortAsync({
      probe: async (port) => (port === 9122 ? { mode: 'daemon' } : null),
      ownership: UNPROVEN,
    });
    expect(found?.port).toBe(9122);
  });
});

describe('localPeerOwnership', () => {
  // The predicate's own contract, at the two points that CAN be observed
  // without root. "other-user" is unreachable in a test for the reason stated
  // in the file header, which is exactly why the call sites above inject.
  it('reads this process as ours and a dead pid as unknown', () => {
    expect(localPeerOwnership(process.pid)).toBe('same-user');
    // 2^22 + 1 — above the default pid_max, so never allocated.
    expect(localPeerOwnership(4_194_305)).toBe('unknown');
    expect(localPeerOwnership(undefined)).toBe('unknown');
    expect(localPeerOwnership(0)).toBe('unknown');
    expect(localPeerOwnership(-1)).toBe('unknown');
  });

  it('isForeignDaemon reports only a definite refusal', () => {
    expect(isForeignDaemon({ pid: 1 }, FOREIGN)).toBe(true);
    expect(isForeignDaemon({ pid: 1 }, MINE)).toBe(false);
    expect(isForeignDaemon({ pid: 1 }, UNPROVEN)).toBe(false);
    expect(isForeignDaemon(null, UNPROVEN)).toBe(false);
  });
});

describe('discovered-daemon selection', () => {
  const D = (host: string, userTag?: string) =>
    ({ host, port: 9120, ...(userTag ? { userTag } : {}) });

  it('prefers this user\'s daemon over whichever answered first', async () => {
    // The office case: the head of the list used to be an arbitrary
    // colleague's daemon, and a board that dials it is closed 4001 forever
    // with nothing on screen its user can act on.
    const { sortDiscoveredDaemons } = await import('../mdns-discover.js');
    const ordered = sortDiscoveredDaemons(
      [D('10.0.0.9', 'beef'), D('10.0.0.4', 'a1b2')],
      { selfTag: 'a1b2' },
    );
    expect(ordered.map((d) => d.host)).toEqual(['10.0.0.4', '10.0.0.9']);
  });

  it('demotes but never drops another user\'s daemon', async () => {
    // Attaching across users is a legitimate ask — it is what --daemon-host
    // is for — so this is an ordering, not an access rule.
    const { sortDiscoveredDaemons } = await import('../mdns-discover.js');
    const ordered = sortDiscoveredDaemons([D('10.0.0.9', 'beef')], { selfTag: 'a1b2' });
    expect(ordered.map((d) => d.host)).toEqual(['10.0.0.9']);
  });

  it('an explicitly named host outranks even our own daemon', async () => {
    const { sortDiscoveredDaemons } = await import('../mdns-discover.js');
    const ordered = sortDiscoveredDaemons(
      [D('10.0.0.4', 'a1b2'), D('10.0.0.9', 'beef')],
      { selfTag: 'a1b2', hostHint: '10.0.0.9' },
    );
    expect(ordered.map((d) => d.host)).toEqual(['10.0.0.9', '10.0.0.4']);
  });

  it('ranks a daemon that predates the TXT keys last, without excluding it', async () => {
    // An older daemon advertises no `user` key at all. Unknown is not the same
    // as foreign, but it is less certain than either — and it must still be
    // selectable when it is the only daemon there is.
    const { sortDiscoveredDaemons } = await import('../mdns-discover.js');
    const ordered = sortDiscoveredDaemons(
      [D('10.0.0.7'), D('10.0.0.9', 'beef')],
      { selfTag: 'a1b2' },
    );
    expect(ordered.map((d) => d.host)).toEqual(['10.0.0.9', '10.0.0.7']);
    expect(sortDiscoveredDaemons([D('10.0.0.7')], { selfTag: 'a1b2' })).toHaveLength(1);
  });
});
