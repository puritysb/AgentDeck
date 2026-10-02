# 2026-10-02 — z.ai 5H and MCP share one cycling key on a crowded usage row

### What changed

On the Stream Deck keypad and the D200H, z.ai's two windows (5H and the MCP tool-call quota, or a token weekly window) now fold onto one key when the usage row cannot give every reading its own key. A press cycles that key through both readings → the first only → the second only, like the Claude weekly key with its per-model cap. The selection persists per device (`zaiPairMode` in the Stream Deck key settings and the Ulanzi global settings). The rule lives in `shared/src/zai-pair-view.ts`.

- **D200H** (`shared/src/d200h-layout.ts` `buildUsageTiles`): the compaction cascade is now Codex → z.ai → Claude → three-row Claude. z.ai used to compact last, after Claude's 5H and 7D had already been merged; Claude's 5H is the reading a user glances at mid-session, so z.ai yields first. The full six-reading three-key strip is unchanged. The macOS D200H preview (`D200HLayoutModel.swift`) mirrors the new order; its SYNC-HASH pin is bumped.
- **Stream Deck** (`plugin/src/session-slot-manager.ts`): the row used to page as soon as the readings outnumbered the row. Folding z.ai first means six readings now fit a classic 15-key deck's five-key row with no page key. Paging still applies when the row overflows after folding (for example a Neo's three-key row).
