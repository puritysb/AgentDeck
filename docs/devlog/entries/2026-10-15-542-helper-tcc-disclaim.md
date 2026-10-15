# 2026-10-15 — Voice helper: the microphone grant now belongs to the helper, not the daemon's launcher (#542)

#542 reported that host push-to-talk failed with `unauthorized: microphone access
not granted` and no prompt when the Node daemon ran from its LaunchAgent, and
worked when the same daemon ran in a terminal. The docs claimed the helper
"prompts as its own helper, not as a terminal". That claim was never measured.

**Measured on macOS 27.0 (TCC `AUTHREQ_ATTRIBUTION`, throwaway launchd jobs):**

- launchd → node → `agentdeck-fm-helper` (the real LaunchAgent shape):
  `responsible=node` (`/opt/homebrew/Cellar/node/26.5.0/bin/node`). TCC prompted
  as node and recorded the grant against node. On this Mac the prompt did appear,
  so the reporter's "no prompt" is most consistent with a denial already on record
  for their node. Not reproduced here.
- launchd → sh → helper: the helper was its own responsible process (a platform
  shell does not take responsibility).
- launchd → node → wrapper with `responsibility_spawnattrs_setdisclaim` → helper:
  helper self-attributed, used its own grant, no `responsible=node`.
- The same with `POSIX_SPAWN_SETEXEC`: identical attribution, same pid.

**Change:** the helper re-executes itself once at startup with
`POSIX_SPAWN_SETEXEC` + the disclaim attribute (looked up with `dlsym`; marker env
`AGENTDECK_FM_HELPER_DISCLAIMED` stops the loop). The pid and pipes stay the same,
so the daemon's tracking and kill are untouched. A spawned child would have
outlived the daemon's SIGTERM while holding its pipes. Verified end to end:
launchd → node → rebuilt helper logged the helper as requester and prompted as
`bound.serendipity.agentdeck.fm-helper`. The microphone refusal now distinguishes
`restricted` and names the entry to enable. When the disclaim is unavailable, it
names the launcher instead.

**Unverified:** whether the reporter's machine now prompts (needs their run), and
how TCC treats a helper rebuilt over the same path for a new release. The existing
docs already say a rebuild re-prompts, and `tccutil reset` is the fallback.
Gates: `bridge/src/__tests__/fm-helper-build.test.ts` (source order pin + a real
build that must answer `health` in the same pid with the marker set).
