---
name: session-end
description: Use when the user asks to end, wrap up, clear, hand off, or prepare continuity for a Codex/AgentDeck session. Summarizes current work, captures next-step memory, updates durable project notes only when needed, and writes a concise handoff for the next session.
---

# Session End

Use this skill at the end of a work session, before `/clear`, `/new`, switching tasks, or handing work to another Codex/Claude session.

## Purpose

Produce a concise handoff that lets the next session continue without rereading the whole transcript. Separate temporary handoff notes from durable project knowledge.

## Workflow

1. Read `AGENTS.md` and the top of `DEVELOPMENT_LOG.md` (a generated aggregate — the entries behind it live in `docs/devlog/entries/`).
2. Inspect the current work state:

```bash
git status --short
git diff --stat
```

3. If files changed, inspect only relevant diffs needed to summarize the work. Do not revert unrelated changes.
4. Summarize:
   - goal and current outcome
   - files changed and why
   - verification run and results
   - unresolved risks or blockers
   - exact next action for the next session
5. Update durable docs only when warranted:
   - Development log: for meaningful fixes, architectural decisions, hardware findings, or known pitfalls, create `docs/devlog/entries/YYYY-MM-DD-<slug>.md` (first line `# YYYY-MM-DD — title`, sections as `###`, links relative to the repo root), then run `pnpm devlog:build`. When committing is within the task scope, include the entry and its regenerated aggregates together. Never edit `DEVELOPMENT_LOG.md` or `docs/devlog/YYYY-MM.md` by hand.
   - `AGENTS.md`: update only for project-wide architecture, invariants, setup, workflow changes, or persistent agent behavior expectations.
6. Do not write secrets, credentials, tokens, private device passcodes, or raw prompt transcripts into durable docs.
7. If no durable doc update is warranted, say so explicitly in the final handoff.

## Handoff Format

Return this shape:

```markdown
**Session Handoff**
- Goal:
- Current state:
- Changed files:
- Verification:
- Open issues:
- Next action:
- Durable docs updated:
```

Keep it short enough to paste into a new Codex prompt. Include file paths for changed files, but avoid dumping large diffs.

## Notes

- Use Codex `/compact` when the active thread should continue with a compressed context.
- Use `/new` or `/clear` after the handoff when the next task should start fresh.
- Follow `AGENTS.md` Agent working agreements for memory ownership and freshness. Store personal recurring preferences and dated retrieval hints in local memory; required AgentDeck rules belong in checked-in docs. Link to the canonical rule rather than copying its body, and do not turn an old approval or release condition into a permanent gate.
