# APME — Agent Performance Monitoring & Evaluation

APME turns AgentDeck agent activity into evaluable local samples. The canonical
unit is **`SessionSample`**: one bounded task with a typed trajectory of user,
assistant, model, tool, and state events. Both evaluation and the optional
timeline projection derive from this sample instead of from separate ad hoc
event streams.

All data is stored locally in `~/.agentdeck/apme.sqlite` (or the App Store
container equivalent). Results are exposed through `/apme/*`, `apme_eval` WebSocket
events, and the APME dashboard. Eval rows are not appended to the device
timeline as `eval_result` activity rows.

## Unit Model

| Unit | Stored in | Meaning |
|---|---|---|
| Session / run | `runs` | One observed agent lifetime or clear-bounded run segment. For CLI agents this starts at CLI launch and ends at exit; Node `/clear` splits the run because it resets context. OpenClaw daemon integration opens a run for each Gateway connect/disconnect lifetime. |
| Turn | `turns` | One user prompt plus captured assistant response. A new `UserPromptSubmit`, `chat_start`, or parsed `user_prompt` opens a turn; the next turn or session close finalizes it. |
| Task / sample | `tasks` + `sample_events` | The evaluation unit. It groups one or more turns between explicit or deterministic task boundaries and carries the typed trajectory used by scorers. |

Task boundaries are intentionally conservative:

| Boundary | Source | Effect |
|---|---|---|
| `manual` | `/task close`, dashboard/detail close action, OpenClaw abort | Closes the active task without resetting the whole session. |
| `clear` | `/clear` | Closes the active task; Node session bridge also closes the current run and opens a new one. |
| `session_end` | CLI exit, Gateway disconnect/shutdown | Closes the final active task and run. |
| `idle_gap` | OpenClaw chat final, Swift idle timer after response | Closes a task after 90s with no follow-up, so a long OpenClaw session does not collapse into one sample. |
| `todo_complete` | TodoWrite all completed | **Soft hint only.** It records a `state=todos_completed` sample event and does not close the task. |

This means "session" and "task" are separate concepts. A single Claude Code,
Codex, OpenCode, or OpenClaw session can produce multiple task samples, but only
when a stable boundary exists. The old TodoWrite-all-completed hard boundary was
removed because it was unreliable and fragmented logical work.

## Architecture

```
Agent events
  Claude Code hooks + PTY tail
  Codex hooks/parser + PTY tail
  OpenCode SSE/timeline
  OpenClaw Gateway chat/session events
        |
        v
TelemetrySpan adapters
        |
        v
ApmeCollector
  runs -> turns -> tasks -> sample_events
        |
        v
ApmeRunner + scorers
  deterministic checks, LLM judge, task_rollup, trajectory scorers
        |
        v
SQLite scorecards + /apme dashboard + apme_eval WS
```

Primary files:

| File | Role |
|---|---|
| `shared/src/sample.ts` | `SessionSample` and typed trajectory event contract |
| `bridge/src/apme/store.ts` | SQLite schema, sample reconstruction, scorecard views |
| `bridge/src/apme/collector.ts` | run/turn/task lifecycle and sample event ingestion |
| `bridge/src/apme/adapters/*.ts` | agent-specific event normalization into `TelemetrySpan`s |
| `bridge/src/apme/runner.ts` | run, turn, and task judge execution |
| `bridge/src/apme/scorers/` | trajectory/sample scorers |
| `bridge/src/apme/pareto.ts` | Pareto-frontier recommendation |
| `bridge/src/apme/http.ts` | `/apme/*` HTTP API |
| `apple/AgentDeck/Daemon/Apme/` | Swift daemon mirror of store/collector/runner |

## Classification

`classifier.ts` computes `TaskSignals` from steps and turns:

```
toolCounts, dominantTool, totalToolCalls, turnCount, sessionDurationSec,
promptLengthChars, planModeUsed, permissionRequests, diffReviews,
filesCreated, filesModified, testCommandsRun, webSearches,
agentDelegations, isAutomated, ocToolNames
```

Rule order:

| Priority | Category | Condition |
|---|---|---|
| 1 | `multi_agent` | at least 2 delegations |
| 2 | `planning` | plan mode used |
| 3 | `conversation` | at most 2 tools and under 120s |
| 4 | `planning` | 1-3 turns and no file changes |
| 5 | `research` | web search plus grep/glob-style lookup |
| 6 | `debugging` | tests plus edits plus bash |
| 7 | `refactoring` | mostly edit tools and at least 3 modified files |
| 8 | `coding` | Edit/Write plus file changes |
| 9 | `review` | mostly reads, at least 5 tools, at most 1 modified file |
| 10 | `ops` | mostly bash |
| fallback | `unknown` | rule miss; optional LLM fallback |

`closeTask()` classifies synchronously when needed so the task row has a stable
category before `task_rollup` runs. The daemon also reclassifies closed runs
whose category is still null, covering early process exit or async classifier
misses.

## Evaluation

| Scope | Trigger | Layers |
|---|---|---|
| Run | closed coding/debugging/refactoring/ops run | deterministic checks + LLM judge |
| Turn | captured non-coding response | turn judge |
| Task sample | `manual`, `clear`, `session_end`, or `idle_gap` boundary | `task_rollup` judge + sample scorers |

Task judge input is the full turn transcript for the task, the boundary signal,
and the category. Outputs are stored in `evals` with `task_id`, then summarized
onto `tasks.summary`, `tasks.composite_score`, and `tasks.outcome`.

Costs are sample-granular. Usage snapshots are cumulative, so the collector
emits `model` sample events from deltas and aggregates them into the task header.

## HTTP API

| Method | Path | Description |
|---|---|---|
| GET | `/apme` | APME dashboard HTML |
| GET | `/apme/runs?limit=&agent=&model=` | Recent runs with eval summaries |
| GET | `/apme/run/:id` | Run detail with steps, turns, tasks, evals, vibe |
| GET | `/apme/samples` | `v_sample_scorecard` rows for the Recommend tab |
| GET | `/apme/scorecard` | Run-level model scorecard |
| GET | `/apme/categories` | Category scorecard |
| GET | `/apme/rubric/current` | Current rubric |
| POST | `/apme/vibe` | User label: `{ runId, verdict, note? }` |
| POST | `/apme/recommend` | Model recommendation from scorecard/Pareto data |

## Verification Coverage

Key regression suites:

| File | Coverage |
|---|---|
| `bridge/src/__tests__/apme-sample.test.ts` | `SessionSample` reconstruction, dedup, cost aggregation |
| `bridge/src/__tests__/apme-telemetry-envelope.test.ts` | adapter spans, `/clear`, soft `todo_complete`, task boundaries |
| `bridge/src/__tests__/openclaw-hook.test.ts` | OpenClaw `chat.send`, `chat.final`, abort, `idle_gap` span contract |
| `bridge/src/__tests__/apme-sample-timeline.test.ts` | OpenClaw session tool/message trajectory capture |
| `apple/AgentDeckTests/ApmeTaskBoundaryTests.swift` | Swift collector task boundaries, idle-gap races, TodoWrite soft hint |

## Schema Versioning

External APME responses use `agentdeck-eval/v1` from
`shared/src/eval-schema.ts`. Additive optional fields, new rubric axes, new
categories, and new boundary signals can stay on v1. Renaming/removing fields
or changing existing field semantics requires a v2 migration window.
