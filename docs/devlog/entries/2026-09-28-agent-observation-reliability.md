# 2026-09-28 — Ordinary agent observation reliability (#411)

## Scope and decisions

[Issue #411](https://github.com/puritysb/AgentDeck/issues/411) tracks the ordinary-session integration audit and implementation. Cloud Claude Code observation remains deferred. Existing Claude/OpenClaw paths and managed-session launchers remain supported; this work adds no relay, automatic trust, broader folder grant or paid probe.

## Changes

- Codex installers preserve an existing explicit `hooks = true`, comments, CRLF, user lifecycle arrays, trust state, notify and OTel. Ambiguous multiline values, broken fences, unreadable files and symlinks are refused without replacement. The managed block now places `notify` in root scope, fixing its previous placement under the last hook table. Node uses unique temporary files and preserves file permissions. Both writers recheck the original before replacement; this is conflict detection, not a filesystem-wide lock against arbitrary external writers.
- Codex SessionStart establishes idle and preserves an already active state. A resumed hook-only session clears its previous terminal eviction timestamp. Swift metadata upgrades retain the whole session value instead of reconstructing a subset of fields.
- OpenCode handles current `permission.asked` string-valued `permission`, `permission.replied.requestID`, and question events. Identity-scoped waits survive unrelated tools and mismatched replies. Questions remain display-only. Swift hooks take row ownership from optional SSE; SSE keepalive/disconnect affects only its own rows. A stream attaches before reading busy/pending requests, and connection epochs reject callbacks from an older connection. The pending-request cap has one TypeScript source and a generated Swift value.
- Kiro Swift discovers legacy flat and current nested v3 stores, retains stable session IDs, and reads only a bounded tail of the retained roster. Explicit v3 turn boundaries drive processing/idle; reasoning records never become response text. Roster and timeline share one snapshot created under the existing folder grant. Node's timeline reader also accepts the nested v3 format and uses bounded tail reads.
- CLI diagnostics separate registration-file evidence from unverified availability and unchecked event reception. The product matrix now states setup, consent and source limitations for each supported path.

## Verification and remaining evidence

Shared non-sensitive fixtures gate Codex config edits, OpenCode request identity and nested Kiro records in Vitest/XCTest. Plugin tests execute the generated OpenCode observer. TOML output is additionally checked with Python's independent `tomllib` parser. Hosted XCTest no longer starts the production daemon automatically. Local macOS tests use ad-hoc signing without entitlements, so they verify native code and fixtures, not App Store sandbox consent.

Build, typecheck, Vitest, targeted XCTest, generated protocol/rule drift, documentation and design checks are recorded on #411 and its PR. The initial full test run selected incompatible Intel tools from `/usr/local/bin`; verification uses an ARM-first PATH for the command only. Clean-tree design lint remains at the base's 89 violations with no new records.

Live CLI/App Store coexistence, real Codex trust and OpenCode reconnect/approval delivery remain release verification. No integration was installed into the user's configuration, no running daemon was restarted, and no device deployment was performed by this task.
