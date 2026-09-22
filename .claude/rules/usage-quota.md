---
paths:
  - "bridge/src/usage-*.ts"
  - "bridge/src/relayed-usage.ts"
  - "bridge/src/codex-rate-limits*.ts"
  - "bridge/src/codex-auth.ts"
  - "bridge/src/claude-usage-recovery.ts"
  - "apple/AgentDeck/Daemon/Core/UsageAPIClient.swift"
  - "apple/AgentDeck/Daemon/Core/UsageRelayFreshness.swift"
  - "apple/AgentDeck/Daemon/Core/AnthropicAdminApiClient.swift"
  - "shared/src/d200h-layout.ts"
---
# Usage and quota gauges
<!-- Moved verbatim from CLAUDE.md (2026-09-10). Rule bodies are the SSOT for their domain; CLAUDE.md keeps only the map. -->
Claude/Codex usage windows as they travel from producer to gauge: freshness vs staleness vs plan vs limit family,
cache TTL vs poll interval, and quota authorization recovery. The wire-boolean rule for `usageStale` is in
[devices-and-wire.md](devices-and-wire.md).

## Codex windows: four axes

- **A freshness signal must never be folded into a hard signal.** A Codex usage window carries four independent axes, and collapsing any two loses a distinction no consumer can recover. (1) **`stale` means the window ENDED** and slot-based consumers (Pixoo renderers, ESP32 firmware) DROP the gauge on it. (2) **"This reading is old" is a different axis and rides `capturedAt`** — the value keeps rendering, dimmed, with its age in place of the countdown; folding the two made every Codex gauge vanish from the unflashable boards after 30 idle minutes. The age is **derived at the consumer** against its own clock (`isCodexSnapshotAged` / `codexUsageFootnote`), never shipped as a producer-computed boolean, which would freeze between pushes exactly like the number it qualifies (a 4h-old 94% read as live). Absence of `capturedAt` is "unknown", not "old": never dim on a missing stamp. (3) ***Whose* number is this.** Codex stamps `plan_type` into every snapshot and the live tier is read separately from `auth.json`; when they disagree the snapshot was minted under a plan the account no longer holds and its windows are **void, not old** (a lapsed Plus leaves a 94% weekly window whose `resetsAt` stays days out, so `stale` never fires). Reconciled at the producer — `normalizeCodexRateLimits` (Node), `codexRateLimitsPayload` (Swift), sharing `codexSnapshotMatchesAccountPlan` / generated `CodexPlanRules` — and unknown on either side MATCHES, because absence is no information. Voiding must ride the wire as an explicit windowless `{ planType }`, never an omitted key: clients merge retain-on-absent, so dropping the field pins the retired gauge forever. Consumers therefore test for a **window**, never for the block's presence. (4) ***Which limit* the number belongs to**, and the rollout can no longer answer it. Codex meters an account family (`limit_id: "codex"`/`"premium"`) and per-model pools, and `isModelScopedCodexLimit` reads the family off `limit_name` — but that label lies: with the weekly account quota exhausted, Codex wrote a per-model pool's windows under `limit_id: "codex"` with a null `limit_name`, so the deck read 54% / 24% against an account at 100%. Neither freshness nor plan can see it — the snapshot is current and correctly stamped, it is simply a different QUANTITY. `codexSnapshotsShareLimitFamily` (`bridge/src/codex-rate-limits-live.ts`) checks the passive reading against the live one on `limitId` + the **weekly** `resetsAt` (the 5h reset slides with every request and identifies nothing); a mismatch prefers the LIVE snapshot and lifts the mid-turn query skip, and the first query after daemon start always fires because it establishes the baseline. **A passive-only source has no defence** — the account-family line is not recoverable from the rollout tail. Swift now reads the account directly with native HTTPS (`CodexAccountUsageClient`) and grants a successful account response 120 seconds of precedence over rollout timestamps. It never spawns a subprocess. (2026-08-05, 2026-08-27 — DEVELOPMENT_LOG.)

## Cache TTL, relay freshness

- **A cache TTL is set together with the interval that polls it, and a relay source serves numbers and their age together or neither.** `fetchedAt` is written *after* the HTTP round trip, so a poller whose interval **divides** the TTL always reaches the expiring tick a few hundred ms early, reads a hit, and waits a whole extra interval — the daemon's 60s poll against a 120s file TTL was a hard **180s floor**, never once landing on 120s. Fix the comparison, not the constant (`age >= TTL - slack`, `FILE_CACHE_SLACK_MS`), so a changed poll interval cannot silently reintroduce it. The second rule follows from the first fix: once `lastApiFetchTime` stopped advancing on a failed apply, `{numbers, fetchedAt: 0}` became reachable for a bridge that never completed a live fetch — so `GET /usage` answers `usage: null` when the stamp is missing, in **the same shape it already returns with no source registered**, letting a consumer keep one branch for both. Closing it at the producer covers every consumer at once. Gates: `bridge/src/__tests__/usage-api.test.ts` (`fileCacheExpired` — a tick landing at 119.6s must expire, a 60s-old cache must not), `hook-server-usage-relay.test.ts`, `bridge-core.test.ts` stale-fetch cases.

## Claude quota authorization

