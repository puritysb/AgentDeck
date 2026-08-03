/**
 * Usage data types and shared formatting helpers.
 * Used by the dedicated Usage Dial (E3) renderer.
 */
import type { CodexRateLimits } from '@agentdeck/shared';

export interface UsageModeData {
  fiveHourPercent?: number;
  fiveHourResetsAt?: string;
  sevenDayPercent?: number;
  sevenDayResetsAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  sessionDurationSec?: number;
  extraUsageEnabled?: boolean;
  extraUsageUtilization?: number;
  extraUsageMonthlyLimit?: number;
  extraUsageUsedCredits?: number;
  subscriptions?: { name: string; until?: string }[];
  // True when upstream daemon couldn't produce a live usage fetch (App Store
  // sandbox without a CLI relay, OAuth missing, etc.). Plugin treats stale the
  // same as "no data" and renders the disconnected placeholder — a stale
  // number on the encoder LCD reads as current.
  usageStale?: boolean;
  // Codex rolling-window quota (primary ≈ 5h, secondary ≈ 7d). Rides alongside
  // the Claude 5h/7d fields so the SD+ Codex usage encoder (E3) can render.
  codexRateLimits?: CodexRateLimits;
}

let sharedData: UsageModeData = {};
let onRefreshRequest: (() => void) | null = null;

/** Update shared usage data (called from plugin.ts on usage_update). */
export function updateUsageModeData(data: UsageModeData): void {
  sharedData = { ...sharedData, ...data };
}

/** Get current shared usage data snapshot. */
export function getUsageModeData(): UsageModeData {
  return sharedData;
}

/** Set callback for refresh request (query_usage). */
export function setUsageRefreshCallback(cb: () => void): void {
  onRefreshRequest = cb;
}

/** Fire refresh request. */
export function fireUsageRefresh(): void {
  onRefreshRequest?.();
}


export function formatResetTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = Date.now();
    const diff = d.getTime() - now;
    if (diff <= 0) return 'now';
    const totalH = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (totalH >= 24) {
      const days = Math.floor(totalH / 24);
      const remainH = totalH % 24;
      return remainH > 0 ? `${days}d${remainH}h` : `${days}d`;
    }
    return totalH > 0 ? `${totalH}h${m}m` : `${m}m`;
  } catch { return ''; }
}

/**
 * Absolute reset instant in the user's local time, e.g. "Thu 15:02".
 *
 * Pairs with `formatResetTime`'s relative countdown on the single-window encoder
 * view: a weekly window resets ~7 days out, where "6d2h" answers "how long do I
 * have" but not "which day do I get it back" — and the weekday alone would be
 * ambiguous without the countdown beside it.
 */
