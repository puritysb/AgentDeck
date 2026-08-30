---
id: system.agent-harness
title: Agent Harness
description: How each coding agent enters the repository, what it reads, and where skills and workflows are discovered.
category: Engineering
locale: en
canonical: true
status: stable
owner: Repository maintainers
reviewed: 2026-07-21
revision: 2026-07-21
source_of_truth: docs/agent-harness.md
validators: [pnpm design-system:check]
---
# Agent Harness — developing AgentDeck with any coding agent

This repo is built by switching between **Claude Code, Codex, OpenCode, and occasionally Antigravity**. This doc is the canonical map of the *developer-facing harness*: the instruction files, skills, workflows, and discovery surfaces that steer whichever agent is currently editing the code, so an agent can be swapped in without re-learning the project or following stale procedures.

> This is about the **meta-layer that steers the agent doing the work**, not AgentDeck's product features (which *observe* agent sessions). For the product's per-agent session-observation matrix, see [appstore-feature-matrix.md](appstore-feature-matrix.md) and [architecture.md](architecture.md).

## Tier model (read in this order)

1. **`AGENTS.md`** — the entry file every agent reads first (Codex/OpenCode/Antigravity discover it by convention; Claude Code reads `CLAUDE.md` directly). It requires `CLAUDE.md` and points back here.
2. **`CLAUDE.md`** — **SSOT** for architecture, protocol, ports, conventions, design system, and App Store invariants.
3. **`DEVELOPMENT_LOG.md`** — searchable recent history (current month plus the preceding month). Never read it in full; check the top, then `rg` for keywords/filenames. Older months live under `docs/devlog/`.

## Supported-agents matrix

| Agent | Enters repo via | Instruction files it reads | Skill/workflow auto-discovery | Known limits in the harness |
|---|---|---|---|---|
| **Claude Code** | native `claude` (`agentdeck claude` is legacy compatibility) | `CLAUDE.md`; `.claude/skills/` | `.claude/skills/*.md` (pointers → `.agents/skills/`) | `.claude/skills/` files must stay **pointers**, not procedure copies |
| **Codex** | native `codex` (`agentdeck codex` is legacy compatibility) | `AGENTS.md` → `CLAUDE.md` | `.agents/skills/` (repo-scoped) + `.agents/workflows/` | — |
| **OpenCode** | native `opencode` (`agentdeck opencode` is legacy compatibility) | `AGENTS.md` → `CLAUDE.md` | No repo hook/skill auto-discovery | Fully supported as a product session type through the observer plugin; when authoring this repo, point it explicitly at `.agents/workflows/<name>.md` |
| **Antigravity** | manual editing, or native Antigravity CLI/app | `AGENTS.md` → `CLAUDE.md` | Instruction files only; no repo hook/skill auto-discovery | Current product session visibility is CLI-daemon passive discovery only; the App Store app shows usage/credit status, not coding-session observation |

Notes:
- **Claude Code & Codex** are the two first-class authoring agents: both get lifecycle hooks (Claude: `~/.claude/settings.json` — written by the CLI installer, or by the App Store opt-in installer against the user-selected file; Codex: `~/.codex/config.toml`) and discover skills.
- **OpenCode** is a fully supported *product session type* through its observer plugin. The legacy `agentdeck opencode` PTY + SSE overlay remains available as a replacement-gated compatibility path. OpenCode still does not auto-discover this repo's skills or hooks as an authoring tool; explicit workflow paths are the supported handoff.
- **Antigravity** reads the repo instruction chain only. AgentDeck does not install or auto-discover Antigravity hooks/skills; the App Store app reads only the user-approved usage/credit database, while coding-session creatures require optional CLI-daemon passive discovery.

## SSOT rules (where each kind of knowledge lives)

| Knowledge | Canonical home | Do **not** |
|---|---|---|
| Architecture, protocol, ports, conventions, App Store invariants | `CLAUDE.md` | re-state rules in `AGENTS.md` beyond a pointer |
| Executable **skills** (deploy, diagnose, session-end, workflows index) | `.agents/skills/<name>/SKILL.md` | put procedure content in `.claude/skills/` — those are pointers |
| Human-readable **procedures** (build, start-dev, xcode-debug, …) | `.agents/workflows/*.md` | hand-roll command sequences when a workflow exists |
| Decisions, bugfixes, hardware findings, pitfalls | `DEVELOPMENT_LOG.md` | dump everything into `CLAUDE.md` |

### Skills are single-source

Canonical skills live under **`.agents/skills/<name>/SKILL.md`** (modern, agent-agnostic, Codex-discovered and Claude-discoverable) and are **committed to git**. The files under `.claude/skills/` are **thin pointers** that preserve Claude Code's `/deploy` and `/sdc-diagnose` slash invocation and forward to the canonical file — note `.claude/` is **gitignored** (per-developer), so those pointers are machine-local while the procedure they reference is the shared, version-controlled source. When a procedure changes, edit only the `.agents/skills/` copy. Current skills:

- `agentdeck-deploy` — build/install/launch across Android, Apple, ESP32, Stream Deck, daemon
- `sdc-diagnose` — Stream Deck/PTY sync, cursor, hook-ingestion, and state-machine diagnostics
- `session-end` — cross-agent handoff (below)
- `agentdeck-workflows` — index/router into `.agents/workflows/`

## Handoff between agents

Before `/clear`, `/new`, switching tasks, or handing work to a different agent, run the **`session-end`** skill (`.agents/skills/session-end/SKILL.md`). It writes a concise handoff (goal, current outcome, changed files, verification, blockers, next action) and updates durable docs only when warranted — separating temporary handoff notes from `CLAUDE.md` / `DEVELOPMENT_LOG.md` / `AGENTS.md`.

## Before you commit (any agent)

```bash
pnpm build && pnpm typecheck && pnpm test
pnpm generate-protocol            # must be a no-op (CI fails on drift)
bash design/lint.sh               # design-rule baseline
python3 design/verify-tokens-sync.py   # token mirror drift
```
CI (`.github/workflows/`) re-runs these regardless of which agent authored the change.
