# 2026-09-24 — Restore the current development runtime after Marketplace validation

Integrated the current upstream release branch with the local IPS10 voice work
in an isolated checkout, preserving both histories. The persistent main checkout
now contains the 1.4.2 Node baseline, 1.4.0 plugin baseline, Apple 1.5.0 baseline,
and the local voice/activity/display improvements. This integration is local;
it is not publication of the unfinished voice work. Deployment safeguards were
reviewed separately in [PR #377](https://github.com/puritysb/AgentDeck/pull/377),
which passed all six CI checks and merged.

Merge resolutions preserved the current IPS10 workspace, the upstream expanded
collaboration inspector and compact usage layout, and both Luna retirement
conditions (ordinary-window exhaustion and reserve expiry). Regenerated the
devlog and recalculated the D200H preview origin hash from the resolved source.
Validation: build/typecheck; 4,743 tests passed, two skipped; protocol generation
without drift; preview pins, docs/catalog and tokens passed. macOS Debug and
IPS10 firmware builds succeeded. Firmware was built only, not flashed; the
installed macOS app remains the previously verified 1.5.0 build 4.

The supported daemon lifecycle restored launchd PID 60270, build `e30d55a7714e`,
on port 9120 with OpenClaw connected. The new plugin deployment command preserved
the Marketplace package, restored the persistent main source link, restarted
Stream Deck's plugin, and verified PID 60701 against bundle SHA-256 prefix
`ef7d18b7e87c`. The independent `pnpm plugin:check` passed afterward.

Before replacement, the live usage frame carried regular weekly usage at 70%
and extra Luna usage at 19%, while the installed package showed Luna 81% left.
After replacement the producer retired the inapplicable reserve, and the actual
Stream Deck+ host preview showed regular Codex weekly usage at 72%. The new
plugin also applies the local shared selection predicate defensively.

Remaining delivery gates are unchanged: publish the #370 npm fix, perform the
#349 physical DRM encoder interaction checks before Elgato publication, ship the
iOS Dashboard emphasis update, and confirm Ulanzi/macOS review outcomes. Runtime
restoration does not claim those releases or hardware interaction tests complete.
