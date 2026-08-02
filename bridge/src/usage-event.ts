import type { StateSnapshot, UsageEvent } from './types.js';
import type { ApiUsageData } from './usage-api.js';
import { getTokenStatus } from './usage-api.js';
import type { OllamaStatus } from './ollama-probe.js';
import { adjustUsagePercent, isCodexWindowStale } from '@agentdeck/shared';
import type { CodexAuthStatus } from './codex-auth.js';
import type { AntigravityStatusInfo, BillingType, CodexRateLimits, CodexRateLimitWindow, ModelCatalogEntry, SubscriptionInfo } from './types.js';

function formatChatGptPlan(planType?: string | null): string | undefined {
  const raw = planType?.trim();
  if (!raw) return undefined;
  switch (raw.toLowerCase()) {
    case 'plus': return 'ChatGPT Plus';
    case 'pro': return 'ChatGPT Pro';
    case 'team': return 'ChatGPT Team';
    case 'enterprise': return 'ChatGPT Enterprise';
    default: return `ChatGPT ${raw}`;
  }
}

function formatClaudeSubscription(
  apiUsage?: ApiUsageData | null,
  billingType?: BillingType,
): SubscriptionInfo | undefined {
  if (apiUsage?.inferredBillingType === 'subscription' || billingType === 'subscription') {
    return { name: 'Claude' };
  }
  return undefined;
}

export function buildSubscriptions(
  codexAuth?: CodexAuthStatus | null,
  apiUsage?: ApiUsageData | null,
  billingType?: BillingType,
  antigravityStatus?: AntigravityStatusInfo | null,
): SubscriptionInfo[] | undefined {
  const items: SubscriptionInfo[] = [];
  const chatgptName = formatChatGptPlan(codexAuth?.planType);
  if (chatgptName) {
    items.push({
      name: chatgptName,
      until: codexAuth?.subscriptionActiveUntil ?? undefined,
    });
  }

  const claude = formatClaudeSubscription(apiUsage, billingType);
  if (claude) {
    items.push(claude);
  }

  if (antigravityStatus?.planName) {
    items.push({
      name: antigravityStatus.planName,
      until: antigravityStatus.subscriptionActiveUntil ?? undefined,
    });
  }

  return items.length > 0 ? items : undefined;
}

/**
 * Normalize a Codex rate-limit window for display. An expired window (its
 * `resetsAt` slid into the past beyond the grace) keeps its last-known
 * `usedPercent` but drops `resetsAt` — so no downstream formatter prints the
 * misleading "now" — and is flagged `stale` so surfaces dim the gauge and show a
 * "stale" marker instead. Per-window, so a stale 5h window doesn't drag down a
 * still-live 7d sibling.
 */
function normalizeCodexWindow(w?: CodexRateLimitWindow): CodexRateLimitWindow | undefined {
  if (!w) return undefined;
  if (isCodexWindowStale(w.resetsAt)) return { ...w, resetsAt: undefined, stale: true };
  return w;
}

function normalizeCodexRateLimits(rl?: CodexRateLimits | null): CodexRateLimits | undefined {
  if (!rl) return undefined;
  // Assign windows to semantic wire slots BY LENGTH, not by the slot Codex used:
  // short (< 1 day → the 5h window) → primary, long (≥ 1 day → weekly) →
  // secondary. Codex now reports the weekly (10080-min) window in its own
  // `primary` slot with `secondary` null once the 5h window resets; slot-based
  // downstream clients (ESP32/InkDeck firmware label primary=5H, secondary=7D and
  // never read windowMinutes) would otherwise mislabel the weekly "5H" and drop
  // the 7D gauge. Length-based consumers still get windowMinutes, unaffected.
  let shortWindow: CodexRateLimitWindow | undefined;
  let longWindow: CodexRateLimitWindow | undefined;
  for (const w of [rl.primary, rl.secondary]) {
    if (!w) continue;
    if (w.windowMinutes >= 1440) longWindow ??= w;
    else shortWindow ??= w;
  }
  // Credit-based plans (limitId "premium" etc.) report null 5h/7d windows and
  // convey usage via a `credits` block instead. With no timed windows the
  // percentage gauges would vanish entirely on slot-based surfaces. Map the
  // credit state onto a synthetic primary window so every surface reads
  // consistently: exhausted credits read as 100% used, unlimited as 0%. A
  // partial balance can't be turned into an honest percentage (no cap is
  // exposed), so it stays absent rather than guessing. No `resetsAt` is set, so
  // the window is never flagged stale (credits refresh on plan renewal, not a
  // rolling timer).
  if (!shortWindow && !longWindow && rl.credits) {
    if (rl.credits.unlimited === true) {
      shortWindow = { usedPercent: 0, windowMinutes: 0 };
    } else if (
      rl.credits.hasCredits === false ||
      (rl.credits.balance != null && Number.isFinite(Number(rl.credits.balance)) && Number(rl.credits.balance) <= 0)
    ) {
      shortWindow = { usedPercent: 100, windowMinutes: 0 };
    }
  }
  return { ...rl, primary: normalizeCodexWindow(shortWindow), secondary: normalizeCodexWindow(longWindow) };
}

