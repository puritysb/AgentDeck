# 2026-09-28 — Matrix panels show the conversation, and iDotMatrix stops flickering OFFLINE

Asking OpenClaw a question put its creature on the iDotMatrix, but only for the
six-second response scene; the reader's own exchange was gone before they looked.
The panels now stage the conversation: a user message to a live session shows
that agent listening under `ASK` until its reply (bounded at 10 minutes, so a lost
reply cannot pin the scene), and the reply holds for 45 seconds under `REPLY`
with a speech bubble. Automated turns and bare task closes are not
conversations. Waiting and errors still preempt everything; a conversation
outranks a new-session entrance. The Timebox face gains a listening and a
talking pose. Policy stays in `shared/src/matrix-expression.ts`
(`matrixInteraction`), frames are regenerated, and the Swift port is held to the
Node pixels by the existing executable parity test, extended with an ask/reply
sequence.

iDotMatrix was the one BLE panel that "went OFFLINE by itself". The CLI client
painted its OFFLINE badge on any single failed 3-second frame request, while the
Timebox client only does so when the daemon is really gone. A busy event loop or
a daemon restart misses one request routinely. It now waits until the daemon has
been unreachable for 15 seconds. The BLE link itself also drops several times an
hour (`disconnected from …; respawning in 5s` in `daemon-stderr.log`); during
those gaps the panel keeps its last frame, which is expected, not OFFLINE.
