# 2026-10-11 — Background work became one tracker every agent feeds

The terrarium's background-task buddies (PR #507) read `backgroundTaskCount` from any session row, but only Claude produced it, through its own reducer. The count now lives in one agent-agnostic tracker, `shared/src/background-work.ts`, with a generated Swift mirror. Each agent has an adapter that may only use a signal measured to exist.

**Codex** was measured on codex-cli 0.160.1 with three probes in a scratch directory. In an interactive session, a background terminal started with `exec_command` and a 1 s yield is announced in its tool result as `{"session_id":98364,…}` with no `exit_code`. The `CommandExecution` `item_completed` carrying `process_id: "98364"` is written 11 s after `task_complete`, when the process exits. The same pair exists in the 2026-04 legacy text form (`Process running with session ID 38463`). The id is Codex's own counter, not an OS pid (session 63748 ran as shell pid 10484), and Codex's hooks carry no task list, so the rollout is the producer. Both daemons read its tail after each turn and poll while terminals remain, but only while the Codex pid is alive.

**OpenCode** 1.18.35 has no background shell. Its background subagents (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`) were captured live from its own store: the `task` tool part completes at once with `metadata.background: true` and `jobId` set to the child session id. The end arrives on the parent as a synthetic user text `<task id="…" state="completed">` 19 s later. Observer plugin v4 posts these as `opencode_background_start` and `opencode_background_finish`.

**Hermes** tool hooks carry `task_id`, and its in-process `process_registry.list_sessions(task_id=…)` reports each background process as running or exited (read from the installed source; not run live). Observer v2 posts `hermes_background_snapshot` at each run end and polls while any run.

**Kiro, Antigravity and OpenClaw** get no producer. Kiro and Antigravity have no background-process concept. OpenClaw's exec background registry lives in Gateway memory, with no RPC or event exposing it. Any future agent joins through the generic `<agent>_background_*` hook vocabulary.

**Lesson.** A first reading suggested that quitting Codex loses the completion record. In fact the native `codex` process had outlived the wrapper that was signalled, and it wrote the record later. Re-read a rollout after the process tree is gone before claiming a write never happens.

Rule: [.claude/rules/observed-sessions.md](.claude/rules/observed-sessions.md).
