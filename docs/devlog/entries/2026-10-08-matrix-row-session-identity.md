# 2026-10-08 — iDotMatrix/Timebox: rows find their session in either id form; ASK becomes HEAR

The iDotMatrix showed DONE over a neutral square face on most results. `MatrixExpression` matched timeline rows
to the roster by exact id, but an observed session is `observed:<agent>:<uuid>` in the roster and the bare uuid on
its rows, and OpenClaw's single `openclaw-gateway` presence never equals its `openclaw:agent:…` row keys — so the
creature lookup failed for every observed session and for OpenClaw, and the conversation scenes could not fire for
them at all. Rows now match through `matrixRowSession` (`sameSession`, OpenClaw by agent) in
[shared/src/matrix-expression.ts](shared/src/matrix-expression.ts) and the Swift mirror, and a result whose session
has left uses the agent named on the row; unknown agents stay neutral. The Swift parity replay now includes both id
forms.

Separately, `ASK` read as "the agent is asking you" when it meant "your message arrived", and it held for the whole
turn (up to ten minutes). The label is `HEAR` and the hold is one minute (`askMs` 600000 → 60000); `WORK` carries the
rest of the turn. Live timeline rows also showed injected prompts (a cross-session idle notice) arriving as
non-automated `chat_start`; those still count as a delivered message and are left for a producer-side fix.
