/**
 * The z.ai provider-account usage client (#348).
 *
 * Covers the three contracts this client owns beyond the SSOT's window mapping
 * (pinned by shared/zai-quota-vectors.json): the provider-key ladder, the
 * cache-TTL/slack pair, and the failure envelope — plus the one security rule:
 * the key is never logged.
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The live Max-plan capture from 2026-09-19, trimmed to what the parser reads. */
const MAX_PLAN_BODY = {
  code: 200,
  msg: 'Operation successful',
  success: true,
  data: {
    limits: [
      { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, currentValue: 4000, remaining: 0, percentage: 100, nextResetTime: 1790588888997 },
      { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1, nextResetTime: 1789845000174 },
    ],
    level: 'max',
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('zaiCacheExpired (TTL/slack pair)', () => {
  const NOW = 1_750_000_000_000;
  it('expires at TTL minus slack, so a 60s poll dividing the 120s TTL cannot double it', async () => {
    const { zaiCacheExpired } = await import('../zai-usage.js');
    expect(zaiCacheExpired(NOW - 104_900, NOW)).toBe(false); // 104.9s — a hair early
    expect(zaiCacheExpired(NOW - 105_000, NOW)).toBe(true); // exactly TTL − slack
    expect(zaiCacheExpired(0, NOW)).toBe(true); // never fetched
    expect(zaiCacheExpired(NOW + 1, NOW)).toBe(true); // clock skew / future stamp
  });
});

describe('fetchZaiQuota', () => {
  let dataDir: string;
  let claudeDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agentdeck-zai-'));
    claudeDir = mkdtempSync(join(tmpdir(), 'agentdeck-claude-'));
    process.env.AGENTDECK_DATA_DIR = dataDir;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    delete process.env.AGENTDECK_ZAI_API_KEY;
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENTDECK_DATA_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.AGENTDECK_ZAI_API_KEY;
  });

  async function loadModule() {
    return import('../zai-usage.js');
  }

  it('answers null data with no key configured anywhere', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { fetchZaiQuota } = await loadModule();
    const result = await fetchZaiQuota();
    expect(result).toEqual({ data: null, fresh: false });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('maps the Max-plan standard schema onto wire windows and caches the reading', async () => {
    process.env.AGENTDECK_ZAI_API_KEY = 'test-plan-key';
    const fetchMock = vi.fn(async () => jsonResponse(MAX_PLAN_BODY));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchZaiQuota } = await loadModule();

    const first = await fetchZaiQuota();
    expect(first.fresh).toBe(true);
    expect(first.data?.planType).toBe('max');
    expect(first.data?.limitId).toBe('standard');
    expect(first.data?.primary).toEqual({ usedPercent: 1, windowMinutes: 300, resetsAt: '2026-09-19T19:10:00.174Z', quantity: 'tokens' });
    expect(first.data?.secondary).toEqual({ usedPercent: 100, windowMinutes: 43200, resetsAt: '2026-09-28T09:48:08.997Z', quantity: 'mcp' });
    expect(first.data?.capturedAt).toBeTruthy();

    // Within the TTL the shared file cache answers without the network.
    await vi.resetModules();
    const again = await (await loadModule()).fetchZaiQuota();
    expect(again.fresh).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();

    // The cache stores numbers + a stamp only — never the key.
    const cached = JSON.parse(readFileSync(join(dataDir, 'zai-usage-cache.json'), 'utf-8'));
    expect(JSON.stringify(cached)).not.toContain('test-plan-key');
  });

  it('treats an HTTP-200 error envelope as a failure and serves the cache as not-fresh', async () => {
    process.env.AGENTDECK_ZAI_API_KEY = 'test-plan-key';
    // Prime the cache with a live reading first.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(MAX_PLAN_BODY)));
    const primed = await (await loadModule()).fetchZaiQuota();
    expect(primed.fresh).toBe(true);

    // Age the cache past TTL−slack so the next poll must go to the network.
    const cachePath = join(dataDir, 'zai-usage-cache.json');
    const aged = JSON.parse(readFileSync(cachePath, 'utf-8'));
    aged.fetchedAt = Date.now() - 10 * 60_000;
    writeFileSync(cachePath, JSON.stringify(aged), 'utf-8');

    // New module instance reading the aged cache; endpoint moved (the shape the
    // live probe returned for /api/coding/usage).
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 500, msg: '404 NOT_FOUND', success: false })));
    const result = await (await loadModule()).fetchZaiQuota();
    expect(result.fresh).toBe(false);
    expect(result.data?.primary?.usedPercent).toBe(1); // last known, explicitly not fresh
  });

  it('reports a pay-as-you-go key as an explicit windowless block, never as gauges', async () => {
    process.env.AGENTDECK_ZAI_API_KEY = 'sk-pay-as-you-go';
    const fetchMock = vi.fn(async () => jsonResponse(MAX_PLAN_BODY));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchZaiQuota } = await loadModule();
    const result = await fetchZaiQuota();
    expect(result).toEqual({ data: { limitId: 'payg' }, fresh: true, payg: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not reuse another account cache or backoff when the key changes', async () => {
    process.env.AGENTDECK_ZAI_API_KEY = 'account-a';
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(MAX_PLAN_BODY))
      .mockResolvedValueOnce(jsonResponse({}, 401)).mockResolvedValueOnce(jsonResponse(MAX_PLAN_BODY));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchZaiQuota } = await loadModule();
    await fetchZaiQuota();
    process.env.AGENTDECK_ZAI_API_KEY = 'account-b';
    expect(await fetchZaiQuota()).toEqual({ data: {}, fresh: false });
    process.env.AGENTDECK_ZAI_API_KEY = 'account-c';
    expect((await fetchZaiQuota()).fresh).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    delete process.env.AGENTDECK_ZAI_API_KEY;
    expect(await fetchZaiQuota()).toEqual({ data: null, fresh: false });
  });

  it('retires cached plan windows immediately for a pay-as-you-go replacement', async () => {
    process.env.AGENTDECK_ZAI_API_KEY = 'account-a';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(MAX_PLAN_BODY)));
    const { fetchZaiQuota } = await loadModule();
    await fetchZaiQuota();
    process.env.AGENTDECK_ZAI_API_KEY = 'sk-pay-replacement';
    expect((await fetchZaiQuota()).data).toEqual({ limitId: 'payg' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('discards a response whose credential was replaced in flight', async () => {
    process.env.AGENTDECK_ZAI_API_KEY = 'account-a';
    vi.stubGlobal('fetch', vi.fn(async () => {
      process.env.AGENTDECK_ZAI_API_KEY = 'account-b';
      return jsonResponse(MAX_PLAN_BODY);
    }));
    expect(await (await loadModule()).fetchZaiQuota()).toEqual({ data: {}, fresh: false });
  });

  it('discovers the key from the Claude Code settings hint only when the base URL is z.ai', async () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'hint-token',
      },
    }), 'utf-8');
    const fetchMock = vi.fn(async () => jsonResponse(MAX_PLAN_BODY));
    vi.stubGlobal('fetch', fetchMock);
    const { fetchZaiQuota, resolveZaiApiKey } = await loadModule();
    expect(resolveZaiApiKey()?.source).toBe('claude-settings-hint');
    const result = await fetchZaiQuota();
    expect(result.fresh).toBe(true);
    const headers = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers.get('Authorization')).toBe('hint-token');
  });

  it('ignores the hint when Claude Code points elsewhere', async () => {
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_AUTH_TOKEN: 'other-account' },
    }), 'utf-8');
    vi.stubGlobal('fetch', vi.fn());
    const { resolveZaiApiKey } = await loadModule();
    expect(resolveZaiApiKey()).toBeNull();
  });

  it('never writes the key into a log line', async () => {
    process.env.AGENTDECK_ZAI_API_KEY = 'secret-key-material';
    const logTagged = vi.fn();
    vi.doMock('../logger.js', () => ({ logTagged, debug: vi.fn() }));
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ code: 500, msg: 'secret-key-material', success: false })));
    const { fetchZaiQuota } = await import('../zai-usage.js');
    await fetchZaiQuota();
    expect(logTagged).toHaveBeenCalled();
    expect(JSON.stringify(logTagged.mock.calls)).not.toContain('secret-key-material');
    vi.doUnmock('../logger.js');
  });
});

