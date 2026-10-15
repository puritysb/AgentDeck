# 2026-10-15 — One session ending no longer takes the hub from the others (#545)

Reported on the App Store app with a D200X: a menu-bar usage app ran
`claude /usage` every few minutes, and each time that short session ended, the
user's working session dropped off the deck. Quitting and relaunching the app
did the same. The log showed `[SM] idle → disconnected [session_end]` for the
probe, then `No transition for user_prompt_submit from disconnected` for every
prompt the working session sent afterwards.

Both daemons drive ONE shared state machine from every observed session, and
the table's `session_end` row is a wildcard drop to DISCONNECTED written for a
bridge that owns exactly one session. Three changes:

- The hub drops to DISCONNECTED only when the session that ended was the last
  one (`DaemonServer.hubDisconnectsOnSessionEnd` over the live rows; Node
  `HubStateDriverTracker.hasOtherLiveHookSession`, which forgets a session
  silent for 30 minutes so a crashed one cannot hold the hub open).
- `shared/src/states.ts` gained DISCONNECTED → PROCESSING on
  `user_prompt_submit`. A session already underway never fires `session_start`
  again, which is also the state every daemon starts in after a restart. The
  Swift daemon also emits `tool_activity` on a tool start from IDLE or
  DISCONNECTED now, mirroring the Node hub; its generated-table note still
  forbade that, and was out of date since Node's 1.0.19 refinement.
- The Swift `refreshSessions` pass snapshots the rows, awaits the registry and
  the `/health` probes, and then wrote the snapshot back and pruned against the
  current keys. A row a hook created during that wait (the working session
  resurrected by its first prompt after a relaunch) was pruned as stale the
  moment it appeared, a state a hook had just set was reverted on the wire, and
  a row that ended during the wait came back for one pass.
  `reconcileRefreshedSessions` decides against the current rows and prunes only
  rows the pass saw.

The deck symptom itself was not reproduced on hardware: the reporter's log
shows the shared-machine half, and the refresh race is the one path found that
removes a live row from `sessions_list`. Gates: `HubSessionIsolationTests`,
`state-transitions.test.ts`, `state-machine.test.ts`,
`hub-state-identity.test.ts`.

**Pre-merge review fixes (same PR).** An independent review found that the Node
turn watchdog called `noteSessionEnd` for any session quiet for 3 minutes. That
removed it from the live set and shrank the 30-minute window to 3, so case A
still reproduced on Node. The watchdog now calls `noteDriverSilent`, which
clears the frame identity and keeps liveness.

Further review fixes:
- When the roster empties without a SessionEnd (the reaper, a refresh prune, or
  a tracker expiry), the hub now settles to DISCONNECTED instead of sitting IDLE.
- The Swift hub now counts only observed rows as live. Managed pushed rows no
  longer hold it open.
- A Gateway link loss now keeps the hub while hook sessions are live, and closes
  only the turn the Gateway itself drove.
- Swift Gateway prompts open a turn from IDLE only, matching Node.
- An anonymous hook driver counts as live, so the settle path cannot drop a hub
  it alone drives.
