# Dashboard collaboration trial

This is a local-only experiment on `codex/dashboard-collaboration`, not a public
Apple or ESP32 release. The first two commits preserve pre-existing Apple and
daemon working-tree changes from the main checkout; they are not UI work.

## Use

Open the locally installed AgentDeck Dashboard. The title-bar switch offers
**기존 보기** (original Habitat) and **협업 보기 · 실험** (collaboration lens).
Select a session in the existing left roster or its terrarium creature. The right
rail shows its most recent canonical task and observed child branches. The network
button in that rail opens the existing system/topology panel. Existing attention
cards, approval paths, timeline and terrarium stay in place.

The lens is opt-in (`dashboardCollaborationEnabled`, default false). Selection
follows explicit focus, never the session that emitted the latest activity.
Observed-session IDs are normalized with the existing generated rules before the
task query. A historical child start is labelled as a start observation, not as
proof that the child is still running. Live session census and task history have
different scopes and are labelled separately. A child stop does not imply that
its result was integrated. Missing data never creates project/team edges.

The lens uses authenticated, ephemeral, loopback GET requests to existing APME
routes, a 15-second refresh, 5/8-second request/resource timeouts and a streamed
2 MiB response cap. Closing the lens cancels its work. Unsupported endpoints and
missing samples leave the original roster/census usable; failed refreshes mark
retained history explicitly. No prompts, histories or tokens are written to disk
by the new UI, and it adds no agent-control commands.

## IPS10 scope

Only `BOARD_IPS10` changes. Work cards are identity-ordered and equal-sized, with
a minimum readable height and vertical overflow. A state change does not move a
card within an unchanged supplied roster or encode a progress percentage. The
existing transport cap/rotation is retained: with more than ten sessions the
supplied subset can change. Project rooms remain co-location, not a
claim of delegation. Parent state and child census are separate labelled lines;
individual child identity/dependency graphs are **not** available on this firmware.

Both daemons retain the optional census only for identified `ips_10` clients and
drop that enhancement if the conservative existing 3,500-byte budget is exceeded.
Other boards and unidentified clients retain their baseline projections. The
firmware treats absent/malformed census as unknown and does not retain an old
value across a full roster snapshot. New state/text buffers are static, IPS10-only;
the ten optional census labels are initialized once and reuse their text storage.

## Local runtime and recovery

Build outputs and backups are under the ignored/untracked `output/` directory.
`output/rollback/AgentDeck.app` preserves the app installed before this trial.
To return visually, switch to **기존 보기**; no reinstall is required.
To restore the previous binary, quit the trial app and open that backup app.

The trial daemon is built from this checkout. Autostart configuration is not
changed; after a reboot the previously configured daemon may run, in which case
macOS still works and IPS10 degrades to “하위 관계 미관측”. To run this daemon again:

```sh
node bridge/dist/cli.js daemon restart --no-build
```

The matching previous IPS10 `1.0.6` image (build `1e974271`) is retained at
`output/rollback/agentdeck-ips_10.bin`, with the release SHA256SUMS. Restore only
the identified IPS10, never all boards:

```sh
node bridge/dist/cli.js esp32-ota ips_10 --firmware output/rollback/agentdeck-ips_10.bin
```

## Integration branch — 2026-09-06 (`feat/collaboration-lens`)

