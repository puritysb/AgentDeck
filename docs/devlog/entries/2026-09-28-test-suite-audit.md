# 2026-09-28 — Test suite audit: a real-daemon E2E, an honest coverage floor, and a public verification catalog

An audit of what the tests actually prove. The Vitest suite itself was sound
(4,914 tests, no `.only`, no `expect(true)`, all sockets on ephemeral loopback
ports), but the evidence around it was not:

- **Nothing ever started the daemon a user runs.** `startDaemon()` in
  `bridge/src/daemon-server.ts` (a ~5,900-line closure holding the route table,
  the auth chokepoint and `/hooks/*` ingestion) was imported by no test; the
  file sat at 9% line coverage. The only end-to-end evidence was deploying to a
  Mac, where runs stalled on privacy dialogs. New
  [tests/e2e/daemon-hub.e2e.test.ts](tests/e2e/daemon-hub.e2e.test.ts)
  (`pnpm test:e2e`) spawns `bridge/dist/cli.js daemon start --foreground --local
  --loopback` in a temp HOME on a private `--port-window` and checks, from outside:
  hooks → `state_update` idle → processing → idle, the installer's exact hook
  snippet discovering the port through `daemon.json`, PreToolUse/Stop answering
  at once with no approving device, `timeline.json` persisted and replayed after a
  restart, `daemon.json` withdrawn on SIGTERM, and the port closed on the LAN
  address. Six cases, ~3 s, stable over repeated runs. A clean shutdown ends in a
  deliberate self-SIGKILL (`exitProcessNow`), so the test asserts "exited on its
  own before the fallback kill", not exit code 0.
- **The coverage floor could not fail.** Thresholds were 17/15/14/16 against
  measured 59.6/60.0/55.3/58.6. Now 56/57/52/55.
- **CI ran the whole suite twice** (`pnpm test`, then `vitest --coverage`). One
  coverage run now, then the E2E.
- **Hidden skips.** Three darwin/win32-only cases in `daemon-supervisor.test.ts`
  and the Swift half of `ips10-roster.test.ts` returned early and reported PASSED
  with zero assertions on Linux; they are `it.runIf`/`it.skipIf` now. Two
  `codex-output-parser` cases and one `daemon-ws-client` case asserted nothing;
  they assert the truncation, partial-ANSI and no-crash behaviour now.
  `BridgeClient` takes an optional handshake timeout, cutting a 6 s real wait.
- **The Pages report misdescribed itself.** It classified 26 of 326 test files
  (the rest were "Other Tests"), its scenario matrix referenced two deleted test
  files, it quoted the coverage floor as literals, and it said Apple tests were
  "not executed" although `apple-test.yml` runs them.
  [scripts/verification-catalog.json](scripts/verification-catalog.json) is now
  the SSOT for every gate (where, when, blocking, what it proves, what it does not),
  the test-domain map, and what is not verified automatically; the report renders
  it as a "What we verify" tab and reads the floor from `vitest.config.ts`.
  `scripts/__tests__/verification-catalog.test.ts` fails when a workflow is
  missing from the catalog, a path is gone, a test file has no domain, or the
  scenario matrix names a missing file.
- **macOS prompts and agent token cost.** New
  [scripts/macos-preflight.sh](scripts/macos-preflight.sh) probes Automation,
  Accessibility, Screen Recording, firewall and DevTools grants with bounded,
  non-interactive calls (granted / denied / unknown, exit 2 / 3) and is Step 0 of
  the deploy skill and the capture scripts. The skills stop reading the 1 MB
  `DEVELOPMENT_LOG.md`, filter diagnostic tails to ~100 lines, send build logs to
  `diagnostics/logs/` and show only the tail, and drop the macOS-incompatible
  `timeout` in the board-identification loop.

Follow-up the same day, from running everything again on a freshly started
container:

- **Cold-start timeouts.** The first full `vitest --coverage` after boot failed
  three tests at the 10 s limit (import phase 45 s; a warm re-run passed all
  327 files). 27 files open an `ApmeStore` — the first `better-sqlite3` load —
  inside `beforeEach`, and `preview-mirror-sync` spawns a cold `node`. CI
  runners start cold too, so `hookTimeout` is now 30 s and that one test has a
  30 s budget; a genuine hang still fails.
- **The report page now follows the design system.** It had drifted because it
  is generated: `design/lint.sh` walks committed files and never saw it, and the
  token verifier deliberately skipped its body. It used Tailwind greens and
  yellows for pass/coverage (painting 59.6 % coverage as a warning while it was
  above the floor) and a sidebar-app layout unlike every sibling. It is now
  rebuilt in the Devices page grammar with tokens only, and status hues follow
  §2.7. It also had a mobile overflow (visually hidden spans escaping the table
  scroller, page 644 px wide at 390 px), and its language selector was wired
  only when the URL had a hash. New `scripts/__tests__/build-health-report.test.ts`
  renders it from fixtures and lints the output. The verifier's body sweep is on
  for the generator. Fixing that exposed a verifier bug: a css-root mirror's
  non-colour values were compared un-normalised (`16px` against `16`), so any
  mirror declaring spacing or type tokens drifted.
- **Scenario matrix, again.** Ten name patterns matched no test (for example
  "permission" in `tier3-integration`, which has no permission test), so the
  page showed "not found". They now name real tests, and the catalog test
  fails when a pattern disappears from its file.

Not done, recorded as follow-ups: the XCTest host still starts the in-process
daemon (firewall / Local Network / Bluetooth prompts during a local `xcodebuild
test`); the darwin usage poller has no switch to skip the Keychain, which is why
the E2E is opt-in on macOS; `setup/src` is outside coverage; two ~54 KB SVG
snapshot files are too large to review in a diff.
