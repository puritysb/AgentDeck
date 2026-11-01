# 2026-11-01 — Settings need an active owner and a distinct durability capability

The [P1.2 contract](docs/daemon.md#session-pin-and-pixoo-configuration-handover)
keeps session pins and the supported Pixoo fields separate from aggregate Pocket
learning. Reusing the admitted checkpoint avoids a private-container cross-read,
but its old ACK was insufficient: an older decoder could discard an unknown
configuration member and still acknowledge the original checkpoint ID. A distinct
configuration subscription and prepared-handover capability prevent claiming that
unsupported peers durably preserved settings.

The Pixoo sheet previously wrote the app-local file while connected to Node.
The CLI's Pixoo commands had the mirror problem while Swift owned the port.
Both now target the active local API; failed/unknown requests never fall back to
an inactive file. Revision comparison prevents a stale device list from undoing
another editor's changes. Inactive supported profiles and per-device extra fields
are archived locally before adoption; unrelated root keys and credentials never
enter the checkpoint. Cold recovery after both processes were absent still needs
an explicitly permitted common recovery channel, not a guessed private path.

Native pin overlays also needed provenance: a cached row already carrying its
old pin was indistinguishable from an explicit managed/remote weight. The cache
marker lets a new pin or clear affect the next roster without changing explicit
weight precedence or session identity.

Two fixture errors were caught before acceptance. Synthetic Hermes sessions must
use the observer's actual `hermes-` plus 32-hex identity, not a descriptive name.
A synchronous XCTest method annotated with the custom daemon actor compiled but
trapped at entry; making the test async establishes the executor hop. A test also
incorrectly expected explicitly deleted per-device metadata to reappear on a
subsequent add; each preservation scenario now establishes its own baseline.

The computer-use service timed out and later reopened only the alternate test
app without the runner's environment. Its socket receipt showed its private
19450 listener and local provider/Gateway connections, not shared 9120–9139.
The exact alternate executable/PID was inspected and terminated before resuming
scoped acceptance. No installed app, shared daemon or hardware was stopped.
Permission preflight passing does not certify usable UI automation: physical
window manipulation remains unverified; native editor transport and signed-app
settings APIs are separate evidence.
