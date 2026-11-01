# 2026-11-01 — Cold continuity needs an explicit recovery store

The user chose a one-time local folder grant followed by automatic recovery.
A live socket replica cannot close an interval during which the receiver never
ran. The [cold-recovery contract](docs/daemon.md#explicit-local-cold-recovery)
therefore adds a separate, opt-in, minimized transaction store; it does not read
another runtime's private container or copy its credentials and grants.

An arbitrary selected folder cannot be found by a Node process that was absent
during selection. The initial native flow consequently uses the known dedicated
`Library/Application Support/AgentDeck Recovery` location, with an explicit
consent marker. The app's persisted grant covers only that child. Node reads the
marker at its next ordinary macOS launch; a custom `AGENTDECK_DATA_DIR` has no
implicit discovery, and the native bookmark is bound to its data profile. This
keeps disposable verification profiles from importing the user's real recovery
state after the feature is enabled.

Independent checkpoint generations and filesystem timestamps cannot order two
offline branches. A shared SQLite immediate transaction compares the previous
store ID, revision and payload before replacing the head. Private cursors and
normalized checkpoint comparison detect stale/changed stores, divergent offline
edits and a crash between shared commit and private cursor write. A conflict is
preserved and refused, not resolved by summing Pocket histories or guessing the
latest wall clock.

The signed lifecycle fixture's bookmark points only at its own disposable
container, enabling real-process SQLite and cold-restart verification without
accessing user data. Such a fixture does not establish Powerbox selection or an
external folder's bookmark permission after relaunch; those are separate UI
acceptance gates.

Two preservation failures were reproduced with disposable stores. Assigning
`PRAGMA user_version=1` on every open changed the database bytes even for a
read; initialization now writes the schema/version only for a new store, and
both native and Node tests compare bytes around a load. A persisted client
inbox also masked a newer shared commit after the receiver was absent; a
regression restored removed pins from the stale inbox. Opted-in compatible
owners now order recovery by the committed store, archive a different old inbox,
and retire the redundant inbox before local-only restart. Replacing a Node
checkpoint writer during setup also resets replica ACK sequence counters so an
old writer's ACK cannot confirm the new writer's setup.

The signed run caught an ownership-order failure that component tests could not:
resolving a local folder bookmark in `makeDaemon` failed on a not-yet-created
consent file before the app could attach to an already healthy Node owner.
Folder restoration now runs only after native listener ownership is established;
authenticated HTTP requests return 503 until that restoration finishes, preventing
an early request from constructing an unrecovered checkpoint first. Startup epoch
validation follows the main-actor bookmark await.
