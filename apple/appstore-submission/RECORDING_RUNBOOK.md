# AgentDeck launch recording runbook

This runbook separates App Store metadata from broader launch marketing. The
same deterministic scenario powers both, so the app and terminal footage tell
one coherent story without exposing a real project, account, path, token, or
network address.

## Decision

Do not add a shipping simulation feature to AgentDeck. The app already has a
Debug-only WebSocket capture path, and the repository has a static screenshot
mock. A developer-only performance harness is safer because it:

- exercises the real dashboard parser and SwiftUI views;
- cannot appear as a hidden or dormant App Store feature;
- never launches a coding agent or modifies a workspace;
- gives every take the same timing and privacy-safe content;
- leaves the existing static screenshot captures reproducible.

`scripts/appstore-demo-orchestrator.mjs` adds a looping 30-second performance
with Claude Code, Codex, and OpenCode. `scripts/record-feature-demo.sh` starts
the feed and, for marketing footage, a synchronized three-pane fictional
terminal replay.

## The cycle

Every cycle opens **cold** — a connected daemon with zero sessions — and then
introduces one agent at a time, which is what a real machine looks like as a
developer starts working. The whole arc fits in 28s because an App Preview may
not exceed 30 seconds.

| Time | Dashboard | Terminal panes |
|---:|---|---|
| 0–2.5s | Empty state; no sessions | All three blank |
| 2.5s | **Claude appears** — reading, then editing | Claude pane opens |
| 8s | **Codex appears**; Codex quota gauge lights up (7d, 78%) | Codex pane opens |
| 11s | Claude completes and goes idle | `✓ Dashboard polish complete` |
| 13.5s | **OpenCode appears** — drafting release notes | OpenCode pane opens |
| 16.5s | Claude enters the amber attention state | `Permission required` |
| 20s | Attention clears; Claude applies the change | `Permission granted` |
| 22.5s | Codex completes; quota ticks to 80% | `✓ 1842 tests passed` |
| 24.5s | OpenCode completes | `✓ Release notes are ready` |
| 26.5–30s | All three idle; creatures settle to the floor | Panes at rest |

### Quota gauges: Codex only, on purpose

The cycle emits a `usage_update` carrying **one Codex weekly window**
(7d, 78 → 80%, ChatGPT Plus) — what a real machine reports once the 5h window
has reset. The Claude `fiveHourPercent` / `sevenDayPercent` fields are
deliberately absent.

This is not a shortcut — it is what the App Store build actually shows.
`TopologyRail.rateLimitChips` gates Claude's gauges on
`daemonService.isUsingExternalDaemon`, because they need OAuth token and relay
data the sandboxed app cannot produce alone; the Codex gauges sit outside that
gate because the Swift daemon reads `~/.codex` directly. A preview showing a
populated Claude quota row would depict a capability the shipped app does not
have without the separately-installed Node daemon.

## Marketing captures are a different path on purpose

`scripts/capture-marketing-screenshots.sh` writes `docs/media/` for the README
and the project site. It runs the same deterministic feed but passes
`--relay-usage`, which adds Claude's subscription gauges — legitimate there,
because those surfaces describe the daemon product where a Node daemon relays
that quota, and forbidden here, because the sandboxed App Store build cannot
produce them alone (`UsageAPIClient.directOAuthUsageSupported == false`). The
App Store scripts never pass the flag and the marketing script never writes
into `apple/appstore-submission/`; keep it that way.

It exists because the screenshots it replaced were real captures of a
developer's desk — real project names, real task text in the operator's own
language — in an English-language README. The Collaboration panel is the one
surface that does not read the feed: it fetches its task history over HTTP, so
the orchestrator answers `/apme/tasks` on the same port, and a pinned capture
feed now also supplies the port the panel asks (`AgentStateHolder.captureFeedPort`).
Without that the panel queried the developer daemon on :9120 and put this
machine's real sessions into an otherwise synthetic frame.

The APME boards and the menu bar popup's activity summary read a much wider
API surface than the two endpoints stubbed here, so they only have anything to
show against a daemon that has really been measuring work.
`scripts/capture-live-screenshots.sh` handles those: same window-capture rule
and the same 1440x900 density, real data by necessity. Real project names and
whatever language the operator writes in are an accepted trade for those three
images, and never for an App Store asset.

It does not click the tab for you. SwiftUI's tab bar ignores a System Events
synthetic click, so the script pins the window and captures whatever tab is
selected rather than pretending it can drive one. Worth scrolling the Work
board a row or two first: it opens on the newest task, which on a machine that
is taking the screenshot is the screenshot.

## What a capture must not inherit

A capture takes whatever the machine is in the mood for unless the harness pins
it down. Three things reached submission assets before they were pinned, all of
them invisible until someone looked at the pixels:

- **The operator's UI state.** The dashboard's Habitat/Collaboration toggle is
  persisted (`dashboardCollaborationEnabled`), and the Debug build shares the
  shipping bundle id, so a panel left open on this desk lands in the capture —
  covering the topology rail the `05-devices` crop is taken from.
  `reset_capture_defaults` writes the deterministic value before every launch.