Created from current `master` with only the three UI commits cherry-picked
(the two baseline commits were superseded by #284/#285). Changes on top:

- `TaskCompleted` no longer becomes a `subagent` completion (both daemons).
  Measured: the claude-glm session `5e58fcbf` carried six "Subagent" branches
  for six TaskCreate items; it ran no children.
- New `relation` sample events + `SessionInfo.coordination` census
  (`bridge/src/coordination-evidence.ts`): `spawned` (process ancestry /
  `claude -p` intent), `messaged` (SendMessage tool + cross-session envelope),
  `waiting_on` (background process naming the session's scratchpad). The lens
  renders them as their own sections and the roster row shows `⧗N`.
- IPS10 cards keep the equal-size layout but restore the tool / model /
  elapsed gates the treemap had (`ph >= 80 / 64`, body height at 216) and drop
  the session-id suffix from the project line — the trial's `300px` gate hid
  all three on every card (simulator render, 2026-09-06).

### Integration-branch deployment evidence — 2026-09-06 15:48

- Vitest 262 files / 4,079 passed / 1 skipped; macOS XCTest 748 passed
  (`CollaborationProjectionTests` incl. two relation cases,
  `CoordinationEvidenceParserTests`); IPS10 geometry host test PASS; IPS10
  firmware build + simulator render (tool / model lines back on every card).
- Daemon on 9120 is this worktree's build `f0af7d8eff4c`. Two earlier OTA
  attempts through the master daemon died with `ECONNRESET`: the daemon logged
  `Shutting down…` mid-upload each time and came back as the same master build
  — run the OTA through a daemon whose build matches the CLI.
- IPS10 WiFi OTA complete (4.0 MB, 4,137 chunks) and reconnected at
  192.168.68.54 (`1.2.1`, serial primary).
- Live within a minute of the restart: the epoch-of-tech parent row carries
  `coordination: {backgroundJobs: 1, …}` and a `waiting_on · run_bot_matrix.sh`
  relation was persisted on its open task — the exact case that started this.
- Release app built Development-signed at
  `output-dd-rel/Build/Products/Release/AgentDeck.app` (structural verifier
  fails only on the dev certificate, as the trial's did). **Not installed**:
  the install step was declined in-session. To trial it, quit AgentDeck and
  copy that bundle over `/Applications/AgentDeck.app` (the trial's rollback
  copies under `../AgentDeck-collaboration/output/rollback/` still apply).

### Second pass — Swift-daemon parity and the IPS10 gaps (2026-09-06 evening)

- Swift daemon now produces `spawned` / `waiting_on` too: `CoordinationTracker.swift`
  over `ProcessEnumerator.processTable()` (sysctl pid/ppid/argv), 5 s tick,
  `coordination` stamped on its own `sessions_list`. Session→pid comes from the
  new hook header `X-AgentDeck-Pid: $PPID` (all three snippet mirrors; Node
  migration 10, the Swift installer rewrites on any snippet change).
- Shared vectors: `shared/coordination-evidence-vectors.json` replayed by both
  suites (envelope, SendMessage, spawn/agent commands, ancestry, the measured
  process table with a worker and a matrix job).
- IPS10: stable card roster on both daemons (awaiting kept, newest fill, id
  order) with `total` → header `+N`; cards render the coordination census
  ("대기 작업 N" / "띄운 작업 N 실행") in amber when the session is waiting.
  Firmware treats an absent census as unknown, never a stale count.

### Second-pass verification — 2026-09-06 18:50

- Vitest 262 files / 4,087 passed / 1 skipped (vector replay, stable roster, pid
  registration); macOS XCTest: Executed 9 tests, with 0 failures (incl. `CoordinationEvidenceVectorTests`).
- IPS10 firmware rebuilt and flashed over WiFi OTA (4.0 MB, 4,138 chunks) through
  the worktree daemon (`a97fcd55b34b`), which is the build on 9120.
- Installed `~/.claude/settings.json` hooks now carry `X-AgentDeck-Pid` (migrated
  by the daemon restart). Sessions that started before the migration keep
  posting through their already-loaded hook set until they restart.

## Review questions

Compare original and collaboration views on the same real work. Can you identify
the task, the parent, observed delegates, and human attention? Can you distinguish
an idle parent with active children from a fully quiet session? Do completed
children look like completed observations rather than a claim of integration?
Check quiet/awaiting/missing-history/disconnected cases and multiple sessions in
one project. The IPS10 physical layout still needs owner observation; firmware
build/OTA health is not proof of visual usability.

Verification artifacts: `output/all-tests.log`, `output/transport-tests.log`,
`output/macos-tests.log`, `output/macos-archive.log`, `output/ips10-build.log`.

## Local deployment evidence — 2026-09-06

- The trial app replaces `/Applications/AgentDeck.app`; the original bundle is
  also retained as `output/rollback/AgentDeck-before-install.app`. It is a locally
  Development-signed Release archive, not an App Store submission.
- Trial Node daemon: port 9120, build `4b45793017d1`. No autostart edits.
- IPS10 at `192.168.68.54` completed WiFi OTA (4,137 chunks), then reported
  version `1.2.1`, build `a167b18e-dirty`, fresh session updates and increasing
  uptime. All 11 serial devices remained connected. No other board was flashed.
  The dirty suffix includes the untracked local output directory.
- Live verification found a large-history UI-actor bottleneck. Reading the same
  736,558-byte response in an optimized isolated probe took 8.36 seconds on the
  main actor versus 0.03 seconds off it. Streaming/decoding now runs off the UI
  actor while published state remains main-actor isolated; the 2 MiB cap remains.
- Observability is still harness-dependent: a real active session had tool and
  message events but no typed delegation events. That session correctly shows
  no confirmed branches; this release does not manufacture links from prose.
- After the large-history fix, the installed app rendered a real `Explore`
  completion branch alongside a current census of 0 active / 1 completed.
  Original-view restoration and switching back were both verified in the app.
- Final Release XCTest run: 37 passed / 0 failed, including the 700 KB ignored
  tool-payload regression. See `output/macos-tests-final.log` and the 12:51:55
  result bundle under `output/macos-build/Logs/Test/`.
