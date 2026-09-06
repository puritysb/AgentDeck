import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { debug, logTagged } from './logger.js';
import type { ScopedUsageLimit } from './types.js';
import { claudeUsageRecovery } from './claude-usage-recovery.js';

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const AGENTDECK_DIR = join(homedir(), '.agentdeck');
const USAGE_CACHE_FILE = join(AGENTDECK_DIR, 'usage-cache.json');

/** Shared file cache TTL — multiple bridge sessions share one cache file */
const FILE_CACHE_TTL_MS = 120_000; // 120s — reduced from 60s to avoid 429 from multiple pollers

/**
 * Slack subtracted from the TTL when testing expiry.
 *
 * `fetchedAt` is stamped AFTER the HTTP round trip completes, so a poller whose
 * interval divides the TTL always arrives a few hundred ms EARLY at the tick
 * that should have expired the cache: it reads a hit and then waits a whole
 * extra interval. With the daemon's 60s poll and a 120s TTL that turned the
 * intended 120s refresh into a hard 180s floor — measured 2026-08-19, three
 * consecutive network fetches at 08:25:43 / 08:28:43 / 08:31:43, exact to the
 * second, never once landing on 120s.
 *
 * The slack must exceed fetch latency plus timer drift, and stay well under the
 * poll interval so the cross-session dedupe the TTL exists for is preserved
 * (effective TTL 105s — still comfortably above the 60s this started at).
 */
const FILE_CACHE_SLACK_MS = 15_000;

/** True when the on-disk cache is old enough that a poller should go to the network.
 *  Exported for the slack regression test — the bug it prevents is invisible in
 *  any single call and only shows up as a cadence, so pin the predicate. */
export function fileCacheExpired(fetchedAt: number, nowMs = Date.now()): boolean {
  return !Number.isFinite(fetchedAt) || fetchedAt > nowMs || (nowMs - fetchedAt) >= (FILE_CACHE_TTL_MS - FILE_CACHE_SLACK_MS);
}

/** Token expiry safety margin — skip fetch if token expires within this window */
const TOKEN_EXPIRY_MARGIN_MS = 30_000; // enough for the bounded HTTP request

export interface ApiUsageData {
  fiveHourPercent: number | null;
  fiveHourResetsAt: string | null;
  sevenDayPercent: number | null;
  sevenDayResetsAt: string | null;
  extraUsageEnabled: boolean;
  extraUsageMonthlyLimit: number | null;
  extraUsageUsedCredits: number | null;
  extraUsageUtilization: number | null;
  /** Per-model scoped limits parsed from the API `limits[]` array (e.g. a weekly
   *  cap for "Fable"). Sorted worst-first (active desc, then percent desc). Empty
   *  when the response carries no scoped model limits. */
  scopedLimits: ScopedUsageLimit[];
  /** Inferred from API response: subscription if rate-limit fields present, api if 401/no fields */
  inferredBillingType: 'subscription' | 'api' | null;
}

/**
 * A usage reading plus whether it is a LIVE one.
 *
 * Freshness must not be folded into the data or into a null return. Every
 * failure branch below can still produce numbers — the last good ones off the
 * shared cache file — and a caller that cannot tell those apart from a live
 * reading will stamp them as fresh: that is exactly what happened before this
 * type existed. `fetchUsageFromApi` returned `fileCache?.data ?? null` on 429 /
 * 401 / !ok / API-error / network-throw, so `BridgeCore.updateApiUsage()` ran on
 * the truthy value, pushed `lastApiFetchTime` forward and cleared
 * `apiUsageStale`. The `usageStale` wire flag was therefore unreachable for the
 * commonest failure mode, `USAGE_STALE_TTL` never tripped, and a 7-minute freeze
 * on 2026-08-19 shipped a stale 0% to every surface marked `usageStale: false`.
 *
 * `null` now means only "no numbers at all" (no cache file and no live fetch).
 */
