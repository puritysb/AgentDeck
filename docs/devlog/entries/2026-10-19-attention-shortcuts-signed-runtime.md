# 2026-10-19 — Installed identity and duplicate bundles can invalidate macOS Shortcuts QA

The main-branch auto-deploy replaced `/Applications/AgentDeck.app` during attention
Shortcuts QA. The replacement had no `Metadata.appintents`, so an empty Shortcuts
search was not evidence against the candidate. Check the installed bundle's path,
build number, metadata, and hashes immediately before interpreting runtime results;
a successful earlier install does not establish which artifact is running now.

A second copy, `/Applications/AgentDeck 2.app` (1.9.0/build 7901), also shared the
bundle ID. Launch Services selected it over the signed candidate (1.9.1/build 5).
Unregistering that exact copy and registering the candidate changed the default
temporarily, then it reverted. A **local build-command override**,
`CURRENT_PROJECT_VERSION=7902`, made the canonical path the default; after `linkd`
indexing, both Shortcuts actions appeared. No source version, tag, or upload changed.
This matches Apple's documented preference for the highest `CFBundleVersion` among
versions of an app, although selection remains subject to system heuristics:
[Launch Services Concepts](https://developer.apple.com/library/archive/documentation/Carbon/Conceptual/LaunchServicesConcepts/LSCConcepts/LSCConcepts.html),
[NSWorkspace bundle lookup](https://developer.apple.com/documentation/appkit/nsworkspace/urlforapplication%28withbundleidentifier%3A%29).

The isolated loopback fixture established these behavior boundaries:

- List returned A and B with distinct agent/question properties. Opening B showed
  B's attention and timeline while protocol focus stayed A. The fixture recorded
  zero incoming commands; this observation covers the fixture runs only.
- Pausing only the roster for 59.3 seconds made List fail (CLI exit 1)
  and Open report an error, despite continuing ordinary state traffic. Fresh
  processing rows instead produced a successful empty List result.
- A saved reference to dead B resolved to no entities. Shortcuts offered a new
  selection containing only A; it did not select A automatically. The chooser was
  cancelled.
- After quitting the app and restoring the original saved URL, a cold List run
  exited successfully, launched the canonical app, and displayed the real local
  daemon's six-session roster on port 9120.

The signed Debug candidate contains merged master `3987bf1c` at integration commit
`5eeae83c`. Strict/deep signature validation and Sandbox entitlement checks passed;
the installed executable hashes matched the tested build. This is local Apple
Development signing, not a distribution-signed App Store archive. The clean-source
full verification passed in 34 minutes: 24 steps passed, Keychain E2E and Windows
runtime were skipped, and three lab gates remained unattested. Its durable record is
`verification/receipts/2026-10-19-5eeae83.json`.

Notification delivery and click navigation remain **unverified**: macOS notification
permission was off, temporary enable/restore permission was unanswered, and the Mac
relocked during automatic verification. The results above establish Shortcuts
behavior, not notification activation. The fixture was stopped and the original
saved connection restored after QA.
