# 2026-10-31 — Session labels need source identity and explicit clearing

Claude 2.1.316 was started in an empty temporary project with a separate
configuration directory and hooks disabled. No model prompt was sent.
`--name AgentDeckNameProbe` wrote `nameSource: "user"`.
`/rename AgentDeckRenameProbe` kept that source, changed `nameSince` and appended a
matching-session `custom-title`. The previously observed `derived` value is
therefore not a synonym for explicit user choice. Unknown source values and
`agent-name` records are not assigned invented semantics.

[The display contract](docs/daemon.md#same-project-display-names) reuses the
existing wire field. Preserving a short ID even with a friendly name avoids
truncating two different long names into an indistinguishable INFO tile. This
also keeps duplicate titles useful without making them command destinations.
An explicit empty hint retires a previously relayed name when Swift takes over;
omission remains unknown and retains the existing hint for the same ID.

No cmux executable was available on this Mac. Existing surface/socket environment
correlation proves a delivery destination, not its live title; startup workspace membership
cannot be treated as current after moving a surface. That producer and physical
D200X INFO/VOICE recipient acceptance remain open rather than being inferred
from the earlier ID-tag receipt.

Rendering the real shared SVG cells exposed a separate readability defect:
the INFO corner pill painted over the ID suffix. Tagged titles now use the
whole bounded title row without that decorative pill; lone-project rendering
is unchanged. This is a synthetic raster inspection, not a physical deck or
voice-delivery receipt.
