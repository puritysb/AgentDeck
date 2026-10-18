/**
 * Claude Code status-line relay — the sanctioned subscription-quota source.
 *
 * Claude Code hands every configured status-line command a JSON document whose
 * `rate_limits` block carries the claude.ai Pro/Max `five_hour` / `seven_day`
 * windows (`used_percentage` 0–100, `resets_at` epoch seconds). It is the one
 * documented place a third party may read those percentages: the
 * `/api/oauth/usage` endpoint both daemons also use is undocumented and needs
 * the Keychain OAuth token, which the sandboxed Swift daemon cannot reach at
 * all. AgentDeck's installed status line therefore POSTs the document to the
 * local daemon (`CLAUDE_STATUSLINE_ROUTE`), and this module is the rule for
 * what either daemon does with it.
 *
 * Decided 2026-10-16 ("keep today's experience, give each daemon the safe
 * maximum"): OAuth polling is not removed. It is suppressed while a status-line
 * reading is fresh and resumes when sessions go quiet, and the per-model scoped
 * caps and account authorization keep refreshing on a slower clock. The Swift
 * daemon, which never had an OAuth path, gains its first token-free Claude
 * gauge from the same reading.
 *
 * Facts the thresholds rest on (Claude Code status-line docs, read 2026-10-16):
 * `rate_limits` is present only for Pro/Max subscribers and only after a
 * session's first API response; each window may be independently absent, and
 * Claude Code drops a window once its `resets_at` passes; the script is
 * debounced at 300 ms and a running script is cancelled by the next update.
 * Timer/mode changes also rerender cached quota. Receipt time advances only for
 * a changed response, with bounded per-session replay memory and cross-session
 * ordering checks; against an OAuth-family reading those checks run at the
 * precision both carriers share. Accepted windows are a replacement snapshot: a
 * missing window retires its old value; a document with neither window changes
 * nothing.
 *
 * `pnpm generate-claude-statusline-rules` emits the Swift mirror
 * (`ClaudeStatuslineRules.generated.swift`); the byte gate is
 * `claude-statusline-sync.test.ts`, and behaviour is pinned by
 * `shared/claude-statusline-vectors.json`, replayed by
 * `claude-statusline.test.ts` and `ClaudeStatuslineRulesTests.swift`.
 */

/** Local HTTP route the installed status line POSTs to, on both daemons. */
export const CLAUDE_STATUSLINE_ROUTE = '/claude/statusline';

/**
 * A reading younger than this is "fresh": it is the live source and the OAuth
 * poll stays quiet. Older readings keep rendering (the usual 10-minute display
 * bound applies to them like any other reading) but no longer hold OAuth back.
 */
export const CLAUDE_STATUSLINE_FRESH_MS = 5 * 60_000;

/**
 * Per-model scoped caps and extra-usage fields exist only in the OAuth
 * response. While the status line is the live source they ride along from the
 * last OAuth reading for this long, then drop — an absent cap is "unknown",
 * never a frozen percent dressed as current.
 */
export const CLAUDE_OAUTH_CARRY_OVER_MS = 30 * 60_000;

/**
 * OAuth refreshes at least this often while the status line is fresh, even
 * without scoped caps: cached session renders must not indefinitely suppress
 * account authorization, reset, or plan observations.
 */
export const CLAUDE_OAUTH_SCOPED_REFRESH_MS = 10 * 60_000;

/**
 * Percent moves smaller than this do not broadcast on their own: the status
 * line fires on every message boundary, and every broadcast repaints every
 * surface (serial boards included). The 5 s usage tick carries small moves.
 */
export const CLAUDE_STATUSLINE_CHANGE_EPSILON = 0.05;

/** A `resets_at` above this is already epoch milliseconds, not seconds. */
export const CLAUDE_STATUSLINE_MS_THRESHOLD = 1e11;

