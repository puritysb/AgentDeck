// The Node half of the operator-approval credential path — parity with
// apple/AgentDeck/Daemon/Server/PairingKnockStore.swift.
//
// What is pinned here is the CONTRACT rather than the membership, because both
// daemons take turns owning port 9120 and read each other's approvals file: a
// rule that holds in one and not the other is a device that pairs on Monday and
// is locked out on Tuesday with nothing in either log saying why.
//
// The four properties that cost something if they drift:
//   - identity is the device id when the client sends one, the address only
//     when it does not, and BOTH are consulted on the way in;
//   - expiry is applied when the list is READ, never by a timer;
//   - the list is bounded, oldest-first;
//   - a decode failure is not "nobody is approved" — that silently un-pairs the
//     whole fleet, which is the one outcome persistence exists to prevent.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../logger.js', () => ({ log: () => {}, debug: () => {} }));

import {
  KNOCK_TTL_MS,
  MAX_KNOCKS,
  approvePeer,
  deviceIdFromHeaders,
  dismissKnock,
  isApprovedPeer,
  pairingApprovals,
  pairingKnocks,
  peerKey,
  recordKnock,
  resetPairingKnocksForTests,
  revokePeer,
} from '../pairing-knocks.js';

const IP = '192.0.2.55';
const OTHER_IP = '192.0.2.56';
// 32 lowercase hex — the shape normalizeDeviceId accepts.
const DEV_A = 'a'.repeat(32);
const DEV_B = 'b'.repeat(32);

let dir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  prevDataDir = process.env.AGENTDECK_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'agentdeck-knocks-'));
  process.env.AGENTDECK_DATA_DIR = dir;
  resetPairingKnocksForTests();
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.AGENTDECK_DATA_DIR;
  else process.env.AGENTDECK_DATA_DIR = prevDataDir;
  resetPairingKnocksForTests();
  rmSync(dir, { recursive: true, force: true });
});

const approvalsPath = () => join(dir, 'pairing-approved.json');

describe('peerKey', () => {
  it('prefers the device id and never emits a bare string', () => {
    expect(peerKey(IP, DEV_A)).toBe(`device:${DEV_A}`);
    expect(peerKey(IP, null)).toBe(`ip:${IP}`);
  });

  it('normalizes so one device cannot appear as several', () => {
    expect(peerKey(IP, DEV_A.toUpperCase())).toBe(`device:${DEV_A}`);
    expect(peerKey(IP, `  ${DEV_A}  `)).toBe(`device:${DEV_A}`);
  });

  it('falls back to the address for an id that is not the accepted shape', () => {
    // Too short, non-hex, wrong type — a loose id would let a client vary its
    // own identity between connects.
    expect(peerKey(IP, 'abc')).toBe(`ip:${IP}`);
    expect(peerKey(IP, 'z'.repeat(32))).toBe(`ip:${IP}`);
    expect(peerKey(IP, 12345)).toBe(`ip:${IP}`);
  });
});

describe('recording knocks', () => {
  it('counts repeat attempts on one row rather than growing the list', () => {
    recordKnock(IP, null, false);
    recordKnock(IP, null, false);
    recordKnock(IP, null, false);
    const knocks = pairingKnocks();
    expect(knocks).toHaveLength(1);
    expect(knocks[0].attempts).toBe(3);
  });

  it('carries the stale-token distinction, which reads differently to an operator', () => {
    recordKnock(IP, null, true);
    expect(pairingKnocks()[0].staleToken).toBe(true);
  });

  it('ignores an empty address', () => {
    recordKnock('', null, false);
    expect(pairingKnocks()).toHaveLength(0);
  });

  it('does not record a peer that is already approved', () => {
    approvePeer(peerKey(IP, null));
    recordKnock(IP, null, false);
    expect(pairingKnocks()).toHaveLength(0);
  });

  it('tells two devices behind one address apart', () => {
    recordKnock(IP, DEV_A, false);
    recordKnock(IP, DEV_B, false);
    expect(pairingKnocks()).toHaveLength(2);
  });

  it('returns newest first', () => {
    recordKnock(IP, null, false, 1_000);
    recordKnock(OTHER_IP, null, false, 2_000);
    expect(pairingKnocks(2_000).map((k) => k.ip)).toEqual([OTHER_IP, IP]);
  });
});

