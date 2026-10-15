# 2026-10-15 — Development log: stop committing the generated aggregates; session-end trimmed

### What was wrong

Splitting the log into one file per entry (2026-09-10) ended the write-time conflict between parallel sessions. The generated `DEVELOPMENT_LOG.md` and `docs/devlog/YYYY-MM.md` were still committed, so the conflict moved to merge time. Every PR that added an entry also rewrote the same aggregate:
- 18 of the 40 PRs merged 2026-10-01..15 carried an entry.
- On 2026-10-15, #546 merged first. #547 and #548 then each needed a rebase, an aggregate rebuild and a force push before they could merge.

`devlog:check` also depended on the calendar. The active window moves on the 1st, so master went stale at each month rollover and every open PR failed the gate.

Agents were already told not to open the aggregate and to grep the entries instead, so the committed copy had no reader to justify the cost.

### Decision

The entries are now the only tracked form of the log:
- `DEVELOPMENT_LOG.md` and `docs/devlog/README.md` are fixed guides that do not change when an entry is added.
- The month files are deleted.
- `pnpm devlog:build` writes a local, git-ignored reading view to `docs/devlog/view/`.
- `devlog:check` validates entry format only, so the calendar no longer affects it.
- `check-docs` validates entry links resolved from the repository root. It found no broken link across 953 entries.

### Rejected alternatives

- **`merge=union` in `.gitattributes`.** GitHub's PR merge ignores custom merge drivers, and the month rollover would remain.
- **A bot commit that regenerates the aggregates after each merge.** This adds a commit to master per merge and keeps a 750 KB file nobody reads.

### session-end skill

The skill was used in 1 of 35 Claude sessions in this repository. Its first step read the top of the aggregate. It now:
- reads cheap state only (`git status`, `git worktree list`, open PRs);
- closes out leftover worktrees and PRs;
- records only what git cannot hold: invariants go to the rules, measurements and decisions to an entry, preferences to memory, and anything else nowhere.

AGENTS.md and the harness doc now say an entry is for what the diff and the PR body cannot say.
