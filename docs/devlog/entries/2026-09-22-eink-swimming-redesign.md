# 2026-09-22 — Replace e-ink flock forces with continuous swimming

The preceding bounded-boids change passed its mechanical checks but the user reported that the visible motion was worse. Heading smoothing did not solve fish hovering around force equilibria, and rotating a side-view fish toward the full 2D velocity made it spin vertically. This supersedes the motion approach in the earlier Android e-ink review.

- Replaced boids with two loose shoals following a broad continuous circuit. Longitudinal offsets and depth lanes preserve spacing without competing forces. STREAMING/HOVERING ease speed along the same path instead of replacing positions.
- Fish remain upright; yaw foreshortens the side view during a U-turn. Replaced diamond bodies with curved silhouettes and continuous tail strokes, independent of the renderer's 32-frame animation wrap.
- Double, bounded phases and 25ms integration ticks preserve trajectories across 100ms/400ms display updates. Existing physical-panel refresh policies are unchanged.
- First installed review used a 70-second recording to cover a full circuit. A second pass enlarged the fish and loosened the regular formation; a 60-second review exposed far-side fish painting over agent marks, so a final pass made depth control occlusion as well as size. The final build was installed on Lenovo in landscape e-ink override; physical EPD waveform quality still requires a reader.
- Android: 401 unit tests passed. New behavior checks require a tank-wide traversal, facing the direction of travel, bounded state transitions, upright posture and repeated-lap continuity. Workspace build/typecheck and 4671 tests passed (2 skipped); protocol generation has no tracked drift, token sync passed. Design lint remains 89 source findings plus 3 ignored generated Ulanzi findings.

See [Android UI](docs/android-ui.md). Local device recordings are kept under ignored `dist/eink-review/`; no store/public release is implied.
