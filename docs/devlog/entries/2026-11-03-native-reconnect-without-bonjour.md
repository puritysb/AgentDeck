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

The initial run also exposed a separate trust prerequisite: Crema's normal package had a
stale LAN token and was already approved by the Swift owner, but the Node owner
refused its per-install identity. The new retry remained active through those
401s and connected when the approved Swift owner returned. Node reapproval was
blocked by automatic approval review pending explicit owner consent; no grant,
credential rotation, QA approval or auth relaxation was applied. iPad candidate
installation was refused because the device had not been unlocked recently;
physical acceptance at that point waited for the owner to unlock it. These are recorded as
pending, not converted into successful end-to-end acceptance by the socket tests.


The return to Node also passed for Pantone with its original app PID and a fresh
parsed session-list frame. The host is restored to Node owning 9120 and the
unchanged Swift app acting as its client. At that point Crema kept retrying the Node owner at
the shared cooldown and reported an authentication refusal; its Node return
was not counted as passed. Neither daemon autostart nor the disabled local-main
deployment workflow was re-enabled.


On the owner's later unlock/approval, the candidate installed successfully on
iPad. Crema's exact normal-package identity was reapproved on Node through
`POST /pair/approve`, as explicitly authorized; no QA variant or IP-wide grant
was added. Crema's retry recovered without a relaunch after this change.

The evening handover attempts are not complete physical passes. A separate
local task restarted Node during the first Swift window, so the iPad frame
observed after that restart was not attributed to Swift. The next bounded
continuous run retained all three client PIDs, but iPad received no first frame
from Swift before the observation deadline. Local mDNS identified its current
address as `.63`, and the Swift owner logged authentication refusals from that
address. The iPad's existing Node device grant was absent from Swift's distinct
approval store. An explicit request to approve only that iPad on Swift is pending;
the reconnect change does not bypass this trust boundary. The run restored Node
through the supported lifecycle command; an immediate post-start probe briefly
refused TCP, and the subsequent bounded observation verified the owner alive.

Latest-master integration uses `a37e87ab`. Its credential-retirement changes and
other upstream fixes were retained byte-for-byte. The only textual conflict was
the adjacent architecture catalogue rows, resolved by retaining both the new
credential rules and the native reconnect cooldown. Quick verification of this
integration passed 7,522 tests (42 skipped). The original Full receipt continues
to describe source `35073357`, rather than claiming it was rerun on the merge.


Changed-area verification of the working integration also passed every selected
local automated step: Android, standard/optimized macOS XCTest, macOS Release,
iOS Release/preview builds, submission assets, ESP32 host policy and simulator
checks, plus the generated/protocol and documentation gates. The same ARM64-only
local Apple scope applies. After the refused Swift window, a separate bounded
Node observation verified all three unchanged client PIDs, both e-ink parsed
frames and the iPad first-message counter advancing from one to two. This proves
Node recovery; it is not an authenticated iPad-on-Swift pass.


The owner then explicitly approved this iPad on Swift. Its current per-install
identity was obtained from the unique live knock at the mDNS-confirmed iPad
address, with the sole running AgentDeck process checked; a historical identity
was stale and was never granted. After this one-time setup, the measured
Swift → Node → Swift → Node cycle passed for all three clients with no further
permission changes or client launches. PIDs remained iPad 6225, Pantone 12989 and
Crema 9475. The iPad first-message counter advanced 2 → 3 → 4 → 5; Android proof
required fresh parsed frames from each normal-package PID. Node → Swift took
179.8 seconds and Swift → Node 62.0 seconds including host lifecycle waits;
these are not claims that every handover finishes within the 30-second client
cooldown. The final owner was Node on 9120, with the installed Swift app its
client. Private `final-verified-acceptance.json` retains the complete phase data.

During final CI review, repository protection already required Kotlin CodeQL
and Security pipeline freshness while their definitions were absent from the
current master. The real Kotlin extraction job and freshness workflow/script/
fixtures were forward-ported from published PR #712 (source `1083235ea6ec`),
without its unrelated runtime edits or Swift analysis jobs. No stand-in success
status or protection relaxation was used. The freshness fixtures preserve the
bounded unverified startup state for cron rather than claiming manual success
proves scheduled execution. The coverage catalogue records both actual checks.


Final integration retained security PR #712 after it reached master as
`05a9bef6`. The four overlapping CI/catalogue documents use that master version
exactly, superseding the temporary minimal forward-port above. Reconnect runtime
files remain identical to the originally tested source. Quick passed 7,561 tests
(42 skipped); every selected Android, Apple and ESP32 native check passed on the
integrated working tree. The changed-area JavaScript suite collided with occupied
fixture ports 19200 and 29321/29324/29326; no competing process was stopped.
The full native receipt preserves that failed JavaScript attempt separately
from its successful retry. Local Apple verification remains ARM64-only and
Darwin Keychain-dependent E2E remains explicitly skipped.
The isolated whole-suite retry passed all 7,561 tests (42 skipped) on the
same source after those fixture ports were free. No native check was repeated
because the retry changed no source or native build input.

While hosted checks were running, master advanced to `eadab28c` through PR #717.
Its BLE readiness and installed-app launch fixes are retained unchanged. Those
upstream changes do not alter native app build inputs or the reconnect repair.
The earlier native verification therefore remains evidence for those unchanged
inputs; this is not a claim that a Full deployment was repeated on the new merge.

The `31cef546` Swift macOS CodeQL job completed compilation, analysis, SARIF
upload and all post steps successfully, but exceeded its 45-minute job budget
while finishing cleanup. GitHub marked the required job cancelled, so the
successful analysis upload was not treated as a passing required check. The
same-head retry was superseded by the later master integration. Give both Swift
analysis jobs 60 minutes, retaining the exact compiler, queries and upload steps;
the measured 45m40s execution needs cleanup headroom rather than weaker checks.

Quick on this later integration exposed two existing auth-test assumptions:
only the custom data directory was isolated, while the legacy home still came
from the operator's machine. A persisted retirement there can intentionally be
inherited into a new data directory, changing the expected revision. Both
failures reproduced in the isolated test file. Mock `homedir()` to a fresh
fixture for every case and preserve the custom-directory environment through
Vitest stubs; the legacy migration case changes that fixture instead of the
process HOME. Product authentication and the operator's credentials are untouched.
The isolated auth tests passed 19/19, then Quick passed 7,567 tests
(42 skipped) on the final working merge. Native app source and generated
build inputs are unchanged from the earlier verified integration. The older
`31cef546` same-SHA retry subsequently passed all 15 then-required CI checks,
but strict up-to-date protection already required the newer master. Those
results are retained as older-head evidence, not credited to the new commit.
