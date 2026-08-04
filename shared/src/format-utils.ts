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
export function isCodexWindowStale(resetsAt: string | undefined, graceMs = 5 * 60_000): boolean {
  if (!resetsAt) return false;
  const t = new Date(resetsAt).getTime();
  if (isNaN(t)) return false;
  return Date.now() - t > graceMs;
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
