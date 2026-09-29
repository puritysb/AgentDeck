import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  parseLiveCodexRateLimits,
  pickAccountWideLiveLimits,
  pickBestCodexRateLimits,
  codexSnapshotsShareLimitFamily,
  liveRejectsPassiveFamily,
  liveCorroboratesPassiveFamily,
  codexLiveFamilyAuthorityExpiry,
  shouldQueryCodexRateLimitsLive,
  queryCodexRateLimitsLive,
  codexSpawnPlan,
  __resetCodexRateLimitsLiveForTest,
  __peekCodexRateLimitsLiveForTest,
  codexRateLimitsWithLiveRefresh,
} from '../codex-rate-limits-live.js';

// The exact `account/rateLimits/read` result observed from codex-cli 0.146.0 on
// 2026-08-05, at the moment the weekly quota was exhausted — the reading the
// passive rollout path structurally cannot produce.
const liveResult = {
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1786459585 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    individualLimit: null,
    spendControlReached: false,
    planType: 'plus',
    rateLimitReachedType: 'rate_limit_reached',
    additionalRateLimits: [{
      meteredFeature: 'gpt-5.6-luna',
      limitName: 'Luna Reserve',
      rateLimit: {
        primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1786459585 },
      },
    }],
  },
  rateLimitResetCredits: { availableCount: 0, credits: [] },
  rateLimitsByLimitId: {
    base_model_inference: {
      limitId: 'base_model_inference',
      limitName: 'gpt-reserve',
      primary: { usedPercent: 18, windowDurationMins: 10080, resetsAt: 1786459585 },
      secondary: null,
      planType: 'plus',
    },
  },
};

// Both halves of the 2026-08-27 reading, copied off `account/rateLimits/read`
// and the rollout tail written at the same minute. The account family is
// exhausted; `codex_bengalfox` ("GPT-5.3-Codex-Spark") is the per-model pool the
// turns were actually served from, and the rollout stamped it `limit_id:
// "codex"`, `limit_name: null` — identical to what the account family looks
// like. The reset instants are what tell them apart.
const ACCOUNT_EXHAUSTED = {
  primary: {
    usedPercent: 100,
    windowMinutes: 10080,
    resetsAt: new Date(1788274890 * 1000).toISOString(),
  },
  planType: 'prolite',
  limitId: 'codex',
  credits: { hasCredits: false, unlimited: false, balance: '0' },
};

const SPARK_MISLABELLED_AS_ACCOUNT = {
  primary: {
    usedPercent: 54,
    windowMinutes: 300,
    resetsAt: new Date(1787853688 * 1000).toISOString(),
  },
  secondary: {
    usedPercent: 24,
    windowMinutes: 10080,
    resetsAt: new Date(1788440488 * 1000).toISOString(),
  },
  planType: 'prolite',
  limitId: 'codex',
  credits: { hasCredits: false, unlimited: false, balance: '0' },
};

describe('parseLiveCodexRateLimits', () => {
  it('does not activate an additional reserve pool while ordinary quota is available', () => {
    const result = structuredClone(liveResult);
    result.rateLimits.primary.usedPercent = 19;
    expect(parseLiveCodexRateLimits(result, '2026-08-05T12:00:00.000Z')?.lunaReserve).toBeUndefined();
  });

  it('maps the app-server shape onto the wire shape', () => {
    const parsed = parseLiveCodexRateLimits(liveResult, '2026-08-05T12:00:00.000Z');
    expect(parsed).not.toBeNull();
    expect(parsed!.primary).toEqual({
      usedPercent: 100,
      windowMinutes: 10080,
      resetsAt: new Date(1786459585 * 1000).toISOString(),
    });
    expect(parsed!.lunaReserve).toEqual({
      usedPercent: 18,
      resetsAt: new Date(1786459585 * 1000).toISOString(),
      regularResetsAt: new Date(1786459585 * 1000).toISOString(),
      available: true,
    });
    expect(parsed!.secondary).toBeUndefined();
    expect(parsed!.planType).toBe('plus');
    expect(parsed!.limitId).toBe('codex');
    expect(parsed!.credits).toEqual({ hasCredits: false, unlimited: false, balance: '0' });
    // Stamped with the query instant, not a rollout timestamp — that is what
    // makes a live answer read as fresh downstream.
    expect(parsed!.capturedAt).toBe('2026-08-05T12:00:00.000Z');
  });

  it('accepts the rollout spelling of the window length', () => {
    const parsed = parseLiveCodexRateLimits(
      { rateLimits: { primary: { usedPercent: 8, windowMinutes: 300 } } },
      '2026-08-05T12:00:00.000Z',
    );
    expect(parsed!.primary).toEqual({ usedPercent: 8, windowMinutes: 300, resetsAt: undefined });
  });

  it('clamps out-of-range percentages', () => {
    const parsed = parseLiveCodexRateLimits(
      { rateLimits: { primary: { usedPercent: 143, windowDurationMins: 300 } } },
      '2026-08-05T12:00:00.000Z',
    );
    expect(parsed!.primary!.usedPercent).toBe(100);
  });

  it('returns null when the result carries no usable limits', () => {
    expect(parseLiveCodexRateLimits(null, 'x')).toBeNull();
    expect(parseLiveCodexRateLimits({}, 'x')).toBeNull();
    expect(parseLiveCodexRateLimits({ rateLimits: { primary: null, secondary: null } }, 'x')).toBeNull();
  });
});

describe('parseLiveCodexRateLimits — limit id provenance', () => {
  it('takes the limit id from the map key when the value carries none', () => {
    // The picker resolves the family by key; if the parser then reads the id off
    // the value only, a keyed entry with no `limitId` yields a snapshot with
    // none — and `codexSnapshotsShareLimitFamily` short-circuits on the missing
    // id, answering "same family" for every comparison. The guard switches off
    // silently while `codexBlockHasLiveFamilyAuthority` keeps claiming it holds.
    const parsed = parseLiveCodexRateLimits(
      {
        rateLimitsByLimitId: {
          codex: {
            limitName: null,
            primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1788274890 },
          },
        },
      },
      '2026-08-27T13:10:00.000Z',
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.limitId).toBe('codex');
  });
});