/**
 * The two carriers stamp one window at different precisions: the status line's
 * `resets_at` is whole epoch seconds, OAuth's is microseconds, and OAuth's
 * fraction lands on either side of that second (`20:50:00.323175+00:00`, then
 * `20:49:59.609113+00:00` for the same window in this desk's usage cache,
 * 2026-10-18). Compared against an OAuth-family reading, resets this close are
 * one window in either direction.
 */
export const CLAUDE_STATUSLINE_CROSS_SOURCE_RESET_TOLERANCE_MS = 1000;

/**
 * OAuth's 5h/7d utilization has arrived as whole percent in every reading on
 * this desk, while the status line carries the response header's finer value.
 * Compared against an OAuth-family reading of the same window, a status-line
 * percent up to this many points lower is the same observation rounded
 * differently, not an older one.
 */
export const CLAUDE_STATUSLINE_CROSS_SOURCE_PERCENT_TOLERANCE = 1;
/** Bounded per-session replay memory; idle sessions cannot repeatedly win by receipt time. */
export const CLAUDE_STATUSLINE_SESSION_LIMIT = 128;

/** Session counters may cross a focus relay without replacing account quota. */
export const RELAYED_SESSION_USAGE_FIELDS = [
  'sessionDurationSec', 'inputTokens', 'outputTokens', 'toolCalls',
  'estimatedCostUsd', 'sessionPercent', 'costSpent', 'costLimit',
  'resetTime', 'resetDate',
] as const;

export interface ClaudeStatuslineWindow {
  /** 0–100; the status line never reports above 100 for these windows, and a
   *  larger value is clamped rather than refused. */
  usedPercent: number;
  /** ISO-8601 UTC with milliseconds, or null when the window carries no reset. */
  resetsAt: string | null;
}

export interface ClaudeStatuslineReading {
  fiveHour: ClaudeStatuslineWindow | null;
  sevenDay: ClaudeStatuslineWindow | null;
  sessionId: string | null;
  /** `model.id` of the session that produced the reading (`claude-opus-5-5`). */
  model: string | null;
  /** Claude Code version string. */
  version: string | null;
  /** Daemon receipt time, epoch ms. */
  receivedAt: number;
  /** Session elapsed time accumulates across resumes; ordering only, never freshness. */
  durationMs?: number | null;
  apiDurationMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

/** Where the Claude 5h/7d numbers a daemon is showing came from. */
export type ClaudeUsageSource = 'oauth' | 'statusline' | 'relay';

export type ClaudeStatuslineAge = 'fresh' | 'aged' | 'unknown';

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseWindow(raw: unknown): ClaudeStatuslineWindow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const pct = o.used_percentage;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0) return null;
  let resetsAt: string | null = null;
  const r = o.resets_at;
  if (typeof r === 'number' && Number.isFinite(r) && r > 0) {
    const ms = r > CLAUDE_STATUSLINE_MS_THRESHOLD ? r : r * 1000;
    // Finite input can still exceed Date's range. Never throw from the HTTP route.
    if (ms <= 8.64e15) resetsAt = new Date(Math.round(ms)).toISOString();
  }
  return { usedPercent: Math.min(100, pct), resetsAt };
}

/**
 * Read the two subscription windows out of a status-line document. Null when
 * the document carries neither — an API-key session, a gateway spend limit, a
 * session before its first API response — so the caller changes nothing.
 */
export function parseClaudeStatusline(payload: unknown, receivedAt: number): ClaudeStatuslineReading | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const p = payload as Record<string, unknown>;
  const rl = p.rate_limits;
  if (!rl || typeof rl !== 'object' || Array.isArray(rl)) return null;
  const r = rl as Record<string, unknown>;
  const fiveHour = parseWindow(r.five_hour);
  const sevenDay = parseWindow(r.seven_day);
  if (!fiveHour && !sevenDay) return null;
  const model = p.model && typeof p.model === 'object' && !Array.isArray(p.model)
    ? (p.model as Record<string, unknown>).id
    : undefined;
  const cost = p.cost as Record<string, unknown> | undefined;
  const context = p.context_window as Record<string, unknown> | undefined;
  const counter = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  return {
    fiveHour,
    sevenDay,
    sessionId: nonEmptyString(p.session_id),
    model: nonEmptyString(model),
    version: nonEmptyString(p.version),
    receivedAt,
    durationMs: counter(cost?.total_duration_ms),
    apiDurationMs: counter(cost?.total_api_duration_ms),
    inputTokens: counter(context?.total_input_tokens),
    outputTokens: counter(context?.total_output_tokens),
  };
}

