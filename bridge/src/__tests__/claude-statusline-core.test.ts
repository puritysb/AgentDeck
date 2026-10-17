/**
 * Claude status-line relay inside BridgeCore: a reading feeds the gauge as a
 * live subscription reading, OAuth-only fields ride along for a bounded time,
 * the OAuth poll stands down while the reading is fresh, and a broadcast goes
 * out only for a repaint-worthy change. Rules: shared/src/claude-statusline.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer } from 'http';
import { BridgeCore } from '../bridge-core.js';
import { syncRelayedClaudeUsage } from '../relayed-usage.js';
import { WsTestClient } from './helpers/ws-test-client.js';
import { createTempDataDir, type TempDataDir } from './helpers/temp-data-dir.js';
import type { UsageEvent } from '../types.js';
import type { ApiUsageData } from '../usage-api.js';
import { parseClaudeStatusline, type ClaudeStatuslineReading } from '@agentdeck/shared';

const MIN = 60_000;
const FIVE_RESET = new Date(Date.now() + 2 * 3600_000).toISOString();
const WEEK_RESET = new Date(Date.now() + 4 * 24 * 3600_000).toISOString();

function oauthUsage(overrides: Partial<ApiUsageData> = {}): ApiUsageData {
  return {
    fiveHourPercent: 20,
    fiveHourResetsAt: FIVE_RESET,
    sevenDayPercent: 35,
    sevenDayResetsAt: WEEK_RESET,
    extraUsageEnabled: true,
    extraUsageMonthlyLimit: 100,
    extraUsageUsedCredits: 12.5,
    extraUsageUtilization: 12.5,
    scopedLimits: [{ kind: 'weekly_scoped', label: 'Fable', percent: 61, active: true }] as ApiUsageData['scopedLimits'],
    inferredBillingType: 'subscription',
    ...overrides,
  };
}

function reading(overrides: Partial<ClaudeStatuslineReading> = {}): ClaudeStatuslineReading {
  return {
    fiveHour: { usedPercent: 23.5, resetsAt: FIVE_RESET },
    sevenDay: { usedPercent: 41.2, resetsAt: WEEK_RESET },
    sessionId: 'abc123',
    model: 'claude-opus-5-5',
    version: '2.1.300',
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe('BridgeCore × Claude status-line relay', () => {
  let core: BridgeCore;
  let httpServer: ReturnType<typeof createServer>;
  let port: number;
  let tempDir: TempDataDir;

  beforeEach(async () => {
    tempDir = createTempDataDir();
    httpServer = createServer();
    await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', () => resolve()); });
    const addr = httpServer.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
    core = new BridgeCore({ port, projectName: 'StatuslineTest', httpServer });
    // A session bridge gates account quota on a Claude model (the daemon hub
    // passes aggregateSubscriptionQuota instead); name one so the numbers show.
    core.stateMachine.handleParserEvent('model_info', { model: 'claude-opus-5-5' });
  });

  afterEach(async () => {
    core.wsServer.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      setTimeout(resolve, 500);
    });
    tempDir.cleanup();
  });

  it('a reading feeds the gauge as a live subscription reading', () => {
    const r = reading();
    expect(core.applyClaudeStatusline(r)).toEqual({ applied: true, broadcast: true });
    const usage = core.buildUsage() as UsageEvent;
    expect(usage.fiveHourPercent).toBeCloseTo(23.5, 1);
    expect(usage.sevenDayPercent).toBeCloseTo(41.2, 1);
    expect(usage.fiveHourResetsAt).toBe(r.fiveHour?.resetsAt);
    expect(usage.usageStale).toBe(false);
    expect(usage.subscriptions?.some((s) => s.name === 'Claude')).toBe(true);
    expect(core.claudeUsageSource).toBe('statusline');
    expect(core.lastApiFetchTime).toBe(r.receivedAt);
    expect(core.claudeUsageDiagnostics()).toMatchObject({
      source: 'statusline', statuslineAge: 'fresh', statuslineSession: 'abc123',
    });
  });

  it('the next own usage tick cannot revive a window retired by a focused snapshot', () => {
    core.updateApiUsage(oauthUsage());
    const capturedAt = core.lastApiFetchTime;
    const cache = core.cachedApiUsage!;
    expect(syncRelayedClaudeUsage(cache, {
      claudeUsageSnapshot: true, sevenDayPercent: 0, sevenDayResetsAt: WEEK_RESET,
    })).toBe(true);
    core.apiUsagePreAdjusted = true;
    const nextTick = core.buildUsage() as UsageEvent;
    expect(nextTick.fiveHourPercent).toBeUndefined();
    expect(nextTick.fiveHourResetsAt).toBeUndefined();
    expect(nextTick.sevenDayPercent).toBe(0);
    expect(nextTick.extraUsageEnabled).toBe(false);
    expect(nextTick.extraUsageMonthlyLimit).toBeUndefined();
    expect(core.lastApiFetchTime).toBe(capturedAt);
  });

  it('OAuth-only fields ride along from a recent OAuth reading and drop after 30 minutes', () => {
    core.updateApiUsage(oauthUsage());
    expect(core.claudeUsageSource).toBe('oauth');
    core.applyClaudeStatusline(reading());
    let usage = core.buildUsage() as UsageEvent;
    expect(usage.scopedLimits?.[0]?.label).toBe('Fable');
    expect(usage.extraUsageEnabled).toBe(true);
    expect(usage.fiveHourPercent).toBeCloseTo(23.5, 1);

    core.lastOAuthFetchTime = Date.now() - 31 * MIN;
    core.applyClaudeStatusline(reading({ fiveHour: { usedPercent: 30, resetsAt: null } }));
    usage = core.buildUsage() as UsageEvent;
    expect(usage.scopedLimits).toBeUndefined();
    expect(usage.extraUsageEnabled).toBe(false);
    expect(usage.fiveHourPercent).toBeCloseTo(30, 1);
  });

  it('a newer successful account read can correct statusline quota downward without forgetting replay history', () => {
    const r = reading();
    core.applyClaudeStatusline(r);
    // Failed OAuth cannot retire the still-fresh token-free statusline source.
    expect(core.applyUsageResult({ data: oauthUsage({ fiveHourPercent: 99 }), fresh: false })).toBe(false);
    expect(core.applyUsageResult(null)).toBe(false);
    expect((core.buildUsage() as UsageEvent).fiveHourPercent).toBe(r.fiveHour?.usedPercent);
    expect((core.buildUsage() as UsageEvent).usageStale).toBe(false);

    core.updateApiUsage(oauthUsage({ fiveHourPercent: 10, sevenDayPercent: 20 }));
    const usage = core.buildUsage() as UsageEvent;
    expect(usage.fiveHourPercent).toBe(10);
    expect(usage.sevenDayPercent).toBe(20);
    expect(usage.scopedLimits?.[0]?.label).toBe('Fable');
    expect(core.claudeUsageSource).toBe('oauth');
    expect(core.claudeStatuslineIsFresh()).toBe(true);
    expect(core.claudeStatuslineIsLive()).toBe(false);
    expect(core.applyClaudeStatusline({ ...r, receivedAt: Date.now() })).toEqual({ applied: false, broadcast: false });
    expect(core.cachedApiUsage?.fiveHourPercent).toBe(10);
  });

  it("a fresh OAuth reading's microsecond resets and whole percent do not lock newer status-line documents out", () => {
    // The live shape (usage cache, 2026-10-18): OAuth stamps resets with
    // microseconds, the status line with whole epoch seconds. Comparing them
    // exactly rejected every document and left the 60 s OAuth poll running.
    const fiveSec = Math.floor(Date.parse(FIVE_RESET) / 1000);
    const weekSec = Math.floor(Date.parse(WEEK_RESET) / 1000);
    const oauthIso = (sec: number) => new Date(sec * 1000).toISOString().replace(/\.000Z$/, '.323175+00:00');
    core.updateApiUsage(oauthUsage({
      fiveHourPercent: 7, fiveHourResetsAt: oauthIso(fiveSec),
      sevenDayPercent: 40, sevenDayResetsAt: oauthIso(weekSec),
    }));
    expect(core.claudeUsageSource).toBe('oauth');
    const document = (sessionId: string, weekly: number, apiMs: number) => parseClaudeStatusline({
      session_id: sessionId,
      cost: { total_duration_ms: 60_000, total_api_duration_ms: apiMs },
      rate_limits: {
        five_hour: { used_percentage: 7, resets_at: fiveSec },
        seven_day: { used_percentage: weekly, resets_at: weekSec },
      },
    }, Date.now())!;
    expect(core.applyClaudeStatusline(document('live', 39.6, 1000)).applied).toBe(true);
    expect(core.claudeUsageSource).toBe('statusline');
    expect(core.cachedApiUsage?.sevenDayPercent).toBe(39.6);
    expect(core.shouldPollClaudeOAuth()).toBe(false);
    // Between status-line readings the order stays exact.
    expect(core.applyClaudeStatusline(document('other', 39.5, 2000)).applied).toBe(false);
    expect(core.applyClaudeStatusline(document('live', 39.8, 1500)).applied).toBe(true);
  });

  it('preserves source timestamps when a fresh file/sibling cache predates the statusline', () => {
    const r = reading();
    core.applyClaudeStatusline(r);
    const fetchedAt = r.receivedAt - 90_000;
    core.applyUsageResult({ data: oauthUsage({ fiveHourPercent: 5 }), fresh: true, fetchedAt });
    expect(core.cachedApiUsage?.fiveHourPercent).toBe(r.fiveHour?.usedPercent);
    expect(core.lastApiFetchTime).toBe(r.receivedAt);
    expect(core.lastOAuthFetchTime).toBe(fetchedAt);
    expect(core.claudeUsageSource).toBe('statusline');
  });

  it('idle rerenders cannot renew age or suppress fallback after five minutes', () => {
    const r = reading({ receivedAt: Date.now() - 6 * MIN, durationMs: 100, apiDurationMs: 50 });
    core.applyClaudeStatusline(r);
    core.lastOAuthFetchTime = Date.now();
    expect(core.applyClaudeStatusline({ ...r, receivedAt: Date.now(), durationMs: 6 * MIN }))
      .toEqual({ applied: false, broadcast: false });
    expect(core.lastApiFetchTime).toBe(r.receivedAt);
    expect(core.shouldPollClaudeOAuth()).toBe(true);
  });

  it('remembers a rejected old session so it cannot return after the newer account reading ages', () => {
    const old = reading({ sessionId: 'old', fiveHour: { usedPercent: 10, resetsAt: FIVE_RESET } });
    core.applyClaudeStatusline(old);
    core.applyClaudeStatusline(reading({ sessionId: 'new', fiveHour: { usedPercent: 40, resetsAt: FIVE_RESET } }));
    expect(core.applyClaudeStatusline({ ...old, receivedAt: Date.now(), apiDurationMs: 1 }).applied).toBe(false);
    core.lastApiFetchTime = Date.now() - 6 * MIN;
    expect(core.applyClaudeStatusline({ ...old, receivedAt: Date.now(), apiDurationMs: 1 }).applied).toBe(false);
    expect(core.cachedApiUsage?.fiveHourPercent).toBe(40);
  });

  it("an idle session retiring its old 5h window cannot clear another session's newer window", () => {
    const old = reading({ sessionId: 'old', apiDurationMs: 50 });
    core.applyClaudeStatusline(old);
    const newer = reading({ sessionId: 'new', fiveHour: {
      usedPercent: 10, resetsAt: new Date(Date.parse(FIVE_RESET) + 3600_000).toISOString(),
    } });
    core.applyClaudeStatusline(newer);
    const retired = { ...old, fiveHour: null, receivedAt: Date.now() };
    expect(core.applyClaudeStatusline(retired).applied).toBe(false);
    core.lastApiFetchTime = Date.now() - 6 * MIN;
    expect(core.applyClaudeStatusline({ ...retired, receivedAt: Date.now() }).applied).toBe(false);
    expect(core.cachedApiUsage?.fiveHourResetsAt).toBe(newer.fiveHour?.resetsAt);
  });

  it('delayed documents cannot rewind session order and a resumed API counter may restart', () => {
    const r = reading({ durationMs: 1000, apiDurationMs: 500 });
    core.applyClaudeStatusline(r);
    expect(core.applyClaudeStatusline({ ...r, durationMs: 900, apiDurationMs: 400 }).applied).toBe(false);
    expect(core.applyClaudeStatusline({ ...r, receivedAt: Date.now() }).applied).toBe(false);
    expect(core.applyClaudeStatusline({ ...r, durationMs: 1200, apiDurationMs: 10, receivedAt: Date.now() }).applied).toBe(true);
  });

  it('a weekly-only snapshot removes the previous 5h window from outgoing usage', () => {
    const r = reading();
    core.applyClaudeStatusline(r);
    expect(core.applyClaudeStatusline({ ...r, fiveHour: null, receivedAt: Date.now() }).applied).toBe(true);
    const usage = core.buildUsage() as UsageEvent;
    expect(usage.claudeUsageSnapshot).toBe(true);
    expect(usage.fiveHourPercent).toBeUndefined();
    expect(usage.fiveHourResetsAt).toBeUndefined();
    expect(usage.sevenDayPercent).toBe(r.sevenDay?.usedPercent);
    expect(usage.usageStale).toBe(false);
  });

  it('broadcasts on the first reading and on a repaint-worthy change only', () => {
    const spy = vi.spyOn(core, 'broadcastUsage');
    const r = reading();
    core.applyClaudeStatusline(r);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(core.applyClaudeStatusline({ ...r, receivedAt: Date.now() })).toEqual({ applied: false, broadcast: false });
    expect(spy).toHaveBeenCalledTimes(1);
    core.applyClaudeStatusline({ ...r, fiveHour: { ...r.fiveHour!, usedPercent: 24.5 }, receivedAt: Date.now() });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('OAuth poll decision: a fresh reading suppresses, one baseline read is owed, every account gets bounded revalidation, an aged reading resumes', () => {
    expect(core.shouldPollClaudeOAuth()).toBe(true);
    core.applyClaudeStatusline(reading());
    expect(core.shouldPollClaudeOAuth()).toBe(true);
    core.updateApiUsage(oauthUsage({ scopedLimits: [] }));
    expect(core.shouldPollClaudeOAuth()).toBe(false);
    core.lastOAuthFetchTime = Date.now() - 11 * MIN;
    expect(core.shouldPollClaudeOAuth()).toBe(true);
    core.lastOAuthFetchTime = Date.now();
    core.claudeStatusline = { ...core.claudeStatusline!, receivedAt: Date.now() - 6 * MIN };
    expect(core.shouldPollClaudeOAuth()).toBe(true);
  });

  it('poll ticks skip the fetch while a reading is fresh and count the suppression', async () => {
    const client = new WsTestClient();
    await client.connect(`ws://127.0.0.1:${port}`);
    try {
      const fetchFn = vi.fn(async () => ({ data: oauthUsage({ scopedLimits: [] }), fresh: true }));
      core.applyClaudeStatusline(reading());
      core.updateApiUsage(oauthUsage({ scopedLimits: [] }));
      core.startApiUsagePolling(10, fetchFn);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(fetchFn).not.toHaveBeenCalled();
      expect(core.oauthPollsSuppressed).toBeGreaterThan(0);
      expect(core.claudeUsageDiagnostics()).toMatchObject({ oauthPollSuppressed: true });

      core.claudeStatusline = { ...core.claudeStatusline!, receivedAt: Date.now() - 6 * MIN };
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(fetchFn).toHaveBeenCalled();
      expect(core.oauthPollsAttempted).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it('every ad-hoc refresh goes through the same gate and the same counters', async () => {
    const fetchFn = vi.fn(async () => ({ data: oauthUsage({ scopedLimits: [] }), fresh: true }));
    core.refreshClaudeUsageIfAllowed(fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(core.oauthPollsAttempted).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));

    core.applyClaudeStatusline(reading());
    core.refreshClaudeUsageIfAllowed(fetchFn);
    core.refreshClaudeUsageIfAllowed(fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(core.oauthPollsSuppressed).toBe(2);
    expect(core.claudeUsageSource).toBe('statusline');
  });

  it('fetchUsageIfStale defers to the status line while it is fresh', async () => {
    const spy = vi.spyOn(core, 'fetchAndUpdateUsage').mockResolvedValue(true);
    core.applyClaudeStatusline(reading());
    core.updateApiUsage(oauthUsage({ scopedLimits: [] }));
    core.lastApiFetchTime = Date.now() - 6 * MIN;
    await core.fetchUsageIfStale();
    expect(spy).not.toHaveBeenCalled();
    core.claudeStatusline = { ...core.claudeStatusline!, receivedAt: Date.now() - 6 * MIN };
    await core.fetchUsageIfStale();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
