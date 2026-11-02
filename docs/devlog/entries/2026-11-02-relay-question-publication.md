# 2026-11-02 — Relay questions require private publication correlation

The 2.0 claim audit found a gap between direct-command relay acceptance and
what the controller actually rendered. The native worker needed a held question's
ID to reject stale answers, but put that ID into the public `requestId` field.
That field means a binary permission to every controller. A correct native
question-answer handler therefore did not establish that the user could reach it.

The new isolated test links the production Swift uplink to a real Node hub and
passes its actual row through the Stream Deck manager. The unfixed worker
published `native-ask-gate`; the test expected no public permission ID. After the
correction it renders Alpha/Bravo/Charlie and the third choice returns through
the socket with its original index and question. This is synthetic hook metadata
and loopback transport, not a real remote coding-agent terminal or device run.

Keeping only a stripped public snapshot would introduce a second problem:
replacing a hold with the same visible question/options would compare equal.
The worker instead retains/fingerprints the private hold identity and sends a
separate public projection. Unit coverage checks that a replaced hold is refused
until republished even when the public bytes remain equal, and that ordinary
permission IDs remain public. The existing v1 wire and controller semantics stay
unchanged.

The first full-tier audit run was stopped when this defect was identified;
that partial run is not a release receipt. The corrected frozen source needs its
own complete verification record. See [release scope](RELEASING.md#20-release-scope-audit-2026-11-02)
and [relay contract](docs/daemon.md#daemon-relay-worker-daemon-to-hub).
