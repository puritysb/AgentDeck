/**
 * Shared format utilities — canonical implementations for time, count, bytes.
 * Used by bridge, plugin, and ported to Android/Apple (manual sync).
 */

/** Format ISO timestamp to relative time like "2h 30m" or "1d 5h" */
export function formatResetTime(isoString: string | undefined): string | undefined {
  if (!isoString) return undefined;
  // Already pre-formatted (no 'T' in ISO dates means it's a relative string)
  if (!isoString.includes('T')) return isoString;

  try {
    const resetMs = new Date(isoString).getTime();
    if (isNaN(resetMs)) return undefined;
    const diffMs = resetMs - Date.now();

    if (diffMs <= 0) return 'now';

    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 60) return `${diffMin}m`;

    const h = Math.floor(diffMin / 60);
    const m = diffMin % 60;
    if (h < 24) return m > 0 ? `${h}h ${m}m` : `${h}h`;

    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
  } catch {
    return undefined;
  }
}

/** Compact format without spaces — "2d5h", "4h23m". For pixel-constrained displays. */
export function formatResetTimeCompact(isoString: string): string {
  const ms = new Date(isoString).getTime() - Date.now();
  if (ms <= 0) return '0m';
  const totalMins = Math.max(1, Math.ceil(ms / 60000));
  const hours = Math.floor(totalMins / 60);
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  const mins = totalMins % 60;
  if (days > 0 && remHours > 0) return `${days}d${remHours}h`;
  if (days > 0) return `${days}d`;
  if (hours > 0 && mins > 0) return `${hours}h${mins}m`;
  if (hours > 0) return `${hours}h`;
  return `${mins}m`;
}

