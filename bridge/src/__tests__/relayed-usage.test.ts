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
