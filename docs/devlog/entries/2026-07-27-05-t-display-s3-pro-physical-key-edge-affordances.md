# 2026-07-27 — T-Display-S3-Pro physical-key edge affordances

The T-Display-S3-Pro's two long side controls each conceal two switches, so a
generic detached button legend did not match the hardware. In the firmware's
landscape pose the UI now places short 44 px capsules beside the actual rocker
halves. The first photo-derived versions were horizontally too long and mapped
to the wrong edge/pairs; direct device feedback established the landscape
geometry as right-side upper = previous/next and right-side lower =
power/Focus, both ordered left to right. The electrical `RST` label was replaced
by a single power icon because the user-visible result is screen-off/restart.
App-readable keys flash cyan when pressed. Persistent LVGL labels use
flash-backed static strings; no new render-loop buffer/allocation was introduced.

---
