# 2026-09-29 — Uninstall now removes the Codex block

`uninstallCodexHooks` had no production caller: `node hooks/dist/install.js uninstall` (what `scripts/uninstall.sh` runs) removed the Claude, OpenCode and Kiro hooks but left the AgentDeck block in `~/.codex/config.toml`. Removing it there was unsafe until the fence stopped implying ownership ([2026-09-29 entry](docs/devlog/entries/2026-09-29-observation-review-config-ownership.md)); with generated-entry removal the uninstall action now calls it. A refusal (for example a hand-modified managed hook group) keeps the file byte-for-byte and prints `Codex hooks kept: <reason>` on stdout, because `scripts/uninstall.sh` discards stderr.

`tests/e2e/hooks-uninstall.e2e.test.ts` runs the real entry point against a temp HOME: a root key inserted after `notify` survives while the block goes, a modified block is kept and reported, and an unconfigured HOME gets no `config.toml`. Without the wiring the first two cases fail.