describe('expiry is applied on read, not by a timer', () => {
  it('drops a knock older than the TTL when the list is read', () => {
    recordKnock(IP, null, false, 1_000);
    expect(pairingKnocks(1_000 + KNOCK_TTL_MS - 1)).toHaveLength(1);
    expect(pairingKnocks(1_000 + KNOCK_TTL_MS)).toHaveLength(0);
  });

  it('keeps a peer alive while it is still knocking', () => {
    recordKnock(IP, null, false, 1_000);
    recordKnock(IP, null, false, 1_000 + KNOCK_TTL_MS - 1);
    expect(pairingKnocks(1_000 + KNOCK_TTL_MS + 1)).toHaveLength(1);
  });
});

describe('bounded', () => {
  it('caps the list and drops the oldest, so a flood cannot grow it without limit', () => {
    for (let i = 0; i < MAX_KNOCKS + 4; i++) {
      recordKnock(`192.0.2.${i + 1}`, null, false, 1_000 + i);
    }
    const knocks = pairingKnocks(1_000 + MAX_KNOCKS + 4);
    expect(knocks).toHaveLength(MAX_KNOCKS);
    // The oldest four are the ones gone.
    expect(knocks.map((k) => k.ip)).not.toContain('192.0.2.1');
    expect(knocks.map((k) => k.ip)).toContain(`192.0.2.${MAX_KNOCKS + 4}`);
  });
});

describe('approving', () => {
  it('admits the peer and retires its knock', () => {
    recordKnock(IP, null, false);
    approvePeer(peerKey(IP, null));
    expect(isApprovedPeer(IP, null)).toBe(true);
    expect(pairingKnocks()).toHaveLength(0);
  });

  it('a device-keyed approval survives an address change', () => {
    recordKnock(IP, DEV_A, false);
    approvePeer(peerKey(IP, DEV_A));
    expect(isApprovedPeer(OTHER_IP, DEV_A)).toBe(true);
  });

  it('an address-keyed approval does not admit a different address', () => {
    approvePeer(peerKey(IP, null));
    expect(isApprovedPeer(OTHER_IP, null)).toBe(false);
  });

  it('does not admit a different device that shares the approved address', () => {
    approvePeer(peerKey(IP, DEV_A));
    expect(isApprovedPeer(IP, DEV_B)).toBe(false);
  });

  it('still admits a device approved by ADDRESS before it learned to send an id', () => {
    // Both are checked rather than one: the upgrade that teaches a device to
    // send an id must not lock it out of the grant it already had.
    approvePeer(peerKey(IP, null));
    expect(isApprovedPeer(IP, DEV_A)).toBe(true);
  });

  it('revokes', () => {
    approvePeer(peerKey(IP, DEV_A));
    expect(revokePeer(peerKey(IP, DEV_A))).toBe(true);
    expect(isApprovedPeer(IP, DEV_A)).toBe(false);
    expect(revokePeer(peerKey(IP, DEV_A))).toBe(false);
  });

  it('refuses an empty key rather than minting a blank grant', () => {
    expect(approvePeer('')).toBe(false);
    expect(pairingApprovals()).toHaveLength(0);
  });
});

describe('dismiss is not a block', () => {
  it('drops the row but lets the peer knock again', () => {
    recordKnock(IP, null, false);
    expect(dismissKnock(peerKey(IP, null))).toBe(true);
    expect(pairingKnocks()).toHaveLength(0);
    recordKnock(IP, null, false);
    expect(pairingKnocks()).toHaveLength(1);
  });
});

