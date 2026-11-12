# AgentDeck for Vobot Mini Dock

A stock-firmware app for Vobot Mini Dock. It connects to a paired AgentDeck daemon
using the [read-only Surface profile](../../docs/surface-protocol.md). The LCD
shows up to six live sessions with AgentDeck creature icons. When a live session
needs approval, an answer, or a review, a full-screen alert shows its animated
creature and session name. The dock keeps the first wait it saw on screen and
shows how many others are waiting as `+N`. When that session clears, the next
waiting session takes its place. The dashboard returns when none are left. The
rear light pulses amber while the alert is active. The dock
resumes control of the light when the app pauses, closes, or loses its connection.

Claude shows the reported quota windows and up to three readings, including
Fable when the daemon reports that model limit. Codex shows the reported plan
windows or the applicable credit balance and Luna reserve. The Luna number
shows the percent left. An older Codex reading includes its age.

## Pair over Wi-Fi

Install AgentDeck using the App ID from its listing when available in the
[Vobot App Gallery](https://app.myvobot.com/). Follow the
[Mini Dock installation guide](https://dock.myvobot.com/guide/download-app/).

1. Connect the Mini Dock and your AgentDeck daemon to the same trusted LAN.
2. On the Mini Dock, open **Settings → Application Settings**. Open the address
   shown on the dock in a browser and select **AgentDeck**.
3. Enter the daemon computer's LAN address and port (default 9120). On that
   computer, run `agentdeck pair` to open a short pairing window.
4. Enter the six-digit code in the Vobot settings and save. Leave Settings and
   open AgentDeck on the dock before the code expires. If pairing fails, open a
   fresh pairing window and repeat this step.

The dock redeems the one-time code and keeps its pairing token in the app's
local files. The app uses the daemon's LAN WebSocket transport. Pairing and
session traffic use a trusted LAN because the transport does not use TLS.

## Gallery release

Version 0.3.0, the first Gallery submission with Wi-Fi pairing, is in review.
Public installation is pending. The 0.3.1 package adds full-screen input alerts
and is ready to submit once the Gallery finishes reviewing 0.3.0.

Use the development install below to try the current source on Mini Dock
firmware 1.2.6 or later. The Vobot app has its own package version and uses the
existing AgentDeck Surface protocol.

## Install a development build

Enable Developer Mode and upload the `AgentDeck/` folder to `/apps` over USB
using the [Vobot developer guide](https://dock.myvobot.com/developer/getting_started/).
Then follow the Wi-Fi pairing steps. Existing development installs with a
`pairing.txt` file can keep that connection.

If AgentDeck has the Vobot USB port open, stop the daemon with
`agentdeck daemon stop` and reconnect the dock before opening Thonny.
After uploading and closing Thonny, run `agentdeck daemon start`.

For Gallery submission, package the folder with the
[Vobot App Bundler](https://dock.myvobot.com/developer/guides/publishing-guide/).
The manifest lists the source files and assets to ship. Keep device-specific
pairing files outside the folder used for packaging.

## Verify on the dock

Open the app and compare its session names and states against the daemon. While
keeping the app visible, make a disposable agent session ask for input. Check
that the session name and animated creature fill the LCD and the strip pulses
amber. Add a second waiting session and check that the first remains on screen
with `+1`. Resolve the first to reveal the second, then resolve the second to
restore the dashboard and turn the strip off. In a brightly lit room, check
whether the pulse is visible from your usual viewing position. Leave the app
and check that the dock resumes its ambient light setting.

Regenerate the bundled LCD icons and palette with `python3 integrations/vobot/generate_assets.py` from the repository root after changing their AgentDeck sources.