- **The system language.** WeatherKit's attribution is localized, so a Korean
  system put a Korean word in an otherwise English capture. The app is launched
  with `-AppleLanguages '("en")'`; the raw captures are locale-independent, and
  only `compose-appstore-screenshots.py`'s captions are per-locale.
- **Z-order.** `screencapture -D` records the display as composited, so any
  window above the dashboard is inside the crop rect. On a desk where other
  agent sessions run GUI apps this is not hypothetical: a game engine's splash
  window put a third party's UI into a take. `isolate_dashboard` hides every
  other regular app and restores them afterwards.

Window geometry is now **set, read back, and retried** (`force_window_geometry`)
rather than set once: the window is restored to its remembered size shortly
after launch, so the early `set size` was silently reverted and the fixed crop
rect then framed desktop instead of dashboard. A run that cannot reach the
geometry fails loudly, because a capture whose frame does not match the crop is
worse than no capture.

**`screencapture -V` does not record at the backing resolution.** A still grab
of this 5120x2880 panel comes out at 5120x2880; a video of the same display
comes out at 4096x2304. The window-to-frame ratio is therefore the recorder's
own, not the 2 a Retina display implies, and a hardcoded doubling framed 80%
dashboard and 20% wallpaper while every geometry assertion passed — the numbers
all agreed with each other and disagreed with the file. The macOS crop is now
measured from the raw's real dimensions against the display's logical size
after each recording, and printed, so a wrong frame is visible in the log rather
than only in the pixels. `AGENTDECK_CAPTURE_DISPLAY`, `AGENTDECK_CAPTURE_WIN_X`
and `AGENTDECK_CAPTURE_CROP_X` move a take to another screen — the window
position is a global coordinate while the crop offset is display-local, so a
secondary-screen capture needs both.

**Stills survive a busy desk; video does not.** Each screenshot beat is an
instantaneous grab, so a moment of quiet is enough. A preview needs ~48 seconds
of uninterrupted, unobstructed screen, and another session launching a window
during it ruins the take with nothing to salvage. Record previews when nothing
else on this machine is driving a GUI.

## Producing the submission assets

Both scripts start the feed with an epoch in the **future** and launch the app
fresh against it. Recording an already-looping feed does not work: the previous
cycle's last session card survives the empty phase, so the cold open reads as
"one idle session" rather than "nothing running yet".

```bash
bash scripts/record-appstore-previews.sh macos    # → previews/macOS/agentdeck-preview.mp4
bash scripts/record-appstore-previews.sh iphone   # → previews/iPhone/…
bash scripts/record-appstore-previews.sh ipad     # → previews/iPad/…

bash scripts/capture-appstore-screenshots.sh macos    # → screenshots-raw/macOS/ (4 beats)
bash scripts/capture-appstore-screenshots.sh iphone
bash scripts/capture-appstore-screenshots.sh ipad

python3 scripts/compose-appstore-screenshots.py       # → screenshots/{en,ko,ja}/<platform>/

bash apple/scripts/validate-appstore-submission.sh
```

Screenshots ship per locale (en/ko/ja) with captions set in IBM Plex Sans /
KR / JP and a JetBrains Mono kicker, on the marketing token palette only —
`compose-appstore-screenshots.py` owns captions and layout; raw captures are
locale-independent (the app UI itself is English). macOS additionally gets a
`05-devices` panel — an enlarged crop of the topology rail from the fleet
capture, real pixels, no fabricated UI. App Previews stay locale-common.

Output is already encoded to everything the validator enforces: H.264 High,
level 4.0, progressive, 30 fps, 28s, 10–12 Mbps, and the exact per-platform
dimensions (macOS 1920×1080, iPhone 886×1920, iPad 1200×1600). Screenshots come
out at native capture size — macOS 2880×1800 from a 1440×900 logical window,
iPhone 1284×2778 (iPhone 14 Plus simulator — see below), iPad 2064×2752 —
with the alpha channel flattened, which the App Store rejects.