describe('persistence', () => {
  it('round-trips approvals across a daemon restart', () => {
    approvePeer(peerKey(IP, DEV_A));
    resetPairingKnocksForTests(); // as if the process restarted
    expect(isApprovedPeer(IP, DEV_A)).toBe(true);
  });

  it('migrates the pre-device-id shape instead of discarding it', () => {
    // A decode that merely fails reads as "nobody is approved", which silently
    // un-pairs every device the operator already let in.
    writeFileSync(approvalsPath(), JSON.stringify([
      { ip: IP, approvedAt: '2026-08-01T00:00:00.000Z' },
    ]));
    resetPairingKnocksForTests();
    expect(isApprovedPeer(IP, null)).toBe(true);
    const rows = pairingApprovals();
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe(`ip:${IP}`);
    expect(rows[0].deviceId).toBeNull();
  });

  it('reads a Foundation reference-date stamp written by the Swift daemon', () => {
    // Swift's JSONEncoder default is seconds since 2001-01-01. Misreading it as
    // epoch ms would date every approval to 1970.
    writeFileSync(approvalsPath(), JSON.stringify([
      { key: `ip:${IP}`, lastIP: IP, approvedAt: 776_000_000 },
    ]));
    resetPairingKnocksForTests();
    const [row] = pairingApprovals();
    expect(new Date(row.approvedAt).getUTCFullYear()).toBe(2025);
  });

  it('reads an epoch-ms stamp written by this daemon', () => {
    const ms = Date.UTC(2026, 7, 1);
    writeFileSync(approvalsPath(), JSON.stringify([
      { key: `ip:${IP}`, lastIP: IP, approvedAt: ms },
    ]));
    resetPairingKnocksForTests();
    expect(pairingApprovals()[0].approvedAt).toBe(ms);
  });

  it('does not overwrite an unparseable file — it is evidence, not garbage', () => {
    writeFileSync(approvalsPath(), '{ this is not json');
    resetPairingKnocksForTests();
    expect(isApprovedPeer(IP, null)).toBe(false);
    expect(readFileSync(approvalsPath(), 'utf8')).toBe('{ this is not json');
  });

  it('writes through a temp file and leaves none behind', () => {
    approvePeer(peerKey(IP, DEV_A));
    expect(existsSync(approvalsPath())).toBe(true);
    expect(existsSync(`${approvalsPath()}.tmp`)).toBe(false);
  });
});

describe('deviceIdFromHeaders', () => {
  it('reads and normalizes the handshake header', () => {
    expect(deviceIdFromHeaders({ 'x-agentdeck-device': DEV_A }, 'x-agentdeck-device')).toBe(DEV_A);
    expect(deviceIdFromHeaders({ 'x-agentdeck-device': [DEV_A] }, 'x-agentdeck-device')).toBe(DEV_A);
  });

  it('is null when the client sends nothing, so the address stays the key', () => {
    expect(deviceIdFromHeaders({}, 'x-agentdeck-device')).toBeNull();
    expect(deviceIdFromHeaders(undefined, 'x-agentdeck-device')).toBeNull();
  });
});


describe('approval retirement generation', () => {
  it('fences old grants, persists a new grant generation and refuses a later retirement', () => {
    approvePeer(`device:${DEV_A}`);
    expect(isApprovedPeer(IP,DEV_A)).toBe(true);
    expect(isApprovedPeer(IP,DEV_A,'1:'+'a'.repeat(32))).toBe(false);
    expect(pairingApprovals('1:'+'a'.repeat(32))).toEqual([]);
    approvePeer(`device:${DEV_A}`,Date.now(),'1:'+'a'.repeat(32));
    resetPairingKnocksForTests();
    expect(isApprovedPeer(IP,DEV_A,'1:'+'a'.repeat(32))).toBe(true);
    expect(isApprovedPeer(IP,DEV_A,'2:'+'b'.repeat(32))).toBe(false);
    // A delayed request admitted before retirement can only issue an old grant.
    approvePeer(`device:${DEV_B}`,Date.now(),undefined);
    expect(isApprovedPeer(IP,DEV_B,'1:'+'a'.repeat(32))).toBe(false);
  });
});
