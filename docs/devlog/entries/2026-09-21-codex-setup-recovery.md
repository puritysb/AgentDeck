# 2026-09-21 — Recoverable macOS Codex observation setup

A support screenshot showed account usage connected while observation remained
“Consent granted, not yet written.” The reporter's actual config and logs were
not supplied, so the exact failing branch is not established.

Source inspection found that an existing user `[features]` table, an
incompatible regular hook table, an unavailable bookmark, and write failures
all reached that same uninformative state. Retry reused a resolvable bookmark
without offering renewed authorization. A failed UTF-8 read was also treated
as an empty configuration, creating an overwrite hazard.

The installer now publishes actionable errors to Settings and offers explicit
retry and file reselection. Cancelling reselection preserves prior consent.
An existing unambiguous `[features] hooks = true` is accepted without creating
a duplicate table; false or missing opt-in remains a conflict with instructions
rather than rewriting user-owned settings. Commented feature headers are
recognized. Model/profile/MCP settings and user hook arrays remain untouched.

File reads fail closed. A change detected between read and write aborts the
attempt. Failed uninstall retains its access grant and installed state so it
can be retried. This is not an interprocess file lock: the final comparison and
atomic write still have a narrow concurrent-write window.

Verification covers existing feature opt-in, conflicting/disabled features,
commented headers, incompatible hooks, missing/non-UTF-8 files, concurrent
modification, idempotence and user-data preservation. No real user config was
edited. Unsigned unit-test builds do not prove security-scoped picker behavior
in the signed App Store build; that remains a release validation requirement.

To identify the reporter's branch, request only the AgentDeck Codex setup log
lines and the relevant feature/hook section shape with secrets removed, not
the complete config. No support reply was sent and no release was deployed.

Validation: `pnpm build`, `pnpm typecheck`, all 303 Vitest suites (4,651
passed, two skipped), 32 macOS installer/MiniToml tests, and the iOS Simulator
build passed. Protocol generation had no drift; all seven token mirrors and
the Markdown/devlog gates passed. Clean-source design lint remains at the
existing 89 violations in untouched files.
