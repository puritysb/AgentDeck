# 2026-09-27 — Independent subscription dials and a shared weekly key

Stream Deck keypad and D200H now reserve one Claude weekly key for 7D and the
worst scoped cap (such as Fable), including when spare keys exist. Press cycles
both readings, 7D alone, then the cap alone. Missing readings fall back to the
available reading; stale Claude snapshots hide both. The selection persists in
the host plugin settings and does not change key allocation. Stream Deck tracks
the choice by physical device; Ulanzi keeps it across list/detail navigation.

Both SD+ usage dials share the same view builder. Rotation offers Claude 5H+7D
and 5H+7D+cap, individual window/cap views and session data. Each action saves
its view. E2/E3 provider choices no longer move the peer on collision; duplicate
subscriptions are valid. The optional long-touch E2 activity mode also stops
excluding E3's provider. Antigravity becomes selectable from confirmed plan
metadata, with a subscription card and no invented usage or backend credits.
The Apple D200H preview mirrors the default combined weekly layout.

Validation: build and typecheck pass; 4,846 TypeScript tests pass (2 skipped).
macOS DevicePreviewSnapshotTests: 7 passed, 1 opt-in snapshot skipped. Protocol
generation leaves no tracked changes. Token mirrors, preview pins, documentation
and design catalogue pass. Design lint remains at the 89 tracked-file baseline;
three additional local findings are ignored generated plugin output. Rendered
144px weekly and 200×100 dial views were inspected, including Fable at 100%.

The built Ulanzi service was also exercised through the SDK WebSocket protocol.
This exposed a repaint-cache omission: mode-only changes were persisted but did
not redraw until another field changed. The signature now includes local view
preferences, placed key positions and complete quota blocks (including scoped
caps). Regression tests cover those invalidations.