/**
 * How old a status-line reading is, in the three-answer form every probe here
 * uses: a missing or zero stamp is `unknown`, never fresh and never aged. A
 * stamp slightly in the future is a same-machine clock disagreement and reads
 * as fresh, as the usage relay already treats it.
 */
export function classifyClaudeStatuslineAge(
  receivedAt: number | null | undefined,
  now: number,
): ClaudeStatuslineAge {
  if (receivedAt == null || !Number.isFinite(receivedAt) || receivedAt <= 0) return 'unknown';
  return now - receivedAt <= CLAUDE_STATUSLINE_FRESH_MS ? 'fresh' : 'aged';
}

export interface ClaudeOAuthPollInput {
  /** Receipt time of the newest status-line reading, or null when none arrived. */
  statuslineReceivedAt: number | null;
  /** Time of the last LIVE OAuth-family reading (direct or sibling relay). */
  lastOAuthFetchAt: number | null;
  /** Whether that reading carried per-model scoped caps. */
  oauthHasScopedLimits: boolean;
  now: number;
}

/**
 * Should the OAuth poll run on this tick? Always when no fresh status-line
 * reading exists. While one does: one baseline account read, then the slow
 * account refresh regardless of whether the previous account had scoped caps.
 */
export function shouldPollClaudeOAuth(input: ClaudeOAuthPollInput): boolean {
  if (classifyClaudeStatuslineAge(input.statuslineReceivedAt, input.now) !== 'fresh') return true;
  const last = input.lastOAuthFetchAt;
  if (last == null || !Number.isFinite(last) || last <= 0) return true;
  // The payload has no capture timestamp/account identity. Even active renders
  // cannot suppress authoritative quota/auth validation indefinitely.
  return input.now - last >= CLAUDE_OAUTH_SCOPED_REFRESH_MS;
}

/** Session elapsed time accumulates across resumes (unlike API/context counters).
 * It orders documents but cannot make an idle timer render a new observation. */
export function claudeStatuslineProgressRegressed(
  previous: ClaudeStatuslineReading | null | undefined, next: ClaudeStatuslineReading,
): boolean {
  return previous?.durationMs != null && next.durationMs != null
    && next.durationMs < previous.durationMs;
}

/** Keep a live token-free reading through OAuth failure, and never rewind a
 * newer observation with an older successful cache, regardless of its source. */
export function preserveClaudeUsageOnOAuth(
  currentFetchedAt: number, nextFetchedAt: number, fresh: boolean, statuslineLive: boolean,
): boolean {
  return (!fresh && statuslineLive) || (fresh && nextFetchedAt < currentFetchedAt);
}

/** A render is not an API observation. Remember each session's response progress
 * even when another session currently owns the display. Exact window comparison
 * is intentional here; repaint epsilon is not a freshness threshold. A lower
 * reading for the same reset, or an older reset, cannot replace a fresh reading.
 * An aged high-water mark stops blocking legitimate account changes; a successful
 * OAuth read replaces it immediately.
 *
 * `currentSource` names where `current`'s windows came from. Between status-line
 * readings the order is exact. Against an OAuth-family reading (`oauth`,
 * `relay`, or an unknown source) it is read at the precision both carriers
 * share. OAuth keeps a fractional reset second that lands on either side of the
 * status line's whole second. Above it, every status-line reset reads as an
 * older window: on 2026-10-18 that kept the 60 s OAuth poll running for 70
 * minutes with sessions active on this desk's Node daemon. Below it, a stale
 * lower percent reads as a newer window. */
