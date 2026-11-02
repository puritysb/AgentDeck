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
