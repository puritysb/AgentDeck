/**
 * Z.ai GLM Coding Plan usage — a direct provider-account query, modeled on
 * `usage-api.ts` (the Claude OAuth usage client).
 *
 * The z.ai plan is a PROVIDER account, not a harness feature: one key serves
 * Claude Code (`/api/anthropic`), Codex (`/api/coding/paas/v4`) and any other
 * CLI from one shared quota, so this module never looks at harness state — it
 * asks the provider's monitor endpoint what is left (#348).
 *
 * Key custody (an AgentDeck-owned provider config — never a harness's):
 *   1. `AGENTDECK_ZAI_API_KEY` env,
 *   2. daemon settings `zaiApiKey` (`~/.agentdeck/settings.json`),
 *   3. discovery hint: `~/.claude/settings.json` `env.ANTHROPIC_AUTH_TOKEN`
 *      when that file points `ANTHROPIC_BASE_URL` at a z.ai host — the
 *      official z.ai Claude Code setup stores exactly this pair, so the common
 *      case works with no AgentDeck-side configuration at all.
 *
 * The endpoint is undocumented (same status as Codex's account endpoint):
 * read-only GET, redirects are not followed anywhere the credential could
 * leak, the key is never logged, and the cache file stores numbers + a
 * `fetchedAt` stamp plus a one-way account fingerprint. A pay-as-you-go key
 * is detected by shape and reports
 * a windowless `{ limitId: "payg" }` block — absence of windows is explicit,
 * never rendered as exhaustion.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { debug, logTagged } from './logger.js';
import { loadDaemonSettings } from './daemon-settings.js';
import {
  zaiKeyLooksPayAsYouGo,
  zaiQuotaFromLimits,
  type ZaiQuotaWindows,
} from '@agentdeck/shared';
import type { ZaiRateLimits } from './types.js';

const DEFAULT_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';
/** See `usage-api.ts` — the TTL is set together with the 60s daemon poll that
 *  reads it, and the slack keeps a poll interval dividing the TTL from
 *  doubling the effective refresh. */
const FILE_CACHE_TTL_MS = 120_000;
const FILE_CACHE_SLACK_MS = 15_000;
const FETCH_TIMEOUT_MS = 10_000;

const AGENTDECK_DIR = process.env.AGENTDECK_DATA_DIR || join(homedir(), '.agentdeck');
export const ZAI_USAGE_CACHE_FILE = join(AGENTDECK_DIR, 'zai-usage-cache.json');

export function zaiCacheExpired(fetchedAt: number, nowMs = Date.now()): boolean {
  return !Number.isFinite(fetchedAt) || fetchedAt > nowMs ||
    (nowMs - fetchedAt) >= (FILE_CACHE_TTL_MS - FILE_CACHE_SLACK_MS);
}

/** A usage reading plus whether it is a LIVE one — same contract as
 *  `UsageFetchResult`: freshness is never folded into the data or a null. */
export interface ZaiUsageFetchResult {
  /** The wire block. Null only when there is nothing at all to say — no key
   *  configured and no cache. A windowless object (`{}`, `{ planType }`,
   *  `{ limitId: "payg" }`) is a legitimate reading with no gauges. */
  data: ZaiRateLimits | null;
  /** True only when `data` came from the network (or a within-TTL cache entry
   *  a network fetch wrote). False when served as a fallback. */
  fresh: boolean;
  /** True when the configured key is pay-as-you-go — not a subscription. */
  payg?: boolean;
}

interface ZaiUsageCacheFile {
  data: ZaiRateLimits;
  fetchedAt: number; // epoch ms
  accountFingerprint: string; // one-way key + endpoint identity, never the credential
}

let lastAccountFingerprint: string | undefined;
let consecutiveFailures = 0;
let lastAttemptAt = 0;
let inFlight: Promise<ZaiUsageFetchResult> | null = null;

function backoffMs(): number {
  if (consecutiveFailures <= 0) return 0;
  const intervals = [45_000, 90_000, 180_000, 300_000];
  return intervals[Math.min(consecutiveFailures - 1, intervals.length - 1)];
}

function noteFailure(reason: string): void {
  consecutiveFailures++;
  if (consecutiveFailures === 1 || consecutiveFailures % 5 === 0) {
    logTagged(
      'usage',
      `z.ai usage fetch failed (${consecutiveFailures}x): ${reason} — serving cached values, next attempt after ${Math.round(backoffMs() / 1000)}s backoff`,
    );
  }
  debug('ZaiUsage', `Fetch failed (${consecutiveFailures}x): ${reason}`);
}

function readFileCache(accountFingerprint: string): ZaiUsageCacheFile | null {
  try {
    const cache = JSON.parse(readFileSync(ZAI_USAGE_CACHE_FILE, 'utf-8')) as ZaiUsageCacheFile;
    if (cache?.data && typeof cache.fetchedAt === 'number' && cache.accountFingerprint === accountFingerprint) return cache;
    return null;
  } catch {
    return null;
  }
}

function writeFileCache(data: ZaiRateLimits, accountFingerprint: string): void {
  try {
    mkdirSync(AGENTDECK_DIR, { recursive: true });
    const cache: ZaiUsageCacheFile = { data, fetchedAt: Date.now(), accountFingerprint };
    writeFileSync(ZAI_USAGE_CACHE_FILE, JSON.stringify(cache), 'utf-8');
  } catch (err) {
    debug('ZaiUsage', `Failed to write cache file: ${err}`);
  }
}

