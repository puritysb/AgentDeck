# 2026-10-31 — Numeric Tailscale ATS classification and bounded exception

The previous [signed relay acceptance](docs/devlog/entries/2026-10-31-signed-relay-two-mac.md)
found `NSURLErrorDomain -1022` for a numeric Tailscale target. A controlled signed
before/after request held the request code, signing identity/profile, sandbox
entitlements and real MacBook endpoint constant. Only the Info.plist ATS
dictionary differed:
the existing local-network key failed; adding an HTTP exception for RFC 6598
`100.64.0.0/10` returned 200. This was policy classification, not pairing failure,
a daemon outage or evidence that the user needed another credential.

The shared CGNAT block is outside RFC 1918 local space. Apple supports explicit
IP/CIDR exceptions on the app's supported macOS versions; default Tailscale IPv4
addresses occupy this block. An individual owner-machine /32 would hard-code
personal infrastructure and fail for other tailnets. A global arbitrary-load
flag would unnecessarily cover public endpoints. The source change is only
the macOS CIDR exception, with its App Review rationale and a built-host policy
test. It is app-wide for that shared block, not a per-relay exception and not
proof that an endpoint uses Tailscale. Consent and pairing gates remain required;
no routes, VPN settings, firewall policy or OS trust store were changed.

Signed boundary requests at 100.63.255.254 and 100.128.0.1 remained ATS-blocked.
A same-range HTTPS server with an untrusted self-signed certificate returned
`-1202`; default certificate verification remained in force. The negative TLS
certificate/private key lived only in the owned temporary remote test directory
and were removed after the server stopped. One proposed comparison containing
a public-domain HTTP request was automatically rejected; subsequent baseline
comparison used only the owned MacBook. No extra approval or external endpoint
was needed to establish the fix.

Full-app acceptance used the newly built Debug artifact with production sandbox
entitlements, plus actual Node relay components on the owner's MacBook. Both
directions used numeric Tailscale IPv4, without a forwarding workaround. The
[feature matrix](docs/appstore-feature-matrix.md#numeric-tailscale-ats-correction-2026-10-31)
records authentication refusal, publication/controls, actual hook soft-stop,
Keychain relaunch, disable/relaunch and preserved shared hardware. Local receipts
are gitignored under `diagnostics/daemon-relay-ats-20261031/`. The installed app
was restored rather than replaced with a development build containing this fix.

The first full Debug verification reported the runner exiting with code 0 before
finishing `BridgeConnectionLifetimeTests.testHealthySocketSurvivesFormerTwoMinuteLifetime`.
The new built-ATS test passed in that run. After temporary signed apps/helpers
and GUI acceptance work ended, the unchanged full Debug suite passed all 1,420
cases (4 skipped); the optimized suite passed 1,438 (9 skipped), including its
125-second lifetime case. The exact early-exit trigger was not established; no
transport/lifetime implementation or test was changed to mask it. Release and
both iOS configurations passed, and their processed policies confirmed that
only macOS gained the CIDR exception.