function isClaudeSubscriptionModel(modelName?: string | null): boolean {
  const raw = modelName?.trim().toLowerCase();
  if (!raw) return false;
  return raw.includes('claude')
    || raw.includes('opus')
    || raw.includes('sonnet')
    || raw.includes('haiku');
}

/**
 * The SESSION half of a `usage_update` — the per-session counters only the
 * focused session bridge can know. `usage_update` is their sole carrier on the
 * wire (state_update has none of these fields).
 */
export const RELAYED_SESSION_USAGE_FIELDS = [
  'sessionDurationSec', 'inputTokens', 'outputTokens', 'toolCalls',
  'estimatedCostUsd', 'sessionPercent', 'costSpent', 'costLimit',
  'resetTime', 'resetDate',
] as const;

/**
 * Splice a relayed session's counters onto the daemon's own aggregate usage
 * event, keeping the daemon's ACCOUNT half (quota, scoped caps, extra usage,
 * subscriptions, Codex/Ollama, usageStale) authoritative.
 *
 * Used when a relayed event carries no Claude quota of its own. Forwarding such
 * an event verbatim blanks the dashboard's Claude gauge on every state tick;
 * dropping it instead blanks the session's tokens/cost/duration for every focus
 * that legitimately has no Claude quota (Codex, OpenCode, API billing), because
 * the daemon's own UsageTracker is never fed by a PTY and reports zeros. Merging
 * by half is the only option that keeps both halves live.
 */
export function mergeRelayedSessionUsage(own: UsageEvent, relayed: Record<string, unknown>): UsageEvent {
  const merged: Record<string, unknown> = { ...own };
  for (const k of RELAYED_SESSION_USAGE_FIELDS) {
    if (relayed[k] !== undefined) merged[k] = relayed[k];
  }
  return merged as unknown as UsageEvent;
}

/**
 * Build a usage_update BridgeEvent from current state.
 * Single source of truth — used by both index.ts and daemon-server.ts.
 *
 * `aggregateSubscriptionQuota` — set by the daemon hub. The daemon has no single
 * session model (its aggregate `modelName` is whatever agent is currently primary,
 * e.g. OpenClaw/Codex), so gating the account-level Claude 5h/7d quota on the active
 * model wrongly hides it on the Dashboard. The hub always exposes the quota when the
 * Claude subscription data exists; per-session bridges keep the model gate so a
 * standalone Codex session doesn't claim Claude quota.
 */
