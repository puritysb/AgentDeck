# 2026-10-05 — Capture a real Hermes child and reconcile acceptance evidence

Issues [#426](https://github.com/puritysb/AgentDeck/issues/426) and
[#425](https://github.com/puritysb/AgentDeck/issues/425) still described native
ingestion and multi-turn lifecycle work already recorded on October 3.
[Hermes compatibility evidence](docs/hermes-agent.md) separates those results
from the remaining messaging-platform reset and physical-device review.

Ran the installed managed Hermes classic CLI at upstream
`0a374d167424cdc730ce9761368b62255b551e58` in a temporary profile/workspace,
using a deterministic loopback provider. The real delegation tool created a
child and upstream emitted its lifecycle callbacks. The unchanged observer
suppressed child exports and sent one parent Stop and finalization. Relevant
managed snapshot files byte-matched the checkout. No user profile, installed
daemon, external messaging channel or paid provider was changed.

Preserved sanitized raw callbacks and six exported hooks in
`bridge/src/__tests__/fixtures/hermes-live-child.json`. Added Python observer,
Node registry, real daemon HTTP/WS E2E and Swift admission/APME regression
coverage. The capture receiver was a stub; daemon replay is a separate gate.
An E2E roster assertion waits for the opening broadcast before posting the
remaining callbacks, because a fully completed turn can otherwise be removed
before the daemon's coalesced roster broadcast.

This completes real child-callback evidence, not all release acceptance.
Messaging-platform `/new`, a post-fix 30-minute live TTL rerun and physical
visual acceptance remain explicitly open. No release artifact was published.
