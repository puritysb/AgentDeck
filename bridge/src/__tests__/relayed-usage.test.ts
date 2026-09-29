/**
 * The daemon's relayed-`usage_update` decision (issue #253).
 *
 * This is the daemon's most flicker-sensitive path: a session bridge broadcasts
 * usage on every state change, and what the daemon forwards lands on every
 * dashboard and device gauge. The branch used to be inlined in the relay
 * callback with no seam, so neither half of the decision could be driven —
 * which is why a Codex block that alternated between a real window and a voided
 * one shipped for as long as it did.
 */
import { describe, it, expect, vi } from 'vitest';
import { resolveRelayedUsageEvent } from '../relayed-usage.js';
import type { CodexRateLimits, UsageEvent } from '../types.js';

/** A daemon aggregate. Only the fields the resolver can touch matter here. */
function ownUsage(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    type: 'usage_update',
    sessionDurationSec: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    fiveHourPercent: 11,
    usageStale: false,
    ...overrides,
  } as unknown as UsageEvent;
}

/** A real Codex reading: plan-matching, stamped, with a live window. */
function stamped(capturedAt: string, usedPercent = 42): CodexRateLimits {
  return {
    planType: 'plus',
    capturedAt,
    primary: { usedPercent, windowMinutes: 300, resetsAt: '2099-01-01T00:00:00Z' },
  } as CodexRateLimits;
}

/**
 * What `normalizeCodexRateLimits` emits for a snapshot minted under a plan the
 * account no longer holds: the live tier survives, every measurement — windows,
 * credits, `capturedAt` — goes with the void. This is the block a session
 * bridge relays when no plan-matching rollout exists, and the one that made the
 * gauge blank on alternate events.
 */
function voided(): CodexRateLimits {
  return { planType: 'plus' } as CodexRateLimits;
}

describe('resolveRelayedUsageEvent — branch selection', () => {
  it('never builds the daemon aggregate when the relay carries Claude quota', () => {
    // buildUsage() arms the throttled `codex app-server` spawn and re-derives
    // the whole account half. The thunk is the guard; this is what it guards.
    const buildOwnUsage = vi.fn(() => ownUsage());
    resolveRelayedUsageEvent({
      relayed: { type: 'usage_update', fiveHourPercent: 63, inputTokens: 900 },
      ownCodexRateLimits: null,
      buildOwnUsage,
    });
    expect(buildOwnUsage).not.toHaveBeenCalled();
  });

  it('counts a lone sevenDayPercent as Claude quota too', () => {
    const buildOwnUsage = vi.fn(() => ownUsage());
    resolveRelayedUsageEvent({
      relayed: { type: 'usage_update', sevenDayPercent: 7 },
      ownCodexRateLimits: null,
      buildOwnUsage,
    });
    expect(buildOwnUsage).not.toHaveBeenCalled();
  });

  it('splits by half when the relay carries no Claude quota', () => {
    // The account half stays the daemon's; only the session counters ride the
    // relay. Forwarding such an event verbatim is what blanked the Claude gauge
    // to "No usage data" on every state tick.
    const out = resolveRelayedUsageEvent({
      relayed: { type: 'usage_update', inputTokens: 1234, toolCalls: 9, usageStale: true },
      ownCodexRateLimits: null,
      buildOwnUsage: () => ownUsage({ fiveHourPercent: 55 }),
    }) as any;
    expect(out.inputTokens).toBe(1234);
    expect(out.toolCalls).toBe(9);
    expect(out.fiveHourPercent).toBe(55);
    // usageStale is account-half: the relay's own value must not win.
    expect(out.usageStale).toBe(false);
  });
});