// ===== Key resolution =====

export interface ZaiApiKeySource {
  key: string;
  source: 'env' | 'daemon-settings' | 'claude-settings-hint';
}

function readClaudeSettingsHint(): string | null {
  try {
    const path = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');
    const env = (JSON.parse(readFileSync(path, 'utf-8')) as { env?: Record<string, string> }).env;
    if (!env) return null;
    const base = env.ANTHROPIC_BASE_URL?.trim().toLowerCase() ?? '';
    // Only when that file demonstrably points Claude Code at z.ai — a token
    // bound to another base is some other account's credential.
    const isZaiBase = base === 'https://api.z.ai/api/anthropic' ||
      (() => { try { return new URL(base).hostname.endsWith('.z.ai'); } catch { return false; } })();
    if (!isZaiBase) return null;
    const token = env.ANTHROPIC_AUTH_TOKEN?.trim();
    return token || null;
  } catch {
    return null;
  }
}

/** The provider key, with its source for diagnostics. Never logged. */
export function resolveZaiApiKey(): ZaiApiKeySource | null {
  const envKey = process.env.AGENTDECK_ZAI_API_KEY?.trim();
  if (envKey) return { key: envKey, source: 'env' };
  const settingsKey = typeof loadDaemonSettings().zaiApiKey === 'string'
    ? (loadDaemonSettings().zaiApiKey as string).trim()
    : '';
  if (settingsKey) return { key: settingsKey, source: 'daemon-settings' };
  const hint = readClaudeSettingsHint();
  if (hint) return { key: hint, source: 'claude-settings-hint' };
  return null;
}

export function zaiUsageConfigured(): boolean {
  return resolveZaiApiKey() !== null;
}

function quotaUrl(): string {
  const base = typeof loadDaemonSettings().zaiApiBase === 'string'
    ? (loadDaemonSettings().zaiApiBase as string).trim().replace(/\/+$/, '')
    : '';
  return base ? `${base}/api/monitor/usage/quota/limit` : DEFAULT_QUOTA_URL;
}

// ===== Fetch =====

export async function fetchZaiQuota(): Promise<ZaiUsageFetchResult> {
  if (inFlight) return inFlight;
  inFlight = fetchZaiQuotaOnce().finally(() => { inFlight = null; });
  return inFlight;
}

async function fetchZaiQuotaOnce(): Promise<ZaiUsageFetchResult> {
  const source = resolveZaiApiKey();
  const url = quotaUrl();
  const fingerprint = source
    ? createHash('sha256').update(JSON.stringify([url, source.key])).digest('hex')
    : '';
  if (lastAccountFingerprint !== fingerprint) {
    consecutiveFailures = 0;
    lastAttemptAt = 0;
    lastAccountFingerprint = fingerprint;
  }
  // A missing/replaced key must retire the old account even within the TTL.
  if (!source) return { data: null, fresh: false };
  if (zaiKeyLooksPayAsYouGo(source.key)) {
    return { data: { limitId: 'payg' }, fresh: true, payg: true };
  }
  const fileCache = readFileCache(fingerprint);
  const stale = (): ZaiUsageFetchResult => ({
    data: resolveZaiApiKey()?.key === source.key && quotaUrl() === url
      ? (readFileCache(fingerprint) ?? fileCache)?.data ?? {} : {}, fresh: false,
  });
  if (fileCache && !zaiCacheExpired(fileCache.fetchedAt)) {
    return { data: fileCache.data, fresh: true };
  }

  const backoff = backoffMs();
  if (lastAttemptAt && Date.now() - lastAttemptAt < backoff) return stale();
  lastAttemptAt = Date.now();

  try {
    // Raw token, no Bearer prefix — matches the provider's own clients; the
    // prefixed form is also accepted, this is simply the canonical spelling.
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: source.key, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status === 401 || res.status === 403) {
      noteFailure(`auth error ${res.status} — check the z.ai coding-plan key (${source.source})`);
      return stale();
    }
    if (!res.ok) {
      noteFailure(`HTTP ${res.status}`);
      return stale();
    }

    const body = await res.json() as Record<string, any>;
    // The envelope answers 200 with `{code:500, msg:"404 NOT_FOUND"}` for a
    // moved path — an HTTP-200 failure is still a failure.
    if (body?.code !== 200 || body?.success !== true || !body?.data) {
      noteFailure('API error envelope');
      return stale();
    }

    // The user may replace the key while the request is in flight.
    if (resolveZaiApiKey()?.key !== source.key || quotaUrl() !== url) {
      return { data: {}, fresh: false };
    }
    const windows: ZaiQuotaWindows = zaiQuotaFromLimits(body.data.limits, body.data.level);
    const data: ZaiRateLimits = {
      ...windows,
      capturedAt: new Date().toISOString(),
    };
    if (consecutiveFailures > 0) {
      logTagged('usage', `z.ai usage fetch recovered after ${consecutiveFailures} failure(s)`);
    }
    consecutiveFailures = 0;
    writeFileCache(data, fingerprint);
    debug('ZaiUsage', `5h: ${windows.primary?.usedPercent}% (family ${windows.limitId ?? '?'}, plan ${windows.planType ?? '?'})`);
    return { data, fresh: true };
  } catch (err) {
    noteFailure('network request failed');
    return stale();
  }
}
