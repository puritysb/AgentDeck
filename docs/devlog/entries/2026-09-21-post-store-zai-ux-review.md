# 2026-09-21 — Post-store review: z.ai account lifecycle and usage UX

Review baseline: `apple-v1.3.2` through `80b8e668` (224 changed files).
The September 15 approval receipt records Apple 1.3.2 live on both platforms;
this review does not make a new store-state claim.

The post-release changes cluster into provider quotas/branding, device usage
layouts, observed-session ordering, approval-state recovery, daemon/serial/ADB
lifecycle, Windows observation/autostart, and delivery documentation. The
review followed the z.ai producer → wire → consumer paths in detail and used
the repository-wide regression suite for the other changed domains. It is not
a claim of a line-by-line audit or a new hardware certification of every file.

## Improvement plan and implementation

1. **Account identity and freshness (implemented).** Node read a fresh disk
   cache before resolving the current credential; Swift retained its singleton
   cache across settings-triggered daemon restarts. Removing/replacing a key
   could therefore show another account's quota. Node now binds the cache to
   a one-way key-and-endpoint fingerprint. Swift clears account state and
   backoff on credential change, guards pending reads/responses with a
   generation, and deduplicates concurrent requests. Both publish an explicit
   windowless retirement on removal. Node uses the original capture time;
   a failed first poll after restart cannot make an old disk reading immortal.
2. **Provider-local settings (implemented).** Saving/clearing a macOS key no
   longer restarts the daemon or disconnects sessions/devices. Keychain writes
   run off the UI actor, replacement uses update-before-add, and only z.ai
   refreshes. A saved key is “Awaiting data,” not proof of connection. Real
   remote readings count even without a local key. The editor is hidden when
   an external daemon owns the data; the product-tier matrix now records this
   boundary explicitly. Copy distinguishes used credits from MCP tool calls.
3. **Request and task lifecycle (implemented).** The Swift client now actually
   refuses redirects as its original contract promised, bounds the entire
   request, and requires the same successful envelope as Node. Logs exclude
   server-provided error text. Shutdown cancels the z.ai polling task; removed
   keys are still observed by the polling path. Existing usage-refresh buttons
   now reach z.ai as well as the existing provider refresh paths.
4. **Deck interaction and scarce space (implemented).** Auto-provider ranking
   replaces processing/recency counts on every roster instead of retaining
   all-time maxima. E2 rotation skips missing windows using the existing view
   helper. With three providers plus a Claude scoped cap, the fixed three-key
   strip previously truncated the final provider: only at this capacity does
   Claude compact to three rows. Its 5h, weekly and scoped readings all survive,
   alongside Codex and z.ai, without taking a session key. With spare keys the
   existing expanded layout is retained.
5. **Preview fidelity (implemented).** D200H live input now forwards z.ai and
   scoped limits. Its z.ai tiles use the actual provider mark rather than the
   Claude fallback. Shared schematic usage rows now include z.ai; TRMNL/IPS10
   label MCP correctly, compact color displays omit that tool-call gauge like
   the firmware, and the TRMNL subscription footer does not repeat its plan.
   Round-preview provider groups now fit inside the circular screen without
   clipping the bottom gauges or overlapping the creatures.
   The Swift layout mirror includes the capacity rule and its source hash is
   reconciled. Two old native assertions still expected always-compacted
   layouts after free-space expansion; fixtures now distinguish sparse and
   crowded rosters, with a new three-provider crowded regression.

## Scope retained and follow-up sequence

- Existing provider visibility preferences, session/harness identities, usage
  action UUIDs, E2 automatic/E3 user-selected roles and MCP quantity semantics
  remain intact. No new setup flow, token-volume metric, or session-launch
  control was introduced.
- Android and firmware already consume explicit windowless retirement blocks;
  their production code is unchanged. Small firmware surfaces intentionally
  omit MCP. Luna remains limited to its previously documented deck surfaces;
  it is not silently promoted to native Apple/Android support in this review.
- Before release: verify key save → first reading → replacement → deletion
  against a real coding-plan account, then validate the three-provider layout
  on physical Stream Deck/D200H and supported firmware displays. Mocked
  responses and image renders do not prove the undocumented endpoint is live.
- Cross-daemon sibling z.ai relay remains the recorded #348 follow-up. Its
  acceptance test must cover daemon ownership changes, original capture time,
  and credential ownership without copying a key between stores. A separate
  release/archive and marketplace verification round remains necessary.

## Validation

- `pnpm build`, `pnpm typecheck`, `pnpm test`: 303 suites, 4,651 passed,
  two platform skips.
- macOS XCTest: quota vectors, account lifecycle, provider status and device
  previews; 30 tests passed with snapshot rendering enabled. The initial
  preview failures were the stale compaction assertions described above.
- iOS Simulator build (arm64 and x86_64), signing disabled: passed.
- Protocol generation: no generated-file drift. Preview hash gate: 10 pins
  synchronized. Token mirrors: all seven synchronized.
- Markdown, design catalog and generated devlog gates passed. Design lint in
  a clean source snapshot still reports the base's 89 violations in untouched
  HTML (82 hex, five radius, two pure-white/black); no new violations.
- Actual shared SVG renderer and native ImageRenderer inspected for crowded
  three-provider D200H, TRMNL, IPS10 and round previews. Test renders are
  stored outside tracked sources under `diagnostics/zai-review/`.

No release archive, installation, firmware flash or marketplace submission
was performed. Native test builds were unsigned; they are not store artifacts.
