/**
 * Who tried to connect, and who the operator let in — the Node daemon's half
 * of the operator-approval credential path (`PairingKnockStore.swift`).
 *
 * The daemon already knew everything this needs: it refuses an unauthenticated
 * LAN peer at the WebSocket handshake and logs the address. What it did not do
 * was tell anyone. So a device with no credential retried forever into a log
 * nobody reads, while every way to give it a credential asked the DEVICE to do
 * something — scan a QR, type six digits, type a 32-character token. An e-ink
 * reader can do none of them comfortably, and one with no camera cannot do the
 * first at all.
 *
 * Turning the refusal into a prompt inverts that: the device does nothing, and
 * the operator — who is holding the machine — approves a peer they can see.
 * That is also the stronger of the two trust models. A pairing code trusts
 * whoever knows a secret, so anyone in range may guess at it while the window
 * is open; an approval trusts a specific peer the operator pointed at, and an
 * attacker cannot approve themselves.
 *
 * This file is the Node parity port. It is deliberately a near-transliteration
 * of the Swift store rather than a re-derivation: both daemons take turns
 * owning port 9120 and they read each other's state, so a rule that is restated
 * in this file's own words is a rule that can drift. The properties below are
 * the ones that must hold in both.
 *
 * **Identity is the device id when the client sends one, and the address only
 * when it does not.** The refusal happens at the HTTP upgrade, before any frame
 * — `client_register`, where a device says its name, arrives only after a
 * socket exists — so the daemon must learn who this is from the handshake
 * itself. A client that sends `x-agentdeck-device` is approved as that device:
 * two devices behind one NAT are told apart, a DHCP lease change does not
 * retire the grant, and one device can be revoked without touching the token
 * the whole fleet shares.
 *
 * The address remains the key for clients that send no id, and that path must
 * keep working: every device already in the field predates the header, and
 * refusing them would turn an upgrade into a fleet-wide outage. An IP-keyed
 * approval carries the old caveats — it retires when the lease changes, and
 * behind NAT it is not an identity at all — so a row says which kind it is
 * instead of letting the two read alike.
 *
 * Neither kind is proof. The link is plaintext `ws://`, so a device id in the
 * handshake is replayable by a passive observer on the same segment — exactly
 * as true of the `?token=` every paired device already carries. This is no
 * weaker than what ships today; it buys granularity and revocation, not
 * secrecy.
 *
 * **A claimed name is never identity.** Nothing here reads one. If a name is
 * ever surfaced it must sit beside the address, never instead of it.
 *
 * **Bounded, and expired on read.** A hostile peer must not be able to grow
 * this list without limit, so it is capped and the oldest knock is dropped —
 * which does mean a flood can push a real device out of view, and the cap is
 * chosen high enough that a human notices the flood first. Expiry is evaluated
 * when the list is read, never by a timer: a timer that fires late on a
 * sleeping laptop would keep a stale knock alive past its promise, exactly as
 * in `pairing-window.ts`.
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { normalizeDeviceId } from '@agentdeck/shared';
import { debug } from './logger.js';

/**
 * A knock is worth showing for this long after its last attempt. Long enough
 * that the operator can walk to the machine; short enough that a device carried
 * out of the building stops being offered.
 */
export const KNOCK_TTL_MS = 15 * 60_000;

/** Cap on simultaneously-tracked peers. */
export const MAX_KNOCKS = 12;

export interface PairingKnock {
  /**
   * What an approval will be recorded against. `device:<id>` when the client
   * identified itself, `ip:<addr>` otherwise — never the bare string, so the
   * two can never collide or be confused downstream.
   */
  key: string;
  ip: string;
  deviceId: string | null;
  attempts: number;
  firstSeen: number;
  lastSeen: number;
  /**
   * True when the peer presented a token we do not accept, rather than no token
   * at all. Reads very differently to an operator: usually a provisioned device
   * whose credential went stale, not a new device.
   */
  staleToken: boolean;
  /** Display only — `key` already encodes which kind this is. */
  deviceScoped: boolean;
}

export interface PairingApproval {
  key: string;
  /**
   * Where it last connected from. Display only — an approval keyed on a device
   * id must not start depending on the address, or it would silently reacquire
   * the NAT and DHCP problems it exists to escape.
   */
  lastIP: string;
  approvedAt: number;
  deviceId: string | null;
  credentialGeneration?: string;
}

/**
 * The one place a key is spelled, so the gate, the store and the UI cannot
 * disagree about what "this peer" means.
 */
