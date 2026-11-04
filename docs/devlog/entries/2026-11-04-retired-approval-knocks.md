# 2026-11-04 — Retired approvals hid the requests needed to re-pair

Catalog exclusion: dated maintainer diagnosis, indexed by the devlog; not a design specification.

This Mac has wired `192.168.68.100` and Wi-Fi `192.168.68.60` addresses. During
physical iPhone/iPad acceptance, both apps showed approval-required while the
host's waiting list was empty. A bounded, redacted iPhone console capture
confirmed Bonjour resolution and a successful public `/health` response through
`.100`, followed by a WebSocket failure with the saved credential. This rules
out an unreachable `.100` as the explanation for that observed HTTP exchange;
it does not certify every client route or every later socket error.

The daemon's refusal logs continued for peers whose persisted approvals belonged
to an earlier credential generation. Admission and the approved-device list
correctly excluded those grants, but the refusal recorder skipped every key
present in the persisted map. The old grant therefore prevented both access and
the new request needed to restore access. Swift had the same map-presence check.
The address and device-ID regressions each reproduced an empty waiting list
before the fix. The mixed Node/Swift fixture exercises two real retirements and
reads the same persisted grants from both runtimes.

Only a grant matching the handshake's credential generation may suppress a
request. Recording a new knock does not renew an approval: an explicit operator
approval is still required. No additional production token rotation, blanket
approval, mobile data clearing or interface change was used to diagnose this.
Camera/optical verification remains deferred independently.

After integration with master `60cf0132`, the first coverage run timed out at
the existing retirement-socket fixture's 6,000 ms readiness wait, before any
socket-retirement assertions. The original assertion hid the child's exit
state and stderr, so this observation alone does not establish a bind failure
or slow startup. Readiness assertions now include those diagnostics without
changing deadlines or product behavior. The six-case focused rerun passed with
the same deadline. The failed full run was stopped and preserved separately;
only a subsequent clean, complete run can supply the deployment receipt.
