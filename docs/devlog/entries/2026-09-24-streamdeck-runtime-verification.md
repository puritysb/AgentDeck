# 2026-09-24 — Verify Stream Deck deployment against the running plugin

A Marketplace 1.4 validation install replaced the local source symlink and was
left installed after validation. Later builds updated the checkout but not the
installed package. The Deck displayed Luna reserve with ordinary Codex weekly
usage at 70%, despite the local development branch already carrying the display
selection fix. The local voice branch also lacked recent upstream release
changes; package version alone could not identify the intended development code.

`pnpm plugin:deploy` now owns macOS source deployment: refuse temporary linked
worktrees using Git topology, refuse a checkout missing known `origin/master`
commits, build shared/plugin, preserve replaced packages outside Stream Deck's
scan directory, link the persistent checkout, restart, and wait for a fresh
runtime receipt. The receipt captures bundle path, SHA-256 and PID once at startup
and is published only after the Stream Deck connection succeeds. A later rebuild
cannot make the old process claim the new bytes. Failed installation switches
restore the previous package. `pnpm plugin:check` checks the installation and live
process without modifying either.

The installer no longer suppresses link errors and prints unconditional success.
Builds explicitly state that compilation alone is not deployment. The deploy
skill and workflow require restoring the development runtime after Marketplace
validation. Automatic deployment is currently macOS-only; read-only verification
also supports Windows.

Validation on the upstream-based patch: build/typecheck, 4,696 passing tests
(two skipped), protocol regeneration without drift, documentation/catalog checks,
and token synchronization. Three regression tests cover packaged/wrong/missing
links, overwritten bundle bytes, and stale/dead/mismatched runtime receipts.
The existing built-checkout design lint count remains 92 (89 source baseline plus
three generated Ulanzi artifact findings). The new checker reproduced the real
packaged-installation failure; the deployment command refused the task worktree.
