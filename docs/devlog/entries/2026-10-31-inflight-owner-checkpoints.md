# 2026-10-31 — In-flight ownership needs a durable receiver and a fresh authority

The isolated signed-app lab exposed a continuity gap that timeline-only markers
could not show: an Outbox response-loss retry needs the previous outcome and the
Pocket aggregate together. The [handover contract](docs/daemon.md#aggregate-feed-and-in-flight-handover)
therefore transfers normalized aggregates plus opaque bounded receipt hashes,
with no card copy, raw prompt or source credentials. Independent inactive totals
are preserved as local profiles; adding them would count copied history twice.

A second failure appeared only after repeating all execution configurations:
Swift advanced its checkpoint while Node was absent, quit, and later attached to
a Node restarted from its older local checkpoint. Treating a lineage's numeric
generation as globally ordered made the legitimate new owner permanently fail
its native replica ACK and return 503. Restart without a current peer now creates
a new authority lineage while retaining the local aggregate and receipts. Within
an admitted current connection, sequence/generation checks and socket retirement
still reject late frames. The inactive competing profile is retained, not summed.

Strict HTTP replay also caught the Swift OTA route writing Content-Length and
Connection itself before the common encoder appended them again. Route-object
checks had not exercised those final wire bytes. The binary-range regression now
checks the actual encoded header count and body, and the live test uses the
existing minimum segment clamp rather than assuming arbitrary small ranges.

The user deferred actual sleep/wake acceptance after a software sleep request to
the dedicated Mac. That request and missing SSH are not a successful wake test.
The opt-in fixture requires actual OS sleep/full-wake evidence, and refuses an
automatic sleep if the shared daemon window cannot be proven vacant. No power
policy, installed app, shared daemon or hardware permission is reset to finish it.
