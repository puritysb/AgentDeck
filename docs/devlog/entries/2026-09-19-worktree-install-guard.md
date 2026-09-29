# 2026-09-19 — Worktree installs refused (Stream Deck dark-key incident)

The Stream Deck lost every status key after the luna-reserve worktree was
merged and removed: the plugin directory under Elgato's Plugins folder is a
symlink, and it had been linked from inside `__worktrees/luna-reserve` — a
directory that no longer exists. Stream Deck silently skips a plugin whose
manifest is unreadable, so the bridge was healthy (daemon on 9120, all ESP32
boards connected) while the plugin process simply did not exist. The same
session had also left the daemon running on native modules loaded from the
removed worktree (held open by deleted file handles) and an npm-global
`@agentdeck/bridge` package emptied mid-operation, which is why
`agentdeck diag` could not even run. Recovery: rebuild from the main
checkout, re-link the plugin (`streamdeck link` from `plugin/`), replace the
CLI shim with a symlink to `bridge/dist/cli.js`, and kickstart the launchd
unit.

Two guards now refuse to recreate the failure mode. `scripts/install.sh`
aborts when its project directory resolves (via `pwd -P`) inside
`__worktrees/`, before it can link the plugin or the CLI. `agentdeck daemon
install` checks both unit targets — the `which agentdeck` path the
plist/task ExecStart bakes and the running cli.js the systemd unit resolves —
against `isWorktreeCheckoutPath`, a segment-exact (both separators, so
Windows paths classify on any platform) check exported from cli.ts, and
exits with the main-checkout/npx recovery hint instead of writing a unit
that would launch deleted files. Worktree development builds keep working:
only long-lived links are gated.

Validation: new guard cases in bridge cli.test.ts (segment match, main
checkout and npm-global accepts, substring non-match, Windows separators),
full vitest suite 4,546 passed, `pnpm -r tsc --noEmit` clean; `pnpm lint`
reports only pre-existing baseline failures (unchanged on stashed master),
and `bash -n` plus a PASS/REJECT matrix cover the shell guard.
