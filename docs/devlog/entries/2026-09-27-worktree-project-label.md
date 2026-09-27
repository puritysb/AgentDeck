# 2026-09-27 — Identify linked worktrees by their repository

A live Claude Code session in `.claude/worktrees/zai-serial-window-minutes`
was displayed as an unfamiliar standalone project after its PR had merged.
The session was actually still running; merge completion is not process exit.

Both project-name resolvers now follow the `.git` file and `commondir` to a
readable common `.git` directory and label the session
`AgentDeck · zai-serial-window-minutes`. The suffix names the checkout folder,
not its current branch, and keeps independent worktree sessions from folding
into the main checkout. Explicit project-name overrides still win. Submodules,
bare common repositories and missing or inaccessible metadata keep their local
name. No processes, locks, worktrees or session IDs are modified.

The existing Node/Swift mirror is covered by shared filesystem fixtures,
including relative and absolute pointers, nested Claude worktrees, spaces,
Unicode, detached HEAD and broken metadata. A real Git worktree test also
checks managed/passive resolver parity and explicit overrides.

Validation: build and typecheck passed; Vitest 4,860 passed / 2 skipped;
macOS build plus 17 ProjectNameResolver XCTest cases passed. Protocol generation
left no drift; token, docs, catalog and devlog checks passed. Clean-tree design
lint reports the same 89 pre-existing violations before and after this change.
