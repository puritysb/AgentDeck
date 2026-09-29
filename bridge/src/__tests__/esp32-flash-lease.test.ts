/**
 * The serial-suspend lease.
 *
 * Two rules carry the whole design and each has a failure mode that is silent:
 * expiry is enforced when the lease is READ (a timer on a sleeping laptop fires
 * late and extends the suspension past what was promised — the daemon simply
 * stays deaf), and the lease lives on disk so it survives a daemon RESPAWN,
 * which is what actually stole the port in the recorded failure.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  LEASE_MAX_SECONDS,
  LEASE_MIN_SECONDS,
  clampLeaseSeconds,
  clearLease,
  leaseFile,
  readLease,
  serialSuspended,
  writeLease,
} from '../esp32-flash-lease.js';

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  prev = process.env.AGENTDECK_DATA_DIR;
  dir = mkdtempSync(join(tmpdir(), 'agentdeck-lease-'));
  process.env.AGENTDECK_DATA_DIR = dir;
});

afterEach(() => {
  if (prev === undefined) delete process.env.AGENTDECK_DATA_DIR;
  else process.env.AGENTDECK_DATA_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe('clampLeaseSeconds', () => {
  it('clamps to the documented window', () => {
    expect(clampLeaseSeconds(0)).toBe(LEASE_MIN_SECONDS);
    expect(clampLeaseSeconds(-5)).toBe(LEASE_MIN_SECONDS);
    expect(clampLeaseSeconds(120)).toBe(120);
    expect(clampLeaseSeconds(99999)).toBe(LEASE_MAX_SECONDS);
  });

  it('never lets junk become an unbounded suspension', () => {
    // A caller that suspends the device layer forever is the failure this
    // clamp exists for, so garbage must land at the FLOOR, not the ceiling.
    expect(clampLeaseSeconds('nonsense')).toBe(LEASE_MIN_SECONDS);
    expect(clampLeaseSeconds(undefined)).toBe(LEASE_MIN_SECONDS);
    expect(clampLeaseSeconds(Number.POSITIVE_INFINITY)).toBe(LEASE_MIN_SECONDS);
    expect(clampLeaseSeconds(Number.NaN)).toBe(LEASE_MIN_SECONDS);
  });
});

describe('readLease', () => {
  it('reports an active lease', () => {
    writeLease({ until: Date.now() + 60_000, reason: 'test', board: '86box' });
    expect(readLease()?.board).toBe('86box');
    expect(serialSuspended()).toBe(true);
  });

  it('an expired lease reads as NO lease — expiry is enforced here, not by a timer', () => {
    const until = Date.now() - 1;
    writeLease({ until, reason: 'test' });
    // The file still exists; nothing ran to remove it. That is the point: a CLI
    // killed mid-flash leaves this file behind and the daemon still recovers.
    expect(existsSync(leaseFile())).toBe(true);
    expect(readLease()).toBeNull();
    expect(serialSuspended()).toBe(false);
  });

  it('is evaluated against the caller\'s clock, not the write time', () => {
    const until = Date.now() + 60_000;
    writeLease({ until, reason: 'test' });
    expect(readLease(until - 1)).not.toBeNull();
    expect(readLease(until)).toBeNull();
    expect(readLease(until + 10 * 60_000)).toBeNull();
  });

  it('fails OPEN on a corrupt lease', () => {
    // Failing closed would leave every device permanently unreachable behind a
    // bad file; failing open costs at most a reset board during a flash that is
    // probably not even running.
    writeFileSync(leaseFile(), '{not json');
    expect(readLease()).toBeNull();
  });

  it('fails open on a lease with no usable expiry', () => {
    writeFileSync(leaseFile(), JSON.stringify({ reason: 'no until field' }));
    expect(readLease()).toBeNull();
    writeFileSync(leaseFile(), JSON.stringify({ until: 'soon', reason: 'x' }));
    expect(readLease()).toBeNull();
  });

  it('is absent when no lease was ever written', () => {
    expect(readLease()).toBeNull();
  });
});

describe('lease persistence', () => {
  it('is a FILE, so it outlives the process that wrote it', () => {
    // This is the whole reason it is not a variable: the daemon that stole the
    // port was the respawned one, and an in-process pause cannot span a respawn.
    writeLease({ until: Date.now() + 60_000, reason: 'usb flash', pid: 4242, board: 'trmnl_75' });
    const onDisk = JSON.parse(readFileSync(leaseFile(), 'utf8'));
    expect(onDisk).toMatchObject({ reason: 'usb flash', pid: 4242, board: 'trmnl_75' });
  });

  it('clearLease is idempotent', () => {
    clearLease();
    writeLease({ until: Date.now() + 60_000, reason: 'test' });
    clearLease();
    clearLease();
    expect(existsSync(leaseFile())).toBe(false);
    expect(readLease()).toBeNull();
  });

  it('honours AGENTDECK_DATA_DIR', () => {
    expect(leaseFile().startsWith(dir)).toBe(true);
  });
});