export function formatResetAbsolute(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    return `${wd} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch { return ''; }
}

/**
 * Subscription renewal date, e.g. "Aug 5" — the year is added only when the
 * boundary is far enough out (annual plans) that the month alone is ambiguous.
 * The upstream value is the NEXT renewal, already rolled forward from Codex's
 * one-shot `auth.json` snapshot (`resolveChatGptRenewalDate`), so this is a
 * live boundary rather than the stale stamp the token carries.
 */
export function formatRenewalDate(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
    const far = d.getTime() - Date.now() > 300 * 24 * 3600e3;
    return far ? `${mon} ${d.getDate()} ${d.getFullYear()}` : `${mon} ${d.getDate()}`;
  } catch { return ''; }
}

export function formatTokens(n?: number): string {
  if (n == null) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── SD+ usage-encoder data builders (Phase 2) ──────────────────────────────
// Map the shared usage snapshot onto the 200×100 dual-tank encoder renderer.

import type { UsageEncoderData, UsageEncoderSideCard } from '../renderers/usage-gauge.js';

/**
 * Build the Claude usage encoder (E2) from the shared snapshot.
 * @param hasReceivedData false before the first usage_update → "Waiting…".
 */
export function buildClaudeUsageEncoder(data: UsageModeData, hasReceivedData: boolean): UsageEncoderData {
  const stale = data.usageStale === true;
  const fiveKnown = !stale && data.fiveHourPercent != null;
  const sevenKnown = !stale && data.sevenDayPercent != null;
  let note: string | undefined;
  if (!hasReceivedData) note = 'Waiting…';
  else if (!fiveKnown && !sevenKnown) note = 'No usage data';
  return {
    agent: 'claude',
    title: 'CLAUDE',
    fiveHour: { label: '5H', usedPercent: data.fiveHourPercent ?? 0, resetsAt: data.fiveHourResetsAt, known: fiveKnown },
    sevenDay: { label: '7D', usedPercent: data.sevenDayPercent ?? 0, resetsAt: data.sevenDayResetsAt, known: sevenKnown },
    note,
  };
}

/**
 * Build the Codex usage encoder (E3) from the shared snapshot. Codex has no
 * rate limits unless the daemon reports `codexRateLimits` (primary ≈ 5h,
 * secondary ≈ 7d) — fall back to a muted note when absent. Credit-based plans
 * (`limit_id`/`credits`, null windows) surface the balance in the note instead.
 * @param hasReceivedData false before the first usage_update → "Waiting…".
 */
/** Views a usage encoder can rotate through (the live subset is per-payload). */
export const USAGE_VIEWS = ['both', '5h', '7d', 'session'] as const;
export type UsageView = typeof USAGE_VIEWS[number];

/**
 * Views actually reachable for the current payload. A window's zoom stop exists
 * only while that window does: Codex stopped reporting its 5h rolling window
 * upstream on 2026-07-12, so a fixed list left one of four rotation stops
 * showing a full-bleed "—" for a window that no longer exists.
 */
export function availableUsageViews(enc: Pick<UsageEncoderData, 'fiveHour' | 'sevenDay'>): UsageView[] {
  const views: UsageView[] = ['both'];
  if (enc.fiveHour.known) views.push('5h');
  if (enc.sevenDay.known) views.push('7d');
  views.push('session');
  return views;
}

export function buildCodexUsageEncoder(data: UsageModeData, hasReceivedData: boolean): UsageEncoderData {
  // NB: Codex rate limits come from local rollout files, independent of the
  // Claude-API `usageStale` flag — so we do NOT blank Codex on global staleness
  // (that wrongly hid Codex whenever no Claude fetch ran). Per-window staleness
  // (an expired snapshot) rides `window.stale`, set centrally in buildUsageEvent.
  const cx = data.codexRateLimits;
  const primary = cx?.primary;
  const secondary = cx?.secondary;
  let note: string | undefined;
  if (!hasReceivedData) note = 'Waiting…';
  else if (primary == null && secondary == null) {
    if (cx?.credits || cx?.limitId) {
      const tier = (cx.limitId ?? 'credits').toUpperCase();
      const bal = cx.credits?.unlimited ? '∞' : (cx.credits?.balance ?? '—');
      note = `${tier} · ${bal} credits`;
    } else {
      note = 'No Codex usage';
    }
  }
  // Exactly one live window — Codex has reported the weekly cap alone since
  // 2026-07-12, when the 5h rolling window disappeared upstream for good (not the
  // transient post-reset slot flip the daemon normalizer already handles). Fill
  // the half the missing gauge used to occupy with the SUBSCRIPTION behind the
  // quota: which plan is paying for it and when it next renews. The window's own
  // countdown stays inside the gauge, where E2 also prints it.
  const solo = primary != null && secondary == null ? primary
    : primary == null && secondary != null ? secondary
    : undefined;
  return {
    agent: 'codex',
    title: 'CODEX',
    fiveHour: { label: '5H', usedPercent: primary?.usedPercent ?? 0, resetsAt: primary?.resetsAt, known: primary != null, stale: primary?.stale === true },
    sevenDay: { label: '7D', usedPercent: secondary?.usedPercent ?? 0, resetsAt: secondary?.resetsAt, known: secondary != null, stale: secondary?.stale === true },
    note,
    sideCard: solo ? buildCodexSideCard(data, cx, solo) : undefined,
  };
}

/**
 * The companion card beside a lone Codex gauge, best-available first:
 * the subscription (tier + next renewal), the bare plan tier, and finally the
 * window's absolute reset instant — the one fact the gauge's relative countdown
 * does NOT carry, so it never restates what sits beside it. Returns undefined
 * when nothing is known, which drops the encoder back to the two-panel layout.
 */
function buildCodexSideCard(
  data: UsageModeData,
  cx: CodexRateLimits | undefined,
  solo: { resetsAt?: string; stale?: boolean },
): UsageEncoderSideCard | undefined {
  // `subscriptions` is multi-provider; match by name, never by index.
  const sub = data.subscriptions?.find((s) => s.name.toLowerCase().startsWith('chatgpt'));
  if (sub) {
    // "ChatGPT Plus" → CHATGPT / PLUS, so the tier is the headline and the
    // 94px-wide card never has to shrink a 12-character string to fit.
    const rest = sub.name.slice('chatgpt'.length).trim();
    const renewal = formatRenewalDate(sub.until);
    return {
      label: rest ? 'CHATGPT' : 'PLAN',
      value: (rest || sub.name).toUpperCase().slice(0, 10),
      sub: renewal ? `Renews ${renewal}` : undefined,
    };
  }
  const tier = cx?.planType?.trim();
  if (tier) return { label: 'PLAN', value: tier.toUpperCase().slice(0, 10) };
  if (!solo.stale && solo.resetsAt) {
    return { label: 'RESETS', value: formatResetAbsolute(solo.resetsAt), muted: true };
  }
  return undefined;
}
