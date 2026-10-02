# 2026-10-03 — OpenClaw's tool calls fold into one row per turn

### Measured

A voice request ("make the wake keyword respond less eagerly") made OpenClaw walk its own config one key at a time with its `openclaw` tool: `channels`, `channels.line`, `channels.defaults`, `agents.main`, `messages.groupChat`, … — 16 `tool_exec` rows in two minutes, one per call, between the prompt and the reply. The other observed agents' tool rows are suppressed from the timeline (`TOOL_EXEC_SUPPRESSED_AGENTS`); OpenClaw's were kept on purpose, because the gateway's live projection is its only record of what it did, and only placeholder rows were dropped. The user saw the timeline full of "intermediate messages" and asked whether that was right.

### Change

The live projection (`shared/src/gateway-live-activity.ts`, and its Swift template `scripts/templates/gateway-live-activity.swift`) now folds every completed tool call of a run into one row. The first call adds the row with its own label. Each later call upserts the same row in place: same `ts` (the first call's) and `runId`, which both stores already match on. `gatewayToolFoldRaw` / `toolFoldRaw` label it `openclaw ×16 · channels, agents.main, messages.groupChat, … · 1 failed`, or `5 tools · exec ×2, read, openclaw ×2` when the tools differ. The detail keeps the last 40 calls, one per line. `repeatCount` is deliberately not set, because the count is already in the label and surfaces that badge `repeatCount` would show it twice.
