# 2026-10-18 — Claude's per-tool rows crowded every device's timeline

Commit 3558b8c9 (2026-09-17) added Claude Code's `PreToolUse` / `PostToolUse`
hooks to the Node daemon's timeline as `tool_request` / `tool_resolved` rows
marked `toolEvent`. They are opt-in on the wire: only a surface that negotiates
`timeline.tool-events.read` receives them, and no AgentDeck app, plugin or board
does. The wire filter worked. The capacity cost did not stay behind it: the rows
sat in the same 200-row buffer, `timeline.json` and per-session reads that every
first-party client depends on.

Measured on this machine on 2026-10-18 (row counts only):

- The persisted buffer (`~/.agentdeck/timeline.json`) spanned 23.6 h. 138 of
  its 200 rows were `toolEvent` rows from two Claude sessions and 60 were task
  rows. The other two were one `chat_start` and one Codex subagent row, so the
  buffer held no reply at all. An earlier read the same day found 3 prompts and
  2 replies.
- A plain WebSocket client on the live daemon got 73 rows of connect history:
  60 task rows, 11 Codex subagent rows, 2 replies and no prompt.
- `query_session_timeline` for this very session, which had run dozens of turns
  that day, returned 3 rows, all task rows. The handler took the session's last
  16 rows and only then dropped the `toolEvent` ones, so a busy turn left
  nothing.

Three mechanisms, one cause:

- **Eviction.** `evictOne` sheds plain `tool_exec` rows first, because they
  stand alone, and leaves `tool_request` / `tool_resolved` to plain FIFO,
  because an approval pair must not be split. The hook rows reused those two
  types, so they took no precedence over chat rows. In FIFO order a turn's
  `chat_start`, always its oldest row, goes first.
- **The Stop and SessionEnd turn checks** read the session's last 24 rows of
  any type. When a turn's own tool rows pushed its `chat_start` out of that
  window, the Stop saw no open turn. A reply went out on the response-only path,
  with no `startedAt` and no tie to its prompt, and a turn with no reply text
  got no closing row at all. A session that exited mid-turn got no
  `Interrupted` row at its SessionEnd, so its prompt kept spinning until the
  turn watchdog's three-minute silence rule closed it. The window alone accounts
  for at most 269 of the 1,183 Claude turns closed by a Stop over 30 days: the
  ones with 12 or more tool calls. Exact dedup folds a repeat of the same tool
  name within 8 s, so fewer of those reached 24 rows. Eviction could drop the
  prompt from the buffer outright, whatever the turn's length.
- **The review judge's context** took the last 16 session rows and kept the
  chat ones, so a busy session gave it almost no request/response text.

The fix evicts `toolEvent` rows ahead of everything except over-cap task rows,
a request together with its result. Turn checks and the review context read the
session's chat rows whole (`getChatRowsForSession`). The Detail query leaves the
hook rows out before its limit. The new daemon e2e runs a 15-tool turn and a
session that exits mid-turn. Against the previous build it fails at the anchor:
`expected undefined to be 1792306858397`.

Rejected alternatives:

- **Keep the rows out of the buffer entirely and only broadcast them live.**
  An opted-in surface's history replay would hold none, which changes what the
  surface protocol promises.
- **Give them their own cap, as task rows have.** Any fixed share still takes
  capacity from rows every client reads. First-party rows now always win, and
  hook rows use whatever is left.
- **Port Swift's `ChatTurnAnchorTracker` now.** Reading the chat rows whole
  gives the same "most recent prompt newer than the last completion" rule while
  the buffer holds the prompt row, and the eviction change is what keeps it
  there. The remaining gap: a turn that runs while other sessions push about
  140 turn-level rows through the buffer (200 less the task share) can still
  lose its prompt row. The tracker would cover that.

An App Store build of the Swift daemon is not affected. It never produced these
rows, and it rehydrates only its own container file plus the wire snapshot it
staged as a Node client, which Node had already filtered. An unsigned dev build
sharing `~/.agentdeck` reads Node's file directly and keeps the hook rows as
plain tool rows: `DaemonTimelineEntry` has no `toolEvent` field, and the Swift
low-signal filter does not drop Claude's tool rows. That edge is left as is.
