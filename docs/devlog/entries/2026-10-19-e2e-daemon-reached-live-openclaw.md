# 2026-10-19 — E2E: the daemon under test was talking to the developer's OpenClaw Gateway

**What was seen.** Local `pnpm verify:quick` runs sometimes failed in the E2E
`afterAll` with `ENOTEMPTY` from `rmSync`. Runs that passed left their temp
`HOME` behind as well. At 02:30 on 2026-10-19, `$TMPDIR` held 15
`agentdeck-e2e-*` homes (about 100 MB) and 30 `agentdeck-relay-*` homes (about
206 MB), all from runs since 2026-10-18. What was left in them was OpenClaw's:
`.openclaw/state`, `.openclaw/npm/projects`, `Library/Caches/bun`, `.npm/_logs`.

**Why.** The E2E daemons inherit the developer's environment apart from the
variables the suites override, and the daemon starts its OpenClaw Gateway
integration unconditionally. On a Mac where the Gateway runs, it listens on
`127.0.0.1:18789`, so the daemon under test:

- found the Gateway and opened an adapter connection to it. With an empty temp
  `HOME` the adapter had no device identity or shared token to offer, so it is
  not known to have read any session;
- 5 s later ran `openclaw doctor`, which the shell PATH resolves to
  `~/.openclaw/bin/openclaw`, with `HOME` set to the suite's temp directory.

Doctor bootstraps a fresh OpenClaw state directory there, including npm and
bun installs, and it outlives the daemon. Its writes raced the suite's
recursive delete. CI never saw any of this, because no Gateway runs on
`ubuntu-latest`. The first usage build also spawned `codex app-server` once per
daemon. It wrote nothing that outlived the run, but it ran the developer's
binary.

**The fix.**

- `AGENTDECK_DAEMON_NO_GATEWAY=1` skips the Gateway probe and the doctor
  schedule in `bridge/src/daemon-server.ts`. The adapter is connected only from
  that probe.
- Both E2E suites set it, together with the existing
  `AGENTDECK_CODEX_LIVE_USAGE=0`, and so does the packaged-daemon harness
  (`scripts/verify-packaged-daemon.mjs`), whose restricted PATH still includes
  node's own bin directory, where a global `openclaw` can live.
- The daemon's startup line used to say `Gateway probe active` whether or not
  the probe ran. It now says `off (AGENTDECK_DAEMON_NO_GATEWAY=1)` when gated.
- A hub test waits for that line and requires `off`, which fails on CI too if
  the gate goes. Where a Gateway runs, it also checks that the daemon never
  logged `OpenClaw Gateway detected` and that no `.openclaw` appeared in its
  `HOME`. Those two cannot fail on CI, which runs no Gateway.

**Rejected.**

- **Removing `openclaw` from the daemon's PATH.** `augmentedPath()` adds
  `/opt/homebrew/bin` and home-relative directories back for the model-catalog
  call. The adapter needs no CLI at all, so it would still have reached the live
  Gateway.
- **A stand-in Gateway on 18789 that counts connections** (the first version of
  the test, which bound it only where a connect was refused). It counted every
  local process that probes that port, not just the daemon under test: the
  developer's own daemon every 5 s, managed session bridges every 800 ms, the
  macOS app's daemon every 5 s. A review ran the same stand-in code beside one
  5 s prober and counted 1 or 2 connections by the time the assertion runs, in
  3 of 3 runs. So the test would fail on any machine running AgentDeck without
  a Gateway, and while the suite held the port the live daemon reported a
  Gateway to its devices. A Gateway port the daemon could be pointed at would
  avoid that, but it adds a production setting for a test.
- **Starting the integration only when `~/.openclaw/openclaw.json` exists.** A
  missing or relocated config would then silently cost a real user the Gateway
  integration.

**Not addressed.** The unit tests also leave temp directories behind:
20,563 `agentdeck-vitest-*` directories (1.1 MB in total) since 2026-10-18.
They are small enough for macOS's periodic `$TMPDIR` purge.