describe('resolveRelayedUsageEvent — Codex block reconciliation (#253)', () => {
  it("replaces the bridge's voided block with the daemon's live window", () => {
    // The reproduction condition: no plan-matching rollout exists, so the bridge
    // — which structurally has only the passive read — voids its snapshot, while
    // the daemon additionally holds a live `codex app-server` reading. Before
    // this, successive events alternated between the two.
    const live = stamped('2026-08-23T00:00:00Z', 42);
    const out = resolveRelayedUsageEvent({
      relayed: { type: 'usage_update', fiveHourPercent: 63, codexRateLimits: voided() },
      ownCodexRateLimits: live,
      buildOwnUsage: () => { throw new Error('must not build'); },
    }) as any;
    expect(out.codexRateLimits).toBe(live);
    expect(out.codexRateLimits.primary.usedPercent).toBe(42);
    // The session half is untouched by the swap.
    expect(out.fiveHourPercent).toBe(63);
  });

  it("keeps the bridge's block when it is the newer reading", () => {
    // Reconciled, not overwritten. The daemon's block is normally the better one,
    // but it is a remembered value from the daemon's last build — a bridge that
    // just read a newer rollout still wins on recency, the same rule the daemon
    // applies to its own two readings.
    const relayedCodex = stamped('2026-08-23T01:00:00Z', 71);
    const out = resolveRelayedUsageEvent({
      relayed: { type: 'usage_update', fiveHourPercent: 63, codexRateLimits: relayedCodex },
      ownCodexRateLimits: stamped('2026-08-23T00:00:00Z', 42),
      buildOwnUsage: () => { throw new Error('must not build'); },
    }) as any;
    expect(out.codexRateLimits).toBe(relayedCodex);
  });

  it("keeps the daemon's block when the bridge relays a different limit family", () => {
    // Recency rules WITHIN a family, not across one. A session bridge has only
    // the passive rollout read, and once the account's weekly quota is exhausted
    // that read is the per-model pool wearing the account's `limit_id` — always
    // seconds old, because the rollout is appended every couple of seconds. The
    // daemon's block is the one backed by the live `codex app-server` answer, so
    // a cross-family disagreement is resolved in its favour rather than by age.
    // Verbatim shapes from 2026-08-27, driven against an injected clock: the
    // guard's authority decays with a reading's age and its window eventually
    // elapses, so left to the wall clock these assertions would invert on a
    // date in the future rather than on a change to the code.
    const poolUnderAccountId = {
      planType: 'prolite',
      limitId: 'codex',
      capturedAt: '2026-08-27T13:09:40.628Z',
      primary: { usedPercent: 54, windowMinutes: 300, resetsAt: '2026-08-27T18:01:28Z' },
      secondary: { usedPercent: 24, windowMinutes: 10080, resetsAt: '2026-09-03T13:01:28Z' },
    } as CodexRateLimits;
    const accountExhausted = {
      planType: 'prolite',
      limitId: 'codex',
      capturedAt: '2026-08-27T13:05:00.000Z',
      primary: { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-09-01T15:01:30Z' },
    } as CodexRateLimits;
    const out = resolveRelayedUsageEvent({
      relayed: { type: 'usage_update', fiveHourPercent: 63, codexRateLimits: poolUnderAccountId },
      ownCodexRateLimits: accountExhausted,
      ownLiveFamilyAuthorityExpiresAtMs: Date.parse('2099-01-01T00:00:00Z'),
      nowMs: Date.parse('2026-08-27T13:09:41Z'),
      buildOwnUsage: () => { throw new Error('must not build'); },
    }) as any;
    expect(out.codexRateLimits).toBe(accountExhausted);
  });

  it('lets the authority lapse on this event\'s clock, not the build\'s', () => {
    // The flag is produced by a usage build and consumed here later. Frozen as a
    // boolean it outlived its own fifteen-minute bound — the relay can only
    // re-check the age of the block it received, and when the picker kept the
    // fresher rollout that block is younger than the live answer behind it.
    const poolUnderAccountId = {
      planType: 'prolite',
      limitId: 'codex',
      capturedAt: '2026-08-27T13:09:40.628Z',
      primary: { usedPercent: 54, windowMinutes: 300, resetsAt: '2026-08-27T18:01:28Z' },
      secondary: { usedPercent: 24, windowMinutes: 10080, resetsAt: '2026-09-03T13:01:28Z' },
    } as CodexRateLimits;
    const accountExhausted = {
      planType: 'prolite',
      limitId: 'codex',
      capturedAt: '2026-08-27T13:05:00.000Z',
      primary: { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-09-01T15:01:30Z' },
    } as CodexRateLimits;
    const call = (nowMs: number, expiresAtMs: number) =>
      (resolveRelayedUsageEvent({
        relayed: { type: 'usage_update', fiveHourPercent: 63, codexRateLimits: poolUnderAccountId },
        ownCodexRateLimits: accountExhausted,
        ownLiveFamilyAuthorityExpiresAtMs: expiresAtMs,
        nowMs,
        buildOwnUsage: () => { throw new Error('must not build'); },
      }) as any).codexRateLimits;
    const expires = Date.parse('2026-08-27T13:15:00.000Z');
    expect(call(Date.parse('2026-08-27T13:09:41Z'), expires)).toBe(accountExhausted);
    expect(call(Date.parse('2026-08-27T13:20:00Z'), expires)).toBe(poolUnderAccountId);
  });

  it('falls back to recency when the daemon has no live reading to arbitrate with', () => {
    // Same inputs, no live answer behind the daemon's block. Two rollout reads
    // disagreeing about the family is not something either side can settle, and
    // with the roles reversed — the daemon on the mislabelled pool line, the
    // bridge on the account line — preferring the daemon would invert the fix.
    const relayedFresh = {
      planType: 'prolite',
      limitId: 'codex',
      capturedAt: '2026-08-27T13:09:40.628Z',
      primary: { usedPercent: 54, windowMinutes: 300, resetsAt: '2026-08-27T18:01:28Z' },
      secondary: { usedPercent: 24, windowMinutes: 10080, resetsAt: '2026-09-03T13:01:28Z' },
    } as CodexRateLimits;
    const ownOlder = {
      planType: 'prolite',
      limitId: 'codex',
      capturedAt: '2026-08-27T13:05:00.000Z',
      primary: { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-09-01T15:01:30Z' },
    } as CodexRateLimits;
    const out = resolveRelayedUsageEvent({
      relayed: { type: 'usage_update', fiveHourPercent: 63, codexRateLimits: relayedFresh },
      ownCodexRateLimits: ownOlder,
      nowMs: Date.parse('2026-08-27T13:09:41Z'),
      buildOwnUsage: () => { throw new Error('must not build'); },
    }) as any;
    expect(out.codexRateLimits).toBe(relayedFresh);
  });

  it("never lets the daemon's contentless block displace a windowed relayed one", () => {
    // `ownCodexRateLimits` is the daemon's last PUBLISHED block, not necessarily
    // a live reading — and one rollout can carry `limit_id: "codex"` and
    // `limit_id: "premium"` a second apart, so two processes reading the same
    // tail legitimately land on different ids. Were a block with no weekly
    // window allowed to reject on that difference, the synthetic credit gauge
    // would pin over a real reading and #253 would come back sticky.
    const relayedWindowed = {
      planType: 'prolite',
      limitId: 'codex',
      capturedAt: '2026-08-27T13:09:40.628Z',
      primary: { usedPercent: 54, windowMinutes: 300, resetsAt: '2026-08-27T18:01:28Z' },
      secondary: { usedPercent: 24, windowMinutes: 10080, resetsAt: '2026-09-03T13:01:28Z' },
    } as CodexRateLimits;
    // Genuinely windowless, and NEWER than the relayed block, so recency alone
    // would take it — the bound is the only thing that can keep the windowed
    // one. An earlier fixture used `windowMinutes: 0`, which still counts as a
    // window present, so the assertion held on recency and deleting the bound
    // left it green.
    const ownContentless = {
      planType: 'prolite',
      limitId: 'codex',
      capturedAt: '2026-08-27T13:20:00.000Z',
    } as unknown as CodexRateLimits;
    const out = resolveRelayedUsageEvent({
      relayed: { type: 'usage_update', fiveHourPercent: 63, codexRateLimits: relayedWindowed },
      ownCodexRateLimits: ownContentless,
      ownLiveFamilyAuthorityExpiresAtMs: Date.parse('2099-01-01T00:00:00Z'),
      nowMs: Date.parse('2026-08-27T13:20:30Z'),
      buildOwnUsage: () => { throw new Error('must not build'); },
    }) as any;
    expect(out.codexRateLimits).toBe(relayedWindowed);
  });

  it("supplies the daemon's block when the relay says nothing about Codex", () => {
    const live = stamped('2026-08-23T00:00:00Z');
    const out = resolveRelayedUsageEvent({
      relayed: { type: 'usage_update', fiveHourPercent: 63 },
      ownCodexRateLimits: live,
      buildOwnUsage: () => { throw new Error('must not build'); },
    }) as any;
    expect(out.codexRateLimits).toBe(live);
  });

  it('leaves the relayed event untouched when the daemon has never built one', () => {
    // Pre-#253 behaviour, and the startup case. Under retain-on-absent merging an
    // absent key means "no information" — it must not become an explicit
    // `undefined`, which clients would read as a value.
    const relayed = { type: 'usage_update', fiveHourPercent: 63 };
    const out = resolveRelayedUsageEvent({
      relayed,
      ownCodexRateLimits: null,
      buildOwnUsage: () => { throw new Error('must not build'); },
    });
    expect(out).toBe(relayed as unknown as UsageEvent);
    expect('codexRateLimits' in (out as object)).toBe(false);
  });

  it('keeps the relayed block on an exact tie rather than churning the object', () => {
    const relayed = { type: 'usage_update', fiveHourPercent: 63, codexRateLimits: stamped('2026-08-23T00:00:00Z') };
    const out = resolveRelayedUsageEvent({
      relayed,
      ownCodexRateLimits: stamped('2026-08-23T00:00:00Z'),
      buildOwnUsage: () => { throw new Error('must not build'); },
    });
    expect(out).toBe(relayed as unknown as UsageEvent);
  });

  it('does not reconcile Codex on the merged branch — that block is already the daemon\'s', () => {
    const own = ownUsage({ codexRateLimits: stamped('2026-08-23T00:00:00Z', 42) } as Partial<UsageEvent>);
    const out = resolveRelayedUsageEvent({
      relayed: { type: 'usage_update', inputTokens: 5, codexRateLimits: stamped('2099-01-01T00:00:00Z', 99) },
      ownCodexRateLimits: null,
      buildOwnUsage: () => own,
    }) as any;
    expect(out.codexRateLimits.primary.usedPercent).toBe(42);
  });
});

describe('resolveRelayedUsageEvent — z.ai provider block', () => {
  const zaiBlock = {
    planType: 'max',
    capturedAt: '2099-01-01T00:00:00Z',
    primary: { usedPercent: 3, windowMinutes: 300 },
  } as import('../types.js').ZaiRateLimits;

  it('re-attaches the daemon\'s remembered z.ai block onto a Claude-bearing relay', () => {
    const relayed = { type: 'usage_update', fiveHourPercent: 63 };
    const out = resolveRelayedUsageEvent({
      relayed,
      ownCodexRateLimits: null,
      ownZaiRateLimits: zaiBlock,
      buildOwnUsage: () => { throw new Error('must not build'); },
    }) as any;
    expect(out.zaiRateLimits).toBe(zaiBlock);
    expect('subscriptions' in out).toBe(false);
    // The relayed object itself is not mutated.
    expect('zaiRateLimits' in relayed).toBe(false);
  });

  it.each([[], [{ name: 'Claude' }, { name: 'ChatGPT Plus', until: '2099-01-01' }]].map(subscriptions => ({ subscriptions })))(
    'retains the daemon z.ai plan alongside a session subscription snapshot $subscriptions', ({ subscriptions }) => {
      const relayed = { type: 'usage_update', fiveHourPercent: 63, subscriptions };
      const out = resolveRelayedUsageEvent({ relayed, ownCodexRateLimits: null,
        ownZaiRateLimits: zaiBlock, buildOwnUsage: () => { throw new Error('must not build'); } });
      expect(out.subscriptions).toEqual([...(subscriptions ?? []), { name: 'GLM Coding Plan · Max' }]);
      expect(relayed.subscriptions).toBe(subscriptions);
    },
  );

  it('replaces an old z.ai plan once and removes it on explicit retirement', () => {
    const relayed = { type: 'usage_update', fiveHourPercent: 63,
      subscriptions: [{ name: 'Claude' }, { name: 'GLM Coding Plan · Pro' }, { name: 'GLM Coding Plan' }] };
    const resolve = (quota: import('../types.js').ZaiRateLimits) => resolveRelayedUsageEvent({
      relayed, ownCodexRateLimits: null, ownZaiRateLimits: quota,
      buildOwnUsage: () => { throw new Error('must not build'); },
    });
    expect(resolve(zaiBlock).subscriptions).toEqual([{ name: 'Claude' }, { name: 'GLM Coding Plan · Max' }]);
    expect(resolve({ limitId: 'payg' }).subscriptions).toEqual([{ name: 'Claude' }]);
    expect(resolve({}).subscriptions).toEqual([{ name: 'Claude' }]);
    expect(relayed.subscriptions).toHaveLength(3);
  });

  it('keeps the identity return when there is no z.ai block to attach', () => {
    const relayed = { type: 'usage_update', fiveHourPercent: 63, codexRateLimits: stamped('2026-08-23T00:00:00Z') };
    const out = resolveRelayedUsageEvent({
      relayed,
      ownCodexRateLimits: stamped('2026-08-23T00:00:00Z'),
      buildOwnUsage: () => { throw new Error('must not build'); },
    });
    expect(out).toBe(relayed as unknown as UsageEvent);
  });
});