describe('buildUsageEvent z.ai block', () => {
  it('normalizes windows (ended window → stale, reset cleared) and keeps plan axes', async () => {
    const { buildUsageEvent } = await import('../usage-event.js');
    const event = buildUsageEvent(
      { sessionDurationSec: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 } as any,
      null, undefined, null, null, false, null, undefined, null, null, undefined, undefined, null,
      {
        planType: 'max',
        limitId: 'standard',
        capturedAt: new Date().toISOString(),
        primary: { usedPercent: 40, windowMinutes: 300, resetsAt: '2001-01-01T00:00:00Z' },
        secondary: { usedPercent: 10, windowMinutes: 43200, resetsAt: '2099-01-01T00:00:00Z' },
      },
    );
    expect(event.zaiRateLimits?.primary).toEqual({ usedPercent: 40, windowMinutes: 300, stale: true });
    expect(event.zaiRateLimits?.secondary?.stale).toBeUndefined();
    // An ENDED window is routine life for a rolling plan (the window rolls on),
    // not a lapsed subscription — the row stays; only the display retirement
    // (a windowless block) removes it.
    expect(event.subscriptions).toContainEqual({ name: 'GLM Coding Plan · Max' });
  });

  it('adds the GLM Coding Plan row with the tier when windows are live', async () => {
    const { buildUsageEvent } = await import('../usage-event.js');
    const event = buildUsageEvent(
      { sessionDurationSec: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 } as any,
      null, undefined, null, null, false, null, undefined, null, null, undefined, undefined, null,
      {
        planType: 'max',
        capturedAt: new Date().toISOString(),
        primary: { usedPercent: 40, windowMinutes: 300 },
      },
    );
    expect(event.subscriptions).toEqual([{ name: 'GLM Coding Plan · Max' }]);
  });

  it('omits the block entirely when the provider is not configured', async () => {
    const { buildUsageEvent } = await import('../usage-event.js');
    const event = buildUsageEvent(
      { sessionDurationSec: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 } as any,
    );
    // The key may sit at `undefined` in-memory (same as codexRateLimits); the
    // WIRE is what matters — retain-on-absent clients must see no key at all.
    expect(JSON.parse(JSON.stringify(event)).zaiRateLimits).toBeUndefined();
  });
});
