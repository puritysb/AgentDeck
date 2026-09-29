/**
 * Daemon-persisted observed-session order pins (#273 session-ordering gate).
 *
 * Covers the store's identity/lifecycle rules (bare-id keying, TTL GC, size
 * cap, persistence round-trip), the enricher overlay's precedence (observed
 * rows without their own weight only), the route helpers' validation and
 * prefix resolution, and — the product claim — that a pinned observed session
 * lands in its slot through the shared fold+sort pipeline every surface uses,
 * including the Codex display fold (distinct pins never fold together).
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import {
  SessionOrderStore,
  MAX_SESSION_ORDER_PINS,
  resolveSessionOrderTarget,
  parseSessionOrderWeight,
} from '../session-order-store.js';
import { foldCodexSessionsForDisplay, sortSessions, rawSessionId } from '@agentdeck/shared';

const tmpDirs: string[] = [];

function tmpStorePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentdeck-session-order-'));
  tmpDirs.push(dir);
  return join(dir, 'session-order.json');
}

afterEach(() => {
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('SessionOrderStore identity', () => {
  it('keys pins on the bare id — both observed id forms address the same pin', () => {
    const store = new SessionOrderStore({ file: tmpStorePath() });
    store.set('observed:claude:abc-123', 3);
    expect(store.weightFor('observed:claude:abc-123')).toBe(3);
    expect(store.weightFor('abc-123')).toBe(3);
    expect(store.clear('abc-123')).toBe(true);
    expect(store.weightFor('observed:claude:abc-123')).toBeUndefined();
  });

  it('weight 0 clears instead of pinning (0 is the default band)', () => {
    const store = new SessionOrderStore({ file: tmpStorePath() });
    expect(store.set('observed:codex:x', 5)).toBe(5);
    expect(store.set('observed:codex:x', 0)).toBeUndefined();
    expect(store.size).toBe(0);
  });

  it('clamps out-of-range weights to the documented cross-platform range', () => {
    const store = new SessionOrderStore({ file: tmpStorePath() });
    expect(store.set('a', 2 ** 40)).toBe(9999);
    expect(store.set('b', -(2 ** 40))).toBe(-9999);
    expect(store.set('c', 4.7)).toBe(4);
  });
});

describe('SessionOrderStore persistence and lifecycle', () => {
  it('persists atomically and a fresh store re-loads it', () => {
    const file = tmpStorePath();
    const t0 = 1_700_000_000_000;
    let now = t0;
    const store = new SessionOrderStore({ file, now: () => now });
    store.set('observed:claude:first', 2);
    store.set('observed:codex:second', 1);

    const doc = JSON.parse(readFileSync(file, 'utf-8'));
    expect(doc.version).toBe(1);
    expect(Object.keys(doc.pins).sort()).toEqual(['first', 'second']);

    // A restart (new instance, wall clock moved on) rehydrates the pins.
    now = t0 + 2 * DAY;
    const reloaded = new SessionOrderStore({ file, now: () => now }).load();
    expect(reloaded.weightFor('observed:claude:first')).toBe(2);
    expect(reloaded.weightFor('observed:codex:second')).toBe(1);
  });

  it('a corrupt or missing file loads as an empty store, never a throw', () => {
    const file = tmpStorePath();
    writeFileSync(file, '{not json', 'utf-8');
    const store = new SessionOrderStore({ file }).load();
    expect(store.size).toBe(0);
    // And the store stays usable afterwards.
    store.set('observed:opencode:z', 7);
    expect(store.weightFor('observed:opencode:z')).toBe(7);
  });

  it('drops pins whose session has been unseen past the TTL, keeps seen ones', () => {
    const file = tmpStorePath();
    let now = 1_700_000_000_000;
    const store = new SessionOrderStore({ file, now: () => now });
    store.set('stale', 1);
    store.set('fresh', 2);
    // `fresh` reappears in rosters hourly for 31 days; `stale` never does.
    for (let i = 0; i < 31 * 24; i++) {
      now += HOUR;
      store.noteSeen(['observed:claude:fresh']);
    }
    store.flush();
    // 31 days elapsed — past the 30-day TTL for `stale`, inside it for `fresh`.
    const reloaded = new SessionOrderStore({ file, now: () => now }).load();
    expect(reloaded.weightFor('fresh')).toBe(2);
    expect(reloaded.weightFor('stale')).toBeUndefined();
  });

  it('enforces the pin cap, evicting the least-recently-seen first', () => {
    const file = tmpStorePath();
    let now = 1_700_000_000_000;
    const store = new SessionOrderStore({ file, now: () => now });
    for (let i = 0; i < MAX_SESSION_ORDER_PINS + 3; i++) {
      now += 10_000;
      store.set(`pin-${i}`, (i % 500) + 1);
      // pin-1 reappears in every roster tick, so its lastSeenAt stays within
      // the noteSeen threshold of `now`; every other pin goes quiet at set.
      store.noteSeen(['pin-1']);
    }
    expect(store.size).toBe(MAX_SESSION_ORDER_PINS);
    expect(store.weightFor('pin-0')).toBeUndefined();
    expect(store.weightFor('pin-1')).toBeDefined();
    expect(store.weightFor(`pin-${MAX_SESSION_ORDER_PINS + 2}`)).toBeDefined();
  });

  it('noteSeen is throttled per pin — a roster every few seconds does not churn the file', () => {
    const file = tmpStorePath();
    let now = 1_700_000_000_000;
    const store = new SessionOrderStore({ file, now: () => now });
    store.set('observed:claude:a', 1);
    store.flush();
    const before = readFileSync(file, 'utf-8');
    now += 5_000;
    store.noteSeen(['observed:claude:a']);
    store.flush();
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });
});

describe('SessionOrderStore.applyTo precedence', () => {
  it('pins an observed row that has no weight of its own', () => {
    const store = new SessionOrderStore({ file: tmpStorePath() });
    store.set('observed:claude:abc', -2);
    const row = { id: 'observed:claude:abc', controlMode: 'observed' as const, projectName: 'P' };
    expect(store.applyTo(row)).toEqual({ ...row, weight: -2 });
  });

  it('never overrides a weight the row already carries (managed/remote contract)', () => {
    const store = new SessionOrderStore({ file: tmpStorePath() });
    store.set('observed:claude:abc', -2);
    const weighted = { id: 'observed:claude:abc', controlMode: 'observed' as const, weight: 5 };
    expect(store.applyTo(weighted)).toBe(weighted);
  });

  it('leaves managed and remote rows untouched even when their id is pinned', () => {
    const store = new SessionOrderStore({ file: tmpStorePath() });
    store.set('abc', -2);
    const managed = { id: 'abc', controlMode: 'managed' as const, projectName: 'P' };
    const unlabeled = { id: 'abc', projectName: 'P' };
    expect(store.applyTo(managed)).toBe(managed);
    expect(store.applyTo(unlabeled)).toBe(unlabeled);
  });

  it('returns the identical object for unpinned rows', () => {
    const store = new SessionOrderStore({ file: tmpStorePath() });
    const row = { id: 'observed:codex:none', controlMode: 'observed' as const };
    expect(store.applyTo(row)).toBe(row);
  });
});

describe('resolveSessionOrderTarget', () => {
  const roster = [
    'observed:claude:aaaa1111-0000-0000-0000-000000000000',
    'observed:claude:bbbb2222-0000-0000-0000-000000000000',
    'observed:codex:cccc3333-0000-0000-0000-000000000000',
  ];

  it('an exact roster id resolves to itself', () => {
    expect(resolveSessionOrderTarget(roster[2], roster))
      .toEqual({ status: 'resolved', id: roster[2] });
  });

  it('a unique prefix (e.g. a device-truncated 31-char echo) resolves', () => {
    expect(resolveSessionOrderTarget('observed:codex:cccc3333-0000-0000-0', roster))
      .toEqual({ status: 'resolved', id: roster[2] });
  });

  it('an ambiguous prefix is refused with the candidates', () => {
    const result = resolveSessionOrderTarget('observed:claude:', roster);
    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates).toEqual([roster[0], roster[1]]);
    }
  });

  it('an id that is not live passes through in bare form (pin waits for the id)', () => {
    expect(resolveSessionOrderTarget('observed:claude:zzzz-not-live', roster))
      .toEqual({ status: 'resolved', id: 'zzzz-not-live' });
    expect(resolveSessionOrderTarget('plain-uuid', roster))
      .toEqual({ status: 'resolved', id: 'plain-uuid' });
  });

  it('cross-form: an observed-form reference resolves against a BARE-id roster (Swift shape)', () => {
    // Swift's observed rows carry the bare uuid. A prefix copied from the
    // Node world (`observed:claude:512d…`) must still resolve — before this
    // it fell through to the truncated uuid and the pin never applied.
    const bareRoster = roster.map(rawSessionId);
    expect(resolveSessionOrderTarget('observed:claude:aaaa1111-0000-0000-0', bareRoster))
      .toEqual({ status: 'resolved', id: 'aaaa1111-0000-0000-0000-000000000000' });
    expect(resolveSessionOrderTarget('observed:codex:cccc3333-0000-0000-0000-000000000000', bareRoster))
      .toEqual({ status: 'resolved', id: 'cccc3333-0000-0000-0000-000000000000' });
  });

  it('cross-form: a bare reference resolves against an observed-form roster, ambiguity still named', () => {
    expect(resolveSessionOrderTarget('aaaa1111-0000-0000-0000-000000000000', roster))
      .toEqual({ status: 'resolved', id: roster[0] });
    // Bare agent-ambiguous prefix: two observed:claude: rows share it.
    const result = resolveSessionOrderTarget('aaaa', ['observed:claude:aaaa1', 'observed:codex:aaaa2']);
    expect(result.status).toBe('ambiguous');
  });
});

describe('parseSessionOrderWeight', () => {
  it('accepts in-range integers (numbers and numeric strings from curl users)', () => {
    expect(parseSessionOrderWeight(3)).toBe(3);
    expect(parseSessionOrderWeight(-9999)).toBe(-9999);
    expect(parseSessionOrderWeight('12')).toBe(12);
  });

  it('rejects anything the wire must never see', () => {
    expect(parseSessionOrderWeight(undefined)).toBeUndefined();
    expect(parseSessionOrderWeight(1.5)).toBeUndefined();
    expect(parseSessionOrderWeight(10000)).toBeUndefined();
    expect(parseSessionOrderWeight(-10000)).toBeUndefined();
    expect(parseSessionOrderWeight('weight')).toBeUndefined();
    expect(parseSessionOrderWeight(null)).toBeUndefined();
  });
});

describe('pinned observed sessions through the shared deck pipeline', () => {
  it('a pin reorders observed rows via the exact fold+sort every surface runs', () => {
    const store = new SessionOrderStore({ file: tmpStorePath() });
    store.set('observed:claude:late', 5);
    const rows = [
      { id: 'observed:claude:early', controlMode: 'observed' as const, agentType: 'claude-code', projectName: 'A', startedAt: '2026-01-02T00:00:00Z' },
      { id: 'observed:claude:late', controlMode: 'observed' as const, agentType: 'claude-code', projectName: 'B', startedAt: '2026-01-01T00:00:00Z' },
    ];
    // Project B would sort first alphabetically; the pin must beat it.
    const order = sortSessions(rows.map((r) => store.applyTo(r))).map((r) => r.id);
    expect(order).toEqual(['observed:claude:early', 'observed:claude:late']);
  });

  it('distinct pins keep same-project Codex tabs from folding together', () => {
    const store = new SessionOrderStore({ file: tmpStorePath() });
    store.set('observed:codex:t1', 1);
    store.set('observed:codex:t2', 2);
    const rows = [
      { id: 'observed:codex:t1', controlMode: 'observed' as const, agentType: 'codex-cli', projectName: 'Same', state: 'processing' },
      { id: 'observed:codex:t2', controlMode: 'observed' as const, agentType: 'codex-cli', projectName: 'Same', state: 'idle' },
    ];
    const folded = foldCodexSessionsForDisplay(rows.map((r) => store.applyTo(r)));
    expect(folded).toHaveLength(2);
    expect(sortSessions(folded).map((r) => r.id)).toEqual(['observed:codex:t1', 'observed:codex:t2']);
  });

  it('unpinned same-project Codex rows still fold exactly as before', () => {
    const store = new SessionOrderStore({ file: tmpStorePath() });
    const rows = [
      { id: 'observed:codex:t1', controlMode: 'observed' as const, agentType: 'codex-cli', projectName: 'Same', state: 'processing' },
      { id: 'observed:codex:t2', controlMode: 'observed' as const, agentType: 'codex-cli', projectName: 'Same', state: 'idle' },
    ];
    expect(foldCodexSessionsForDisplay(rows.map((r) => store.applyTo(r)))).toHaveLength(1);
  });
});
