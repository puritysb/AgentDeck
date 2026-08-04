import { describe, expect, it } from 'vitest';
import { PermissionMode, State, type StateSnapshot, type UsageEvent } from '../types.js';
import { buildUsageEvent, mergeRelayedSessionUsage } from '../usage-event.js';
import type { ApiUsageData } from '../usage-api.js';
import { codexUsageFootnote } from '@agentdeck/shared';

function snapshot(overrides: Partial<StateSnapshot> = {}): StateSnapshot {
  return {
    state: State.IDLE,
    permissionMode: PermissionMode.DEFAULT,
    currentTool: null,
    toolInput: null,
    toolProgress: null,
    options: [],
    question: null,
    navigable: false,
    cursorIndex: 0,
    projectName: 'AgentDeck',
    modelName: null,
    effortLevel: null,
    billingType: 'unknown',
    sessionDurationSec: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    estimatedCostUsd: null,
    sessionPercent: null,
    costSpent: null,
    costLimit: null,
    resetTime: null,
    resetDate: null,
    suggestedPrompt: null,
    remoteUrl: null,
    ...overrides,
  };
}

function usage(overrides: Partial<ApiUsageData> = {}): ApiUsageData {
  return {
    fiveHourPercent: 55,
    fiveHourResetsAt: '2026-06-06T18:00:00Z',
    sevenDayPercent: 44,
    sevenDayResetsAt: '2026-06-12T18:00:00Z',
    extraUsageEnabled: true,
    extraUsageMonthlyLimit: 100,
    extraUsageUsedCredits: 12,
    extraUsageUtilization: 12,
    scopedLimits: [],
    inferredBillingType: 'subscription',
    ...overrides,
  };
}

describe('buildUsageEvent subscription quota scoping', () => {
  it('omits Anthropic quota when the model is not yet known', () => {
    const evt = buildUsageEvent(
      snapshot({ billingType: 'subscription' }),
      usage(),
      true,
    ) as UsageEvent;

    expect(evt.fiveHourPercent).toBeUndefined();
    expect(evt.sevenDayPercent).toBeUndefined();
    expect(evt.extraUsageEnabled).toBeUndefined();
  });

  it('omits Anthropic 5h/7d quota for GLM/API-backed models', () => {
    const evt = buildUsageEvent(
      snapshot({ modelName: 'glm-5.1', billingType: 'subscription' }),
      usage(),
      true,
    ) as UsageEvent;

    expect(evt.fiveHourPercent).toBeUndefined();
    expect(evt.fiveHourResetsAt).toBeUndefined();
    expect(evt.sevenDayPercent).toBeUndefined();
    expect(evt.sevenDayResetsAt).toBeUndefined();
    expect(evt.extraUsageEnabled).toBeUndefined();
    expect(evt.oauthConnected).toBe(true);
  });

  it('keeps Anthropic 5h/7d quota on the daemon hub even with a non-Claude aggregate model', () => {
    // Regression: the daemon aggregates many agents and its `modelName` is whatever
    // agent is primary (e.g. OpenClaw "GLM-5.2"). The account-level Claude quota must
    // still broadcast so the Dashboard shows subscription usage. `aggregateSubscriptionQuota`
    // is the 12th positional arg; preAdjusted (11th) = true keeps the raw percent.
    const evt = buildUsageEvent(
      snapshot({ modelName: 'GLM-5.2 (1M)', billingType: 'subscription' }),
      usage(),
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
      true,
    ) as UsageEvent;

    expect(evt.fiveHourPercent).toBe(55);
    expect(evt.sevenDayPercent).toBe(44);
    expect(evt.extraUsageEnabled).toBe(true);
    expect(evt.oauthConnected).toBe(true);
  });

  it('keeps Anthropic 5h/7d quota for Claude model aliases', () => {
    const evt = buildUsageEvent(
      snapshot({ modelName: 'opus-4.6', billingType: 'subscription' }),
      usage(),
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    ) as UsageEvent;

    expect(evt.fiveHourPercent).toBe(55);
    expect(evt.sevenDayPercent).toBe(44);
    expect(evt.extraUsageEnabled).toBe(true);
  });
});

