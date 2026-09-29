# 2026-09-15 — Windows autostart review hardening

PR #336 keeps the contributor's detached launcher and no-console fixes. The
maintainer follow-up preserves `unknown` when no daemon registry can be read,
so an answering daemon is not stopped during the discovery-file handover gap.
A readable record without `startedBy` still identifies an unsupervised daemon.
This corrects the earlier entry's acceptance of a temporary `unsupervised`
reading: install acts on that reading immediately, before self-healing.

The launcher now awaits the child's actual `spawn` event before unref and
success exit. Asynchronous spawn errors produce a nonzero launcher exit, so
Task Scheduler can apply its launcher retry policy. This does not add daemon
crash supervision after the launcher exits.

Regression coverage exercises a real failed OS spawn, successful spawn, and
healthy-daemon classification with an unavailable registry. Windows Node
22/24/26 CI now runs the launcher and supervisor suites too.

The Windows UTF-8 hook E2E retains its Korean path and payload assertions.
Its process budget is 30 seconds and the outer test budget 40 seconds to allow
cold Git Bash/PowerShell startup. Failures now report elapsed time, exit code,
signal, killed status and whether HTTP arrived. The previous 10-second failure
suggests timeout but did not contain enough diagnostics to establish its cause.
The production hook's HTTP timeout and encoding behavior are unchanged.
