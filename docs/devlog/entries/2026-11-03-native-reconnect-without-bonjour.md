# 2026-11-03 — A daemon handover need not produce another Bonjour event

Catalog exclusion: dated maintainer diagnostics and acceptance evidence, indexed
by the devlog; not a design specification.

Pantone and Crema retained their app processes and working USB reverse tunnels
while the Node/Swift ownership transition interrupted their selected LAN socket.
Both current app PIDs logged six failed attempts followed by clearing the URL for
mDNS fallback. Their dashboard registrations stayed absent until an app restart.
The existing selected-host guard deliberately prevents switching to an unrelated
USB host; removing it would violate the multi-Mac selection contract.

iPad's original initiating WebSocket error was not captured. Its live HTTP 401s
continued after a restart restored WebSocket messages and pings, so those HTTP
responses do not establish the cause of its socket outage. Source review found
two independent recovery gaps: remote retry exhaustion depended on another
Bonjour emission, and authentication refusal set the same permanent suppression
as an explicit user stop. The new tests exercise both paths rather than asserting
that the historical iPad failure had a proven close code.

The repair preserves the short retry burst, then retries the same selected
endpoint after a quiet period independently of discovery. Authentication is
still required on every attempt; no approval, token or trust rule is widened.
Explicit stop, termination and a newer selection retire queued recovery work.
The cooldown is defined in `shared/src/pairing-code.ts` and generated into both
native clients. A persistent recovery timer never drives the foreground spinner.

Robolectric exercises real IPv6-loopback WebSocket handshakes and parsed frames,
with coroutine time controlled by the test. IPv6 selects the ordinary network
retry budget rather than Android's special literal localhost/ADB budget. XCTest
uses the shared iPad/macOS state holder with no preferred local daemon and no
Bonjour emissions, including a real exhausted retry burst before replacement
owner success. Focused Android tests passed 4/4 and Apple connection tests 12/12.

Initial Quick failures were unrelated to these changes: one existing fixed-port
test collided on 19200, and macOS's Bash 3.2 cannot run the design linter's
associative arrays. The port was free on inspection; no other process was stopped.
Quick passed when rerun with the existing Homebrew Bash 5 first in the command's
PATH. These are local verification conditions, not application requirements.

Native verification builds retain the existing version/build defaults. No
version bump, release tag, Store upload or change to the submitted 2.0 package
is part of this fix's local acceptance.

Full changed-area acceptance passed Android 580/580 and both macOS test
configurations without failures. Native Release verification was restricted to
arm64 using an invocation-local xcconfig: the existing Homebrew Rust installation
has no x86_64 target libraries. This does not certify a universal Intel archive.
The Android stop flag is also observed by discovery, startup and USB recovery,
so a Compose remount cannot undo an explicit disconnect.


The clean-commit Full receipt is
[`2026-11-02-3507335.json`](verification/receipts/2026-11-02-3507335.json)
(UTC filename; the owner was testing on November 3 in Korea). All selected
local automated steps passed, including coverage, both macOS test configurations,
iOS Release and preview builds, deterministic CloudKit checks, submission assets,
ESP32 host/simulator/TTGO builds, and isolated packaged-daemon recovery plus a
60-second soak. Local Keychain opt-in was not granted, so the receipt correctly
skips Darwin daemon E2E; the PR's Ubuntu daemon E2E and Windows Node 22/24/26
runtime jobs passed without that access.

Physical acceptance uses owner-signed, in-place Android updates and a development
signed iPad candidate, with unchanged version/build numbers. The original Android
APKs were retained and their signing certificates matched the candidate. Evidence
is kept under the gitignored `diagnostics/local-update-2.0.0/native-reconnect-fix/`.
Android frame checks filter the normal package PID and require a fresh parsed
state or session-list event; a model-name dashboard row alone could belong to a
separately installed QA variant and is not accepted as proof.

Both e-ink apps recovered onto the unchanged Swift host without a client restart,
retaining their installation-start PIDs. The observed host first exhausted its
9120 bind retries, served 9121, then reclaimed 9120 after the bind-failure memory
expired. That took approximately three minutes: the initial 150-second smoke
window timed out and the extended observation passed. Its final 25-second probe
is not the duration of the whole handover. No client was relaunched to make the
check pass.

The run also exposed a separate trust prerequisite: Crema's normal package had a
stale LAN token and was already approved by the Swift owner, but the Node owner
refused its per-install identity. The new retry remained active through those
401s and connected when the approved Swift owner returned. Node reapproval was
blocked by automatic approval review pending explicit owner consent; no grant,
credential rotation, QA approval or auth relaxation was applied. iPad candidate
installation was refused because the device had not been unlocked recently;
physical acceptance waits for the owner to unlock it. These are recorded as
pending, not converted into successful end-to-end acceptance by the socket tests.


The return to Node also passed for Pantone with its original app PID and a fresh
parsed session-list frame. The host is restored to Node owning 9120 and the
unchanged Swift app acting as its client. Crema keeps retrying the Node owner at
the shared cooldown and still reports an authentication refusal; its Node return
is not counted as passed. Neither daemon autostart nor the disabled local-main
deployment workflow was re-enabled.
