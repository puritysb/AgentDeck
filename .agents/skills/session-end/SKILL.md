---
name: session-end
description: Use when the user asks to end, wrap up, clear, hand off, or prepare continuity for a Codex/AgentDeck session. Closes out in-flight work (uncommitted changes, worktrees, open PRs), records only what the next reader cannot get from git, and writes a concise handoff for the next session.
---

# Session End

Use this skill at the end of a work session, before `/clear`, `/new`, switching tasks, or handing work to another Codex/Claude session. Its job is a handoff the next session can act on without the transcript. It does not create a record of everything that happened; git, the PRs and the issues already hold that.

## 1. Read the state (cheap commands only)

```bash
git status -sb
git worktree list
gh pr list --author @me --state open --json number,title,headRefName,mergeable
```

Do not read `DEVELOPMENT_LOG.md` or the devlog entries here. Nothing in the handoff depends on them.

## 2. Close out what this session started

- **Uncommitted changes.** Commit them on the task branch, or name them in the handoff as deliberately left uncommitted. Never revert, stash, or restore another session's changes in a shared tree.
- **Worktrees this session created.** Remove one only when its branch is pushed, its tree is clean, and no other session owns it (`AGENTS.md` § Agent working agreements). Otherwise list it with the reason it stays.
- **PRs this session opened.** List each with its state: CI, mergeable, review, and what blocks it.
- **Background agents or long commands.** Say whether each is still running. Never report a result you have not received.

## 3. Record only what git cannot

| What you learned | Where it goes |
|---|---|
| A domain invariant (a rule future edits must keep) | the matching `.claude/rules/<domain>.md`. Move the rule body there verbatim; never paraphrase it |
| A measurement, incident, pitfall, or decision with its rejected alternatives | one new file `docs/devlog/entries/YYYY-MM-DD-<slug>.md` (line 1 `# YYYY-MM-DD — title`, `###` sections, links relative to the repo root), committed with the change. Nothing to regenerate |
| A personal preference or dated retrieval hint | agent memory (local, not the repo) |
| What changed and why | nothing: the diff and the PR body already say it |

Update `AGENTS.md` only for a project-wide workflow or invariant change, and stay inside its byte budget (`pnpm docs:check`). Never write secrets, tokens, device passcodes, or raw transcripts into any of these.

## 4. Handoff

```markdown
**Session Handoff**
- Goal:
- Current state: (merged / open PRs with blockers / uncommitted work)
- Worktrees and branches left:
- Verification: (what ran, result)
- Open issues / risks:
- Next action: (one concrete step)
- Records written: (devlog entry / rule / memory, or "none — git holds it")
```

Keep it short enough to paste into a new prompt. Give file paths and PR numbers, not diffs.

## Notes

- Codex: use `/compact` to keep going with compressed context, and `/new` to start fresh after the handoff.
- Claude Code: use `/clear` to start fresh after the handoff.
- Link to a canonical rule rather than copying it. An old approval or release condition is a dated fact, not a permanent gate.