export function peerKey(ip: string, deviceId: unknown): string {
  const normalized = normalizeDeviceId(deviceId);
  if (normalized) return `device:${normalized}`;
  return `ip:${ip}`;
}

function deviceIdOfKey(key: string): string | null {
  return key.startsWith('device:') ? key.slice('device:'.length) : null;
}

/**
 * Every other module resolves its state through
 * `AGENTDECK_DATA_DIR || ~/.agentdeck`; mirror that here rather than hardcoding
 * the home path, or a daemon started with a custom data dir would keep its
 * approvals somewhere else than the rest of its state.
 */
function dataDir(): string {
  return process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
}

function approvalsFile(): string {
  return join(dataDir(), 'pairing-approved.json');
}

/** Cached per resolved directory, so pointing AGENTDECK_DATA_DIR elsewhere re-reads. */
let cache: { dir: string; approved: Map<string, PairingApproval> } | null = null;
const pending = new Map<string, PairingKnock>();

/** One shape written before approvals were keyed on a device: an address and a time. */
interface LegacyApproval {
  ip: string;
  approvedAt: string | number;
}

/**
 * Read a timestamp written by either daemon.
 *
 * The two encode `approvedAt` differently — this file writes epoch ms, while
 * Swift's `JSONEncoder` default writes a Foundation reference-date Double
 * (seconds since 2001-01-01). The files do not collide today, because the
 * sandboxed app keeps its copy inside its container and this one lives in
 * `~/.agentdeck`. But the two daemons take turns owning port 9120, and the day
 * those paths converge a silent misread would date every approval to 1970 or to
 * the far future — so accept both now, by magnitude, rather than discovering it
 * as a bug later. A reference-date value for any plausible date is < 1e11;
 * epoch ms is > 1e12.
 */
const FOUNDATION_REFERENCE_EPOCH_MS = 978_307_200_000; // 2001-01-01T00:00:00Z

function toEpoch(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (Math.abs(value) < 1e11) return Math.round(value * 1000) + FOUNDATION_REFERENCE_EPOCH_MS;
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

function loadApprovals(): Map<string, PairingApproval> {
  const dir = dataDir();
  if (cache && cache.dir === dir) return cache.approved;

  const table = new Map<string, PairingApproval>();
  let raw: string | null = null;
  try {
    raw = readFileSync(approvalsFile(), 'utf8');
  } catch {
    // No file yet is the common case: nobody has been approved.
    cache = { dir, approved: table };
    return table;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Unparseable is NOT "nobody is approved" — see the migration note below.
    // We cannot recover rows from it, but we must not overwrite the file
    // either, so leave it on disk untouched for the operator to inspect.
    debug('Pair', 'approvals file is unparseable; treating as empty without overwriting it');
    cache = { dir, approved: table };
    return table;
  }

  if (Array.isArray(parsed)) {
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue;
      const r = row as Record<string, unknown>;
      if (typeof r.key === 'string' && r.key.length > 0) {
        table.set(r.key, {
          key: r.key,
          lastIP: typeof r.lastIP === 'string' ? r.lastIP : '',
          approvedAt: toEpoch(r.approvedAt),
          deviceId: deviceIdOfKey(r.key),
          credentialGeneration: r.credentialGeneration === undefined ? undefined : typeof r.credentialGeneration === 'string' ? r.credentialGeneration : 'invalid',
        });
        continue;
      }
      // Migrate rather than discard. A decode that merely fails reads as
      // "nobody is approved", which silently un-pairs every device the operator
      // already let in — the same failure the tmp+rename below exists to
      // prevent, arriving through the schema instead of the disk.
      const legacy = row as unknown as LegacyApproval;
      if (typeof legacy.ip === 'string' && legacy.ip.length > 0) {
        const key = `ip:${legacy.ip}`;
        table.set(key, {
          key,
          lastIP: legacy.ip,
          approvedAt: toEpoch(legacy.approvedAt),
          deviceId: null,
        });
      }
    }
  }

  cache = { dir, approved: table };
  return table;
}

