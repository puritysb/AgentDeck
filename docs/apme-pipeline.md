# APME Pipeline

This document describes the current APME data path. The canonical contract is
`SessionSample` (`shared/src/sample.ts`): a bounded task sample plus an ordered
typed trajectory. Timeline rows and evals are projections of that sample where
possible.

## Layers

```
L1 agent signals
   Claude Code hooks/PTY tail
   Codex hooks/parser/PTY tail
   OpenCode SSE
   OpenClaw Gateway chat/session events
        |
L2 adapter normalization
   bridge/src/apme/adapters/*
   source-specific events -> TelemetrySpan
        |
L3 collection
   ApmeCollector opens runs, turns, tasks
   appends sample_events and records raw steps
        |
L4 classification
   computeSignals + rule classifier + optional LLM fallback
   closeTask classifies synchronously when the task row needs a category
        |
L5 evaluation
   run judge, turn judge, task_rollup judge, trajectory scorers
        |
L6 scorecards and recommendation
   v_sample_scorecard, v_model_scorecard, Pareto recommender
        |
L7 surfaces
   /apme/* HTTP, apme_eval WS, dashboard Recommend tab
   optional SessionSample timeline projection
```

There is no active rubric auto-tuner layer and eval results are not emitted as
device timeline `eval_result` activity rows.

## L1-L2: Ingestion

| Agent | Source | Boundary notes |
|---|---|---|
| Claude Code | HTTP hooks plus PTY response capture | `UserPromptSubmit` opens a turn. `/clear` is a task boundary. TodoWrite all-completed is a soft state hint only. |
| Codex CLI | lifecycle hooks when installed, parser/PTY fallback | Hook-primary path handles prompt, tool, stop, and clear spans; parser closes gaps when hooks lag. |
| OpenCode | SSE/timeline events | SSE-derived spans feed the same collector path as hooks. |
| OpenClaw | Gateway `chat`, `session.tool`, `session.message` events | `chat.send` opens a turn, `chat.final` records the response and arms a 90s idle-gap boundary, abort maps to `manual`. |

All paths converge on `ApmeCollector.ingestSpan()` or the legacy collector
methods it dispatches to.

## L3: Collection

The collector maintains live maps:

| Map | Purpose |
|---|---|
| `sessionToRun` | current run for a session id |
| `sessionToTurn` | active turn |
| `sessionToLastTurnId` | response fallback after a turn is already closed |
| `sessionToTask` | active task/sample |
| `sessionToUsage` | cumulative usage baseline for per-sample cost deltas |

Lifecycle:

1. `openRun()` creates a `runs` row.
2. First prompt opens task 0 and turn 0.
3. Tool and model events append to `sample_events`.
4. Response capture appends `assistant_message`.
5. `manual`, `clear`, `session_end`, or `idle_gap` closes the active task.
6. `closeRun()` finalizes git metadata, artifacts, and run classification.

Empty tasks are dropped. Empty runs are tagged `_empty` rather than evaluated.

## Task Boundaries

| Signal | Hard boundary? | Source |
|---|---:|---|
| `manual` | yes | `/task close`, dashboard close action, OpenClaw abort |
| `clear` | yes | `/clear` |
| `session_end` | yes | CLI exit, Gateway shutdown/disconnect |
| `idle_gap` | yes | OpenClaw/Swift idle timer after final response |
| `todo_complete` | no | TodoWrite all-completed; records `state=todos_completed` |

The soft TodoWrite rule is deliberate. It preserves evidence that the agent
declared its todos done without letting an unreliable hook fragment logical
tasks.

## L4: Classification

`computeSignals()` derives tool counts, turn count, duration, file changes,
test commands, web searches, delegations, automation hints, and OpenClaw tool
names. `classify()` applies the ordered rule table documented in
[docs/apme.md](./apme.md#classification). Unknown cases may use LLM fallback.

The task row is classified at close time if the run category is still null or
unknown. This prevents task judges from falling back to the wrong generic rubric
when async run classification finishes later.

## L5: Evaluation

| Scope | Queue | Output |
|---|---|---|
| Run | `runner.enqueue(runId)` | `evals` rows with run-level deterministic/judge metrics |
| Turn | `runner.enqueueTurn({ runId, turnId, category })` | `turn_judge` rows tied to `turn_id` |
| Task | `runner.enqueueTask({ runId, taskId, category, boundarySignal })` | `task_judge` rows tied to `task_id`, plus `tasks.summary/composite_score/outcome` |

The task judge sees all turns in the sample, the task category, and the boundary
signal. It should judge the user's goal, not the amount of activity.

## L6-L7: Surfaces

`ApmeStore` exposes:

| View/API | Use |
|---|---|
| `v_sample_scorecard` | Recommend tab and Pareto quality/cost comparison |
| `v_model_scorecard` | run-level model scorecard |
| `v_category_scorecard` | category-level run scorecard |
| `/apme/samples` | sample scorecard endpoint |
| `/apme/recommend` | model recommendation |
| `apme_eval` WS | live score broadcast |

Timeline projection is opt-in with `AGENTDECK_TIMELINE_PROJECTION=1`. When off,
adapters still emit chat/tool rows directly and APME stays the eval source of
truth.

## Validation Checklist

Use these when changing task/session semantics:

1. Node: `pnpm vitest run bridge/src/__tests__/apme-sample.test.ts bridge/src/__tests__/apme-telemetry-envelope.test.ts bridge/src/__tests__/openclaw-hook.test.ts bridge/src/__tests__/apme-sample-timeline.test.ts`
2. Swift: `xcodebuild test -project apple/AgentDeck.xcodeproj -scheme AgentDeck_macOS -destination 'platform=macOS' -only-testing:AgentDeckTests_macOS/ApmeTaskBoundaryTests`
3. Confirm TodoWrite all-completed does not close a task.
4. Confirm OpenClaw `chat.final` can close via `idle_gap`, and a follow-up prompt cancels that close.
5. Confirm `/clear`, `manual`, and `session_end` still close tasks and trigger task rollup.
