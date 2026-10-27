# 2026-10-28 — Idle Claude sessions read "working" because Claude calls an idle teammate "running"

Two Claude Code sessions showed `processing` · "Waiting for 3/4 background tasks" on every surface for about a day while both sat at an empty prompt (2026-10-27, Remin and toolkit). The live `sessions_list` carried `backgroundTaskCount: 3` and `4`. The terminal footers showed `1 shell · ← 3 agents`, the agents marked `◯` (idle, 1d 21h). Claude's own `~/.claude/sessions/<pid>.json` said `status: idle` for the toolkit session.

**What Claude sends.** Reading the 2.1.311 binary: the Stop/SubagentStop hook builds `background_tasks` from every task that is `running`/`pending` and not explicitly foreground. That covers shells, monitors, subagents, workflows, `in_process_teammate`, `remote_agent`, `dream`, `auto_mode_scan` and MCP tasks. Each entry is `{id, type, status, description, …}`, with `type` the friendly label (`shell`, `subagent`, `teammate`, `monitor`, `cloud session`, …) falling back to the raw discriminant. There is **no idle bit**. A teammate idling between mailbox messages stays `running`. Claude's own active predicate excludes `in_process_teammate && isIdle` and a long-running `remote_agent`, and its footer counts shells separately. The hook loses both distinctions. An isolated `claude -p` probe (scratch `--settings`, `--setting-sources ""`) confirmed the shape for `subagent` and `shell`. Named agents in `-p` run as ordinary background subagents, so the teammate shape is from the binary only.

**What it was.** Remin had a `run_in_background` picking-page server (`serve.py 8817`, alive for hours) plus two idle teammates. Toolkit had no live background shell at all: three idle teammates plus one more running entry.

**Decision.** Every background item now has a kind. A `job` ends on its own and stays active until it does. A `process` may run indefinitely, so it is active for 10 minutes from its first sighting and on standby after that. Standby work rides a new additive `backgroundStandbyCount`, does not hold the parent working, and renders as `STBY n` beneath any active `BG n`.

Rejected alternatives:
- Dropping teammates and shells from the count entirely would hide real work: a freshly spawned teammate or a 3-minute background test run is exactly what the working display exists for.
- Inferring a server from the command text or from listening sockets is a guess the sandboxed Swift daemon cannot make the same way.
- Adding a new `state` value would render as nothing on every client that predates it.

Not changed: the terrarium buddies and the ESP32/Pixoo/matrix surfaces read only the active count, so standby work shows nothing there (an honest idle creature), and ESP32 firmware does not yet parse the new field.

Rule: [.claude/rules/observed-sessions.md](.claude/rules/observed-sessions.md).