function persist(approved: Map<string, PairingApproval>): void {
  const rows = [...approved.values()].sort((a, b) => a.approvedAt - b.approvedAt);
  const path = approvalsFile();
  const tmp = `${path}.tmp`;
  try {
    mkdirSync(dataDir(), { recursive: true });
    // tmp+rename, as everywhere else that writes the data dir: a truncated
    // approvals file reads as "nobody is approved" and silently locks the whole
    // fleet out.
    writeFileSync(tmp, JSON.stringify(rows, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    debug('Pair', `failed to persist approvals: ${String(err)}`);
  }
}

function evictIfNeeded(): void {
  if (pending.size <= MAX_KNOCKS) return;
  const ordered = [...pending.values()].sort((a, b) => a.lastSeen - b.lastSeen);
  for (const knock of ordered.slice(0, pending.size - MAX_KNOCKS)) {
    pending.delete(knock.key);
  }
}

/**
 * Called from the refusal path. Cheap on purpose — it runs for every rejected
 * handshake, and a looping device produces one every few seconds.
 */
export function recordKnock(
  ip: string,
  deviceId: unknown,
  staleToken: boolean,
  now = Date.now(),
  credentialGeneration?: string,
): void {
  if (!ip) return;
  const normalized = normalizeDeviceId(deviceId);
  const key = peerKey(ip, normalized);
  // A retired grant still exists on disk but no longer admits this peer. It
  // must not hide the fresh request the operator needs in order to re-approve.
  const approval = loadApprovals().get(key);
  if (approval && approval.credentialGeneration === credentialGeneration) return;

  const existing = pending.get(key);
  if (existing) {
    existing.attempts += 1;
    existing.lastSeen = now;
    existing.staleToken = staleToken;
    return;
  }
  pending.set(key, {
    key,
    ip,
    deviceId: normalized,
    attempts: 1,
    firstSeen: now,
    lastSeen: now,
    staleToken,
    deviceScoped: normalized !== null,
  });
  evictIfNeeded();
}

/** Live knocks, newest first. Expiry is applied here — see the header. */
export function pairingKnocks(now = Date.now()): PairingKnock[] {
  for (const [key, knock] of pending) {
    if (now - knock.lastSeen >= KNOCK_TTL_MS) pending.delete(key);
  }
  return [...pending.values()].sort((a, b) => b.lastSeen - a.lastSeen);
}

/**
 * Drop a knock without approving it. Not a block: the peer may knock again,
 * which is deliberate — a permanent denylist keyed on an address a stranger can
 * change is security theatre, and it would silently strand a real device that
 * later inherits that address.
 */
export function dismissKnock(key: string): boolean {
  return pending.delete(key);
}

/**
 * Approving is what a pairing code would have done, minus the typing: from here
 * on this peer authenticates by its key. Persisted immediately.
 */
export function approvePeer(key: string, now = Date.now(), credentialGeneration?: string): boolean {
  if (!key) return false;
  const approved = loadApprovals();
  const lastIP = pending.get(key)?.ip ?? approved.get(key)?.lastIP ?? '';
  approved.set(key, { key, lastIP, approvedAt: now, deviceId: deviceIdOfKey(key), credentialGeneration });
  pending.delete(key);
  persist(approved);
  return true;
}

export function revokePeer(key: string): boolean {
  const approved = loadApprovals();
  if (!approved.delete(key)) return false;
  persist(approved);
  return true;
}

/**
 * The question the WebSocket gate asks.
 *
 * A device id wins when the client sent one; the address is consulted only as
 * the legacy path, so a client that adopts the header stops depending on its
 * address the moment it does. Both are checked rather than one, because a
 * device approved by address before it learned to send an id must not be locked
 * out by the upgrade that taught it.
 */
export function isApprovedPeer(ip: string, deviceId: unknown, credentialGeneration?: string): boolean {
  const approved = loadApprovals();
  const normalized = normalizeDeviceId(deviceId);
  if (normalized && approved.get(`device:${normalized}`)?.credentialGeneration === credentialGeneration && approved.has(`device:${normalized}`)) return true;
  if (!ip) return false;
  return approved.has(`ip:${ip}`) && approved.get(`ip:${ip}`)?.credentialGeneration === credentialGeneration;
}

export function pairingApprovals(credentialGeneration?: string): PairingApproval[] {
  return [...loadApprovals().values()].filter(a => a.credentialGeneration === credentialGeneration).sort((a, b) => b.approvedAt - a.approvedAt);
}

/** Read the device id a client offered on the handshake, if any. */
export function deviceIdFromHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
  headerName: string,
): string | null {
  const raw = headers?.[headerName];
  return normalizeDeviceId(Array.isArray(raw) ? raw[0] : raw);
}

export function resetPairingKnocksForTests(): void {
  pending.clear();
  cache = null;
}