describe('buildUsageEvent scoped limits', () => {
  const SCOPED = [
    { kind: 'weekly_scoped', label: 'Fable', percent: 98, severity: 'critical', resetsAt: '2026-06-12T18:00:00Z', active: true },
    { kind: 'weekly_scoped', label: 'Opus', percent: 40, severity: 'normal', resetsAt: '2026-06-12T18:00:00Z', active: false },
  ];

  it('forwards scopedLimits for a subscription Claude model', () => {
    // opus-4.6 + preAdjusted (11th arg) = the subscription-quota-applies path.
    const evt = buildUsageEvent(
      snapshot({ modelName: 'opus-4.6', billingType: 'subscription' }),
      usage({ scopedLimits: SCOPED }),
      true,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      true,
    ) as UsageEvent;

    expect(evt.scopedLimits).toEqual(SCOPED);
  });

  it('omits scopedLimits for an API/GLM-backed model even when present', () => {
    // Same gate as the 5h/7d quota: a non-Claude subscription model must not leak
    // Anthropic scoped caps.
    const evt = buildUsageEvent(
      snapshot({ modelName: 'glm-5.1', billingType: 'subscription' }),
      usage({ scopedLimits: SCOPED }),
      true,
    ) as UsageEvent;

    expect(evt.scopedLimits).toBeUndefined();
  });

  it('omits scopedLimits when the scoped array is empty (no phantom key)', () => {
    const evt = buildUsageEvent(
      snapshot({ modelName: 'opus-4.6', billingType: 'subscription' }),
      usage({ scopedLimits: [] }),
      true,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      true,
    ) as UsageEvent;

    expect(evt.scopedLimits).toBeUndefined();
  });
});

describe('buildUsageEvent staleness contract', () => {
  it('flags usageStale when no quota numbers ride the frame (never fetched)', () => {
    // Clients treat "percent fields absent + usageStale falsy" as "keep the
    // previous value" — a daemon with nothing to report must say stale so a
    // dashboard roaming from another daemon purges the foreign numbers.
    const evt = buildUsageEvent(
      snapshot({ modelName: 'claude-fable-5', billingType: 'subscription' }),
      null,
      true,
    ) as UsageEvent;

    expect(evt.fiveHourPercent).toBeUndefined();
    expect(evt.sevenDayPercent).toBeUndefined();
    expect(evt.usageStale).toBe(true);
  });

  it('does not flag usageStale when fresh quota numbers are present', () => {
    const evt = buildUsageEvent(
      snapshot({ modelName: 'claude-fable-5', billingType: 'subscription' }),
      usage(),
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    ) as UsageEvent;

    expect(evt.fiveHourPercent).toBe(55);
    expect(evt.usageStale).toBe(false);
  });

  it('always puts usageStale on the wire, never omits it', () => {
    // Clients merge usage retain-on-absent, so an omitted key can only ever
    // ADD staleness — never retract it. Omitting when fresh made usageStale a
    // one-way latch (macOS Dashboard stuck on "stale" over live percentages,
    // 2026-07-25). The key must survive serialization, not just be falsy.
    const evt = buildUsageEvent(
      snapshot({ modelName: 'claude-fable-5', billingType: 'subscription' }),
      usage(),
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    ) as UsageEvent;

    expect(Object.prototype.hasOwnProperty.call(evt, 'usageStale')).toBe(true);
    expect(JSON.parse(JSON.stringify(evt)).usageStale).toBe(false);
  });

  it('keeps usageStale true when cached numbers ride a stale frame', () => {
    // "Had data, now stale" — clients rely on the explicit true to SCRUB the
    // percentages, so data-presence must never override an explicit flag.
    const evt = buildUsageEvent(
      snapshot({ modelName: 'claude-fable-5', billingType: 'subscription' }),
      usage(),
      true,
      undefined,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    ) as UsageEvent;

    expect(evt.fiveHourPercent).toBe(55);
    expect(evt.usageStale).toBe(true);
  });

  it('does not force usageStale when the cost-based API-billing percent is present', () => {
    const evt = buildUsageEvent(
      snapshot({ billingType: 'api', costSpent: 5, costLimit: 10 }),
      null,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      'api',
    ) as UsageEvent;

    expect(evt.fiveHourPercent).toBe(50);
    expect(evt.usageStale).toBe(false);
  });
});

