# 2026-10-04 — 1.7 store submissions and platform delivery

## Source and verification

[PR #446](https://github.com/puritysb/AgentDeck/pull/446) merged as
`2ee27840d0f63e65c433da4cad026890f5fa81e5` after all ten CI checks passed.
This is the exact source of the Android, ESP32, Stream Deck and Ulanzi tags.
Apple's already-submitted 7701 build remains from `65847d64`; see the
[Apple receipt](docs/devlog/entries/2026-10-04-platform-release-preparation.md).
No Apple queued binary or tag was replaced.

Local build/typecheck, protocol drift, documentation/catalog/devlog/token checks,
Android's 449 tests and signed APK/AAB builds, and both plugin packaging checks
passed. New Ulanzi discovery/client coverage passed 15 tests. The initial full
Vitest run found one old 1.6.0 fixture expectation; it was corrected and the
relevant 15-test suite passed, followed by clean full CI. The built checkout's
92 design-lint findings were existing/generated-output findings; the clean CI
regression gate passed. These checks do not establish Windows/WSL2 physical
acceptance for #445, nor the processed Stream Deck encoder review loop.

## Channel receipts

| Channel | Measured state | Evidence / next gate |
|---|---|---|
| Apple iOS/macOS | 1.7.0 (7701), Waiting for Review | Separate submissions at 08:53/08:54 KST; linked receipt above |
| Android GitHub | 1.7.0 signed APK published | [Release run 37164393964](https://github.com/puritysb/AgentDeck/actions/runs/37164393964) |
| Google Play | 24 (1.7.0), full rollout submitted; Changes in review / quick checks | [Publishing overview](https://play.google.com/console/u/1/developers/7107476187102902603/app/4975606862124022024/publishing); managed publishing off |
| Stream Deck | Package 1.7.0.0, Pending review · 1.7 | [Release CI artifact](https://github.com/puritysb/AgentDeck/actions/runs/37164391977); automatic publication off until DRM-processed encoder acceptance |
| Ulanzi | 1.7.0, Works under review (1) | [Review work](https://ugc.ulanzistudio.com/my/0); [GitHub release CI](https://github.com/puritysb/AgentDeck/actions/runs/37164964246) passed |
| ESP32 | 1.7.0 published: 62 assets for 12 boards | [Release workflow](https://github.com/puritysb/AgentDeck/actions/runs/37164390316) succeeded; manifest reports firmwareVersion 1.7.0 |
| npm | 1.7.0 public on all four packages, each latest 1.7.0 | [Release run](https://github.com/puritysb/AgentDeck/actions/runs/37184235170) succeeded; exact versions/latest/readme read back |

The Stream Deck CI artifact must be uploaded to Maker Console, so its artifact
release preceded marketplace submission. Neither that GitHub Release nor the
submission is a claim of marketplace publication. The unrelated old 1.4
Ready to publish version was not released.

## Store content

Apple's existing previews/screenshots remain representative, and the native
Hermes simulator capture was inspected. No new preview video was uploaded.
Play release notes cover English, Korean and Japanese; existing galleries remain.
Ulanzi's seven locale pairs were restored after ZIP upload, saved, then read back
exactly; unsupported Dial and AU05 selections introduced by the uploader were
removed and their saved exclusion verified. The existing banner and equivalent
regenerated cover were retained. Hermes is explicitly read-only in deck listings.
The first Ulanzi submission expired with the login session; a fresh login and
resubmission produced exactly one pending review record.

Canonical submitted copy and receipts: [Play listing](marketplace/play/LISTING.md),
[Elgato listing](marketplace/elgato/LISTING.md),
[Ulanzi listing](marketplace/ulanzi/LISTING.md).

## npm continuation

Four 1.7.0 candidate tarballs were packed from clean `2ee27840`. The submitted
macOS 1.7.0 (7701) package was downloaded from Apple release CI, expanded, and
passed the App Store archive verifier. Privacy preflight passed. Native app
launch was refused because the Mac was locked; no required soak row is claimed.
The installed CLI/runtime was not replaced or stopped.

Measured global versions before any candidate install: bridge 1.6.0, hooks,
shared and setup 1.4.2. Rollback to that exact global package set:

```bash
npm install --global @agentdeck/bridge@1.6.0 @agentdeck/hooks@1.4.2 @agentdeck/shared@1.4.2 @agentdeck/setup@1.4.2
```

The initial locked-Mac attempt above is historical. After unlock, TestFlight
installed exact macOS 1.7.0 (7701) with a valid receipt, and all three
[pre-tag soak rows](RELEASING.md#pre-tag-three-mode-daemon-soak) passed.
Measured results and remaining store gates live in [release issue #449](https://github.com/puritysb/AgentDeck/issues/449).

The soak found a missing explicit Node `isSwift: false` in full health.
[PR #448](https://github.com/puritysb/AgentDeck/pull/448) fixed it and added a
real-process E2E assertion; all six CI checks passed. Final npm source/tag:
`5116a2bcfd5498d13507e9590ffaf0666f441ef8`. The corrected tarballs were installed
on the real global command path, then the required rows were repeated from that
clean commit. Swift PID 2797 reported `isSwift: true` on 9120; Node PID 10957
reported `isSwift: false`, startup build `4ecf5e505be9`, and native diagnostic ready
on Node 26.5.0 / ABI 147. Real directly launched Claude turns reached both the
app and Lenovo tablet. Coexistence kept exactly one 9120 listener; supported CLI
stop left the app open, and Swift PID 12177 reclaimed 9120 automatically. A fresh
real turn reached the recovered app/tablet without hook reinstallation.

Initial TestFlight startup waited for normal Keychain consent; the owner handled
the prompt and health recovered. Port handoff briefly used 9121 while the
existing 120-second failed-bind memory expired, then recovered 9120 without
manual repair. No security bypass was performed. Local build/typecheck, 5,110
unit tests and ten real-daemon E2E tests passed; protocol generation left no
drift and token mirrors matched. The existing built-checkout design findings
remain; CI lint regression passed.

The latest review found no new report among the eleven previously open issues.
#445 now records the shipped implementation and keeps physical Windows/WSL2
acceptance open. #414 now records public Elgato/Ulanzi 1.6 delivery while leaving
the unmeasured old Google Play gallery comparison open.

## Restored runtime

After the required soak, an extra app-first → CLI ownership attempt reported
that the app yielded but the port remained held, then reported the incumbent
Swift PID instead of a verified Node owner. This is recorded separately from
the passing required CLI-first coexistence row. The documented quit-app path
followed by supported `agentdeck daemon restart` restored the Node owner:
PID 15859, 9120, `isSwift: false`, build `4ecf5e505be9`. Reopening 7701 attached
it as a client. The reverse-start-order port-release limitation remains in
[the release tracker](https://github.com/puritysb/AgentDeck/issues/449); no
claim of a seamless reverse takeover is made.

## Public npm confirmation

At 16:04 KST, the original OIDC release run succeeded without rerun or retag.
All four exact 1.7.0 versions and their `latest` tags were read back from npm;
setup's registry README is non-empty. [npm-v1.7.0](https://github.com/puritysb/AgentDeck/releases/tag/npm-v1.7.0)
is published. Store submissions remain review states, not public-release claims.
