# 2026-11-10 — The communication graph was removed, the evidence was kept

Catalog exclusion: dated maintainer decision, indexed by the devlog; not a design specification.

The macOS Dashboard had a Messages button that opened a history list and a
graph of observed `SendMessage` traffic between sessions, and the aquarium drew
the same links as cyan currents. All three are gone. Work detail still lists a
message as a confirmed delivery inside the task it belongs to.

## What was measured

Local `apme.sqlite`, 30 days to 2026-11-10: 80 of 1,758 runs carry any
`messaged` relation, and that count includes QA fixtures. There were none from
November 1 to 8; the 33 on November 9 and 10 are acceptance fixtures. Over the
same store `spawned` has 986 rows and `waiting_on` 670.

The 2026-11-09 pass over real traffic found every one of ten "reply requested,
awaiting" indications already answered, and 74 of 127 unresolved peers were a
teammate or subagent inside the same session drawn as a separate session node.
Claude supplies no reply correlation, so the wait timer cannot be made right.

Only Claude emits this signal. Codex, Kiro, OpenCode and OpenClaw sessions were
nodes with no possible edge.

The graph placed 98 pt nodes on an ellipse inside a 250 pt viewport and grew
42 pt per node, so eight sessions overlapped or scrolled. It plotted the whole
roster, and an edge carried only the direction of the latest message, which the
list beside it already said.

## Decision

Removed: the Messages button and sheet, the graph, the link and wait
projection, the habitat currents in 2D and 3D. Kept: relation collection in
both daemons, `/apme/communications`, the `messagesIn`/`messagesOut` wire
fields, and the receipt pairing that feeds "Confirmed deliveries" in Work.

Rejected: keeping the graph behind the opt-in. The opt-in did not make the
wait indication correct. Rejected: deleting collection and the route. APME
uses the relations as trajectory evidence and the task handoff rows read the
route. Rejected: keeping the currents alone. They share the projection and
its ghost nodes and are empty on most days.

The name Messages is left free for a surface that sends: Claude inbox
dictation has delivery receipts and held and unconfirmed outcomes.