- **Claude quota authorization is distinct from session connectivity.** The Node daemon alone enables bounded recovery (`claude-usage-recovery.ts`) when a credential expires or the usage endpoint rejects it with 401. Claude Code owns refresh-token rotation and its locks; AgentDeck asks the user's CLI for one tool-free, customization-free Haiku reply (small quota cost, 25s timeout), then re-reads credentials before retrying usage. Never add this subprocess to Swift. A persisted recovery cooldown survives daemon restart: an unchanged credential gets one short retry after 1 min, a rotated credential starts with the normal 30 min cooldown rather than reopening the quick tier, the second attempt backs off for 30 min, and the third and later attempts back off for 6 h. The record persists only sanitized subprocess outcomes, never credentials or output. `AGENTDECK_CLAUDE_USAGE_RECOVERY=0` disables recovery. `tokenStatus` must explicitly emit `unknown` as well as valid/expired/missing so a previous auth error can be retracted. The app preserves this field and shows the quota failure reason independently of working session hooks. API `Retry-After` is scheduling metadata, never a replacement for the cache's successful `fetchedAt` stamp.

## Claude display retirement

- **Stale Claude quota is hidden, not displayed with a stale badge.** On a failed fetch, or after the existing 10-minute successful-fetch validity bound, both daemons omit Claude 5h/7d percentages, reset times, scoped limits and extra-usage values and emit `usageStale: true`. Check expiry while building state/usage frames as well as on the periodic tick, so reconnecting cannot revive an expired reading. Consumers clear those fields on explicit `true`, including when an older producer still supplies numbers. A fresh successful reading restores the display with explicit `false`; authentication status remains available to settings/diagnostics. Cache retention is internal and does not extend display validity.
- **Subscription lists are replacement snapshots.** Both state and usage producers send `subscriptions: []` when empty. Claude appears only with non-stale quota data supporting subscription billing; a session billing mode or old cached classification alone is insufficient. A failed fetch means subscription status is unknown, not proof of cancellation. Hiding Claude quota/subscription metadata must not remove actual Claude sessions or affect Codex/other-provider usage and subscriptions.

## Provider presence and sparse display windows

Upstream membership is a stable, explicit display preference (`dashboardProviders`), persisted by the daemon and shared by Apple/Android through authenticated `/dashboard/providers`. First registration seeds confirmed integrations once; reconnects, session count changes and quota failures never remove a registered row. An explicit empty list is a saved choice, not an uninitialized setting. Hiding a provider never disables observation or hides its sessions. Installed hooks alone do not establish a healthy provider connection. Quota validity remains independent: expired/failed readings are cleared inside the stable row. A missing 5h window is absent, never 0%. Serial usage snapshots, including empty retirement snapshots, must not be gated on Claude 5h availability.

A lone color-display tank keeps its square aspect ratio and shares a centerline with its name and reset label; compact content does not stretch to fill an absent window. TRMNL uses a readable subscription column beside actual quota windows. EPD47 and NM follow the stable-home contract in `docs/eink-surface-contract.md`.

Dashboard subscription metadata belongs to the selected upstream provider row: show the plan once and append its reported subscription date separately from quota reset timers. Do not repeat a SUBSCRIPTIONS footer or revive hidden providers through it. Dashboard settings retain the full reported list, including providers hidden from the rail; dates may be cached or estimated and an old date alone must not claim cancellation or required renewal.

## z.ai GLM Coding Plan provider

- **The z.ai plan is a PROVIDER ACCOUNT, not a harness feature (#348).** One coding-plan key serves Claude Code (`/api/anthropic`), Codex (`/api/coding/paas/v4`) and other CLIs from one quota, so the reading never looks at harness state: the daemons poll `GET https://api.z.ai/api/monitor/usage/quota/limit` directly (undocumented — the Codex account-endpoint discipline: read-only GET, redirects refused, key never logged, no subprocess). Key custody is AgentDeck-owned (Node: env `AGENTDECK_ZAI_API_KEY` > daemon settings `zaiApiKey` > the Claude-settings z.ai-redirect hint; Swift: Keychain, the Admin-API-key pattern) — a harness config is a discovery hint, never the mechanism.
- **The monitor response carries its own limit-family axis.** Standard schema = TOKENS_LIMIT (5h credits) + TIME_LIMIT (monthly MCP); lite tier returns credit-only CREDIT_LIMIT items told apart by `unit` (3 → session, 6 → weekly). Classification is the generated SSOT `shared/src/zai-quota.ts` → `ZaiQuotaRules.generated.swift`, pinned by `shared/zai-quota-vectors.json` replayed by BOTH suites. `level` stamps the plan tier per snapshot. Weekly credits are NOT exposed on the standard schema — the secondary window is conditional, never a fabricated number. A pay-as-you-go key (`sk-pay`/`payg` shape) is not a subscription: it ships an explicit windowless `{limitId:"payg"}` block so prior gauges clear instead of freezing, and renders as nothing, never as 0%.
- **Retirement is block-scoped and explicit.** After the shared 10-minute display bound the wire block goes windowless `{planType?}` (plan/family axes survive so surfaces can still name the row) — `usageStale` stays Claude-owned and must never be reused for z.ai. Per-window ended-staleness rides `resetsAt` + `stale` exactly like Codex windows. The GLM Coding Plan subscription row needs live windows; an ended window is routine rolling life and does not remove it.

## Native Codex account refresh

Swift polls Codex's read-only account usage endpoint every 30 seconds using
credentials inside the existing user-granted folder scope. Successful account
readings outrank passive records for 120 seconds: an old session can append a
new timestamp after a coupon reset while carrying old quota or a model pool.
Only the account `rate_limit` block is consumed; `additional_rate_limits` are
not account quota. Failure retains the original capture time and backs off;
credential/account changes invalidate the native cache. HTTP redirects are
refused, credentials and responses are never logged, and token rotation and
coupon redemption remain owned by Codex. The endpoint follows Codex's upstream
implementation and is not a public, versioned OpenAI API contract.

`AGENTDECK_CLAUDE_CLI` can select the recovery executable when the daemon PATH lacks it. Relative paths resolve before the child changes working directory; Windows `.cmd`/`.bat` shims are diagnosed and skipped rather than executed through a shell.
