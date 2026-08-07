# AgentDeck — Google Play listing

Submission target: **[Play Console](https://play.google.com/console)** → AgentDeck → *Grow → Store presence → Main store listing*.
Package `dev.agentdeck`. The account is an **organization** account, so the
12-tester / 14-day closed-testing requirement that applies to personal accounts
created after 2023-11-13 does not apply — production is reachable directly.

The APK on GitHub Releases stays; Play is an additional channel, not a
replacement. Nothing in the app changes between them.

## Release gate

Play refuses an upload below its target API floor before a human ever sees it.

| Requirement | Value | State |
|---|---|---|
| `targetSdk` from 2025-08-31 | ≥ 35 | — |
| `targetSdk` from **2026-08-31** | **≥ 36** | met (`compileSdk`/`targetSdk` 36) |
| Artifact | AAB, not APK | `./gradlew bundleRelease` |
| Signing | upload key | `android/signing.properties`, CI secrets |

`android-release.yml` already builds and uploads the bundle to the **internal
track** when the repo variable `ANDROID_PLAY_ENABLED` is `true` and the secret
`PLAY_SERVICE_ACCOUNT_JSON` holds a service-account key with *Release manager*
on this app. Until then the workflow only attaches the APK to a GitHub Release.

## Store assets

Per [Play's asset specs](https://support.google.com/googleplay/android-developer/answer/9866151), checked against our files.

| Slot | Spec | Our file | ✓ |
|---|---|---|---|
| App icon | 512×512 PNG, no transparency | `1.0.5/icon-512.png` | 512×512, flattened onto `--ink-900` |
| Feature graphic | 1024×500 PNG/JPG, no transparency | `1.0.5/feature-graphic-1024x500.png` | 1024×500 |
| Phone screenshots | 2–8, 320–3840 px | `1.0.5/phone-01-dashboard.png`, `phone-02-attention.png` | 1080×2400 |
| Tablet screenshots | 10" required to list as tablet-optimized | `1.0.5/tablet-01-dashboard.png` | 2560×1600 |

**Screenshots are captured from the app, never mocked up** — Android 16
emulators at the two Play form factors (phone 1080×2400 @420dpi, 10" tablet
2560×1600 @320dpi), rendering a synthetic daemon feed. The projects
(`checkout-api`, `payments-worker`, `design-system`, `docs-site`, `mobile-app`)
and the quota numbers are fabricated for exactly this purpose: the real daemon
carries live session content — prompts, file paths, other people's work — and
none of it belongs in a store listing.

The feature graphic reuses the tablet capture as a text-free band (terrarium,
creatures, kelp). Panel UI is deliberately cropped out: at 1024×500 its type is
unreadable, and the app's own header would collide with the wordmark.

## Short description (≤80 chars)

```
Every coding agent session on one calm screen — running, waiting, or idle.
```

## Full description (≤4000 chars)

```
AgentDeck turns your Android tablet, phone, or e-ink reader into a live status surface for the AI coding agents running on your computer.

Every session gets a row: which agent it is, which project it is in, which model it is using, and whether it is working, waiting on you, or idle. The screen repaints itself as that changes, so you can tell at a glance which of five sessions actually needs you.

WHAT YOU SEE
• Live sessions from Claude Code, Codex, OpenCode, and OpenClaw
• Rate-limit gauges for your Claude and ChatGPT subscriptions, with reset countdowns
• A timeline of what each agent did — prompts, tool calls, and replies
• An aquarium view where each session is a creature, so activity reads without reading

WHEN AN AGENT ASKS
When an agent stops to ask a question, the dashboard says so, shows the question, and — when your setup allows it — lets you answer from the device. Otherwise it points you back at the terminal. It never guesses on your behalf.

BUILT FOR THE SCREEN YOU HAVE
One app covers phones, tablets, and e-ink readers. E-ink devices are detected and driven through their vendor's own refresh path — Onyx Boox, Crema, Kobo, MOAAN, Bigme and others — with layouts and refresh strategies chosen for the panel rather than scaled down from a tablet.

WHAT IT NEEDS
AgentDeck for Android is a dashboard, not an agent. It shows what the AgentDeck daemon on your computer reports, so you need that running on the same network:

• On a Mac, install the free AgentDeck Dashboard app from the Mac App Store, or
• On macOS, Windows, or Linux, run: npx @agentdeck/setup

Then start Claude Code, Codex, or OpenCode the way you already do. Sessions appear on their own. With no daemon reachable, the app says so plainly instead of pretending.

PRIVACY
The app talks only to your own daemon on your own network. There is no AgentDeck account, no analytics SDK, and no advertising SDK.

AgentDeck is an independent project and is not affiliated with or endorsed by Anthropic, OpenAI, Google, or any other party named here. All trademarks belong to their owners.
```

## Data safety

| Question | Answer |
|---|---|
| Does the app collect or share user data? | No |
| Data encrypted in transit? | Local network only; no data leaves the user's network |
| Microphone (`RECORD_AUDIO`) | Used only for push-to-talk dictation into a session, on device request; audio is sent to the user's own daemon, never to us |
| Account creation | None |

Privacy policy: <https://puritysb.github.io/AgentDeck/#privacy>

## Declared permissions worth a note

- `RECORD_AUDIO` — push-to-talk dictation to the user's own daemon.
- `WRITE_SECURE_SETTINGS` / `WRITE_SETTINGS` — **not grantable to a Play
  install.** They exist for the adb-granted e-ink path where `BootReceiver`
  re-enables USB debugging on readers that reset it every boot
  ([docs/android.md](../../docs/android.md#e-ink-device-setup-cremas-etc)). Play
  users simply do not get that behavior, so the listing must not advertise it.
- `FOREGROUND_SERVICE_CONNECTED_DEVICE` — the monitor service holding the
  dashboard connection while the screen is on.

## Submission steps

1. Confirm `pnpm verify-version` and the Android version bump (`versionName`,
   `versionCode`) — Play requires a strictly higher `versionCode` per upload.
2. `./gradlew bundleRelease` (or let `android-v*` CI do it with
   `ANDROID_PLAY_ENABLED=true`).
3. Upload to **internal testing** first and install from Play on one device.
4. Complete *App content*: privacy policy, data safety, ads (none), content
   rating, target audience, government-app declaration (no).
5. Promote to production once the internal install is verified.
