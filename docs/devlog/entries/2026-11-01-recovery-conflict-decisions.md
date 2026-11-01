# 2026-11-01 — Recovery decisions must outlive a failed producer startup

The recovery refusal happens before a divergent Node profile can serve HTTP.
Routing every conflict choice through that producer would therefore leave the
operator unable to resolve the condition that prevents it from starting. Reading
Node's private directory from the Sandbox app would also violate the selected
folder boundary. The selected SQLite store now carries a bounded minimized
candidate and explicit revision-fenced decisions. Only the producer can validate
its current private content and consume a decision. The UI reads that shared
projection, not another runtime's files. Contract:
[explicit local cold recovery](docs/daemon.md#explicit-local-cold-recovery).

Consent stays at version 1 while storage moves to schema 2. This avoids treating
a schema migration as fresh consent or resetting an existing head. Old readers
must refuse the newer schema. Resolution history retains both minimized versions;
the producer separately preserves the original supported private files before
adoption. A successful shared decision is acknowledged after the private cursor
write, so an earlier crash can retry without approving unrelated later edits.

During signed native UI acceptance, pressing the synchronous `runModal` folder
button through Accessibility left the action awaiting the modal loop and timed
out the automation call. A read-only process sample identified the nested
`NSAccessibility` action → `RecoveryFolderSettings.choose` → `NSSavePanel.runModal`
stack. The picker now starts asynchronously, letting the initiating action return.
The validation fixture has a separate bundle ID, synthetic data directory and
loopback port window with all hardware modules disabled; it never replaces the
installed app or writes the normal recovery folder.
