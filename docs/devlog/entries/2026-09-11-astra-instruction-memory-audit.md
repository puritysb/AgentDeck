# 2026-09-11 — Clarify agent instructions and memory ownership

### Changes

Reduced [AGENTS.md](AGENTS.md) to discovery and routing. `CLAUDE.md` (the root map, renamed `AGENTS.md` on 2026-09-29) now owns current-task authorization, shared-worktree isolation, memory freshness, and checks by change type. Corrected fixed output-limit claims and stale skill-pointer descriptions in [the harness map](docs/agent-harness.md) and skills. Documentation-only local checks no longer imply a full application build; code, CI, and release gates remain explicit.

Agent-local memory cleanup promotes shared-tree lessons into tracked agreements and treats prior release approvals and recovery commands as historical evidence. Required project behavior no longer depends on reading a particular agent's private memory.

### Verification

Validated Markdown links and H1 structure, design-system catalog coverage, and the four changed skills. No application behavior or deployment changed.
