# 2026-09-28 — One tablet, one history, whichever daemon it is attached to

The same Android tablet showed about a dozen timeline rows on connect under the
Node daemon and up to a hundred under the Swift daemon. The Node connect burst
capped every client at 12 KB, because an untagged links2004 board (15 KB inbound
frame limit) could look like a dashboard on its first connect; agent replies
carry their full text, so 12 KB bought about twelve rows. Boards are now
identified from byte one — the `?clientType=esp32` tag, the links2004
`User-Agent: arduino-WebSocket-Client` sent on every upgrade, or a known board
IP — and keep their ≤3.5 KB board cap, while dashboards get the latest 100
readable rows under a 256 KB guard, the Swift daemon's `getRecent(100)`. The
session Detail query now applies the board cap to boards too (it used to send
them up to 12 KB).

The Android usage zone attached the Codex plan only from a `ChatGPT …`
subscription row, which the App Store Swift daemon deliberately does not send.
It now falls back to `codexPlanType` / `codexSubscriptionActiveUntil`, which both
daemons send, so the plan line reads the same under either.