describe('buildUsageEvent Codex window normalization', () => {
  const codexArgs = (codexRateLimits: unknown) =>
    [
      snapshot(),
      null, // apiUsage
      undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined,
      codexRateLimits,
    ] as Parameters<typeof buildUsageEvent>;

  it('marks an expired window stale and drops its resetsAt (no misleading "now")', () => {
    const expired = new Date(Date.now() - 30 * 60_000).toISOString();
    const evt = buildUsageEvent(
      ...codexArgs({ primary: { usedPercent: 67, windowMinutes: 300, resetsAt: expired } }),
    ) as UsageEvent;

    const p = evt.codexRateLimits!.primary!;
    expect(p.usedPercent).toBe(67); // last-known preserved
    expect(p.stale).toBe(true);
    expect(p.resetsAt).toBeUndefined(); // no past timestamp → no "now"
  });

  it('leaves a live window untouched', () => {
    const future = new Date(Date.now() + 2 * 3600_000).toISOString();
    const evt = buildUsageEvent(
      ...codexArgs({ secondary: { usedPercent: 12, windowMinutes: 10080, resetsAt: future } }),
    ) as UsageEvent;

    const s = evt.codexRateLimits!.secondary!;
    expect(s.usedPercent).toBe(12);
    expect(s.stale).toBeUndefined();
    expect(s.resetsAt).toBe(future);
  });

  it('forwards capturedAt so consumers can age the reading themselves', () => {
    const future = new Date(Date.now() + 6 * 24 * 3600_000).toISOString();
    const capturedAt = new Date(Date.now() - 4 * 3600_000).toISOString();
    const evt = buildUsageEvent(
      ...codexArgs({
        primary: { usedPercent: 94, windowMinutes: 10080, resetsAt: future },
        capturedAt,
      }),
    ) as UsageEvent;

    expect(evt.codexRateLimits!.capturedAt).toBe(capturedAt);
  });

  it('does NOT set `stale` on a merely-old snapshot of a live window', () => {
    // `stale` is the HARD signal — Pixoo/ESP32 consumers drop the gauge on it.
    // A 4h-old reading of a window that is still six days from resetting is not
    // gone, it is old: it keeps rendering, and `capturedAt` is what dims it.
    const future = new Date(Date.now() + 6 * 24 * 3600_000).toISOString();
    const evt = buildUsageEvent(
      ...codexArgs({
        primary: { usedPercent: 94, windowMinutes: 10080, resetsAt: future },
        capturedAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
      }),
    ) as UsageEvent;

    // Length-based slotting: the weekly window Codex reports in its own
    // `primary` slot lands on the wire's `secondary`.
    const w = evt.codexRateLimits!.secondary!;
    expect(evt.codexRateLimits!.primary).toBeUndefined();
    expect(w.stale).toBeUndefined();
    expect(w.usedPercent).toBe(94);
    expect(w.resetsAt).toBe(future); // countdown still valid — the window is live
    expect(codexUsageFootnote(w, evt.codexRateLimits!.capturedAt))
      .toEqual({ text: '4h ago', dim: true });
  });

  it('keeps capturedAt through the credits-only synthetic window', () => {
    const capturedAt = new Date(Date.now() - 90 * 60_000).toISOString();
    const evt = buildUsageEvent(
      ...codexArgs({
        limitId: 'premium',
        credits: { hasCredits: false, unlimited: false, balance: '0' },
        capturedAt,
      }),
    ) as UsageEvent;

    expect(evt.codexRateLimits!.primary!.usedPercent).toBe(100);
    expect(evt.codexRateLimits!.capturedAt).toBe(capturedAt);
  });

  it('treats each window independently (5h expired, 7d live)', () => {
    const expired = new Date(Date.now() - 30 * 60_000).toISOString();
    const future = new Date(Date.now() + 2 * 3600_000).toISOString();
    const evt = buildUsageEvent(
      ...codexArgs({
        primary: { usedPercent: 90, windowMinutes: 300, resetsAt: expired },
        secondary: { usedPercent: 20, windowMinutes: 10080, resetsAt: future },
      }),
    ) as UsageEvent;

    expect(evt.codexRateLimits!.primary!.stale).toBe(true);
    expect(evt.codexRateLimits!.primary!.resetsAt).toBeUndefined();
    expect(evt.codexRateLimits!.secondary!.stale).toBeUndefined();
    expect(evt.codexRateLimits!.secondary!.resetsAt).toBe(future);
  });

  it('routes a weekly window arriving in Codex\'s primary slot to the secondary (7D) wire slot', () => {
    // Codex reports the weekly (10080-min) window as `primary` with `secondary`
    // null once the 5h window resets. Slot-based downstream clients (ESP32/InkDeck
    // firmware: primary=5H, secondary=7D) must receive it as `secondary`, and no
    // phantom `primary` (5h) window, so the 7D gauge shows and 5H stays empty.
    const future = new Date(Date.now() + 6 * 24 * 3600_000).toISOString();
    const evt = buildUsageEvent(
      ...codexArgs({ primary: { usedPercent: 4, windowMinutes: 10080, resetsAt: future } }),
    ) as UsageEvent;

    expect(evt.codexRateLimits!.primary).toBeUndefined();     // no phantom 5h window
    expect(evt.codexRateLimits!.secondary!.usedPercent).toBe(4);
    expect(evt.codexRateLimits!.secondary!.windowMinutes).toBe(10080);
    expect(evt.codexRateLimits!.secondary!.resetsAt).toBe(future);
  });

  it('maps exhausted credit-based plan (null windows) to a 100% primary gauge', () => {
    // Credit plans (limitId "premium") report null 5h/7d windows. An exhausted
    // balance reads as 100% used so the gauge shows instead of vanishing, and is
    // NOT marked stale (no resetsAt → not stale) so surfaces don't hide it.
    const evt = buildUsageEvent(
      ...codexArgs({
        limitId: 'premium',
        primary: null,
        secondary: null,
        credits: { hasCredits: false, unlimited: false, balance: '0' },
        planType: 'plus',
      }),
    ) as UsageEvent;

    expect(evt.codexRateLimits!.primary!.usedPercent).toBe(100);
    expect(evt.codexRateLimits!.primary!.stale).toBeUndefined();
    expect(evt.codexRateLimits!.secondary).toBeUndefined();
  });

  it('maps an unlimited credit plan to a 0% primary gauge', () => {
    const evt = buildUsageEvent(
      ...codexArgs({ credits: { hasCredits: true, unlimited: true } }),
    ) as UsageEvent;

    expect(evt.codexRateLimits!.primary!.usedPercent).toBe(0);
    expect(evt.codexRateLimits!.primary!.stale).toBeUndefined();
  });

  it('leaves a partial credit balance absent (no honest percentage)', () => {
    const evt = buildUsageEvent(
      ...codexArgs({ credits: { hasCredits: true, unlimited: false, balance: '42' } }),
    ) as UsageEvent;

    expect(evt.codexRateLimits!.primary).toBeUndefined();
    expect(evt.codexRateLimits!.secondary).toBeUndefined();
  });
});