export function shouldAcceptClaudeStatusline(
  previousForSession: ClaudeStatuslineReading | null | undefined,
  current: ClaudeStatuslineReading | null | undefined,
  next: ClaudeStatuslineReading,
  currentSource: ClaudeUsageSource | null = null,
): boolean {
  if (claudeStatuslineProgressRegressed(previousForSession, next)) return false;
  const equalWindow = (a: ClaudeStatuslineWindow | null, b: ClaudeStatuslineWindow | null) =>
    a?.usedPercent === b?.usedPercent && a?.resetsAt === b?.resetsAt;
  if (previousForSession
    && equalWindow(previousForSession.fiveHour, next.fiveHour)
    && equalWindow(previousForSession.sevenDay, next.sevenDay)
    && (previousForSession.apiDurationMs ?? null) === (next.apiDurationMs ?? null)
    && (previousForSession.inputTokens ?? null) === (next.inputTokens ?? null)
    && (previousForSession.outputTokens ?? null) === (next.outputTokens ?? null)) return false;
  if (current && classifyClaudeStatuslineAge(current.receivedAt, next.receivedAt) === 'fresh') {
    const crossSource = currentSource !== 'statusline';
    const resetSlack = crossSource ? CLAUDE_STATUSLINE_CROSS_SOURCE_RESET_TOLERANCE_MS : 0;
    const percentSlack = crossSource ? CLAUDE_STATUSLINE_CROSS_SOURCE_PERCENT_TOLERANCE : 0;
    // An unparseable reset is NaN, which compares false both ways: no claim.
    const sameWindow = (x: string | null | undefined, y: string) =>
      Math.abs(Date.parse(x ?? '') - Date.parse(y)) <= resetSlack;
    for (const key of ['fiveHour', 'sevenDay'] as const) {
      const a = current[key], b = next[key];
      // An idle session dropping its expired window cannot retire a newer
      // session's still-live window. Same-window retirement remains valid.
      if (a && !b && a.resetsAt && Date.parse(a.resetsAt) > next.receivedAt
        && !sameWindow(previousForSession?.[key]?.resetsAt, a.resetsAt)) return false;
      if (!a?.resetsAt || !b?.resetsAt) continue;
      const delta = Date.parse(b.resetsAt) - Date.parse(a.resetsAt);
      if (delta < -resetSlack) return false;
      if (Math.abs(delta) <= resetSlack && b.usedPercent < a.usedPercent - percentSlack) return false;
    }
  }
  return true;
}

/** May the last OAuth reading's scoped caps and extra-usage fields still ride along? */
export function claudeOAuthCarryOverFresh(lastOAuthFetchAt: number | null | undefined, now: number): boolean {
  if (lastOAuthFetchAt == null || !Number.isFinite(lastOAuthFetchAt) || lastOAuthFetchAt <= 0) return false;
  return now - lastOAuthFetchAt <= CLAUDE_OAUTH_CARRY_OVER_MS;
}

function windowChanged(a: ClaudeStatuslineWindow | null, b: ClaudeStatuslineWindow | null): boolean {
  if (!a || !b) return (a == null) !== (b == null);
  if (a.resetsAt !== b.resetsAt) return true;
  return Math.abs(a.usedPercent - b.usedPercent) >= CLAUDE_STATUSLINE_CHANGE_EPSILON;
}

/** Does `next` say anything a surface would repaint for, compared with `prev`? */
export function claudeStatuslineChanged(
  prev: ClaudeStatuslineReading | null | undefined,
  next: ClaudeStatuslineReading,
): boolean {
  if (!prev) return true;
  return windowChanged(prev.fiveHour, next.fiveHour) || windowChanged(prev.sevenDay, next.sevenDay);
}
