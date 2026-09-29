# 2026-09-27 — Codex's memory-consolidation agent is not a user session

A Codex creature labelled "memories" appeared as WORKING on the dashboards.
It was not a project, and it was not caused by a stale deployment. Codex runs
a `memory_consolidate_global` job (`~/.codex/memories_1.sqlite`) as an
ephemeral thread. Its cwd is `~/.codex/memories`, it has no rollout and no
`threads` row, and it still fires the user-global lifecycle hooks, so both
daemons created a `codex-cli` row for it. The job's `started_at` (17:57:29 KST)
and the row's `startedAt` (17:57:34) confirmed the match.

The Codex background-thread gate that already drops Desktop ambient-suggestion
threads now also drops a thread whose hook cwd is Codex's memory store
(`$CODEX_HOME/memories`, or any `…/.codex/memories`). That cwd arrives on the
first hook, so nothing is created and nothing needs retracting. The passive
observer and the hook-row fallback apply the same predicate as a second line of
defence. Ten `cwdVectors` in `shared/codex-ambient-vectors.json` are replayed by
the Node and Swift suites. They include a user project that is merely named
`memories`, which must stay visible.
