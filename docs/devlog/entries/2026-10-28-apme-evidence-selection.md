# 2026-10-28 — APME long-task evidence coverage

Read-only measurement of the local CLI SQLite store before deploying P1:
4,038 closed tasks had turn rows; 150 exceeded the ten-turn judge budget.
In 128 of those tasks, the latest non-empty archived response occurred after
the first ten rows and was absent from the previous prefix-only judge input.
The largest task contained 78 turns. No task text or credentials were exported.

The new selection preserves that last non-empty reply even when empty tail
turns exceed the budget. This measures evidence coverage, not improved judge
accuracy: historical verdicts were neither rerun nor rewritten. Synthetic
50-turn/60-event fixtures verify retention of original intent, final response,
older validation output and matching Node/Swift selection.

Native activity uses a session id and task index that can recur after a daemon
handover. Direct review links also require the task start timestamp; absent
private history must not resolve to another run's task with the same index.
See [APME review contract](docs/apme.md#task-review-and-evaluation-evidence).
