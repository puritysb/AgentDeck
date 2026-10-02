# OpenClaw live activity capture

`turn.json` was captured from OpenClaw 2026.9.6 on 2026-09-29 during a real
`chat.send` request executing `sleep 20` and returning a fixed marker. It preserves
ordered Gateway events, observation times, run IDs, message text and tool data.
Unconsumed session metadata, thinking blocks and personal workspace paths were removed.

Both TypeScript and Swift replay this sequence through their production activity
reducers. It proves early busy state, prompt attribution, one completed tool row,
one final response, and idle recovery. It does not prove delivery from a live
Gateway; that additionally requires executing OpenClaw against a running daemon.
