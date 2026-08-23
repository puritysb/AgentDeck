import type { CodexRateLimits, UsageEvent } from './types.js';
import { mergeRelayedSessionUsage } from './usage-event.js';
import { pickBestCodexRateLimits } from './codex-rate-limits-live.js';

/**
 * Decide what the daemon broadcasts when a session bridge relays a
 * `usage_update`, and keep that decision out of the callback it used to be
 * inlined in.
 *
 * A session bridge broadcasts usage on EVERY state change. In daemon-first mode
 * its snapshot usually has no model context, so the Claude quota model gate
 * (`isClaudeSubscriptionModel`) yields no percents and the event carries
 * `usageStale=true`. Forwarding that bare event verbatim clobbered the daemon's
 * own authoritative aggregate on the dashboard: the Claude gauge blanked to
 * "No usage data" on every state tick (the Codex gauge, which ignores global
 * staleness, stayed put — hence the Claude-only flicker).
 *
 * Suppressing the relay instead is NOT an option: `usage_update` is the ONLY
 * carrier of per-session tokens / cost / duration (`state_update` has none of
 * those fields), and the daemon's own `buildUsage()` reads a UsageTracker that
 * no PTY ever feeds, so its session half is zeros. Dropping the event would
 * blank the session numbers for every focus that legitimately carries no Claude
 * quota — Codex, OpenCode, API billing.
 *
 * So the event is split by HALF, not by event: the ACCOUNT half (quota, scoped
 * caps, extra usage, subscriptions, Codex/Ollama, `usageStale`) comes from the
 * daemon's authoritative aggregate, the SESSION half from the relay.
 *
 * ## Why the Claude-bearing branch is not just the same merge
 *
 * When the relay carries Claude percentages the event already holds the account
 * half the merge exists to protect, so it goes out as-is — except for
 * `codexRateLimits`, which is the one account-half field a session bridge
 * cannot compute as well as the daemon. A bridge keeps host processes off by
 * design, so it has only the passive rollout read; the daemon additionally
 * holds a throttled `codex app-server` reading. They agree whenever a
 * plan-matching rollout exists. When none does, the daemon holds a live
 * snapshot with real windows while the bridge holds a mismatched one that
 * `normalizeCodexRateLimits` voids to a windowless block — and successive
 * events then alternated between a real Codex window and a voided one, which
 * reads as a flickering/blanking Codex gauge on every surface (issue #253).
 *
 * The two blocks are RECONCILED rather than one overwriting the other, by the
 * same `pickBestCodexRateLimits` rule the daemon already applies to its own two
 * readings. Both inputs arrive already normalized against the same `auth.json`
 * by their own producer, so no account tier is read here: voiding has already
 * stripped `capturedAt` from a mismatched block, which is exactly what makes it
 * lose to a stamped one under plan-agnostic newest-wins. That matters in both
 * directions — the daemon's block is normally the better one, but a bridge that
 * just read a newer rollout than the daemon's last build still wins on recency.
 *
 * ## Why `buildOwnUsage` is a thunk
 *
 * `BridgeCore.buildUsage()` is the call that arms the throttled `codex
 * app-server` spawn gate and re-derives the whole account half. It must run on
 * the merged branch only — the Claude-bearing branch is the daemon's most
 * flicker-sensitive path, and its entire history is about not clobbering the
 * dashboard. Passing it as a thunk puts that in the signature instead of in a
 * comment, so a test can assert it was never called.
 *
 * `ownCodexRateLimits` is the block from the daemon's own last built usage
 * event — a remembered value, never a fresh build, so reading it costs nothing
 * and cannot arm the spawn. Null before the daemon has built one, in which case
 * the relayed block stands, which is the pre-#253 behaviour.
 */
export function resolveRelayedUsageEvent(input: {
  relayed: Record<string, unknown>;
  ownCodexRateLimits: CodexRateLimits | null;
  buildOwnUsage: () => UsageEvent;
}): UsageEvent {
  const { relayed, ownCodexRateLimits, buildOwnUsage } = input;

  const hasClaudeData = relayed.fiveHourPercent != null || relayed.sevenDayPercent != null;
  if (!hasClaudeData) {
    return mergeRelayedSessionUsage(buildOwnUsage(), relayed);
  }

  const relayedCodex = (relayed.codexRateLimits ?? null) as CodexRateLimits | null;
  const best = pickBestCodexRateLimits(relayedCodex, ownCodexRateLimits);
  // Identity, not deep-equality: the picker returns one of its two arguments, so
  // an unchanged pick must leave the relayed event object untouched — including
  // an absent `codexRateLimits` key, which under retain-on-absent merging is
  // "no information" and must not become an explicit `undefined`.
  if (best === relayedCodex) return relayed as unknown as UsageEvent;
  return { ...(relayed as unknown as UsageEvent), codexRateLimits: best ?? undefined };
}
