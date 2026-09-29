# 2026-09-23 — macOS 1.5.0 preview preparation and crowd review

Prepared Apple marketing version 1.5.0 and a macOS-only manual release workflow selection. Apple tags still archive/upload both platforms; no tag, upload, submission or public release was performed. Added localized release copy and review notes in [the preparation record](apple/appstore-submission/macos-1.5.0.md).

Recorded the actual Debug macOS app with synthetic sessions and the existing deterministic capture feed. The 28.7-second preview includes the 3D habitat and Dashboard settings. Output is 1920×1080, H.264 High level 4.0, 30 fps, about 10.94 Mbps, silent AAC 44.1 kHz. The submission package validator passed. Recording uses a window-only capture; no private session content is in the video.

Validation: macOS 1.5.0 Debug build passed; pnpm build/typecheck and serial Vitest passed (4,671 tests, 2 skipped); protocol regeneration produced no drift; all seven token mirrors matched; documentation and design catalog checks passed. Design lint retains the known 92 checkout violations (89 tracked baseline and 3 ignored build output). No Release archive or signing/upload gate is claimed.

A user-requested crowd check then rendered 20 synthetic threads in 12 workspaces. Nine Codex threads folded into one ×9 creature as designed. However, labels shrank and the attention HUD covered the top row. Submission remains pending a crowd-layout refinement; the existing geometry tests alone do not establish readable runtime layout. Preserve parent/child grouping intent without treating all unrelated sessions in one workspace as children. The preparation record documents the proposed refinement, not an implemented feature.

An independently modified Blender source and its backup were left untouched and excluded from the release-preparation changes.