export interface UsageFetchResult {
  data: ApiUsageData;
  /** True only when `data` came from the network, or from a cache entry a
   *  network fetch wrote within the TTL. False when it is a fallback served
   *  because the fetch could not be made or failed. */
  fresh: boolean;
}

export type TokenStatus = 'valid' | 'expired' | 'missing' | 'unknown';

interface UsageCacheFile {
  data: ApiUsageData;
  fetchedAt: number; // epoch ms
  retryAfter?: number; // server throttle deadline, NEVER a successful-fetch timestamp
}

// ===== Error tracking =====

let lastFetchFailed = false;
let consecutiveFailures = 0;
let lastTokenStatus: TokenStatus = 'unknown';
let lastAttemptAt = 0;
let retryDeadline = 0;
let lastCredential: string | null = null;
let rejectedCredential: string | null = null;
let recoveryEnabled = false;
let inFlight: Promise<UsageFetchResult | null> | null = null;

/** Called only by the bound Node daemon, never by managed session bridges. */
export function enableClaudeUsageRecovery(): void { recoveryEnabled = true; }

export function didLastFetchFail(): boolean {
  return lastFetchFailed;
}

export function getTokenStatus(): TokenStatus {
  return lastTokenStatus;
}

/** Reset error tracking on system wake — fresh start without pre-sleep backoff */
export function resetConsecutiveFailures(): void {
  consecutiveFailures = 0;
  lastAttemptAt = 0;
  lastFetchFailed = false;
}

/**
 * Record a failed fetch and make it visible in the daemon's own log.
 *
 * `debug()` was the only breadcrumb here, and the daemon runs without DEBUG —
 * so a run of failed fetches left NO record anywhere. The 2026-08-19 freeze had
 * to be reconstructed from cache-file mtimes, and the reason for it is still
 * unknown because nothing wrote it down. Log the first failure and every fifth
 * after it: a persistent outage stays visible without flooding a file that a
 * 60s poller writes to.
 */
function noteFailure(reason: string): void {
  lastFetchFailed = true;
  consecutiveFailures++;
  if (consecutiveFailures === 1 || consecutiveFailures % 5 === 0) {
    logTagged(
      'usage',
      `Claude usage fetch failed (${consecutiveFailures}x): ${reason} — serving cached values as stale, next attempt after ${Math.round(getBackoffMs() / 1000)}s backoff`,
    );
  }
  debug('UsageAPI', `Fetch failed (${consecutiveFailures}x): ${reason}`);
}

/** Clear failure state after a live fetch, announcing recovery if one was needed. */
function noteSuccess(): void {
  if (consecutiveFailures > 0) {
    logTagged('usage', `Claude usage fetch recovered after ${consecutiveFailures} failure(s)`);
  }
  lastFetchFailed = false;
  consecutiveFailures = 0;
  lastTokenStatus = 'valid';
  rejectedCredential = null;
}

/** Backoff interval based on consecutive failures: 0→0, 1→45s, 2→90s, 3→180s, 4+→300s */
export function getBackoffMs(): number {
  if (consecutiveFailures <= 0) return 0;
  const intervals = [45_000, 90_000, 180_000, 300_000];
  return intervals[Math.min(consecutiveFailures - 1, intervals.length - 1)];
}

// ===== Credentials =====

interface OAuthCredentials {
  accessToken: string;
  expiresAt?: number; // epoch ms
}

/** Injected sources for credential resolution — keeps the platform branch pure/testable
 *  (no `process.platform` mutation) and defers all I/O so the macOS `security` subprocess
 *  is NEVER spawned on non-darwin. Mirrors the `judgeBackendSupported(judge, platform)`
 *  idiom in apme/settings.ts. */
export interface CredSources {
  platform: NodeJS.Platform;
  /** CLAUDE_CONFIG_DIR ?? ~/.claude — resolved per call so a post-start relocation is honored. */
  configDir: string;
  env: NodeJS.ProcessEnv;
  /** Returns the creds-file text, or null on ENOENT / read error (never throws). */
  readCredsFile: (path: string) => string | null;
  /** LAZY macOS keychain read — invoked ONLY inside the darwin branch, so Windows/Linux
   *  never spawn `security` (no error, no flashed console window). */
  runSecurityCli: () => string | null;
}

