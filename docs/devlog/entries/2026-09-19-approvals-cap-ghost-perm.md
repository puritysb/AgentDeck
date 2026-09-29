# 2026-09-19 — Ghost-PERM acceptance live: the approvals cap was the missing half

The #308 live acceptance was blocked on 2026-09-11 because no client on this
host could raise an exec approval (openclaw 2026.9.3 denied every ask as
`nonInteractiveApproval`). On 2026.9.4 the upstream blocker is gone — a
pty-driven `openclaw tui` probe raises real, blocking `exec.approval` records
— but the daemon still showed nothing while connected. Root cause, read from
the Gateway bundle: `canDeliverApprovals` pushes
`exec.approval.requested`/`resolved` (and the plugin equivalents) only to
connections whose handshake advertises an approvals cap
(`GATEWAY_CLIENT_CAPS.APPROVALS = "approvals"`) or a known approval client id;
the `operator.approvals` scope both adapters already carry grants the RPCs but
not the events. Both handshakes sent `caps: ["tool-events"]`, so every
approval handler sat wired and unreachable and approvals surfaced only via the
handshake catch-up — which also explains how the 2026-09-09 ghost PERM
appeared at all. Both adapters now send `caps: ["tool-events", "approvals"]`
(Node `sendConnectRequest`, Swift mirror, connect-format test pinned), and the
invariant is recorded in the openclaw-gateway rule.

Live acceptance against 2026.9.4 after the fix, daemon on :9120 with
`--debug`, three probe approvals: the deck row renders `awaiting_permission`
with the real command, detail and Allow once/Deny options (`liveAnswerable`);
the pending list and the deck agree on id and command; a stale-but-listed
record adopted at handshake is abandoned in 7 s ("Not approved · run
cancelled"); and two blocking approvals were cleared at run-abort/authority
lapse (~6 min) in seconds via the pushed `resolved` frame — far inside the
30 s polling bound and the 30 min record expiry. The pure no-resolution drop
(the 09-09 ghost shape) did not reproduce on 2026.9.4: the Gateway now
actively denies run-bound approvals when the run dies, so the reconcile loop
remains the vector-pinned backstop rather than the observed path. The
unknown/expired press path is likewise no longer reachable live (no zombie
window exists) and stays pinned by `shared/openclaw-approval-error-vectors.json`
in both suites.

Validation: full vitest suite 4,546 passed, `pnpm -r tsc --noEmit` clean,
AgentDeck_macOS xcodebuild clean; the launchd daemon was restored from the
temporary `--debug` instance and reports healthy with the Stream Deck plugin
reconnected.