describe('pickAccountWideLiveLimits', () => {
  // Shapes from the real `account/rateLimits/read` result on 2026-08-22: the
  // top-level block is the account's, and `rateLimitsByLimitId` carries every
  // family including the per-model one.
  const account = { limitId: 'codex', limitName: null, primary: { usedPercent: 13, windowDurationMins: 10080 } };
  const spark = {
    limitId: 'codex_bengalfox',
    limitName: 'GPT-5.3-Codex-Spark',
    primary: { usedPercent: 0, windowDurationMins: 300 },
  };

  it('keeps the top-level block, which is what the Codex CLI itself shows', () => {
    expect(pickAccountWideLiveLimits(account, { codex: account, codex_bengalfox: spark })?.limits).toBe(account);
  });

  it('falls back to the unnamed family when the top level is scoped to one model', () => {
    expect(pickAccountWideLiveLimits(spark, { codex_bengalfox: spark, codex: account })?.limits).toBe(account);
  });

  it('answers null when every family is model-scoped', () => {
    // "No account-wide reading" is the honest answer: the caller then keeps what
    // the rollout path found instead of adopting one model's quota as the
    // account's. Same rule as the passive reader.
    expect(pickAccountWideLiveLimits(spark, { codex_bengalfox: spark })).toBeNull();
    expect(pickAccountWideLiveLimits(null, null)).toBeNull();
  });

  it('does not let the top-level block fingerprint against its own mirror', () => {
    // The response mirrors the top-level block into the map under its own key.
    // Fingerprinting candidates against the response's own pools therefore made
    // any account id outside a hardcoded allow-list match ITSELF: rung 1 refused,
    // every lower rung required the allow-list, and the whole live read returned
    // null — no 100%-wall detection, no cached answer, the mid-turn spawn skip
    // pinned open and the relay guard permanently unarmed. Third HIGH from that
    // machinery, which is why it is gone rather than patched again.
    const account = {
      limitId: 'codex_pro',
      limitName: null,
      primary: { usedPercent: 42, windowDurationMins: 10080, resetsAt: 1788274890 },
    };
    const spark = {
      limitId: 'codex_bengalfox',
      limitName: 'GPT-5.3-Codex-Spark',
      primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1787853688 },
    };
    expect(
      pickAccountWideLiveLimits(account, { codex_pro: account, codex_bengalfox: spark })?.limits,
    ).toBe(account);
  });

  it('prefers a windowed entry even on the last-resort rung', () => {
    // Reached when the top level is absent or named-scoped. Without the same
    // preference the rung returns whatever comes first in key order, and a
    // windowless `premium` credit block was picked ahead of a real windowed
    // `codex` entry sitting in the same map — the inversion the rung above it
    // is written to prevent, re-exposed one rung down.
    const shared = { usedPercent: 24, windowDurationMins: 10080, resetsAt: 1788440488 };
    const account = { limitId: 'codex', limitName: null, primary: shared };
    const pool = { limitId: 'codex_bengalfox', limitName: 'GPT-5.3-Codex-Spark', primary: shared };
    const credit = { limitId: 'premium', limitName: null, credits: { hasCredits: false, unlimited: false, balance: '0' } };
    const byLimitId = { premium: credit, codex: account, codex_bengalfox: pool };
    expect(pickAccountWideLiveLimits(null, byLimitId)?.limits).toBe(account);
    expect(pickAccountWideLiveLimits(pool, byLimitId)?.limits).toBe(account);
  });

  it('never adopts a model-scoped entry\'s key for the account block', () => {
    // During the weekly sweep the pool's rolling anchor sits inside the
    // tolerance of the account's fixed one. An unfiltered scan then stamps
    // `codex_bengalfox` onto the correct account reading, which afterwards
    // mismatches every correct passive `codex` reading.
    const weekly = { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1788274890 };
    const topNoId = { limitName: null, primary: weekly };
    const poolSharingTheAnchor = {
      limitId: 'codex_bengalfox',
      limitName: 'GPT-5.3-Codex-Spark',
      primary: weekly,
    };
    expect(
      pickAccountWideLiveLimits(topNoId, { codex_bengalfox: poolSharingTheAnchor })?.limitId,
    ).toBeUndefined();
  });

  it('adopts a matching entry key when the top-level block names no id', () => {
    // The preferred rung emitted `limitId: undefined` whenever the app-server's
    // top level omits it, which is the state the guard cannot survive: the
    // family test short-circuits on a missing id and answers "same family" for
    // everything.
    const weekly = { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1788274890 };
    const topNoId = { limitName: null, primary: weekly };
    const account = { limitId: 'codex', limitName: null, primary: weekly };
    expect(pickAccountWideLiveLimits(topNoId, { codex: account })?.limitId).toBe('codex');
  });

  it('carries the map key out as the limit id', () => {
    // Without it a value with no `limitId` yields a snapshot with none, and
    // `codexSnapshotsShareLimitFamily` short-circuits on the missing id — the
    // guard answers "same family" for everything and switches itself off.
    const account = { limitName: null, primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1788274890 } };
    expect(pickAccountWideLiveLimits(null, { codex: account })?.limitId).toBe('codex');
  });

});

