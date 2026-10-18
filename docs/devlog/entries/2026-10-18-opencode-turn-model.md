# 2026-10-18 — OpenCode turns record their model; Swift stamps hook Stop models

The first `agentdeck apme coverage` run (30 days, Node store) showed every
finished observed OpenCode turn without a model: 0 of 39. The managed SSE path
already read `modelID`, but the standalone observer plugin's `opencode_stop`
carried only the reply, and the stop is the only hook the daemon reads a model
from.

The producer was measured before the plugin changed. OpenCode 1.18.35 persists
its sync events in `~/.local/share/opencode/opencode.db` (`event` table), so the
shape of every `message.updated` it ever published can be read, read-only,
without running a prompt or spending a request. All 10,474 assistant updates
carried `modelID` and `providerID`, including the 6,980 written before the
message completed, and every stored assistant message (3,683) does too. In the
latest session the final assistant update is the last event of the turn: no
assistant re-emit follows it, unlike the user message, which OpenCode updates
again mid-turn.

Plugin v5 keeps the turn's latest assistant model per session, sends it on the
stop as `model` and `model_provider`, and drops it with the turn. Values from a
Task-tool child session stay out of the parent's turn. A turn that produced no
assistant message sends no model rather than the previous turn's.

`providerID` names the endpoint, so the daemon now passes it to
`normalizeModelProvider` ahead of the model id. The model id alone reads
`mlx-community/Qwen3.6-35B-A3B-4bit` as `alibaba`; the endpoint says `local`,
which is what the provider axis means. Names outside the allow-list
(`zai-coding-plan`, OpenCode Zen's `opencode`) fall back to the model id as
before. Adding `zai-coding-plan` to the allow-list was rejected: it changes the
generated Swift and Kotlin mirrors and gains nothing, since `glm-*` already
resolves to `zai`.

Reading the Swift daemon for parity turned up a wider gap. It never stamped a
hook Stop's `model` on the turn: run open reads `model_name`, which only the
Hermes path maps, and `ApmeCollector.updateModel` has no caller. Codex turns
recorded by the macOS app therefore had no model either.
`DaemonServer.stampApmeStopIdentity` now does what Node's Stop path does with
`updateModel`. Node also stamps at `session_end`. No hook producer sends a model
there, and the Swift `session_end` drops the run before a stamp could find it,
so the Swift helper covers `stop` only.

Existing plugin files change only when `agentdeck daemon install`, setup or
`agentdeck opencode` rewrites them. Turns recorded before then keep a NULL model,
and none are backfilled. OpenCode's own store would allow a backfill, but
whether to run one is a separate decision.
