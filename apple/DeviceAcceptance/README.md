# Physical-device timeline acceptance

This standalone XCUITest runner exercises the installed `bound.serendipity.agent.deck`
app without adding test code or fixture sessions to the product. It launches the app,
taps a Codex roster entry, clears the filter, selects OpenClaw, and clears again.
Screenshots and accessibility trees stay in the result bundle. Existing connection
and appearance preferences are retained; inspection finishes with no filter.

Prerequisites: paired/unlocked iPhone or iPad, Developer Mode and UI automation
available, the candidate already installed, and a connected dashboard containing
real Codex and OpenClaw sessions. Missing prerequisites fail rather than skip.
Use the deployment skill for installation. Set `device_id` to the target's UDID.

```bash
xcodegen generate --spec apple/DeviceAcceptance/project.yml
xcodebuild test -project apple/DeviceAcceptance/AgentDeckAcceptance.xcodeproj \
  -scheme Acceptance -destination "platform=iOS,id=$device_id" \
  -derivedDataPath diagnostics/apple-device-acceptance/DerivedData \
  -resultBundlePath diagnostics/apple-device-acceptance/result.xcresult \
  -allowProvisioningUpdates
```

Use a fresh result path per run. This is explicit lab acceptance, not an unattended
CI suite. It does not install the app under test, manufacture sessions, establish
Store signing, or validate 3D creature coordinates. On 2026-10-13 it reproduced
header taps being intercepted by overflowing timeline content on iPhone 14 Pro Max;
the same test passed after bounding the scroll hit area and raising the header.
An iPad runner initialization timeout is a tooling failure, not an app pass.

## OpenCode and CloudKit lab acceptance

`OpenCodeAttention` adds explicit installed-device checks. An external lab
orchestrator must first create a fresh real OpenCode session whose single-choice
label includes `Phone acceptance`, followed by a harmless permission wait.
Run only `OpenCodeAttention/testQuestionThenOneTimePermission`; the runner opens
the existing local dashboard, chooses the real option, allows the tool once and
retains screenshots/accessibility evidence. It does not inject app state.

`OpenCodeAttention/testCacheRestoresAfterProcessRelaunch` requires a current
CloudKit summary and the PoC candidate already installed. It fetches once,
terminates/relaunches the app and asserts that the original summary reappears
without another refresh. Offline identity-token availability and original source
time remain separate assertions in the persistence unit suite and device record.


The reproducible lab orchestrator is `fixtures/opencode-attention.mjs`. From the
repository root, build the workspace and run it in a separate terminal:

```bash
pnpm build
node apple/DeviceAcceptance/fixtures/opencode-attention.mjs phone
```

It starts a real standalone OpenCode TUI with the generated observer, temporary
configuration/data and a loopback Anthropic-compatible model fixture. It does not
use the user's provider key, change HOME, inject hooks, or answer an existing
session. `opencode` must be on PATH; `AGENTDECK_ACCEPTANCE_OPENCODE_BINARY` can
select another installed executable. `deck` selects the `Deck acceptance` label
for a separate Stream Deck run. The harmless Bash tool requests approval after
the expected question choice; `Review only` ends the test without running it.

`diagnostics/phone-acceptance-run.json` (or `deck-acceptance-run.json`) contains
the run's PID, temporary root and local model port. Its `/status` endpoint records
the actual returned tool results; check the original selected label and harmless
command output as well as the UI assertions. Incoming test model requests and
TUI output stay under that temporary root. Ctrl-C stops only this test process;
a one-hour bound also stops it. The observer uses the real current daemon and
its normal command queue, so production pairing remains in force. An installed
candidate and an unlocked phone are still required. The simulator-only branch
uses the normal manual URL UI against loopback and cannot attest physical-device
or APNs/Watch delivery.

`OpenCodeAttention/testLocalCacheStorageRoundTrip` uses the PoC's storage-only
check. It writes and reads a disposable marker using the actual app directory,
file protection and backup exclusion, then removes that marker. No iCloud account
or fake summary is needed. Run it separately from the cloud/relaunch test: a
passed storage probe cannot attest account matching or notification delivery.

Before starting the question UI test, confirm the actual daemon has the new
session's `awaiting_option` row, original choices and live response capability.
The fixture model's `question` stage alone does not prove observer readiness.
The runner waits for enabled/hittable controls and uses ordinary taps; no
label-only coordinate fallback masks a broken button hit region.
