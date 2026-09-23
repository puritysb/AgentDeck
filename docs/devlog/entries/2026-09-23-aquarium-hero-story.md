# 2026-09-23 — High-resolution aquarium story and shorter README

Replaced the nearly static 18-second homepage capture (1440×824, 0.41 Mbps)
with a 42.8-second native iPad recording (2752×2000, 30 fps, 3.73 Mbps).
Five fictional coding sessions arrive progressively, edit a search feature,
run tests, wait for permission in the source terminal, and finish. The shared
timeline stays unfocused so the story remains visible across sessions.

- Added opt-in `--story` to the recording fixture; the default 30-second App Store
  scenario is unchanged. No app binary or store submission is changed.
- Published English/Korean/Japanese WebVTT captions, a new poster, and an
  eight-second lightweight README GIF. Native controls and on-demand video
  loading remain. Capture provenance lives in [the Pages runbook](docs/pages-site.md).
- Reduced README from 426 to 234 lines (about 56% fewer words): lead with the
  dashboard value and installation, consolidate distribution links, link
  detailed contracts rather than repeat them. Preserve managed compatibility,
  provider limits, community ownership, and release-channel anchors.
- Validation: build/typecheck passed; 305 test files, 4,684 tests passed with
  2 skipped; protocol generation left no drift; docs/catalog/token checks
  passed. Fixture snapshots and reconnects passed for both story profiles.
  Chrome playback and caption layout were inspected against the actual recording.
