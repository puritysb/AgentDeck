# 2026-09-23 — Claude lifecycle truth in the observed roster

Issue [#367](https://github.com/puritysb/AgentDeck/issues/367) reports Windows
Claude sessions remaining idle throughout a 6,575 ms tool call even though
the aggregate state machine receives the hooks. The Node roster previously
merged only awaiting overlays into passive Claude rows.

`HookClaudeSessions` now merges lifecycle state and sanitized tool names into
existing `observed:claude:<uuid>` rows. It never creates identities or changes
observer-owned project, process, task, goal, model or usage metadata. Awaiting
permission/option overlays run afterward and keep precedence. Tool invocation
IDs prevent one parallel completion from clearing another active tool.

Stop clears tool state and closes the turn. SessionEnd suppresses the row;
only explicit SessionStart reopens it. The tracker retains the latest 4096
identities and at most 256 tool IDs per identity, without a time-based expiry
that could interrupt a long-running tool. State is in-memory and starts fresh
on daemon restart. Sessions absent from the passive roster remain absent.

The shared roster broadcast throttle now schedules a trailing refresh instead
of dropping changes inside its two-second window. Feed and WebSocket use the
same merged snapshot. No wire-format, hook installer, approval/control or
firmware change is required.

Validation: build and typecheck pass; 4,684 tests pass with two skipped.
Protocol generation has no drift; docs and token checks pass. Windows live
reproduction remains reporter validation; the local checks run on macOS.
This entry records a source fix, not an npm publication or installed upgrade.
