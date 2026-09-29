# 2026-09-28 — A board's first frame carries several rows under the Node daemon too

Under the Node daemon an ESP32 board received one timeline row at connect; under
the Swift daemon, several. Both apply the same 3.5 KB board budget, but Swift
trims each entry to the firmware's buffers (raw 120 / detail 200 / project 40
bytes) before budgeting, while Node budgeted full-length entries in the connect
burst and trimmed only afterwards — so one long agent reply filled the frame.
The trim now lives in one helper (`bridge/src/board-timeline-entry.ts`) used by
both the connect burst and serial/WS shaping, and runs before the budget. Found
by probing both board paths while making the dashboard history match the Swift
daemon (#402).
