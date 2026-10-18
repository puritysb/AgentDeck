# 2026-10-18 — APME coverage: a misrouted Stop reply and a mid-turn queue

Workshop candidate 6 (APME coverage) started from one question per agent: how
much of its work reaches the judge with a reply and a model? The first pass of
that instrument (`agentdeck apme coverage`, 30 days, one store) showed Claude
keeping a reply on 79% of finished turns against 96% for Codex, and Claude's
`stop-health` loss reading 35%. Both turned out to be measurement artifacts with
one root each, and neither was a lost hook.

## Replies went to the previous turn

Every reply that reached a Stop-closed Claude turn through the daemon's
"open turn" branch carries `response_source: direct`; the closed-turn fallback
writes none. Split that way, the 30-day population (1,145 Claude turns closed by
a Stop) is unambiguous: 587 routed to the open turn, **0** without a reply; 558
routed through the fallback, **247** without one. The fallback fired for 417 of
432 turns a `<task-notification>` opened, 136 of 173 other turns with 12 or more
tool calls, and 5 of 540 shorter ones.

The daemon picked the target with its timeline's predicate — a `chat_start` in
the session's last 24 rows with no completion after it. The timeline drops
`<task-notification>` prompts as low signal, and Claude's per-tool
`tool_request`/`tool_resolved` rows push a long turn's prompt out of a 24-row
window. Either way the timeline called the turn closed, and the reply went to
`setLastClosedTurnResponse`, i.e. the previous turn: dropped when it had a
reply, a turn early when it had none. The survivors were the Stops whose own
transcript read came back empty, because the deferred re-read lands after the
turn has closed.

Fix: the collector decides (`recordStopReply`, open turn first). An e2e case
against the real daemon process returns `null` for the notification turn's
reply with the old routing and the reply with the new one. Not backfilled: the
replies are still in the transcripts, but rewriting history is a separate call.
The same 24-row predicate also gates the device timeline's `chat_response` row,
so long Claude turns can lack a reply row there too. That is a separate change
with device-facing effects, left out of this PR.

## A running turn was counted as a lost Stop

Claude Code delivers queued messages (`<task-notification>`, `<agent-message>`,
`<cross-session-message>`) at the next tool boundary of a running turn and fires
`UserPromptSubmit` there. The collector closed the still-running turn as
`next_prompt`, the unrecovered-loss bucket. A retrospective replay of the new rule over 30
days, using the store plus the transcripts: of 587 Claude `next_prompt` closes, 522 had an
enveloped incoming prompt. **517** of those had no `end_turn` between the turn's
start and the displacement, so they are now `injected`. **5** had finished, so they really lost
their Stop. The remaining **65** were typed prompts. Claude's adjudicable loss goes from
623/1,768 (35%) to 106/1,251 (8%).

Measured ordering, 2026-10-18: the hook for a mid-turn notification arrived at
00:32:53.826Z, and the transcript's `queued_command` record for it was written
only after the queue removal at 00:32:54.302Z. At hook time the envelope is
therefore the only evidence that the prompt was queued. Rejected: reading the
transcript for `queued_command` (it is not there yet); classifying any prompt
into an unfinished turn as `injected` (a truncated transcript walk can hide an
`end_turn`, so the claim needs a second, independent fact, the same reasoning
`superseded` uses with its tool-call check). Typed prompts that Claude Code
queued mid-turn stay `next_prompt`, because nothing at hook time distinguishes
them.

Node only. The Swift daemon cannot read the transcript in the sandbox, and
already closes every displaced turn `next_prompt`.

## What coverage shows per agent

OpenCode and Kiro carry no model at all (OpenCode's plugin sends none in
`opencode_stop`; the Kiro timeline feed has neither tools nor a model, and all 8
of its tasks were declined as trivial). Antigravity has no APME producer: the
passive observer polls transcripts for the roster only. Those are the next
coverage items, together with Claude OTel.