describe('pickBestCodexRateLimits', () => {
  const at = (iso: string, usedPercent: number) => ({
    primary: { usedPercent, windowMinutes: 10080 },
    capturedAt: iso,
  });

  it('prefers the newer capture', () => {
    const passive = at('2026-08-04T18:38:42.076Z', 94);
    const live = at('2026-08-05T12:18:00.000Z', 100);
    expect(pickBestCodexRateLimits(passive, live)).toBe(live);
  });

  it('keeps a passive reading that is newer than the cached live one', () => {
    const passive = at('2026-08-05T13:00:00.000Z', 3);
    const live = at('2026-08-05T12:18:00.000Z', 100);
    expect(pickBestCodexRateLimits(passive, live)).toBe(passive);
  });

  it('preserves Luna metadata when the newer passive reading wins', () => {
    const passive = {
      ...at('2026-08-05T13:00:00.000Z', 100),
      lunaReserve: undefined,
    };
    const live = {
      ...at('2026-08-05T12:18:00.000Z', 100),
      lunaReserve: { usedPercent: 10, regularResetsAt: '2026-08-06T00:00:00.000Z' },
    };
    const picked = pickBestCodexRateLimits(passive, live);
    expect(picked?.primary?.usedPercent).toBe(100);
    expect(picked?.lunaReserve?.usedPercent).toBe(10);
  });

  it('does not resurrect an old passive reserve when a fresh live answer omits it', () => {
    const passive = {
      ...at('2026-08-05T12:00:00.000Z', 100),
      lunaReserve: { usedPercent: 10 },
    };
    for (const used of [19, 100]) {
      const live = at('2026-08-05T13:00:00.000Z', used);
      expect(pickBestCodexRateLimits(passive, live)?.lunaReserve).toBeUndefined();
    }
  });

  it('does not carry cached live reserve into recovered ordinary quota', () => {
    const live = {
      ...at('2026-08-05T12:00:00.000Z', 100),
      lunaReserve: { usedPercent: 10 },
    };
    const passive = at('2026-08-05T13:00:00.000Z', 19);
    expect(pickBestCodexRateLimits(passive, live)?.lunaReserve).toBeUndefined();
  });

  it('handles either side being absent', () => {
    const live = at('2026-08-05T12:18:00.000Z', 100);
    expect(pickBestCodexRateLimits(null, live)).toBe(live);
    expect(pickBestCodexRateLimits(live, null)).toBe(live);
    expect(pickBestCodexRateLimits(null, null)).toBeNull();
  });

  it('lets a stamped snapshot beat an unstamped one', () => {
    const unstamped = { primary: { usedPercent: 94, windowMinutes: 10080 } };
    const live = at('2026-08-05T12:18:00.000Z', 100);
    expect(pickBestCodexRateLimits(unstamped, live)).toBe(live);
  });

  it('takes the live reading over a NEWER rollout minted under the old plan', () => {
    // The 2026-08-22 upgrade: a Codex session opened before the plan change kept
    // writing `plus` snapshots with the newest timestamps, so the live answer —
    // correct, current, and the only source carrying the new tier — lost every
    // comparison and was then voided as a mismatch. Recency picked the one
    // snapshot guaranteed to be discarded.
    const passive = { ...at('2026-08-21T16:40:29.100Z', 66), planType: 'plus' };
    const live = { ...at('2026-08-21T16:35:00.000Z', 0), planType: 'prolite' };
    expect(pickBestCodexRateLimits(passive, live, 'prolite')).toBe(live);
    // Without a known account tier nothing is reshuffled: recency still rules.
    expect(pickBestCodexRateLimits(passive, live, undefined)).toBe(passive);
  });

  it('still prefers a fresh passive reading once the rollout carries the new plan', () => {
    // The rescue must not become permanent: a rollout written by a session
    // started after the upgrade is the cheaper, more exact source again.
    const passive = { ...at('2026-08-22T01:43:09.000Z', 12), planType: 'prolite' };
    const live = { ...at('2026-08-22T01:35:00.000Z', 0), planType: 'prolite' };
    expect(pickBestCodexRateLimits(passive, live, 'prolite')).toBe(passive);
  });

  it('takes the live reading over a NEWER rollout describing a different limit family', () => {
    // Measured 2026-08-27. The account's weekly quota was exhausted, Codex began
    // serving turns from the per-model Spark pool, and the rollout recorded THAT
    // pool under `limit_id: "codex"` with no `limit_name` — so the name-based
    // filter admitted it and recency crowned it, every two seconds, for as long
    // as the session ran. Both snapshots carry the account's own plan, so no
    // existing axis separates them: only the weekly reset instant does
    // (1788440488 is the Spark window; 1788274890 is the account's).
    const passive = {
      ...SPARK_MISLABELLED_AS_ACCOUNT,
      capturedAt: '2026-08-27T13:09:40.628Z',
    };
    const live = { ...ACCOUNT_EXHAUSTED, capturedAt: '2026-08-27T13:05:00.000Z' };
    // `nowMs` explicitly: read against the wall clock this assertion inverts on
    // 2026-09-01, when the fixture's weekly window elapses and the picker falls
    // back to recency — the flagship gate for this change was a time bomb.
    expect(
      pickBestCodexRateLimits(passive, live, 'prolite', Date.parse('2026-08-27T13:09:41Z')),
    ).toBe(live);
  });

  it('does not let the family guard outrank the plan test', () => {
    // A plan change moves the weekly reset instant under the same `limit_id`
    // (both lines are verbatim fixtures in codex-rate-limits.test.ts), so ranked
    // above the plan test the family guard answers an upgrade by returning the
    // retired-plan live snapshot — which `normalizeCodexRateLimits` voids to a
    // windowless block, blanking every Codex gauge until a live query lands.
    const retiredPlanLive = {
      primary: {
        usedPercent: 100,
        windowMinutes: 10080,
        resetsAt: new Date(1787805401 * 1000).toISOString(),
      },
      planType: 'plus',
      limitId: 'codex',
      capturedAt: '2026-08-21T16:55:00.000Z',
    };
    const currentPlanPassive = {
      primary: {
        usedPercent: 0,
        windowMinutes: 10080,
        resetsAt: new Date(1787934975 * 1000).toISOString(),
      },
      planType: 'prolite',
      limitId: 'codex',
      capturedAt: '2026-08-21T16:43:09.009Z',
    };
    expect(codexSnapshotsShareLimitFamily(currentPlanPassive, retiredPlanLive)).toBe(false);
    // `nowMs` sits inside BOTH weekly windows on purpose. A retired plan's window
    // stays future-dated for up to seven days — that is the whole reason the plan
    // axis exists — so evaluating this at today's clock would let the elapsed-
    // window bound answer instead, and the ordering itself would go ungated:
    // hoisting the family guard above the plan test then leaves the suite green.
    const duringBothWindows = Date.parse('2026-08-21T17:00:00.000Z');
    expect(
      pickBestCodexRateLimits(currentPlanPassive, retiredPlanLive, 'prolite', duringBothWindows),
    ).toBe(currentPlanPassive);
  });

  it('stops arbitrating once the live answer is older than a few query intervals', () => {
    // Measured over 45,743 account-family weekly readings: 104 distinct anchors,
    // and in 103 of the 104 changes the OLD anchor was still 1.6-7.0 days in the
    // future when the new one appeared — a re-anchor, not an expiry. So window
    // expiry alone can never detect one, and a cached snapshot would go on
    // vetoing every fresh rollout: bounded to one query interval normally, but
    // unbounded once the query enters its 30-minute backoff or the `codex`
    // binary disappears after a single good answer.
    const reanchoredPassive = {
      limitId: 'codex',
      planType: 'prolite',
      capturedAt: '2026-08-04T16:27:32.000Z',
      primary: {
        usedPercent: 42,
        windowMinutes: 10080,
        resetsAt: new Date(1786459585 * 1000).toISOString(),
      },
    };
    const staleLive = {
      limitId: 'codex',
      planType: 'prolite',
      capturedAt: '2026-08-04T13:27:04.000Z',
      primary: {
        usedPercent: 91,
        windowMinutes: 10080,
        resetsAt: new Date(1786179739 * 1000).toISOString(),
      },
    };
    const atReanchor = Date.parse('2026-08-04T16:27:40.000Z');
    // Both anchors are days from expiry, so only the age bound can separate them.
    expect(codexSnapshotsShareLimitFamily(reanchoredPassive, staleLive)).toBe(false);
    expect(liveRejectsPassiveFamily(reanchoredPassive, staleLive, atReanchor)).toBe(false);
    expect(pickBestCodexRateLimits(reanchoredPassive, staleLive, 'prolite', atReanchor)).toBe(
      reanchoredPassive,
    );
    // A live answer inside the window still arbitrates — this bound is about
    // age, not about giving the guard up.
    const freshLive = { ...staleLive, capturedAt: '2026-08-04T16:25:00.000Z' };
    expect(pickBestCodexRateLimits(reanchoredPassive, freshLive, 'prolite', atReanchor)).toBe(
      freshLive,
    );
  });

  it('ignores a family fingerprint whose own weekly window has already elapsed', () => {
    // The account's weekly rollover reaches the rollout first, and reads as a
    // family mismatch. An expired live snapshot describes a window that no
    // longer exists, so it is not evidence about the current one — and a live
    // query that starts missing would otherwise pin it for the whole backoff.
    const elapsedLive = { ...ACCOUNT_EXHAUSTED, capturedAt: '2026-09-01T14:00:00.000Z' };
    const rolledOverPassive = {
      primary: {
        usedPercent: 3,
        windowMinutes: 10080,
        resetsAt: '2026-09-08T15:01:30.000Z',
      },
      planType: 'prolite',
      limitId: 'codex',
      capturedAt: '2026-09-01T15:30:00.000Z',
    };
    const afterReset = Date.parse('2026-09-01T15:30:00.000Z');
    expect(codexSnapshotsShareLimitFamily(rolledOverPassive, elapsedLive)).toBe(false);
    expect(pickBestCodexRateLimits(rolledOverPassive, elapsedLive, 'prolite', afterReset)).toBe(
      rolledOverPassive,
    );
    // Before that window elapses the guard still holds — this bound is about an
    // expired fingerprint, not a licence to trust the rollout again.
    const beforeReset = Date.parse('2026-08-27T13:09:40.628Z');
    const stillRunningLive = { ...ACCOUNT_EXHAUSTED, capturedAt: '2026-08-27T13:05:00.000Z' };
    expect(
      pickBestCodexRateLimits(
        { ...SPARK_MISLABELLED_AS_ACCOUNT, capturedAt: '2026-08-27T13:09:40.628Z' },
        stillRunningLive,
        'prolite',
        beforeReset,
      ),
    ).toBe(stillRunningLive);
  });

  it('lets a caller with no live reading opt out of the family guard entirely', () => {
    // The guard's authority is the live answer. Where the second argument is not
    // one — the relay path hands it the daemon's last published block, which is
    // a rollout read whenever no live query has succeeded — a cross-family
    // disagreement would otherwise be settled by which process holds the block,
    // and with the roles reversed that inverts the fix.
    const passive = { ...SPARK_MISLABELLED_AS_ACCOUNT, capturedAt: '2026-08-27T13:09:40.628Z' };
    const other = { ...ACCOUNT_EXHAUSTED, capturedAt: '2026-08-27T13:05:00.000Z' };
    const now = Date.parse('2026-08-27T13:10:00.000Z');
    expect(pickBestCodexRateLimits(passive, other, 'prolite', now)).toBe(other);
    expect(
      pickBestCodexRateLimits(passive, other, 'prolite', now, { liveOwnsFamilyAuthority: false }),
    ).toBe(passive);
  });

  it('lets a credits-only live answer win over a leftover windowed rollout', () => {
    // On a credit plan with a partial balance nothing synthesizes a window, so a
    // credits block is the ONLY current reading there is. Counting it as empty
    // discarded it on every build in favour of a stale windowed rollout, and the
    // credits tile — which renders only when both windows are absent — could
    // never appear.
    const staleWindowed = {
      limitId: 'premium',
      planType: 'prolite',
      capturedAt: '2026-08-27T12:00:00.000Z',
      primary: { usedPercent: 40, windowMinutes: 10080, resetsAt: '2026-09-01T15:01:30.000Z' },
    };
    const creditsOnlyLive = {
      limitId: 'premium',
      planType: 'prolite',
      capturedAt: '2026-08-27T13:09:00.000Z',
      credits: { hasCredits: true, unlimited: false, balance: '12.50' },
    };
    const now = Date.parse('2026-08-27T13:09:30.000Z');
    expect(pickBestCodexRateLimits(staleWindowed, creditsOnlyLive, 'prolite', now)).toBe(
      creditsOnlyLive,
    );
  });

  it('does not let a contentless block win on recency, in either direction', () => {
    // The reject path was guarded; the recency path was not. A live answer is
    // captured "now" by construction, so when the account-wide ladder falls
    // through to a windowless credit block it wins every recency comparison —
    // replacing a fully-windowed reading with one carrying no gauge at all, and
    // every slot-based Codex surface blanks.
    const windowedPassive = {
      limitId: 'premium',
      planType: 'prolite',
      capturedAt: '2026-08-27T13:00:00.000Z',
      primary: { usedPercent: 12, windowMinutes: 10080, resetsAt: '2026-09-01T15:01:30.000Z' },
    };
    // Contentless, not merely windowless: a credits block is a real reading on a
    // credit plan and must still be able to win, so the guard is about a block
    // carrying no measurement at all — a voided snapshot.
    const contentlessLive = {
      limitId: 'premium',
      planType: 'prolite',
      capturedAt: '2026-08-27T13:09:00.000Z',
    };
    const now = Date.parse('2026-08-27T13:09:30.000Z');
    // Same family, live is newer — recency alone would take it.
    expect(codexSnapshotsShareLimitFamily(windowedPassive, contentlessLive)).toBe(true);
    expect(pickBestCodexRateLimits(windowedPassive, contentlessLive, 'prolite', now)).toBe(
      windowedPassive,
    );
    // Symmetric: the relay calls this with (relayed, own), so the mirrored
    // direction had to hold too or a newer contentless relayed block would blank
    // the daemon's real one.
    expect(pickBestCodexRateLimits(contentlessLive, windowedPassive, 'prolite', now)).toBe(
      windowedPassive,
    );
  });

  it('does not let a windowless live block veto a fully-windowed passive reading', () => {
    // `codexSnapshotsShareLimitFamily` answers on the ids alone here and never
    // reaches its own weekly check, so a credit-plan block (`limit_id:
    // "premium"`, no windows — a shape `parseLiveCodexRateLimits` admits on the
    // strength of `limitId` alone) counted as a mismatch AND as evidence. It
    // then displaced a reading captured seconds ago, and since consumers test
    // for a window rather than for the block, every Codex gauge blanked.
    const windowlessLive = {
      planType: 'prolite',
      limitId: 'premium',
      capturedAt: '2026-08-27T13:00:00.000Z',
      credits: { hasCredits: false, unlimited: false, balance: '0' },
    };
    const windowedPassive = {
      ...SPARK_MISLABELLED_AS_ACCOUNT,
      capturedAt: '2026-08-27T13:09:40.628Z',
    };
    const now = Date.parse('2026-08-27T13:10:00.000Z');
    expect(codexSnapshotsShareLimitFamily(windowedPassive, windowlessLive)).toBe(false);
    expect(liveRejectsPassiveFamily(windowedPassive, windowlessLive, now)).toBe(false);
    expect(pickBestCodexRateLimits(windowedPassive, windowlessLive, 'prolite', now)).toBe(
      windowedPassive,
    );
  });

  it('keeps preferring the fresher passive reading within the account family', () => {
    // The guard is about identity, not about distrusting the rollout: a passive
    // snapshot of the SAME weekly window stays the cheaper, more exact source.
    const passive = { ...ACCOUNT_EXHAUSTED, capturedAt: '2026-08-27T13:09:40.628Z' };
    const live = { ...ACCOUNT_EXHAUSTED, capturedAt: '2026-08-27T13:05:00.000Z' };
    expect(
      pickBestCodexRateLimits(passive, live, 'prolite', Date.parse('2026-08-27T13:09:41Z')),
    ).toBe(passive);
  });
});

