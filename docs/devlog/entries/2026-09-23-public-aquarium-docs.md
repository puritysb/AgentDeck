# 2026-09-23 — Public aquarium media and evergreen documentation

## Reader-facing changes

README now opens with a six-second animated aquarium preview linked to the Pages
video player. The Pages overview plays an 18-second H.264 recording with native
controls, no autoplay, and no eager video download. The GIF and MP4 are each
under 1 MB. Android and iPad images were captured from the actual native apps at
`ce3a7127` with synthetic sessions; no private work was published. Media provenance
and refresh instructions live in [docs/pages-site.md](docs/pages-site.md).

English remains the canonical/default public language. New landing copy includes
Korean and Japanese translations through the existing shared locale selector.
README, Apple, Android, configuration, installation, and roadmap explain selectable
3D, mobile viewing mode, bounded foreground residents, Collaboration task history,
provider usage, and wireless APK updates. E-ink's static rendered backdrop remains
distinct from the LCD native renderer. Older store-version/review chatter was
replaced by evergreen channel links; historical submission records remain intact.

## Validation

- Browser: 1280px desktop and 390px mobile; no horizontal overflow; all three
  locales switch correctly; 1440×824 video playback advances without error.
- Build/typecheck and all 304 Vitest files passed: 4,671 tests, two skipped.
- Documentation, design catalog, viewer build, nav, surface count, hardware cards,
  preview mirror, protocol generation, and token sync checked.
- The existing macOS CI failure was a render test asserting readiness after a
  fixed 100ms sleep. It now awaits the mounted feed's published ready event with
  a five-second bound. All seven CollaborationFeedTests passed locally.

These changes do not assert that an unmeasured store candidate is live. Pages
publication follows the master workflow; app store release operations are separate.
