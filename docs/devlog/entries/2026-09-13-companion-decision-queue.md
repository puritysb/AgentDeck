# 2026-09-13 — Give the two small companions distinct daily jobs

T-Embed now opens an arrival-ordered waiting queue, with the actual project and
question filling the panel. All sessions remains an encoder destination. Detail
uses two readable option rows and starts with no selected action; a changed
request clears the cursor. An exact bounded request snapshot guards dispatch,
and a pending reply distinguishes a state update from an unconfirmed send.

The landscape T-Display-S3-Pro now pins by session ID, retains its last result
until tapped, keeps an ended pin visible, and exposes a persistent waiting count.
Its waiting list is paginated and preserves arrival order; incoming requests do
not steal another page. Its approval buttons also guard the displayed request
and suppress duplicate pending replies. Camera Pocket behavior is unchanged.

Verification: production-renderer host interaction checks pass on both boards,
including queue reorder, changed options/request IDs, offline input, pinned
results, ended sessions, and pagination. Five plain C++ suites pass. Actual
T-Embed and T-Display-Pro firmware builds pass. Common build/typecheck/Vitest:
4492 passed, one skipped; protocol generation has no drift; token mirrors pass;
clean-source design lint remains 89. Runtime deployment and channel release
states are recorded separately after they are measured.

See [device behavior](docs/devices.md) and the
[design record](docs/esp32-companion-concepts.md).
