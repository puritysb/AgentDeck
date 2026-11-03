# 2026-11-03 — Claude peer receipts and live cmux title acceptance

Claude Code **2.1.316** was exercised with temporary configuration/project roots,
hooks disabled and a synthetic loopback model endpoint. A macOS sandbox denied
external networking, real user files, Keychain IPC and unrelated local services.
The policy's refusal of a real repository file and port 9120 was checked before
launch. Only OS user-directory lookup was allowed through the libinfo service.
No real session was messaged and no external model endpoint was reachable.

The actual [production inbox module](bridge/src/claude-inbox.ts) then reproduced:

- `accept`: the recipient persisted the supplied UUID as its own `user` row,
  with the expected session ID and `isMeta: true`. This is the positive receipt;
  the initial socket write has no acceptance ACK.
- `hold`: a separate `control/peer_message_status` frame carried `held` and the
  original message ID. No matching input row appeared.
- `refuse`: the frame used `status: expired` plus `status_detail: refused`.
  Treating every `expired` as an approval timeout would lose this distinction.

No exported child token was forwarded. Messages retain peer semantics and the
receiver's inbound policy; they do not answer permission dialogs. Correlation
tests also cover late releases, mismatched IDs, silence, PID changes and teardown.
These are local protocol receipts, not a production installation or a claim that
every later Claude version uses this frame contract.

The official **cmux 0.65.1 arm64** release was signature-verified (Manaflow,
`7WLXT3NR37`) and launched with temporary preferences, configuration and shell
startup roots. Only that disposable instance used `allowAll`; no existing
instance's access policy changed. Its actual listener was under the temporary
profile's `.local/state/cmux/`, rather than the requested compatibility socket.
Production reads therefore use the surface's exported socket path.

Using [the production title reader](bridge/src/cmux-titles.ts), workspace rename,
cross-workspace surface move and surface rename all updated the displayed hint
while retaining the same surface UUID. Two measurement traps mattered:

- `system.tree` uses a published snapshot that can lag a successful mutation.
  A bounded convergence check was necessary; immediate read-back was stale.
- Moving the last surface can leave an empty workspace in the tree. Its first
  workspace/pane is not a substitute for matching the actual surface UUID.

The TTGO firmware build compiled the build-local WebSockets source replacement
that exposes close payloads to the existing virtual callback. The downloaded
dependency remained unchanged. This proves compilation and the adapter seam,
not installation, WiFi reconnect/radio parking or optical panel acceptance.
Those remain distinct from host policy and simulator results. The Mac was locked
during attempted GUI inspection; no D200X or camera/panel acceptance is claimed.

Final review also found that most boards restored only the token after reboot;
the endpoint preference survived only on selected boards. Every board now saves
one bounded endpoint/port/token blob, with a migration fence committed first.
An unreadable or missing fenced blob refuses legacy fallback and asks for USB
pairing. A legacy token without an endpoint does the same. Legacy mDNS token TXT
values are ignored. Host cases cover malformed, missing and unreadable snapshots;
the TTGO build checks the NVS adapter compiles. This does not attest a physical
power-cut test or protect against deleting/restoring the entire NVS store.
