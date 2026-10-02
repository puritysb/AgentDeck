# 2026-10-02 — Hermes conversations end with their process (`hermes -z` never finalizes)

### Measured

This Mac was given a verification-only Hermes install: the official installer with `--non-interactive`, so no gateway service and nothing kept running. It used z.ai `glm-5.3`, and the AgentDeck observer was enabled. Two one-shot runs:

- `hermes chat -q "…" --oneshot`: start, prompt, Stop and finalize all arrived. The APME run closed and the deck row left at once.
- `hermes -z "…"`: the turn closed (`end_source=stop`, about 6 s), but no finalize arrived. The APME run stayed open and the row stayed `idle` until the 30-minute silence TTL.

The cause is upstream, in Hermes main `0a374d167`. `hermes_cli/main.py::_run_and_exit_oneshot` runs `run_oneshot` and then `_exit_after_oneshot`, which calls `os._exit` to dodge a native finalizer abort (#30387, #43055). `run_oneshot` never calls `lifecycle.finalize_session`, and `os._exit` skips `atexit`. So no observer callback can report the end; the plugin's own one-second `atexit` drain never runs either.

### Change

- The observer payload carries `pid` (`os.getpid()`), the process that hosts the conversation.
- `HermesSessions` records it and gains `sweepDeparted(probe)`. A conversation whose process probes `dead` (`ESRCH` only) is closed as a finalize would close it: the row leaves, it is entered in the ended set so a late callback cannot reopen it, and its id is returned. `unknown` (EPERM, any other error) never closes. A row with no pid keeps the TTL path. Each pid is probed once per sweep, so a gateway's conversations close together.
- The Node daemon runs `sweepDepartedHermes()` on its five-second coordination tick and closes each departed conversation's APME run.

`isProcessAlive` (session-registry) was not reused: it folds EPERM into "dead", which would close a live conversation whose probe was merely refused.
