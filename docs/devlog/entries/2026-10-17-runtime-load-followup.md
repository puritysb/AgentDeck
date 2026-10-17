# 2026-10-17 — Shared-runtime load and aquarium camera follow-up

The PR #560 acceptance run is separate from this follow-up. Its real Claude
notification/request/reverse-notification/reply checks passed in Collaboration
and the native aquarium. The remaining warm health delays and an earlier blank
3D scene were explicitly left unconfirmed.

Before the next coordinated deployment, daemon PID 43412/build 99656c7f0932
stopped answering health requests while its listener and process remained alive.
The actual Dashboard entered Reconnecting and later recovered without restarting
the app or daemon. The host load average was 254.92/129.88/77.57 at one capture;
a concurrent session later measured 368/274/175. Other projects were also running.
Do not attribute every timeout to this source change or treat a process replacement
from the main deployment workflow as a spontaneous reconnect.

A 66.7-second V8 profile attributes about 4.0 seconds of sampled time to
coordination reconciliation, 6.2 seconds to CI intent parsing, and 9.2 seconds
to display fallback probes. Native sampling also shows posix_spawn on the main
thread: even an asynchronous execFile can spend 0.5–1 second entering the child
under this host load. Instrumentation recorded operation names, duration and
caller stacks without command arguments or environment values, then was removed.

The coordination reducer rebuilt process/peer maps for each ancestry lookup and
searched every command once per session. A synthetic 1,505-process/300-session
comparison produced the same five relation records and SHA-256 digest in 975ms
before versus 21ms after indexing. This is a bounded comparison under one host
condition, not a production speedup guarantee. CI watcher cleanup now skips
command parsing when no waits exist or a process has no possible waiting owner.
Display fallback deadlines retain their child latch until the exit callback,
including stop/start, so an unreaped child cannot cause replacement spawns on
every poll. The initial fork itself can still be delayed by the operating system.

The next full macOS run exposed a real reconnect race: an immediate HTTP 503
could reach handleDisconnect before the main queue published the initial URL.
The transport read the UI property as nil and silently declined retrying.
Transport endpoint, retry budget and connection readiness now live with the
socket queue; UI publications do not authorize transport work. A real loopback
regression blocks the main queue and requires a second handshake while the
published URL is still nil. The initial failing test and the new blocked-main
case both pass with this correction. Retry exhaustion still has its fixed budget.

After the other session handed over main 839bf10c, fresh app PID 82875 reproduced
an empty 3D area with a normal six-session HUD. Health from daemon PID 83044 /
build 24998d473eb9 answered in 15ms. Raising and resizing the window and switching
Habitat/Collaboration did not restore it. All four model imports completed. A
bounded read-only heap probe found the retained camera rig with distanceScale 1
and a non-null camera. This instance therefore does not establish camera
interpolation poisoning as the cause. Debugger attach intervals are excluded
from continuous-connection acceptance. Scene assembly and first-frame logs now
separate asset import, RealityView assembly and attached-camera frame delivery.

A separate concrete camera failure path was found by inspection: a negative
interval can overflow exp(), and a nonfinite interval can poison the persistent
distance with NaN. Every later interpolation then stays NaN. Invalid intervals
are now rejected before any camera or resident mutation, with a diagnostic, and
a regression drives the real RealityKit camera through invalid values and
subsequent valid viewing motion. This guard is not proof of the blank scene's
cause.

A unique-bundle comparison app then rendered the raw habitat, the actual
LivingAquariumScene with both empty and populated state, and the full
MonitorScreen connected to the same eight live sessions. All rendered normally.
Switching the installed app away from 3D and back recreated its renderer but
reproduced the blank area after model loading. Thus a working standalone scene
or a restarted app alone does not establish the historical failure's cause.
Sandboxed comparisons rendered as well. The comparison app was stopped after
captures and never started a daemon.

Private profiles, socket observations, screenshots and measurement summaries
remain under ignored diagnostics/dashboard-stability/runtime-followup-20261017/.
Full candidate verification passed in 34m31s: TypeScript 6,116 tests with coverage,
macOS Debug 1,214 tests (4 skipped), optimized DotPreview 1,233 (8 skipped),
all Apple build configurations, Android, ESP32 and clean npm package acceptance.
The recorded receipt explicitly identifies dirty source based on 839bf10c; it is
not an exact-commit attestation. Hosted Windows and manual hardware gates were
not executed locally. Post-deployment acceptance remains separate and pending.
