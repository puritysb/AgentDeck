# 2026-09-13 — Bound local registry discovery before shipping hooks

The coordinated release soak exposed a real Claude SessionStart stall with the
Swift daemon alone: Python waited while opening the protected app-container
registry. Bounded HTTP requests did not bound that earlier filesystem read.
A 200 ms SIGALRM now covers each POSIX registry read in every Claude and Codex
installer, including the Swift writers; Claude migration 11 replaces old hooks.
A no-writer FIFO regression executes the emitted Python and verifies the mirrors.

OpenCode had the same issue in a synchronous registry read. Its observer now
uses bounded async reads and retains at most one pending OS read per registry
path. The regression parks all reads indefinitely and still observes a prompt
POST; sequencing tests no longer inspect the maintainer's real home directory.

Common verification passes: build, typecheck, 4494 tests (one skipped), protocol
no drift, and token mirrors. A real Codex turn completed under the Swift-only
candidate with the corrected hooks. Claude Code reached its account check after
the fix, but its organization disables subscription access; this is not evidence
of a completed Claude turn. Final three-mode release verification is separate.

Apple 1.3.1 was already uploaded, so Apple 1.3.2 carries the hook-writer fix;
the unpublished npm 1.3.3 candidate includes it. Existing tags are immutable.
The ASC maintenance workflow also gains a read-only app-scoped store-status
operation so CI can report version/build/review states without exporting keys.
