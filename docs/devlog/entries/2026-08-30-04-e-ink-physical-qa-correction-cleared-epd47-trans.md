# 2026-08-30 — E-ink physical QA correction: cleared EPD47 transitions, explicit NM controls, InkDeck live-board restore

- Physical review rejected the first EPD47/NM/InkDeck redesign build: EPD47 partial page writes retained old tab underlines/body text, NM's 400×300 offline footer overlapped the connection copy, and InkDeck exposed the internal `GLANCE` state as its product title.
- EPD47 now performs a clearing full refresh for every automatic or manual page transition. When no supported touch controller answers the boot probe, GPIO21 cycles `FOCUS → QUEUE → LIMITS` and holds the chosen page for eight minutes, so the installed unit remains controllable while its touch hardware is investigated.
- NM now shows the actual controls in a dedicated non-overlapping footer. Home: `BOOT PAGE / OPEN`, `USER HOME`. Decision: `BOOT NEXT`, then `USER SELECT` / `USER CONFIRM`; the second confirmation sends the session-scoped `select_option` command. The not-yet-enabled ES8311 microphone path is no longer promised by the retained UI.
- InkDeck's default face again uses the proven live session grid with AgentDeck identity and provider limits. `GLANCE` remains an internal face/arbitration identifier only.
- Host builds and board-sized renders passed for `inkdeck`, `nm_epd_420_preview`, and `lilygo_epd47_preview`. Release firmware was hash-verified on EPD47 (`/dev/cu.usbmodem21401`), NM (`/dev/cu.usbmodem83201`), and InkDeck (download `/dev/cu.usbmodem3111101`, runtime `/dev/cu.usbmodem1CDBD474F4D81`). After AgentDeck restart all three re-registered over Wi-Fi as fresh `1.0.8` / `3d975d47-dirty`; InkDeck also answered a direct USB `device_info_request` with build epoch `1788073652`.

---
