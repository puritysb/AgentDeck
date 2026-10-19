# 2026-10-19 — Tests left Foundation Models helpers stuck in dyld

**What was found.** Twelve `agentdeck-fm-helper` processes were orphaned (ppid
1) under `$TMPDIR/agentdeck-test-<uuid>/fm-helper/`. They were 3 h to 31 h old.
`sample` put every one of them at `_dyld_start`, so none had ever run any code
of its own. They used no measurable CPU or memory, but they accumulated with
each test run.

**How tests produced them.**

1. `createTempDataDir()` (`bridge/src/__tests__/helpers/temp-data-dir.ts`)
   points `AGENTDECK_DATA_DIR` at an `agentdeck-test-<uuid>` directory.
2. A test that drives `BridgeCore` reaches `activityFor` →
   `probeFoundationModelsHelper()`.
3. The bundled binary `bridge/assets/fm-helper/agentdeck-fm-helper` is a
   gitignored build output, so a fresh worktree has none. In that case the
   resolver compiles the helper from source into `<dataDir>/fm-helper/` and
   spawns it.
4. Some launches of the freshly compiled binary never left dyld, which matches
   the `_dyld_start` orphans seen under load during the reference-judge work. The
   worker then finished, its temp dir was removed, and the process stayed.

The shell working directories of the orphans were worktrees that no longer
exist. The main checkout has the bundled binary, and its daemon's helper exited
normally on stdin EOF when the daemon restarted.

**Now.**

- `vitest.setup.ts` points `AGENTDECK_FM_HELPER` at a path that does not exist.
  Resolution then reports the helper unavailable, which is what Linux CI already
  sees, so nothing is compiled or launched. Tests that exercise the helper stub
  their own path with `vi.stubEnv`, as `fm-helper-speech-worker.test.ts` does.
  `fm-helper-build.test.ts` runs the binary it builds directly.
- The two e2e daemons get the same override. The e2e config has no setup file,
  and those daemons also run with temp data dirs.

**Measured, A/B, in a fresh worktree.** The four test files that use
`createTempDataDir()` were run while `ps` was polled every 0.3 s.

- With the old setup, a vitest worker ran `bridge/scripts/build-fm-helper.mjs`,
  and `swiftc` wrote `$TMPDIR/agentdeck-test-<uuid>/fm-helper/agentdeck-fm-helper`.
  That is the orphans' path.
- With the new setup, no helper process was seen.
- 77 of 77 tests passed both times.

The full quick tier in the same worktree showed only `fm-helper-build.test.ts`
compiling its own binary.

**Not covered.** An e2e daemon still runs the default APME judge chain, which
finds a local MLX server at `127.0.0.1:8800` or `:8080` when one is running. Its
endpoint comes only from `settings.json`, and the z.ai e2e test rewrites that
file mid-run, so pinning it needs that test to keep the key too.