/** Parse the shared `{ claudeAiOauth: { accessToken, expiresAt } }` JSON that BOTH the
 *  macOS Keychain blob and the on-disk `.credentials.json` file carry. Never throws. */
function parseOauthPayload(raw: string | null): OAuthCredentials | null {
  if (!raw) return null;
  try {
    const creds = JSON.parse(raw);
    const oauth = creds?.claudeAiOauth;
    if (!oauth?.accessToken || typeof oauth.accessToken !== 'string') return null;
    return {
      accessToken: oauth.accessToken,
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : undefined,
    };
  } catch {
    // A non-null blob that fails to parse is worth a breadcrumb (matches the old macOS
    // single-try behavior that logged on parse-throw). Never logs the raw content.
    debug('UsageAPI', 'Failed to parse OAuth credentials payload');
    return null;
  }
}

/** Pure, platform-aware credential resolver.
 *  - macOS: read the Keychain via the injected `security` thunk (unchanged behavior).
 *  - Windows/Linux: use `CLAUDE_CODE_OAUTH_TOKEN` if set, else read the plaintext
 *    `<configDir>/.credentials.json` that Claude Code writes on those platforms.
 *  No subprocess is spawned off-darwin. */
export function resolveOAuthCredentials(sources: CredSources): OAuthCredentials | null {
  if (sources.platform === 'darwin') {
    return parseOauthPayload(sources.runSecurityCli());
  }
  // Non-macOS: env token takes precedence (mirrors Claude Code's own auth precedence —
  // CLAUDE_CODE_OAUTH_TOKEN outranks the /login file). No expiry info for env tokens; the
  // existing fetch path treats undefined expiry as "attempt fetch" and 401-self-throttles.
  const envToken = sources.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (envToken) {
    return { accessToken: envToken, expiresAt: undefined };
  }
  return parseOauthPayload(sources.readCredsFile(join(sources.configDir, '.credentials.json')));
}

/** Read the macOS Keychain OAuth blob via the `security` CLI. macOS-only caller. */
function runSecurityCli(): string | null {
  try {
    return execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
  } catch {
    debug('UsageAPI', 'Failed to read OAuth token from Keychain');
    return null;
  }
}

/** Read a credentials file's text, or null on any error (missing/permission/torn write). */
function readCredsFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/** Assemble the real credential sources from `process`/`fs`/`execSync`, per call.
 *  `configDir` resolves CLAUDE_CONFIG_DIR at read time (NOT a module-level constant like
 *  AGENTDECK_DIR), and `runSecurityCli`/`readCredsFile` are passed as thunks — never
 *  invoked here — so the `security` subprocess only ever runs inside the darwin branch of
 *  `resolveOAuthCredentials` (Windows/Linux spawn no child process, open no console window).
 *  Exported so a test can lock this wiring without mutating `process.platform`. */
export function buildCredSources(): CredSources {
  return {
    platform: process.platform,
    configDir: process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    env: process.env,
    readCredsFile,
    runSecurityCli,
  };
}

function getOAuthCredentials(): OAuthCredentials | null {
  return resolveOAuthCredentials(buildCredSources());
}

function getOAuthToken(): string | null {
  return getOAuthCredentials()?.accessToken ?? null;
}

export function hasOAuthToken(): boolean {
  return getOAuthToken() !== null;
}

// ===== File cache =====

