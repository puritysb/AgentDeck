# 2026-09-26 — Consolidate local work and audit outstanding issues

The owner ended the other sessions and authorized repository cleanup and remaining
issue work. A full Git bundle and ordinary-directory copies of all 21 retired
worktrees preserve every original ref, uncommitted Blender file, ignored build
output and diagnostic artifact. Browser captures were moved into the same local
archive. No user files were discarded. Retired local branch names were removed
after bundle verification; the held release PR remains on GitHub.

## Integration decisions

Tree-level comparison showed the apparent unmerged Claude recovery, Dashboard,
store submission/preview, validation receipt and README work was already present
through squash commits or superseded by newer master edits. Preserve the newer
master content instead of replaying those branches. The recovery executable and
its tests exactly matched master, including the locally unique review commit.

- PR #380: merge OpenClaw dead-socket exit reporting, handshake cleanup and
  level-triggered bounded reconnection. A listening Gateway port no longer hides
  a dead adapter indefinitely.
- PR #381: merge optional WiFi RSSI and visible identified-serial failure logs,
  retaining fleet-wide Luna forwarding. Reject fractional near-zero readings
  that would round to invalid 0 dBm; regression fixture covers this boundary.
- PR #378: retain the provisional npm 1.4.3 / Apple 1.5.1 release candidate and
  its receipts in the remote draft and the archive. The documented publication
  hold is unchanged; no tag, package/store upload or submission is triggered.
- The standalone commercialization research document is preserved in the archive;
  cleanup does not republish personal research or its unverified external claims.

## Issue triage

- #370: preferred-port recovery is implemented and live-tested; remaining scope
  is publication, covered by the held release candidate.
- #367: the fix is published; original Windows multi-session confirmation is
  still missing. No macOS result substitutes for that receipt.
- #303: no reproducible Windows transport trace is available; keep open.
- #349 / #314: physical processed-package encoder interaction and store delivery
  gates remain open. Build success is not physical verification or publication.
- #348: detailed model/tool timeseries remains consumer-gated; no speculative
  producer or new quota semantics are added.
- #273: managed commands remain supported. Real remote topologies and replacement
  decisions are required before removing compatibility paths.
- #272: current desk panels expose fresh board-specific repaint counters;
  short samples are diagnostic evidence, not delivery counts, refresh-interval
  percentiles or representative approval traffic. EPD47 was still running with
  advancing repaint count about 3.6 hours after the earlier firmware recovery.

## Validation

Combined build/typecheck succeeded; 4,763 tests passed with two skipped.
Protocol generation has no drift; token mirrors match. Actual AMOLED firmware
compiled successfully with the added WiFi telemetry. Other running boards retain
their previously verified firmware; old firmware may omit RSSI by contract.

The first combined macOS CI run exposed a stale native Luna fixture inherited
from the earlier usage change: it expected a reserve to replace account windows
at 30%/10%. The fixture now exhausts a live window before expecting Luna and also
asserts that reset account windows return even while the reserve remains reported.
Production selection logic is unchanged.
