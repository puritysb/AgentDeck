# 2026-09-27 — Review follow-ups: yielding badges, tag draw order, 2D habitat tags, label drift

This entry records the follow-ups to the Dashboard palette and aquarium name-tag
work. They came from an external review and from a second sweep of live data and
screens.

- **WORKING badge stayed opaque when its tag yielded.** On Android, `Paint.setColor`
  resets alpha to 255, so the badge ignored the faded backing; the Apple badge
  was excluded from the fade. A yielding tag now fades its badge and ink to
  `nativeLabel.yieldSignalOpacity` (0.5). A Robolectric render test asserts that
  a yielding tag leaves no opaque badge pixel.
- **The resolved priority never reached RealityKit.** Iterating in priority
  order does not change draw order. Every tag part now carries a
  `ModelSortGroupComponent` in one post-pass sort group, ordered by the
  resolved priority.
- **The macOS/iPad 2D habitat had the same overlap.** It is the default
  dashboard type, and each creature painted its own tag. `drawTerrariumNameTag`
  now queues into a frame-scoped `TerrariumNameTagLayer`, which the renderer
  resolves with the same `ResidentLabelLayout` after the last creature. Verified
  on a running debug build in both 2D and 3D; the installed app was restored
  afterwards.
- **IPS10 idle was the offline grey.** `D1_IDLE` pointed at `UiIdleDark`, and one
  cyan `D1_OK` meant working, link-up, focus outline and gauge base at once. The
  state colour now comes from `SessionState::color`. Link-up is health green,
  offline is the offline grey, and the voice-target outline is focus cyan.
- **Timeline labels disagreed with session rows.** Node hook timeline rows used
  the bare cwd folder, so this worktree session showed as `dashboard-state-palette`
  on the timeline and as `AgentDeck · dashboard-state-palette` in the roster. They
  now use the same resolver as session rows (`hookPayloadProjectName`). OpenClaw
  task headers carried the raw Gateway key `agent:main:main` while their chat
  rows said `OpenClaw`; the timeline now labels every OpenClaw row `OpenClaw`,
  and the APME store keeps the key.