function readFileCache(): UsageCacheFile | null {
  try {
    const raw = readFileSync(USAGE_CACHE_FILE, 'utf-8');
    const cache = JSON.parse(raw) as UsageCacheFile;
    if (cache?.data && typeof cache.fetchedAt === 'number') {
      // Harden the unsound JSON cast: a cache written by a pre-scopedLimits
      // bridge has no `scopedLimits`, but the type (and downstream) expect an
      // array. Normalize so `data.scopedLimits` is never undefined.
      if (!Array.isArray(cache.data.scopedLimits)) cache.data.scopedLimits = [];
      return cache;
    }
    return null;
  } catch {
    return null;
  }
}

function writeFileCache(data: ApiUsageData): void {
  try {
    mkdirSync(AGENTDECK_DIR, { recursive: true });
    const cache: UsageCacheFile = { data, fetchedAt: Date.now() };
    writeFileSync(USAGE_CACHE_FILE, JSON.stringify(cache), 'utf-8');
  } catch (err) {
    debug('UsageAPI', `Failed to write cache file: ${err}`);
  }
}

// ===== Response parsing helpers =====

/** Extract utilization from a rate-limit object, handling multiple possible shapes:
 *  - { utilization: number } — original format
 *  - { percentage: number } or { percent: number } — possible rename
 *  - number directly (if five_hour is the utilization itself)
 */
function parseUtilization(limitObj: unknown): number | null {
  if (limitObj == null) return null;
  if (typeof limitObj === 'number') return limitObj;
  if (typeof limitObj === 'object') {
    const obj = limitObj as Record<string, unknown>;
    if (typeof obj.utilization === 'number') return obj.utilization;
    if (typeof obj.percentage === 'number') return obj.percentage;
    if (typeof obj.percent === 'number') return obj.percent;
    if (typeof obj.usage === 'number') return obj.usage;
  }
  return null;
}

/** Extract resets_at from a rate-limit object, handling multiple possible shapes */
function parseResetsAt(limitObj: unknown): string | null {
  if (limitObj == null) return null;
  if (typeof limitObj === 'object') {
    const obj = limitObj as Record<string, unknown>;
    if (typeof obj.resets_at === 'string') return obj.resets_at;
    if (typeof obj.resetsAt === 'string') return obj.resetsAt;
    if (typeof obj.reset_at === 'string') return obj.reset_at;
    if (typeof obj.expires_at === 'string') return obj.expires_at;
  }
  return null;
}

/** Parse the API `limits[]` array into per-model scoped limits. Keeps only the
 *  entries carrying a model scope (the per-model weekly caps) — the account-wide
 *  `session`/`weekly_all` kinds are already surfaced via five_hour/seven_day, so
 *  re-emitting them here would double-count. Sorted worst-first so the encoder's
 *  default "triple" view can headline `scopedLimits[0]` as the binding limit. */
export function parseScopedLimits(limits: unknown): ScopedUsageLimit[] {
  if (!Array.isArray(limits)) return [];
  const out: ScopedUsageLimit[] = [];
  for (const raw of limits) {
    if (raw == null || typeof raw !== 'object') continue;
    const l = raw as Record<string, unknown>;
    const scope = l.scope as Record<string, unknown> | null | undefined;
    const model = scope?.model as Record<string, unknown> | null | undefined;
    // Only per-model scoped caps — the ones not already carried by 5h/7d.
    if (!model) continue;
    const percent = typeof l.percent === 'number' ? l.percent : null;
    if (percent == null) continue;
    const displayName = typeof model.display_name === 'string' ? model.display_name : null;
    out.push({
      kind: typeof l.kind === 'string' ? l.kind : undefined,
      label: displayName ?? (typeof l.kind === 'string' ? l.kind : 'limit'),
      percent,
      severity: typeof l.severity === 'string' ? l.severity : undefined,
      resetsAt: typeof l.resets_at === 'string' ? l.resets_at : undefined,
      active: l.is_active === true,
    });
  }
  // Worst-first: active limits ahead of inactive, then by descending percent —
  // a three-way comparator (never subtraction) so NaN/equal ties stay stable.
  out.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.percent > b.percent) return -1;
    if (a.percent < b.percent) return 1;
    return 0;
  });
  return out;
}