/** Format count: 1234 → "1.2K", 1500000 → "1.5M" */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/** Format byte size: 1073741824 → "1.0G", 1048576 → "1M" */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) {
    const gb = bytes / 1_073_741_824;
    return gb >= 10 ? `${Math.round(gb)}G` : `${gb.toFixed(1)}G`;
  }
  if (bytes >= 1_048_576) {
    const mb = bytes / 1_048_576;
    return mb >= 10 ? `${Math.round(mb)}M` : `${mb.toFixed(1)}M`;
  }
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}K`;
  return `${bytes}B`;
}

/**
 * Truncate to a UTF-8 **byte** budget on a code-point boundary.
 *
 * Firmware buffers are byte arrays, so every daemon text cap must be a byte
 * budget: 39 Hangul syllables are 117 bytes, and a character-counted cap sails
 * past a `char[40]` and gets cut mid-sequence by the board's `strncpy` — which
 * renders as broken glyphs, not as truncation. Iterating code points (not
 * UTF-16 units) is what keeps the cut on a boundary.
 */
export function truncateUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(value, 'utf-8') <= maxBytes) return value;
  let used = 0;
  let end = 0;
  for (const ch of value) {
    const n = Buffer.byteLength(ch, 'utf-8');
    if (used + n > maxBytes) break;
    used += n;
    end += ch.length;
  }
  return value.slice(0, end);
}

/**
 * Defensive clean for an API-provided scoped-model display name before it lands
 * in compact gauge text: drop control chars / newlines, collapse runs of
 * whitespace, trim. The usage API's `limits[]` payload is undocumented, so a
 * stray newline or control byte would otherwise break a single-line SVG layout.
 * XML-escaping (in each renderer) still handles `< & >`; this is the
 * layout-safety pass that runs before uppercase + truncate.
 *
 * Canonical here rather than in one plugin so every scoped-limit surface (SD
 * encoder, SD keypad, D200H tiles) cleans labels identically.
 */
export function sanitizeScopedLabel(label: string | undefined | null): string {
  return (label ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Sanitize + uppercase + code-point-safe truncate a scoped-model label for a
 * compact gauge. Iterating code points (not UTF-16 units) keeps the cut on a
 * character boundary, same rule as truncateUtf8Bytes above. Falls back to
 * "MODEL" when the API label is empty or was entirely control characters.
 */
export function formatScopedLabel(label: string | undefined | null, max: number): string {
  const clean = sanitizeScopedLabel(label).toUpperCase();
  return Array.from(clean).slice(0, max).join('') || 'MODEL';
}

/** Format uptime from seconds: 3725 → "1h 2m" */
export function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
}

/**
 * Reconcile a rate-limit percent against its resets_at timestamp.
 *
 * - Future resets_at → trust percent (current window).
 * - Recently past resets_at → return 0 (window just rolled over; old percent is meaningless).
 * - Far-past resets_at (> 1h) → trust percent (server is returning a prior window's
 *   final value because no new window is active; zeroing would underreport).
 *   Consumers should pair this with a `usageStale` badge so the user sees uncertainty.
 */
export function adjustUsagePercent(
  percent: number | null | undefined,
  resetsAt: string | null | undefined,
): number | undefined {
  if (percent == null) return undefined;
  if (resetsAt) {
    try {
      const resetMs = new Date(resetsAt).getTime();
      if (!isNaN(resetMs)) {
        const elapsed = Date.now() - resetMs;
        if (elapsed > 3_600_000) return percent;
        if (elapsed > 0) return 0;
      }
    } catch { /* fall through */ }
  }
  return percent;
}

/**
 * A Codex rolling-window snapshot is stale once its window has ended: `resetsAt`
 * is in the past beyond a short grace. Codex usage is read passively from the
 * newest local rollout file, so once Codex stops being used the snapshot freezes
 * — `usedPercent` stays at its last value and `resetsAt` slides into the past. At
 * that point a "now" countdown would mislead (the bar still shows the old percent),
 * so consumers should dim the gauge and show a "stale" marker instead.
 *
 * Grace (default 5m) keeps a genuinely-just-reset window briefly showing "now".
 */
export function isCodexWindowStale(
  resetsAt: string | undefined,
  graceMs = 5 * 60_000,
  nowMs = Date.now(),
): boolean {
  if (!resetsAt) return false;
  const t = new Date(resetsAt).getTime();
  if (isNaN(t)) return false;
  return nowMs - t > graceMs;
}

/**
 * How old a Codex snapshot may get before its numbers stop reading as live.
 *
 * Codex writes a `rate_limits` line on every turn, so during real use snapshots
 * are seconds apart; anything older than this means "nobody asked Codex in a
 * while", not "usage is holding steady". An ABSOLUTE threshold on purpose — a
 * fraction of the window length would scale to 8h+ on the weekly window and be
 * useless, which is exactly the hole this closes.
 */
export const CODEX_SNAPSHOT_STALE_MS = 30 * 60_000;

/**
 * Age of a Codex snapshot in ms, or undefined when unknown/unparseable.
 * `capturedAt` is when the snapshot was WRITTEN (see `CodexRateLimits.capturedAt`),
 * which is the only thing that can distinguish "94% right now" from "94% four
 * hours ago" — the window's `resetsAt` cannot, since a weekly window stays in the
 * future for up to 7 days.
 */
export function codexSnapshotAgeMs(capturedAt: string | undefined, nowMs = Date.now()): number | undefined {
  if (!capturedAt) return undefined;
  const t = new Date(capturedAt).getTime();
  if (isNaN(t)) return undefined;
  return Math.max(0, nowMs - t);
}

/**
 * True when the snapshot is too old to present as live.
 *
 * This is deliberately NOT the same signal as `isCodexWindowStale` and must NOT
 * be folded into the wire `stale` flag: `stale` means "this window has ENDED, the
 * number no longer applies" and slot-based consumers (Pixoo renderers, ESP32
 * firmware) HIDE the gauge on it. An aged snapshot still carries the last true
 * reading of a live window, so it keeps rendering — dimmed, with its age shown.
 *
 * Derived at the consumer from `capturedAt`, never precomputed by the producer:
 * a producer-side boolean would freeze at push time and read "fresh" an hour later,
 * the same way the frozen percent did.
 */
export function isCodexSnapshotAged(
  capturedAt: string | undefined,
  nowMs = Date.now(),
  maxAgeMs = CODEX_SNAPSHOT_STALE_MS,
): boolean {
  const age = codexSnapshotAgeMs(capturedAt, nowMs);
  return age != null && age > maxAgeMs;
}

/**
 * Compact "when was this measured" label for a gauge footnote: `"34m ago"`,
 * `"3h ago"`, `"2d ago"`. Returns undefined when there is nothing to say.
 * Rounds DOWN so the label never overstates freshness.
 */
export function formatSnapshotAge(capturedAt: string | undefined, nowMs = Date.now()): string | undefined {
  const age = codexSnapshotAgeMs(capturedAt, nowMs);
  if (age == null) return undefined;
  const min = Math.floor(age / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The one footnote a Codex gauge should print under its percentage, and whether
 * the gauge should be dimmed. Single decision point so every surface (D200H tile,
 * SD encoder, menubar, Android rail, Swift preview) resolves the three states the
 * same way:
 *
 *   - window ended (`stale`)          → "stale",  dim — the number no longer applies
 *   - snapshot aged (> 30m old)       → "3h ago", dim — last true reading, not live
 *   - live                            → undefined      — caller prints its countdown
 *
 * `stale` wins over age: an ended window is a stronger statement than an old read.
 */
export function codexUsageFootnote(
  win: { resetsAt?: string; stale?: boolean } | undefined,
  capturedAt?: string,
  nowMs = Date.now(),
): { text: string; dim: true } | undefined {
  if (!win) return undefined;
  if (win.stale === true) return { text: 'stale', dim: true };
  if (isCodexSnapshotAged(capturedAt, nowMs)) {
    return { text: formatSnapshotAge(capturedAt, nowMs) ?? 'stale', dim: true };
  }
  return undefined;
}

/**
 * Does the worst per-model scoped cap (e.g. the weekly "Fable" limit) earn one of
 * the few keys a fixed-width usage strip has?
 *
 * Both decks pin usage to a short strip — three keys on the D200H, four on a
 * classic Stream Deck — and Claude 5H/7D always take the first two, so this
 * decides what happens to the remainder. Shared so the two decks cannot disagree
 * about which limit a user is looking at.
 *
 * Any surfaced cap claims one logical usage tile. An ACTIVE cap outranks Codex
 * and is placed ahead of it because a per-model weekly cap can be binding while
 * the aggregate 5H/7D windows still read low (issue #99). An inactive cap is
 * informational and is placed after live Codex windows.
 *
 * Physical surfaces enforce their own budgets by pairing or paging readings;
 * this shared arbiter never authorizes silently dropping a known quota.
 */
export function scopedLimitClaimsUsageKey(
  scoped: { active?: boolean } | undefined | null,
  _codexWindowCount?: number,
): boolean {
  if (!scoped) return false;
  return true;
}

/**
 * The Codex windows that sit beside the scoped limit tile.
 *
 * Retains every present Codex window. Fixed-size surfaces compact or page the
 * resulting logical tiles instead of discarding a known window.
 */
export function codexWindowsBeside<T>(
  codexWindows: T[],
  _scopedClaimsKey?: boolean,
): T[] {
  return codexWindows;
}

/**
 * Display name for a raw `chatgpt_plan_type`, keyed by the tier with every
 * separator removed — `prolite`, `pro_lite` and `pro lite` are one plan.
 *
 * SSOT for both daemons: the Swift mirror (`ChatGPTPlan` in
 * CodexFreshnessRules.generated.swift) is emitted from this table. It used to be
 * a hand copy, and a tier missing from one copy does not degrade gracefully —
 * it renders as the fallback capitalisation ("ChatGPT Prolite") on that surface
 * only, so the same account reads differently on the dashboard and the deck.
 */
export const CHATGPT_PLAN_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  free: 'ChatGPT Free',
  plus: 'ChatGPT Plus',
  pro: 'ChatGPT Pro',
  prolite: 'ChatGPT Pro Lite',
  team: 'ChatGPT Team',
  enterprise: 'ChatGPT Enterprise',
};

/**
 * Format a raw `chatgpt_plan_type` for display, or `undefined` when there is no
 * tier to show.
 *
 * An unrecognised tier is capitalised rather than dropped: OpenAI mints new plan
 * names on its own schedule (`prolite` arrived unannounced), and a tier this
 * build predates must still read as a plan beside Plus/Pro/Team — never as the
 * raw lowercase token, and never as nothing.
 */
export function formatChatGptPlanName(planType?: string | null): string | undefined {
  const raw = planType?.trim();
  if (!raw) return undefined;
  const known = CHATGPT_PLAN_DISPLAY_NAMES[normalizeChatGptPlanKey(raw)];
  if (known) return known;
  return `ChatGPT ${raw.charAt(0).toUpperCase()}${raw.slice(1)}`;
}

/**
 * The one comparison form for a raw `chatgpt_plan_type`.
 *
 * Trimmed, lowercased, and stripped of separators — `prolite`, `pro_lite` and
 * `pro lite` are one plan, so they must key the display table AND compare equal.
 * Normalizing only the display path was an internal contradiction with teeth:
 * the two sides of the plan check come from different producers (the auth token
 * for the account tier, the rollout stamp for the snapshot), so a spelling the
 * table was written to absorb would still land every candidate in the "mismatch"
 * class — ranking would have nothing to prefer, the winner would be voided, and
 * on the Node daemon `passivePlanMatchesAccount` would be permanently false, so
 * `codex app-server` would be spawned every 5 minutes forever and its answer
 * voided too. The exact failure this module exists to prevent, via a different
 * spelling.
 *
 * A value that is nothing but separators normalizes to `''` — i.e. "unknown",
 * which the predicate already treats as no information rather than as a licence
 * to void.
 */
export function normalizeChatGptPlanKey(value?: string | null): string {
  return (value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * True when the ChatGPT tier carries no paid Codex subscription.
 *
 * The tier string comes from `~/.codex/auth.json` (`chatgpt_plan_type`), which is
 * the LIVE account fact — it is rewritten on every token refresh, unlike the
 * rollout snapshots below.
 */
export function isCodexFreePlan(plan?: string | null): boolean {
  return normalizeChatGptPlanKey(plan) === 'free';
}

/**
 * True when a rollout usage snapshot still belongs to the plan the account
 * actually holds.
 *
 * Codex stamps `plan_type` into every `rate_limits` snapshot it writes, and
 * AgentDeck reads the live tier separately from `auth.json`. When the two
 * disagree the snapshot was minted under a plan the account no longer has, and
 * its windows are not merely OLD — they are VOID. Neither existing freshness
 * axis can retire them: `stale` only fires once `resetsAt` has passed (a retired
 * weekly window stays future-dated for up to 7 days) and `capturedAt` only dims,
 * because an aged reading of a *live* window is still that window's last true
 * value. A window whose plan is gone has no true value at all.
 *
 * Unknown on either side → matches. Absence is "no information", never a licence
 * to void real data: an API-key Codex install reports no account tier, and a
 * pre-`plan_type` rollout reports no snapshot tier.
 *
 * The emptiness test MUST stay ahead of the equality test, and not because it is
 * a cheap early-out. Normalization strips separators, so two separator-only
 * values (`"-"`, `" "`) both reduce to `''` — reordered, they would compare equal
 * and report a positive plan MATCH where the answer is "neither side named a
 * tier". Every current caller happens to act the same way on both answers, which
 * is exactly why the difference would go unnoticed. Mirrored in Swift.
 */
export function codexSnapshotMatchesAccountPlan(
  snapshotPlan?: string | null,
  accountPlan?: string | null,
): boolean {
  const snap = normalizeChatGptPlanKey(snapshotPlan);
  const account = normalizeChatGptPlanKey(accountPlan);
  if (!snap || !account) return true;
  return snap === account;
}

/**
 * True when a Codex `rate_limits` snapshot meters a single model or feature
 * rather than the account.
 *
 * Codex writes more than one limit FAMILY, and the rollout carries whichever one
 * the last request was metered against — not necessarily the account's. Measured
 * across 823 rollout files on 2026-08-22, the whole observed space is three
 * families and the discriminator is exact:
 *
 *   limit_id "codex"            limit_name null                     37,985 lines  account
 *   limit_id "premium"          limit_name null                         66 lines  account (credit plan)
 *   limit_id "codex_bengalfox"  limit_name "GPT-5.3-Codex-Spark"       915 lines  ONE MODEL
 *
 * A named limit is a scoped limit — the name exists precisely to say which model
 * it applies to. So the account-wide families are the unnamed ones, and that is
 * what "Codex usage" on a deck, dial or panel means.
 *
 * This is not a freshness or a plan question, and neither axis can catch it: the
 * scoped snapshot is CURRENT and belongs to the right plan. It is simply a
 * different quantity, and rendering it under the account's label reports 0%
 * while the account sits at 13% (observed). Within a single session the family
 * alternates hour to hour, so "newest line wins" silently switches quantities
 * mid-stream.
 *
 * Polarity is deliberate and follows the unknown-agent rule (CLAUDE.md): this is
 * an allow-list of the UNNAMED, never a deny-list of known scoped ids. A new
 * scoped family — OpenAI ships models on its own schedule — is excluded
 * automatically; the failure mode of a deny-list is that the new family renders
 * AS the account's number, which is a wrong reading rather than a missing one.
 * If a future account-wide family ever carries a name, this hides it, and a
 * missing gauge is the safe direction.
 *
 * Callers skip such snapshots and keep scanning; they must not treat a scoped
 * snapshot as "no Codex data" for the file, because a session that alternates
 * families still has an account-wide line further back in the same tail.
 */
export function isModelScopedCodexLimit(limitName?: string | null): boolean {
  return (limitName ?? '').trim().length > 0;
}

/**
 * Rank one Codex usage snapshot against another for the live account tier.
 *
 * Recency alone is the wrong ordering, because a snapshot that will be VOIDED a
 * step later must not first win the selection. Codex stamps `plan_type` from the
 * auth token the WRITING PROCESS started with, so a Codex session opened before
 * a plan change keeps appending old-plan snapshots for as long as it stays open
 * — and, being the busiest session, it also keeps minting the newest timestamps.
 * A newest-wins picker therefore hands `normalizeCodexRateLimits` a mismatched
 * snapshot on every single build, the windows are voided, and every gauge goes
 * blank even though a valid same-plan snapshot is sitting right there in another
 * rollout (measured 2026-08-22: a 20:35 pre-upgrade session out-stamping a 01:43
 * post-upgrade one indefinitely).
 *
 * So plan agreement is the PRIMARY key and age is only the tie-break:
 *   1. a snapshot matching the account plan outranks one that does not, at any age
 *   2. within the same match class, the newer `capturedAtMs` wins
 *   3. exact ties keep the incumbent (both pickers scan in priority order)
 *
 * This orders snapshots; it never rescues one. A mismatched snapshot that wins
 * because it is the only one left is still voided downstream — the point is that
 * it must not displace a valid peer first.
 *
 * `capturedAtMs` is a number, not a string, so both a parsed rollout stamp and
 * "unknown" (`-Infinity` / `-.infinity`) order without a second date parse.
 */
export function codexSnapshotOutranks(
  candidate: { planType?: string | null; capturedAtMs: number },
  incumbent: { planType?: string | null; capturedAtMs: number },
  accountPlan?: string | null,
): boolean {
  const candidateMatches = codexSnapshotMatchesAccountPlan(candidate.planType, accountPlan);
  const incumbentMatches = codexSnapshotMatchesAccountPlan(incumbent.planType, accountPlan);
  if (candidateMatches !== incumbentMatches) return candidateMatches;
  return candidate.capturedAtMs > incumbent.capturedAtMs;
}

/**
 * Antigravity plan name → compact "AGY <tier>" chip.
 *
 *   "Google AI Pro"   → "AGY Pro"
 *   "Google AI Ultra" → "AGY Ultra"
 *   "" / undefined     → undefined  (nothing to show)
 *
 * The raw `availableCredits` count is deliberately never surfaced — it's backend
 * metering with no glanceable meaning (see antigravity-local.ts). This is the
 * canonical definition; the native mirrors (ESP32 `util/usage_format.h`
 * `formatAgyPlan`, Android `EinkMonitorScreen.buildAntigravityLimitValue`) must
 * match it. Idempotent: an already-"AGY …" string is returned unchanged.
 */
export function formatAntigravityPlanShort(planName?: string | null): string | undefined {
  const raw = planName?.trim();
  if (!raw) return undefined;
  if (raw === 'AGY' || raw.startsWith('AGY ')) return raw;
  let tier = raw;
  if (/^Google AI\b/.test(tier)) tier = tier.slice('Google AI'.length);
  else if (/^Antigravity\b/.test(tier)) tier = tier.slice('Antigravity'.length);
  tier = tier.trim();
  return tier ? `AGY ${tier}` : 'AGY';
}

/**
 * Compact human duration for an elapsed span of seconds. Timeline task/turn
 * close rows previously printed raw seconds ("Session end · 3672s"), which is
 * unreadable past a few minutes.
 *
 *   42    → "42s"
 *   312   → "5m 12s"   (zero-second remainder dropped: 300 → "5m")
 *   3720  → "1h 2m"    (zero-minute remainder dropped: 7200 → "2h")
 *
 * Canonical definition; the Swift daemon mirror
 * (DaemonTimelineStore.formatDurationSec) must match.
 */
export function formatDurationSec(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r > 0 ? `${m}m ${r}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const rm = Math.floor((s % 3600) / 60);
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

/** Plain-text gauge bar: "████░░" (no ANSI colors) */
export function gaugeBar(percent: number, width = 6): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}