export function buildUsageEvent(
  snapshot: StateSnapshot,
  apiUsage?: ApiUsageData | null,
  oauthStatus?: boolean,
  ollamaStatus?: OllamaStatus | null,
  mlxModels?: string[] | null,
  stale?: boolean,
  codexAuth?: CodexAuthStatus | null,
  billingType?: BillingType,
  modelCatalog?: ModelCatalogEntry[] | null,
  antigravityStatus?: AntigravityStatusInfo | null,
  preAdjusted?: boolean,
  aggregateSubscriptionQuota?: boolean,
  codexRateLimits?: CodexRateLimits | null,
): UsageEvent {
  const subscriptionQuotaApplies = (
    apiUsage?.inferredBillingType === 'subscription'
      || billingType === 'subscription'
  ) && (aggregateSubscriptionQuota || isClaudeSubscriptionModel(snapshot.modelName));

  let fiveHourPercent: number | undefined;
  let fiveHourResetsAt: string | undefined;
  let sevenDayPercent: number | undefined;
  let sevenDayResetsAt: string | undefined;

  if (subscriptionQuotaApplies) {
    fiveHourPercent = preAdjusted ? (apiUsage?.fiveHourPercent ?? undefined) : adjustUsagePercent(apiUsage?.fiveHourPercent, apiUsage?.fiveHourResetsAt);
    fiveHourResetsAt = apiUsage?.fiveHourResetsAt ?? undefined;
    sevenDayPercent = preAdjusted ? (apiUsage?.sevenDayPercent ?? undefined) : adjustUsagePercent(apiUsage?.sevenDayPercent, apiUsage?.sevenDayResetsAt);
    sevenDayResetsAt = apiUsage?.sevenDayResetsAt ?? undefined;
  } else if (billingType === 'api' && snapshot.costLimit && snapshot.costLimit > 0) {
    const spent = snapshot.costSpent ?? 0;
    fiveHourPercent = Math.min(100, Math.max(0, (spent / snapshot.costLimit) * 100));
    fiveHourResetsAt = snapshot.resetTime
      ? `${snapshot.resetDate || ''} ${snapshot.resetTime}`.trim()
      : undefined;
  }

  const event: UsageEvent = {
    type: 'usage_update',
    sessionDurationSec: snapshot.sessionDurationSec,
    inputTokens: snapshot.inputTokens,
    outputTokens: snapshot.outputTokens,
    toolCalls: snapshot.toolCalls,
    estimatedCostUsd: snapshot.estimatedCostUsd ?? undefined,
    sessionPercent: snapshot.sessionPercent ?? undefined,
    costSpent: snapshot.costSpent ?? undefined,
    costLimit: snapshot.costLimit ?? undefined,
    resetTime: snapshot.resetTime ?? undefined,
    resetDate: snapshot.resetDate ?? undefined,
    fiveHourPercent,
    fiveHourResetsAt,
    sevenDayPercent,
    sevenDayResetsAt,
    // Per-model scoped caps (e.g. the weekly "Fable" limit). Only meaningful for
    // subscription quota — an API-billing session has no scoped model windows.
    scopedLimits: subscriptionQuotaApplies && apiUsage?.scopedLimits && apiUsage.scopedLimits.length > 0
      ? apiUsage.scopedLimits
      : undefined,
    extraUsageEnabled: subscriptionQuotaApplies ? (apiUsage?.extraUsageEnabled ?? undefined) : undefined,
    extraUsageMonthlyLimit: subscriptionQuotaApplies ? (apiUsage?.extraUsageMonthlyLimit ?? undefined) : undefined,
    extraUsageUsedCredits: subscriptionQuotaApplies ? (apiUsage?.extraUsageUsedCredits ?? undefined) : undefined,
    extraUsageUtilization: subscriptionQuotaApplies ? (apiUsage?.extraUsageUtilization ?? undefined) : undefined,
    oauthConnected: oauthStatus,
    ollamaStatus: ollamaStatus ?? undefined,
    // ALWAYS an explicit boolean — never omitted. Clients merge usage fields
    // retain-on-absent, so an absent key can only ever ADD staleness; both
    // halves of the contract have to ride the wire:
    //   positive — no quota numbers at all (never fetched / not applicable)
    //     reads as stale, so a dashboard that roamed from another daemon
    //     purges the foreign quota instead of rendering it forever;
    //   negative — fresh numbers read as explicitly NOT stale. Omitting here
    //     (the old `|| undefined`) made usageStale a one-way latch: the
    //     cold-cache frame `sendInitialState` emits on connect set it true and
    //     nothing could ever retract it, so the macOS Dashboard showed "stale"
    //     over live percentages until the app restarted (2026-07-25).
    // The cost-based API-billing percent path keeps usageStale honest too
    // (defined percent → not forced stale).
    usageStale: stale || (fiveHourPercent === undefined && sevenDayPercent === undefined),
    tokenStatus: getTokenStatus() !== 'unknown' ? getTokenStatus() : undefined,
    codexAuthMode: codexAuth?.authMode,
    codexWebAuthConnected: codexAuth?.webAuthConnected,
    codexPlanType: codexAuth?.planType,
    codexAccountId: codexAuth?.accountId,
    codexSubscriptionActiveUntil: codexAuth?.subscriptionActiveUntil,
    codexLastRefreshAt: codexAuth?.lastRefreshAt,
    codexRateLimits: normalizeCodexRateLimits(codexRateLimits),
    modelCatalog: modelCatalog && modelCatalog.length > 0 ? modelCatalog : undefined,
    mlxModels: mlxModels && mlxModels.length > 0 ? mlxModels : undefined,
    subscriptions: buildSubscriptions(codexAuth, apiUsage, billingType, antigravityStatus),
    antigravityStatus: antigravityStatus ?? undefined,
  };
  return event;
}