// ===== Main fetch =====

export async function fetchUsageFromApi(): Promise<UsageFetchResult | null> {
  if (inFlight) return inFlight;
  inFlight = fetchUsageOnce().finally(() => { inFlight = null; });
  return inFlight;
}

async function fetchUsageOnce(): Promise<UsageFetchResult | null> {
  // A cached reading served because the live path could not run or failed. Never
  // `fresh` — see UsageFetchResult.
  const stale = (fc: UsageCacheFile | null): UsageFetchResult | null =>
    (fc ? { data: fc.data, fresh: false } : null);

  // 1. Check file cache first — shared across all bridge sessions
  const fileCache = readFileCache();
  if (fileCache && !fileCache.retryAfter && !fileCacheExpired(fileCache.fetchedAt)) {
    debug('UsageAPI', `File cache hit (age ${Math.round((Date.now() - fileCache.fetchedAt) / 1000)}s)`);
    // A within-TTL entry was written by a real network fetch (only the success
    // path writes it), so this IS a fresh reading — just a shared one.
    noteSuccess();
    return { data: fileCache.data, fresh: true };
  }

  // 2. Read OAuth credentials
  let creds = getOAuthCredentials();
  if (!creds) {
    if (lastTokenStatus !== 'missing') logTagged('usage', 'Claude usage authorization unavailable — waiting for credentials');
    lastTokenStatus = 'missing';
    lastFetchFailed = true;
    return stale(fileCache); // last known values, explicitly not fresh
  }

  // Re-read after Claude's own refresh. Exit code / a successful model response
  // cannot certify the credential we will use for the usage request.
  const credentialBeforeRecovery = creds.accessToken;
  if (creds.expiresAt && (creds.expiresAt - Date.now() < TOKEN_EXPIRY_MARGIN_MS
    || creds.accessToken === rejectedCredential)) {
    if (lastTokenStatus !== 'expired') logTagged('usage', 'Claude usage authorization expired — usage paused until renewal');
    lastTokenStatus = 'expired';
    lastFetchFailed = true;
    if (recoveryEnabled && process.env.AGENTDECK_CLAUDE_USAGE_RECOVERY !== '0') {
      await claudeUsageRecovery.recover(creds.accessToken);
      creds = getOAuthCredentials();
    }
    if (!creds) { lastTokenStatus = 'missing'; return stale(fileCache); }
    if (!creds.expiresAt || creds.expiresAt - Date.now() < TOKEN_EXPIRY_MARGIN_MS) return stale(fileCache);
    // A 401 may be transient. An unexpired, unchanged token still gets a
    // backed-off API retry, including when CLI recovery is disabled/unavailable.
    if (creds.accessToken !== credentialBeforeRecovery) {
      logTagged('usage', 'Claude usage credentials renewed — retrying usage fetch');
    }
  }

  // A newly rotated credential must not inherit the old token's auth backoff.
  if (lastCredential !== creds.accessToken) {
    lastCredential = creds.accessToken;
    rejectedCredential = null;
    consecutiveFailures = 0;
    lastAttemptAt = 0;
    lastTokenStatus = 'unknown';
  }
  if (Date.now() < Math.max(retryDeadline, fileCache?.retryAfter ?? 0)) {
    lastFetchFailed = true;
    return stale(fileCache);
  }
  const backoff = getBackoffMs();
  if (lastAttemptAt && Date.now() - lastAttemptAt < backoff) return stale(fileCache);
  lastAttemptAt = Date.now();

  // 5. Actual API fetch
  try {
    const headers = {
      'Authorization': `Bearer ${creds.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Accept': 'application/json',
    };

    const res = await fetch(USAGE_API_URL, {
      method: 'GET', headers,
      signal: AbortSignal.timeout(10000),
    });

    // A later response is authoritative: do not keep an earlier 401 latched
    // through 403, rate limits or a successful response with the same token.
    rejectedCredential = res.status === 401 ? creds.accessToken : null;

    // 429 — respect Retry-After header, backoff on next poll
    if (res.status === 429) {
      noteFailure('rate limited (429)');
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        const retrySec = Number.isFinite(seconds) ? seconds
          : (Date.parse(retryAfter) - Date.now()) / 1000;
        if (Number.isFinite(retrySec) && retrySec > 0) {
          retryDeadline = Date.now() + retrySec * 1000;
          // Retry-After is scheduling metadata, never freshness. The old code
          // moved fetchedAt into the future and made stale quota look live.
          if (fileCache) {
            try {
              writeFileSync(USAGE_CACHE_FILE, JSON.stringify({ ...fileCache,
                retryAfter: retryDeadline }), 'utf-8');
            } catch { /* ignore */ }
          }
          debug('UsageAPI', `Rate limited (429), Retry-After: ${retrySec}s, consecutive failures: ${consecutiveFailures}`);
        } else {
          debug('UsageAPI', `Rate limited (429), consecutive failures: ${consecutiveFailures}, backoff: ${getBackoffMs() / 1000}s`);
        }
      } else {
        debug('UsageAPI', `Rate limited (429), consecutive failures: ${consecutiveFailures}, backoff: ${getBackoffMs() / 1000}s`);
      }
      return stale(fileCache);
    }

    // 401/403 — token issue
    if (res.status === 401 || res.status === 403) {
      lastTokenStatus = res.status === 401 ? 'expired' : 'unknown';
      noteFailure(`auth error ${res.status} — authorization unavailable`);
      return stale(fileCache);
    }

    if (!res.ok) {
      noteFailure(`API returned ${res.status} ${res.statusText}`);
      return stale(fileCache);
    }

    const data = await res.json() as Record<string, any>;

    // DEBUG: dump raw response to diagnose field structure changes
    debug('UsageAPI', `Raw response keys: ${JSON.stringify(Object.keys(data))}`);
    if (data.five_hour) {
      debug('UsageAPI', `five_hour type=${typeof data.five_hour} keys=${JSON.stringify(
        typeof data.five_hour === 'object' ? Object.keys(data.five_hour) : data.five_hour
      )}`);
    }
    // Write raw response to file for inspection
    try {
      writeFileSync(join(AGENTDECK_DIR, 'usage-raw-debug.json'), JSON.stringify(data, null, 2), 'utf-8');
    } catch { /* ignore */ }

    if (data.error) {
      noteFailure(`API error: ${data.error.type}`);
      return stale(fileCache);
    }

    const extraUsage = data.extra_usage;
    const hasRateLimitData = data.five_hour != null || data.seven_day != null;
    const result: ApiUsageData = {
      fiveHourPercent: parseUtilization(data.five_hour),
      fiveHourResetsAt: parseResetsAt(data.five_hour),
      sevenDayPercent: parseUtilization(data.seven_day),
      sevenDayResetsAt: parseResetsAt(data.seven_day),
      extraUsageEnabled: !!(extraUsage?.is_enabled ?? extraUsage?.enabled),
      extraUsageMonthlyLimit: extraUsage?.monthly_limit ?? null,
      extraUsageUsedCredits: extraUsage?.used_credits ?? null,
      extraUsageUtilization: parseUtilization(extraUsage),
      scopedLimits: parseScopedLimits(data.limits),
      inferredBillingType: hasRateLimitData ? 'subscription' : 'api',
    };

    debug('UsageAPI', `5h: ${result.fiveHourPercent}%, 7d: ${result.sevenDayPercent}%, extra: ${result.extraUsageEnabled ? 'enabled' : 'disabled'}`);

    // Success — reset counters, write cache
    noteSuccess();
    writeFileCache(result);

    return { data: result, fresh: true };
  } catch (err) {
    noteFailure(String(err).slice(0, 160));
    return stale(fileCache);
  }
}

// formatResetTime is now in @agentdeck/shared/format-utils
export { formatResetTime } from '@agentdeck/shared';