**iPhone screenshot size (2026-07-19 incident)**: the iPhone capture device
was "iPhone 16 Pro Max" (1320×2868, the 6.9"-class resolution) until ASC
rejected an upload with "스크린샷 크기가 잘못되었습니다 — 1242×2688, 2688×1242,
1284×2778 또는 2778×1284이어야 합니다" — this app's screenshot slot in ASC only
accepts the "6.5-inch Display" bucket, not 6.9" or 6.7"/1290×2796. Fixed by
switching `scripts/capture-appstore-screenshots.sh`'s iPhone capture device
to "iPhone 14 Plus" (native 1284×2778, one of the two accepted sizes), and
`apple/scripts/validate-appstore-submission.sh`'s iPhone accepted-size list
now matches ASC's literal error text exactly instead of guessing at "any
valid Apple size." Before re-adding a newer/larger iPhone simulator here,
confirm in ASC's UI which bucket this app record's screenshot slot actually
accepts — it does not auto-widen just because Apple ships a new device.

**Every App Preview carries a silent AAC-LC audio track** (44.1kHz stereo,
muxed in via `anullsrc`), even though the captures have no real sound. App
Store Connect rejects an uploaded preview with no audio stream at all with
"unsupported or corrupted audio" — it does not accept an absent track as
equivalent to a silent one. This has bitten this repo twice (recordings from
2026-07-14 and 2026-07-19 both shipped audio-less `.mp4`s); do not reintroduce
`-an` in `scripts/record-appstore-previews.sh`'s `encode()`. The validator
(`apple/scripts/validate-appstore-submission.sh`) now fails any preview
missing an AAC audio stream, so a regression here is caught locally instead
of surfacing only at ASC upload time.

Verify the shape of a run without the app at all:

```bash
node scripts/appstore-demo-orchestrator.mjs serve --port 9221
```

## Story A — App Store Preview (app UI only, ≤30 seconds)

Apple App Review Guideline 2.3.4 permits only screen capture of the app itself
in an App Preview. Do not show Terminal, tmux, Xcode, browser chrome, a desktop,
or a hardware camera shot in this asset. App Previews are also capped at 30
seconds, so **record the full 60-second cycle and trim** — do not try to make
the harness itself fit the limit.

The whole cycle is already under the limit, so the recorded 28s clip **is**
the preview — no trimming step.

| Cut | Message |
|---|---|
| 0–2.5s | Nothing to manage yet |
| 2.5–13.5s | Your agents show up on their own, one at a time |
| 13.5–16.5s | Every agent, one surface |
| 16.5–20s | Know exactly when a human is needed |
| 20–28s | Back to flow; everything lands |

Use the **`02-attention`** screenshot beat (cycle t=18.8s) as the poster frame
candidate on macOS.

Start the animated feed:

```bash
bash scripts/record-feature-demo.sh app-only
```

Launch an iOS Debug Simulator build with these arguments:

```text
-AgentDeckScreenshotURL ws://127.0.0.1:9220
```

For a fresh simulator, complete the first-run onboarding before capturing;
otherwise the onboarding screen covers the dashboard even though the feed is
connected. The `prefs.hasSeenOnboarding` preference is read as a Boolean, so
a string-valued launch argument does not replace completing onboarding.
`AGENTDECK_CAPTURE_IOS_UDID` selects an explicit simulator for either capture
script. If the Debug trampoline stalls in `simctl launch`, rebuild the Debug
simulator target with `ENABLE_DEBUG_DYLIB=NO ARCHS=arm64 ONLY_ACTIVE_ARCH=YES`
and ad-hoc simulator signing (`CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES`).
This does not alter the Release archive settings.

Record at least one complete 60-second cycle, then trim in the editor. The
existing `apple/appstore-submission/previews/` files remain the current
upload-ready assets until a replacement passes
`validate-appstore-submission.sh`.

## Story B — launch film (website, social, press; 45–60 seconds)

This version may show the developer workflow because it is not an App Store
Preview.

| Time | Shot | Direction |
|---:|---|---|
| 0–2.5s | Empty dashboard beside three blank panes | “Nothing running yet.” |
| 2.5–8s | Claude pane opens; its card slides into the app | One agent, two surfaces, same instant |
| 8–16.5s | Codex then OpenCode join | Show the dashboard filling up, not a static grid |
| 16.5–20s | Tight crop on amber attention state | Human attention becomes the visual climax |
| 20–26.5s | Attention clears and agents complete | Show control without pretending the app approved it |
| 26.5–30s | Full AgentDeck hero frame, creatures at rest | End card: “Your agents. One calm control surface.” |

For a longer film, record two consecutive cycles and cut between them.

Start the synchronized terminal rehearsal:

```bash
bash scripts/record-feature-demo.sh marketing
```

The command creates a tmux session named `agentdeck-launch-demo`. It does not
run Claude, Codex, or OpenCode. The panes replay fictional output synchronized
to the same epoch as the app feed. In another Terminal window, launch the macOS
Debug app with:

```bash
open -n apple/DerivedData/Build/Products/Debug/AgentDeck.app --args \
  -AgentDeckScreenshotURL ws://127.0.0.1:9220
```

Stop everything with:

```bash
bash scripts/record-feature-demo.sh stop
```

## Capture rules

- Capture at 30 fps. App Store H.264 previews must be 15–30 seconds, progressive,
  at most 500 MB, and use a supported target resolution.
- Keep terminal text fictional. Never point the harness at a real repository.
- Do not show approval buttons in the observed Claude attention state; the
  faithful UI is display-only and says to respond in the terminal.
- Do not replace current upload assets until the new files pass:

```bash
bash apple/scripts/validate-appstore-submission.sh
```

- Verify the processed 5-second poster frame in App Store Connect.
