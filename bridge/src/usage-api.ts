import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { debug } from './logger.js';

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const AGENTDECK_DIR = join(homedir(), '.agentdeck');
const USAGE_CACHE_FILE = join(AGENTDECK_DIR, 'usage-cache.json');

/** Shared file cache TTL — multiple bridge sessions share one cache file */
const FILE_CACHE_TTL_MS = 120_000; // 120s — reduced from 60s to avoid 429 from multiple pollers

/** Token expiry safety margin — skip fetch if token expires within this window */
const TOKEN_EXPIRY_MARGIN_MS = 10 * 60 * 1000; // 10 minutes

export interface ApiUsageData {
  fiveHourPercent: number | null;
  fiveHourResetsAt: string | null;
  sevenDayPercent: number | null;
  sevenDayResetsAt: string | null;
  extraUsageEnabled: boolean;
  extraUsageMonthlyLimit: number | null;
  extraUsageUsedCredits: number | null;
  extraUsageUtilization: number | null;
  /** Inferred from API response: subscription if rate-limit fields present, api if 401/no fields */
  inferredBillingType: 'subscription' | 'api' | null;
}

export type TokenStatus = 'valid' | 'expired' | 'missing' | 'unknown';

interface UsageCacheFile {
  data: ApiUsageData;
  fetchedAt: number; // epoch ms
}

// ===== Error tracking =====

let lastFetchFailed = false;
let consecutiveFailures = 0;
let lastTokenStatus: TokenStatus = 'unknown';

export function didLastFetchFail(): boolean {
  return lastFetchFailed;
}

export function getTokenStatus(): TokenStatus {
  return lastTokenStatus;
}

/** Reset error tracking on system wake — fresh start without pre-sleep backoff */
export function resetConsecutiveFailures(): void {
  consecutiveFailures = 0;
  lastFetchFailed = false;
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
    if (cache?.data && typeof cache.fetchedAt === 'number') return cache;
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

// ===== Main fetch =====

export async function fetchUsageFromApi(): Promise<ApiUsageData | null> {
  // 1. Check file cache first — shared across all bridge sessions
  const fileCache = readFileCache();
  if (fileCache && (Date.now() - fileCache.fetchedAt) < FILE_CACHE_TTL_MS) {
    debug('UsageAPI', `File cache hit (age ${Math.round((Date.now() - fileCache.fetchedAt) / 1000)}s)`);
    lastFetchFailed = false;
    consecutiveFailures = 0;
    lastTokenStatus = 'valid';
    return fileCache.data;
  }

  // 2. Read OAuth credentials
  const creds = getOAuthCredentials();
  if (!creds) {
    debug('UsageAPI', 'No OAuth token available');
    lastTokenStatus = 'missing';
    return fileCache?.data ?? null; // return stale cache if available
  }

  // 3. Token expiry check
  if (creds.expiresAt) {
    const timeUntilExpiry = creds.expiresAt - Date.now();
    if (timeUntilExpiry <= 0) {
      debug('UsageAPI', 'OAuth token expired — waiting for Claude Code to refresh');
      lastTokenStatus = 'expired';
      lastFetchFailed = true;
      return fileCache?.data ?? null;
    }
    if (timeUntilExpiry < TOKEN_EXPIRY_MARGIN_MS) {
      debug('UsageAPI', `OAuth token expires in ${Math.round(timeUntilExpiry / 60000)}m — skipping fetch`);
      lastTokenStatus = 'expired';
      return fileCache?.data ?? null;
    }
  }

  // 4. Exponential backoff — skip if too soon after consecutive failures
  const backoff = getBackoffMs();
  if (backoff > 0 && fileCache && (Date.now() - fileCache.fetchedAt) < backoff) {
    debug('UsageAPI', `Backoff active (${consecutiveFailures} failures, next in ${Math.round((backoff - (Date.now() - fileCache.fetchedAt)) / 1000)}s)`);
    return fileCache.data; // return stale cache
  }

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

    // 429 — respect Retry-After header, backoff on next poll
    if (res.status === 429) {
      consecutiveFailures++;
      lastFetchFailed = true;
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) {
        const retrySec = parseInt(retryAfter, 10);
        if (!isNaN(retrySec) && retrySec > 0) {
          // Write a synthetic cache entry so backoff uses Retry-After timing
          const staleCacheData = fileCache?.data ?? null;
          if (staleCacheData) {
            // Push fetchedAt forward so cache TTL covers Retry-After period
            const syntheticCache: UsageCacheFile = {
              data: staleCacheData,
              fetchedAt: Date.now() + (retrySec * 1000) - FILE_CACHE_TTL_MS,
            };
            try {
              writeFileSync(USAGE_CACHE_FILE, JSON.stringify(syntheticCache), 'utf-8');
            } catch { /* ignore */ }
          }
          debug('UsageAPI', `Rate limited (429), Retry-After: ${retrySec}s, consecutive failures: ${consecutiveFailures}`);
        } else {
          debug('UsageAPI', `Rate limited (429), consecutive failures: ${consecutiveFailures}, backoff: ${getBackoffMs() / 1000}s`);
        }
      } else {
        debug('UsageAPI', `Rate limited (429), consecutive failures: ${consecutiveFailures}, backoff: ${getBackoffMs() / 1000}s`);
      }
      return fileCache?.data ?? null;
    }

    // 401/403 — token issue
    if (res.status === 401 || res.status === 403) {
      debug('UsageAPI', `Auth error ${res.status} — token may be invalid or expired`);
      lastTokenStatus = 'expired';
      lastFetchFailed = true;
      consecutiveFailures++;
      return fileCache?.data ?? null;
    }

    if (!res.ok) {
      debug('UsageAPI', `API returned ${res.status}: ${res.statusText}`);
      lastFetchFailed = true;
      consecutiveFailures++;
      return fileCache?.data ?? null;
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
      debug('UsageAPI', `API error: ${data.error.type}`);
      lastFetchFailed = true;
      consecutiveFailures++;
      return fileCache?.data ?? null;
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
      inferredBillingType: hasRateLimitData ? 'subscription' : 'api',
    };

    debug('UsageAPI', `5h: ${result.fiveHourPercent}%, 7d: ${result.sevenDayPercent}%, extra: ${result.extraUsageEnabled ? 'enabled' : 'disabled'}`);

    // Success — reset counters, write cache
    lastFetchFailed = false;
    consecutiveFailures = 0;
    lastTokenStatus = 'valid';
    writeFileCache(result);

    return result;
  } catch (err) {
    debug('UsageAPI', `Fetch failed: ${err}`);
    lastFetchFailed = true;
    consecutiveFailures++;
    return fileCache?.data ?? null;
  }
}

// formatResetTime is now in @agentdeck/shared/format-utils
export { formatResetTime } from '@agentdeck/shared';
