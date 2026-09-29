# 2026-09-22 — Remove shrimp and correct snail motion

- User rejected the shrimp's appearance/movement and suggested removing it. Removed both shrimp and their authoring branches; native import coverage now explicitly requires zero shrimp so regeneration cannot silently restore them.
- Rounded the snail's head/shell, shortened eyestalks and enlarged the paired eyes for dashboard-scale readability. Preserved the agent characters and the solid hinged fish fins.
- Replaced position-only oscillation with a slow closed path whose heading follows its tangent. Unwrapped yaw avoids a full-turn discontinuity at the seam. Blender authoring checks evaluated forward displacement and start/end transform continuity, catching the previous backward-slide behavior.
- Shared Apple asset rebuilt; macOS installed for visual review. 34 focused native tests and 4,671 workspace tests pass (2 skipped); macOS/iOS builds and workspace build/typecheck pass. No Android/e-ink or store deployment.
