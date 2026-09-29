# 2026-09-19 — Luna reserve on Codex usage surfaces

Codex accounts with a Luna reserve report it as an additional rate-limit pool
that the account 5h/7d windows do not describe. The live parser
(`parseLiveCodexRateLimits`) now extracts it from `additionalRateLimits` (and
the legacy `rateLimitsByLimitId` reserve block), and `pickBestCodexRateLimits`
preserves the live account read's Luna metadata when the newer passive rollout
wins the window race — rollouts cannot carry additional pools. A
plan-mismatched snapshot is still voided whole, Luna included, by
`normalizeCodexRateLimits`, so a retired reserve cannot pin a gauge on
retain-on-absent clients.

While a reserve is reported it REPLACES the Codex 5h/7d gauges on the Stream
Deck session buttons and encoder, and on the D200H deck (shared layout engine
plus the plugin-ulanzi deck signature, which now invalidates on Luna
appearance/change/disappearance). The tile is a crescent moon with the
remaining percent or EMPTY; both surfaces use the same shadow-disk offset.
The Apple device-preview mirror (D200HLayoutModel.swift) was re-ported and its
SYNC-HASH pin advanced; protocol mirrors (Swift/Kotlin/JSON schema) were
regenerated for the new `lunaReserve` field.

Scope limit: Apple, Android and ESP32 surfaces do not render Luna yet — the
Swift usage parser does not emit the field and the firmware is unchanged.
The wire field is optional, so those clients keep their current Codex gauges.

Validation: build, typecheck and all 4,539 vitest tests passed (two platform
skips), including new parser, merge-preservation, tile, encoder and
deck-signature cases. `pnpm generate-protocol` left no drift after committing
the regenerated mirrors. The macOS DevicePreviewSnapshotTests suite passed
under xcodebuild, including the new Luna replacement test. Token mirrors are
in sync; design lint reports pre-existing base violations in untouched docs
HTML only (non-gating in CI).
