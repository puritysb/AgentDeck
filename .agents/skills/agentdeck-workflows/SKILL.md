---
name: agentdeck-workflows
description: Use for AgentDeck build, dev-server, Stream Deck plugin, Android release, or Apple/Xcode diagnostic workflows. Reads the matching .agents/workflows file and follows it instead of guessing commands.
---

# AgentDeck Workflows

Use this skill when the user asks to build, run dev mode, link/package the Stream Deck plugin, build Android, or debug an Apple/Xcode reproduction.

## Required Context

1. Read `CLAUDE.md` before running workflow commands.
2. Do not open `DEVELOPMENT_LOG.md` (a generated ~1 MB aggregate). Search the per-entry sources for the subsystem you are touching — `grep -ril '<keyword>' docs/devlog/entries/ | tail -5`, or `ls docs/devlog/entries/ | tail -10` for the latest — and read only the matching entries; for a month's history grep one `docs/devlog/YYYY-MM.md`, never all of them.
3. Preserve App Store invariants from `CLAUDE.md` and `AGENTS.md` when touching Apple UI, daemon, setup, or diagnostics.

## Workflow Map

- Android release APK: read `.agents/workflows/build-android.md`.
- Stream Deck plugin build/link: read `.agents/workflows/build-plugin.md`.
- Dev watch mode: read `.agents/workflows/start-dev.md`.
- Apple/Xcode diagnostics: read `.agents/workflows/apple-xcode-debug.md`.

## Execution Rules

- Treat the workflow file as the canonical command sequence for that task.
- Follow `CLAUDE.md` Agent working agreements for existing authorization and execution-policy failures.
- For Apple/Xcode diagnostics, capture repository-side diagnostics before editing code when the issue was reproduced from Xcode.
- Keep generated diagnostics under `diagnostics/`; do not commit them.
- Report which workflow file was used and the verification result.
