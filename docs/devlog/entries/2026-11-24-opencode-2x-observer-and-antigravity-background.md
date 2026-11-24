# 2026-11-24 — OpenCode 2.x observer and Antigravity background work

### What the user saw

One OpenCode session was running, in `toolkit`, yet the deck showed two: an idle `puritysb` session and an idle `toolkit` session. The `toolkit` session never went to working.

### Causes, measured on OpenCode 2.4.1

- OpenCode 2.x rejects the 1.x observer plugin at load. It validates `default` against `{id, setup}` / `{id, effect}`, so no `opencode_*` hook reached the daemon after the upgrade.
- With no hooks, the only rows were from the process scan, and a process-scan row is always idle. 2.x runs every session in one `opencode serve --service` started from the home directory. The scan counted that server as a session named after the home folder.

### What the 2.x event stream offers

The measurements came from an isolated server (`XDG_*` and `HOME` pointed at a scratch directory, a capture receiver standing in for the daemon, `session.prompt` over `opencode api`).

| Area | Events |
|---|---|
| Turn | `session.execution.started` and its outcome (`succeeded` / `failed` / `interrupted`); `session.inbox.enqueued` / `delivered` carry user and synthetic messages |
| Tools | `session.tool.input.started` (name), `session.tool.called` (input: `{command, background}` for `shell`), `session.tool.success` / `failed` |
| Approvals | `permission.asked` / `permission.replied`; `form.created` / `replied` / `cancelled` |
| Background | `experimental.job.updated` with `info.kind` `shell` or `subagent` and the parent `sessionID`. A foreground shell emits only a completed update. Subagents always run in the background |

- Every location's `setup` instance receives every location's events, so the observer elects a leader. Two sessions in two directories, one server: each hook arrived once, with the right `cwd`.
- A device "allow" sent through `/opencode/commands` resolved the real permission via `ctx.permission.reply`. The tool then ran.
- `ctx` has no form-reply API, only HTTP `session.form.reply`, so questions are display-only on 2.x.
- Live sequence for "background `sleep 10`, foreground `echo`, subagent":
  - `tool_start` ×3;
  - `background_start` for the subagent (`job`) and the shell (`process`);
  - shell `background_finish` 11 s later, then subagent stop and finish;
  - `stop` with model and provider.

### Antigravity background tasks

Local transcripts held 688 starts that read "Tool is running as a background task":

| Record type | Count | What it is |
|---|---|---|
| `RUN_COMMAND` | 399 | Commands moved to the background |
| `GENERIC` | 289 | Self-set timers (`Task Description: Timer: 30s, Prompt: …`) |

Each command task ends with a `SYSTEM_MESSAGE` from `sender=<task id>`: 371 reported "finished with result" and 21 "was canceled with result". Timers fire through the same sender form, so only `RUN_COMMAND` starts count as work.

### Left open

- Under 2.x a managed `agentdeck opencode` TUI talks to the shared service, which does not carry `AGENTDECK_PORT`. The service's observer may therefore report the managed session a second time. This is not measured.
- A 2.x hook row's pid is the service's pid, so a closed TUI's row lingers until the 30-minute silent TTL.
