# 2026-10-19 — A slow app quit stopped local deployment for nine hours

**What was found.** No master push reached this Mac from 2026-10-18 17:15Z
until 10-19 01:59Z, so #577–#585 were not live. Six local deployment runs in a
row failed at `A staged app from an earlier deployment needs inspection`. The run
before them had staged the app and then failed at `Installed app did not quit;
preserving it`, which left `/Applications/AgentDeck.deploy-staged.app` behind.

The app did quit, just late. It handles SIGTERM with a dispatch source on the
main queue (`DaemonService.setupSignalHandler`), and it arms its 5 s forced-exit
backstop inside that handler. A busy main thread therefore delays both. The
app's `daemon-crash.log` and `swift-daemon.log` put the handler about 40 s after
the deploy's SIGTERM. The same thing happened on 10-17 08:34Z with a delay of
5 to 6 s, so the 10 s wait gave up at most a second before the backstop would
have fired.

Both times the app then quit on its own, and nothing reopened it until the next
successful deployment. The app's log has no lines between the SIGTERM entry and
the next launch: 43 min on 10-17 and 8 h 49 min on 10-18. "Preserving it" held
for the installed bundle, not for the running app.

`diagnostics/backups/` holds four staged copies that were set aside by hand
since 10-09. The run logs of the two newest both end at the quit wait.

**Now.**

- `beforeSwap` (`scripts/deploy-local-main.mjs`) discards the staged copy when a
  step between staging and the swap fails. Nothing installed has changed at that
  point. The guard stays, because a run killed mid-swap can leave a staged copy
  and a moved-aside backup with no installed app, and that needs a person.
- The quit wait is 60 s. The longest delay seen was about 40 s, and the backstop
  adds up to 5 s.

**Rejected.** SIGKILL after the wait would let every deployment finish, but it
skips the app's clean shutdown, and a 60 s wait already covers both delays seen.

**Backstop off the main queue, closed the same day.** `DaemonService` now
also gives SIGTERM and SIGINT a dispatch signal source on a queue of its own,
which arms `exit(0)` 8 s after the signal whatever the main thread is doing.
The handler on the main queue still runs first when it can, with its 5 s exit;
the new one only matters when the main thread is busy. It is
`makeTerminationBackstop`, a file-scope `nonisolated` function, so no closure
inherits `@MainActor` and traps on the other queue. `exit` runs the `atexit`
in `SingletonGuard` that unlinks `daemon.json`, so a forced quit leaves no
stale registry row. `TerminationBackstopTests` raises SIGUSR2 at the test host
and blocks the main thread on a semaphore that only the backstop's action can
signal. Why the main queue was busy for 40 s is still unknown.