// ─── Relayed session usage: split by half, never dropped ───────────────

describe('mergeRelayedSessionUsage', () => {
  /** What the daemon knows: real account quota, but a zeroed session half — its
   *  UsageTracker is never fed by a PTY. */
  const own = {
    type: 'usage_update',
    sessionDurationSec: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: 0,
    estimatedCostUsd: 0,
    fiveHourPercent: 32,
    sevenDayPercent: 64,
    scopedLimits: [{ label: 'Fable', percent: 98, active: true }],
    usageStale: false,
  } as unknown as UsageEvent;

  /** What a focused Codex session relays: real session counters, no Claude quota. */
  const relayed = {
    type: 'usage_update',
    sessionDurationSec: 742,
    inputTokens: 12_000,
    outputTokens: 3_400,
    toolCalls: 17,
    estimatedCostUsd: 0.42,
    usageStale: true,
  };

  it('keeps the relay session counters', () => {
    const m = mergeRelayedSessionUsage(own, relayed) as any;
    expect(m.sessionDurationSec).toBe(742);
    expect(m.inputTokens).toBe(12_000);
    expect(m.outputTokens).toBe(3_400);
    expect(m.toolCalls).toBe(17);
    expect(m.estimatedCostUsd).toBe(0.42);
  });

  it('keeps the daemon account half authoritative — a quota-less relay cannot blank the gauge', () => {
    const m = mergeRelayedSessionUsage(own, relayed) as any;
    expect(m.fiveHourPercent).toBe(32);
    expect(m.sevenDayPercent).toBe(64);
    expect(m.scopedLimits).toEqual([{ label: 'Fable', percent: 98, active: true }]);
    // The session asserts staleness about quota it never had — the daemon's own
    // explicit `false` must win, or the dashboard latches a "stale" badge over
    // live percentages (CLAUDE.md wire-flag rule).
    expect(m.usageStale).toBe(false);
  });

  it('leaves the daemon value in place for a session field the relay omits', () => {
    const m = mergeRelayedSessionUsage(own, { type: 'usage_update' }) as any;
    expect(m.inputTokens).toBe(0);
    expect(m.fiveHourPercent).toBe(32);
  });

  it('does not mutate either input', () => {
    mergeRelayedSessionUsage(own, relayed);
    expect((own as any).inputTokens).toBe(0);
    expect(relayed.inputTokens).toBe(12_000);
  });
});