describe('codexSnapshotsShareLimitFamily', () => {
  it('separates the Spark pool from the account even when both claim `codex`', () => {
    expect(codexSnapshotsShareLimitFamily(SPARK_MISLABELLED_AS_ACCOUNT, ACCOUNT_EXHAUSTED)).toBe(false);
  });

  it('treats a missing side as no information rather than a mismatch', () => {
    // Absence must never manufacture a verdict: a pre-`limit_id` rollout and a
    // credit plan with no weekly window both land here, and refusing them would
    // drop real readings on the strength of a field that was never sent.
    expect(codexSnapshotsShareLimitFamily(ACCOUNT_EXHAUSTED, null)).toBe(true);
    expect(codexSnapshotsShareLimitFamily(null, ACCOUNT_EXHAUSTED)).toBe(true);
    expect(
      codexSnapshotsShareLimitFamily({ ...ACCOUNT_EXHAUSTED, limitId: undefined }, ACCOUNT_EXHAUSTED),
    ).toBe(true);
    expect(
      codexSnapshotsShareLimitFamily(
        { limitId: 'premium', credits: { hasCredits: false, unlimited: false, balance: '0' } },
        { limitId: 'premium', primary: { usedPercent: 4, windowMinutes: 10080, resetsAt: 'x' } },
      ),
    ).toBe(true);
  });

  it('tolerates the seconds of jitter Codex puts on the same weekly window', () => {
    // Measured over 32,753 weekly-bearing lines: the account family's 21 raw
    // reset values are 10 windows plus jitter — `1788274878` and `1788274890`
    // are the same window twelve seconds apart. Compared exactly, ~4% of
    // same-family pairs read as a family change, and the passive and live
    // readings are by construction taken at different instants.
    const at = (resetsAt: number) => ({
      limitId: 'codex',
      capturedAt: '2026-08-27T13:00:00.000Z',
      primary: {
        usedPercent: 100,
        windowMinutes: 10080,
        resetsAt: new Date(resetsAt * 1000).toISOString(),
      },
    });
    expect(codexSnapshotsShareLimitFamily(at(1788274878), at(1788274890))).toBe(true);
    // ...without blurring the windows apart. The closest genuinely different
    // ones in that store sit ~1.5 days apart.
    expect(codexSnapshotsShareLimitFamily(at(1788274890), at(1788440488))).toBe(false);
    expect(codexSnapshotsShareLimitFamily(at(1788137317), at(1788274890))).toBe(false);
  });

  it('ignores the 5h window, whose reset instant slides with every request', () => {
    // Observed within one minute of Spark traffic: resets_at 1787716807 →
    // 1787716837 → 1787716845. A fingerprint including it would report a new
    // family on every turn.
    const a = { ...SPARK_MISLABELLED_AS_ACCOUNT };
    const b = {
      ...SPARK_MISLABELLED_AS_ACCOUNT,
      primary: { usedPercent: 55, windowMinutes: 300, resetsAt: '2026-08-27T18:31:28.000Z' },
    };
    expect(codexSnapshotsShareLimitFamily(a, b)).toBe(true);
  });

  it('reads the weekly fingerprint off whichever slot still carries a reset', () => {
    // An elapsed weekly window has its reset stripped by `normalizeCodexWindow`,
    // so stopping at the first long slot reports "no fingerprint" while another
    // slot still holds one. The live-side twin already scanned on; these two are
    // documented as computing one fingerprint and must not disagree.
    const strippedFirstSlot = {
      limitId: 'codex',
      primary: { usedPercent: 100, windowMinutes: 10080 },
      secondary: { usedPercent: 24, windowMinutes: 10080, resetsAt: '2026-09-03T13:01:28.000Z' },
    };
    const otherFamily = {
      limitId: 'codex',
      primary: { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-09-01T15:01:30.000Z' },
    };
    expect(codexSnapshotsShareLimitFamily(strippedFirstSlot, otherFamily)).toBe(false);
  });

  it('reports a different id as a different family', () => {
    expect(
      codexSnapshotsShareLimitFamily({ limitId: 'premium' }, { limitId: 'codex' }),
    ).toBe(false);
  });
});

describe('codexLiveFamilyAuthorityExpiry', () => {
  const now = Date.parse('2026-08-27T13:10:00.000Z');
  const live = {
    ...ACCOUNT_EXHAUSTED,
    capturedAt: '2026-08-27T13:08:00.000Z',
    primary: { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-09-01T15:01:30.000Z' },
  };

  it('holds for the fresher rollout the picker keeps, not only for the live block itself', () => {
    // Written as identity with the pick, this read false on every build while
    // Codex was working — the picker keeps the fresher rollout whenever the two
    // agree on family — and the relay guard switched off exactly where the
    // daemon did hold a verified baseline.
    const publishedPassive = {
      ...ACCOUNT_EXHAUSTED,
      primary: { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-09-01T15:01:30.000Z' },
      capturedAt: '2026-08-27T13:09:58.000Z',
    };
    expect(publishedPassive).not.toBe(live);
    const expiry = codexLiveFamilyAuthorityExpiry(publishedPassive, live);
    expect(expiry).not.toBeNull();
    // Measured from the LIVE answer's capture, not from the published block's:
    // the picker keeps the fresher rollout, so a bound read off that block would
    // outlive the live evidence that granted it.
    expect(expiry).toBe(Date.parse(live.capturedAt) + 15 * 60 * 1000);
    expect(expiry! > now).toBe(true);
  });

  it('is false with no live reading, and false when the live one cannot reject', () => {
    expect(codexLiveFamilyAuthorityExpiry(live, null)).toBeNull();
    expect(codexLiveFamilyAuthorityExpiry(null, live)).toBeNull();
    // Windowless: no fingerprint anything may rest on.
    expect(
      codexLiveFamilyAuthorityExpiry(live, {
        limitId: 'premium',
        planType: 'prolite',
        capturedAt: '2026-08-27T13:08:00.000Z',
      }),
    ).toBeNull();
    // Unstamped: an anchor is a discriminator but never an immutable one, so a
    // reading with no age has no authority to lend.
    const { capturedAt: _dropped, ...unstamped } = live;
    expect(codexLiveFamilyAuthorityExpiry(live, unstamped)).toBeNull();
    // Already elapsed at its own capture instant.
    const bornExpired = {
      ...live,
      capturedAt: '2026-09-02T00:00:00.000Z',
      primary: { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-09-01T15:01:30.000Z' },
    };
    expect(codexLiveFamilyAuthorityExpiry(bornExpired, bornExpired)).toBeNull();
  });

  it('refuses a rolling window, which is a countdown rather than an anchor', () => {
    // The per-model pool reports `resets_at` one full window ahead of every
    // reading (749 distinct values in 14 days, `resets_at - timestamp` pinned at
    // ~604,790s of 604,800). It never elapses, so the elapsed-window escape can
    // never retire it — left unchecked it could veto every passive reading for
    // as long as it stayed cached.
    const capturedAt = '2026-08-27T13:00:00.000Z';
    const rolling = {
      limitId: 'codex',
      capturedAt,
      primary: {
        usedPercent: 24,
        windowMinutes: 10080,
        resetsAt: new Date(Date.parse(capturedAt) + 604790 * 1000).toISOString(),
      },
    };
    const anchored = {
      limitId: 'codex',
      capturedAt,
      primary: {
        usedPercent: 100,
        windowMinutes: 10080,
        resetsAt: new Date(Date.parse(capturedAt) + 3 * 86400 * 1000).toISOString(),
      },
    };
    const now = Date.parse('2026-08-27T13:05:00.000Z');
    expect(codexLiveFamilyAuthorityExpiry(rolling, rolling)).toBeNull();
    expect(codexLiveFamilyAuthorityExpiry(anchored, anchored)).not.toBeNull();
    // And it cannot reject through the picker either.
    const passive = {
      limitId: 'codex',
      capturedAt: '2026-08-27T13:04:59.000Z',
      primary: {
        usedPercent: 7,
        windowMinutes: 10080,
        resetsAt: new Date(Date.parse(capturedAt) + 4 * 86400 * 1000).toISOString(),
      },
    };
    expect(codexSnapshotsShareLimitFamily(passive, rolling)).toBe(false);
    expect(pickBestCodexRateLimits(passive, rolling, undefined, now)).toBe(passive);
  });

  it('is false when what was published belongs to another family', () => {
    expect(codexLiveFamilyAuthorityExpiry(SPARK_MISLABELLED_AS_ACCOUNT, live)).toBeNull();
  });
});

describe('liveCorroboratesPassiveFamily', () => {
  const anchored = (capturedAt: string, resetsAt: string, usedPercent = 100) => ({
    limitId: 'codex',
    planType: 'prolite',
    capturedAt,
    primary: { usedPercent, windowMinutes: 10080, resetsAt },
  });
  const now = Date.parse('2026-08-27T13:30:00.000Z');

  it('is NOT the complement of liveRejectsPassiveFamily, which is the point', () => {
    // Routed through the rejection test, the throttle inherited its age bound
    // and the two deadlocked: the skip suppresses queries while the rollout is
    // fresh, so under continuous use the cached answer is never refreshed; past
    // fifteen minutes it can no longer arbitrate; and a disagreement could then
    // no longer be REPORTED as one, so the skip stayed engaged, no query ever
    // fired, and the picker fell through to recency — publishing the mislabelled
    // pool reading for the rest of the run.
    // Same anchor on both sides — the earlier draft of this fixture put two
    // days between them, so the share test answered first and the age bound the
    // assertion names was never reached.
    const passive = anchored('2026-08-27T13:29:58.000Z', '2026-09-01T15:01:30.000Z', 24);
    const staleAgreeingLive = anchored('2026-08-27T13:00:00.000Z', '2026-09-01T15:01:30.000Z');
    expect(codexSnapshotsShareLimitFamily(passive, staleAgreeingLive)).toBe(true);
    // Stale: it may not reject...
    expect(liveRejectsPassiveFamily(passive, staleAgreeingLive, now)).toBe(false);
    // ...and it may not buy the skip either. Both false at once.
    expect(liveCorroboratesPassiveFamily(passive, staleAgreeingLive, now)).toBe(false);
  });

  it('lets a plan that structurally has no weekly window earn the skip', () => {
    // A credit plan reports no windows at all, so no live answer it returns can
    // ever carry a fingerprint. Demanding one made corroboration impossible
    // there: the skip disabled forever, the query succeeding every time so the
    // failure backoff never engages, and a `codex app-server` spawn every five
    // minutes for as long as Codex is in use, with no state that could end it.
    const creditPassive = {
      limitId: 'premium',
      planType: 'prolite',
      capturedAt: '2026-08-27T13:29:58.000Z',
      credits: { hasCredits: false, unlimited: false, balance: '0' },
    };
    const creditLive = {
      limitId: 'premium',
      planType: 'prolite',
      capturedAt: '2026-08-27T13:28:00.000Z',
      credits: { hasCredits: false, unlimited: false, balance: '0' },
    };
    expect(liveCorroboratesPassiveFamily(creditPassive, creditLive, now)).toBe(true);
  });

  it('does not let a content-free answer corroborate its way into the deadlock', () => {
    // The carve-out is for a credit plan, which has no weekly window to offer.
    // Extended to "no weekly window" in general it admits a block with nothing
    // at all — a shape the ladder's third rung can return and the parser accepts
    // on `limitId` alone. That answer counts as a success so the backoff never
    // engages, the family test short-circuits on the missing weekly, and the
    // skip stays engaged for as long as Codex is in use while `cachedLive`
    // freezes on a block that can never arbitrate anything.
    const passive = anchored('2026-08-27T13:29:58.000Z', '2026-09-01T15:01:30.000Z', 24);
    const contentFreeLive = { limitId: 'codex', planType: 'prolite', capturedAt: '2026-08-27T13:28:00.000Z' };
    expect(liveCorroboratesPassiveFamily(passive, contentFreeLive, now)).toBe(false);
    const fiveHourOnlyLive = {
      limitId: 'codex',
      planType: 'prolite',
      capturedAt: '2026-08-27T13:28:00.000Z',
      primary: { usedPercent: 54, windowMinutes: 300, resetsAt: '2026-08-27T18:01:28.000Z' },
    };
    expect(liveCorroboratesPassiveFamily(passive, fiveHourOnlyLive, now)).toBe(false);
  });

  it('earns the skip only with a present, current, agreeing answer', () => {
    const passive = anchored('2026-08-27T13:29:58.000Z', '2026-09-01T15:01:30.000Z', 99);
    const freshAgreeing = anchored('2026-08-27T13:28:00.000Z', '2026-09-01T15:01:30.000Z');
    expect(liveCorroboratesPassiveFamily(passive, freshAgreeing, now)).toBe(true);
    expect(liveCorroboratesPassiveFamily(passive, null, now)).toBe(false);
    const freshDisagreeing = anchored('2026-08-27T13:28:00.000Z', '2026-09-03T13:01:28.000Z');
    expect(liveCorroboratesPassiveFamily(passive, freshDisagreeing, now)).toBe(false);
  });
});

describe('codexRateLimitsWithLiveRefresh — throttle wiring', () => {
  const original = process.env.AGENTDECK_CODEX_BIN;
  beforeEach(() => {
    // A binary that cannot exist: `spawn` emits 'error' and the query resolves
    // null. The assertion is on `lastAttemptMs`, which moves synchronously
    // before any subprocess does, so nothing here depends on the child.
    process.env.AGENTDECK_CODEX_BIN = '/nonexistent/agentdeck-codex-probe';
  });
  afterEach(() => {
    if (original === undefined) delete process.env.AGENTDECK_CODEX_BIN;
    else process.env.AGENTDECK_CODEX_BIN = original;
    __resetCodexRateLimitsLiveForTest();
  });

  const reading = (ageMs: number, resetsInDays: number, usedPercent: number) => ({
    limitId: 'codex',
    planType: 'prolite',
    capturedAt: new Date(Date.now() - ageMs).toISOString(),
    primary: {
      usedPercent,
      windowMinutes: 10080,
      resetsAt: new Date(Date.now() + resetsInDays * 86400_000).toISOString(),
    },
  });

  it('spends a query when the cached live answer has aged out, mid-turn or not', () => {
    // The deadlock: under continuous Codex use the skip suppresses every query,
    // so the cached answer is never refreshed and eventually cannot arbitrate —
    // and routed through the rejection predicate, "cannot arbitrate" read as
    // "no disagreement", which re-engaged the skip. No query ever fired again.
    __resetCodexRateLimitsLiveForTest({
      cachedLive: reading(20 * 60_000, 3, 100),
      lastAttemptMs: Date.now() - 6 * 60_000,
    });
    const before = __peekCodexRateLimitsLiveForTest().lastAttemptMs;
    codexRateLimitsWithLiveRefresh(reading(2_000, 3, 99), 'prolite');
    expect(__peekCodexRateLimitsLiveForTest().lastAttemptMs).toBeGreaterThan(before);
  });

  it('keeps the mid-turn skip while the cached answer is fresh and agrees', () => {
    // The bound is about a stale answer, not about giving the skip up: a live
    // answer that is present, current and in agreement still earns it.
    __resetCodexRateLimitsLiveForTest({
      cachedLive: reading(60_000, 3, 100),
      lastAttemptMs: Date.now() - 6 * 60_000,
    });
    const before = __peekCodexRateLimitsLiveForTest().lastAttemptMs;
    codexRateLimitsWithLiveRefresh(reading(2_000, 3, 99), 'prolite');
    expect(__peekCodexRateLimitsLiveForTest().lastAttemptMs).toBe(before);
  });
});

describe('shouldQueryCodexRateLimitsLive', () => {
  const now = Date.parse('2026-08-05T12:00:00.000Z');

  it('queries when the passive snapshot has gone quiet', () => {
    expect(
      shouldQueryCodexRateLimitsLive({
        nowMs: now,
        lastAttemptMs: 0,
        consecutiveFailures: 0,
        passiveCapturedAtMs: now - 17 * 60 * 60 * 1000,
      }),
    ).toBe(true);
  });

  it('skips while Codex is mid-turn (the rollout is writing fresh readings)', () => {
    expect(
      shouldQueryCodexRateLimitsLive({
        nowMs: now,
        lastAttemptMs: now - 6 * 60 * 1000,
        consecutiveFailures: 0,
        passiveCapturedAtMs: now - 30 * 1000,
      }),
    ).toBe(false);
  });

  it('always asks once, even mid-turn, when nothing has been asked yet', () => {
    // The first query is what establishes which limit family belongs to the
    // account. Skipping it because the rollout is busy means the family guard
    // never has a baseline on precisely the machine that needs it.
    expect(
      shouldQueryCodexRateLimitsLive({
        nowMs: now,
        lastAttemptMs: 0,
        consecutiveFailures: 0,
        passiveCapturedAtMs: now - 2 * 1000,
      }),
    ).toBe(true);
  });

  it('queries a fresh passive snapshot when its plan is one the account no longer holds', () => {
    // "The rollout is writing fresh readings" is only a reason to skip if those
    // readings are usable. A snapshot stamped with a retired plan is voided
    // downstream, so honouring its freshness suppressed the one source that
    // still had a number — precisely while Codex was being used hardest.
    expect(
      shouldQueryCodexRateLimitsLive({
        nowMs: now,
        lastAttemptMs: 0,
        consecutiveFailures: 0,
        passiveCapturedAtMs: now - 30 * 1000,
        passivePlanMatchesAccount: false,
      }),
    ).toBe(true);
  });

  it('does not let a plan mismatch defeat the spawn throttles', () => {
    // A mismatch is a reason to PREFER the live read, never a licence to spawn a
    // subprocess on every usage build (they are built several times a minute).
    expect(
      shouldQueryCodexRateLimitsLive({
        nowMs: now,
        lastAttemptMs: now - 60 * 1000,
        consecutiveFailures: 0,
        passiveCapturedAtMs: now - 30 * 1000,
        passivePlanMatchesAccount: false,
      }),
    ).toBe(false);
    expect(
      shouldQueryCodexRateLimitsLive({
        nowMs: now,
        lastAttemptMs: now - 6 * 60 * 1000,
        consecutiveFailures: 3,
        passiveCapturedAtMs: now - 30 * 1000,
        passivePlanMatchesAccount: false,
      }),
    ).toBe(false);
  });

  it('queries a fresh passive snapshot that describes a different limit family', () => {
    // A rollout pouring out per-model pool readings every two seconds is the
    // state in which the account's own number is least visible and most wanted.
    // Skipping on its freshness suppresses the only source that can report it.
    //
    // `lastAttemptMs` must be past the interval but non-zero, or neither branch
    // under test is the one that answers: at 0 the baseline rule returns true on
    // its own, and inside the interval the throttle returns false on its own.
    // Written the vacuous way, deleting the flag from the skip left the suite
    // green.
    const midTurn = {
      nowMs: now,
      lastAttemptMs: now - 6 * 60 * 1000,
      consecutiveFailures: 0,
      passiveCapturedAtMs: now - 2 * 1000,
    };
    expect(shouldQueryCodexRateLimitsLive({ ...midTurn, passiveMatchesAccountFamily: false })).toBe(
      true,
    );
    expect(shouldQueryCodexRateLimitsLive({ ...midTurn, passiveMatchesAccountFamily: true })).toBe(
      false,
    );
    // ...but it is still not a licence to spawn on every usage build.
    expect(
      shouldQueryCodexRateLimitsLive({
        ...midTurn,
        lastAttemptMs: now - 60 * 1000,
        passiveMatchesAccountFamily: false,
      }),
    ).toBe(false);
  });

  it('stops treating an elapsed live fingerprint as a family mismatch', () => {
    // The throttle asks the same question as the picker and must get the same
    // answer. Compared without a bound, a cached live snapshot whose weekly
    // window has elapsed mismatches every passive read forever — lifting the
    // mid-turn skip permanently instead of while the account's number is
    // genuinely unreachable.
    const passive = {
      limitId: 'codex',
      capturedAt: '2026-08-30T23:59:00.000Z',
      primary: { usedPercent: 3, windowMinutes: 10080, resetsAt: '2026-09-08T15:01:30.000Z' },
    };
    const elapsedLive = {
      limitId: 'codex',
      capturedAt: '2026-08-30T23:58:00.000Z',
      primary: { usedPercent: 100, windowMinutes: 10080, resetsAt: '2026-09-01T15:01:30.000Z' },
    };
    const beforeReset = Date.parse('2026-08-31T00:00:00.000Z');
    const afterReset = Date.parse('2026-09-01T16:00:00.000Z');
    expect(liveRejectsPassiveFamily(passive, elapsedLive, beforeReset)).toBe(true);
    expect(liveRejectsPassiveFamily(passive, elapsedLive, afterReset)).toBe(false);
    expect(liveRejectsPassiveFamily(passive, null, beforeReset)).toBe(false);
  });

  it('honours the minimum interval between spawns', () => {
    expect(
      shouldQueryCodexRateLimitsLive({
        nowMs: now,
        lastAttemptMs: now - 60 * 1000,
        consecutiveFailures: 0,
        passiveCapturedAtMs: 0,
      }),
    ).toBe(false);
  });

  it('backs off hard after repeated misses (no Codex CLI installed)', () => {
    const input = {
      nowMs: now,
      lastAttemptMs: now - 6 * 60 * 1000,
      consecutiveFailures: 3,
      passiveCapturedAtMs: 0,
    };
    expect(shouldQueryCodexRateLimitsLive(input)).toBe(false);
    expect(shouldQueryCodexRateLimitsLive({ ...input, lastAttemptMs: now - 31 * 60 * 1000 })).toBe(true);
  });
});

describe('codexSpawnPlan', () => {
  it('runs a plain binary directly on posix', () => {
    expect(codexSpawnPlan('codex', 'darwin')).toEqual({ command: 'codex', shell: false });
    expect(codexSpawnPlan('/usr/local/bin/codex', 'linux')).toEqual({
      command: '/usr/local/bin/codex',
      shell: false,
    });
  });

  it('asks for a shell on Windows .cmd/.bat shims, which spawn refuses to run bare', () => {
    expect(codexSpawnPlan('codex.cmd', 'win32')).toEqual({ command: 'codex.cmd', shell: true });
    expect(codexSpawnPlan('CODEX.BAT', 'win32')).toEqual({ command: 'CODEX.BAT', shell: true });
  });

  it('quotes a shim path with spaces, since the shell re-parses the command line', () => {
    expect(codexSpawnPlan('C:\\Program Files\\nodejs\\codex.cmd', 'win32')).toEqual({
      command: '"C:\\Program Files\\nodejs\\codex.cmd"',
      shell: true,
    });
  });

  it('leaves a real Windows executable alone — the shell is only for the shims', () => {
    expect(codexSpawnPlan('C:\\tools\\codex.exe', 'win32')).toEqual({
      command: 'C:\\tools\\codex.exe',
      shell: false,
    });
  });

  it('never asks for a shell on posix, even for a file that happens to end in .cmd', () => {
    expect(codexSpawnPlan('/opt/codex.cmd', 'darwin')).toEqual({
      command: '/opt/codex.cmd',
      shell: false,
    });
  });
});

describe('queryCodexRateLimitsLive', () => {
  let dir: string;

  beforeEach(() => {
    __resetCodexRateLimitsLiveForTest();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Write a stand-in app-server that speaks the same stdio JSON-RPC framing. */
  const fakeServer = (body: string): string => {
    const file = path.join(dir, `server-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(file, body);
    return file;
  };

  it('reads the rate limits out of the JSON-RPC stream', async () => {
    const server = fakeServer(`
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.method === 'initialize') {
            process.stdout.write(JSON.stringify({ id: msg.id, result: { codexHome: '/tmp' } }) + '\\n');
            // An unsolicited notification lands between the two replies.
            process.stdout.write(JSON.stringify({ method: 'remoteControl/status/changed', params: {} }) + '\\n');
          } else if (msg.method === 'account/rateLimits/read') {
            process.stdout.write(JSON.stringify({ id: msg.id, result: ${JSON.stringify(liveResult)} }) + '\\n');
          }
        }
      });
      setTimeout(() => {}, 60000);
    `);
    const rl = await queryCodexRateLimitsLive({
      binary: process.execPath,
      args: [server],
      timeoutMs: 10000,
    });
    expect(rl).not.toBeNull();
    expect(rl!.primary).toEqual({
      usedPercent: 100,
      windowMinutes: 10080,
      resetsAt: new Date(1786459585 * 1000).toISOString(),
    });
    expect(Date.parse(rl!.capturedAt!)).toBeGreaterThan(0);
  });

  it('resolves null when the server never answers, without hanging', async () => {
    const server = fakeServer(`setTimeout(() => {}, 60000);`);
    const started = Date.now();
    const rl = await queryCodexRateLimitsLive({
      binary: process.execPath,
      args: [server],
      timeoutMs: 300,
    });
    expect(rl).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('resolves null when the binary does not exist', async () => {
    const rl = await queryCodexRateLimitsLive({
      binary: path.join(dir, 'definitely-not-a-binary'),
      timeoutMs: 2000,
    });
    expect(rl).toBeNull();
  });

  it('resolves null when the server exits before replying', async () => {
    const server = fakeServer(`process.exit(1);`);
    const rl = await queryCodexRateLimitsLive({
      binary: process.execPath,
      args: [server],
      timeoutMs: 5000,
    });
    expect(rl).toBeNull();
  });
});
