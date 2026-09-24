# 2026-09-24 — Bound CLI startup recovery after a silent app handoff

Issue #370 recorded fallback after a 20-second preferred-port wait, followed by a successful restart about 58 seconds after that wait began. This is an upper bound on eventual availability, not a measurement of the exact release time or proof of NECP as the cause.

The Node daemon now retries its actual listener with its resolved bind address, up to 90 seconds on macOS and 20 seconds elsewhere. Each failed bind rechecks the peer: a live same-user daemon wins, a foreign daemon is left alone, and non-contention errors propagate. Failed attempts remove both event listeners, avoiding stale success callbacks on a later bind. The successful listener remains bound instead of closing a probe socket and racing to bind again.

This is a startup mitigation, not runtime migration of an already-serving fallback fleet. Persistent conflicts still fall back; no daemon, app, hook, device or store installation was changed. Same-condition published 1.4.1/1.4.2 comparison and real App Store/device coexistence validation remain open in #370.

Validation: build and typecheck passed; 306 test files / 4,693 tests passed (two skipped), including nine new reclaim cases with simulated 58-second contention and real isolated loopback sockets. Protocol generation left no drift. Documentation/catalog and seven token mirrors passed. Broad design lint returned 92 findings: the same 89 source findings as the clean base, plus three findings in ignored Ulanzi build output (record-by-record comparison). No source lint regression; no UI source was edited.
