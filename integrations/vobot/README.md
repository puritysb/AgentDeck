# AgentDeck for Vobot Mini Dock

A stock-firmware app for Vobot Mini Dock. It connects to a paired AgentDeck daemon
using the [read-only Surface profile](../../docs/surface-protocol.md). The LCD
shows up to six live sessions with AgentDeck creature icons and puts input
requests first. The ambient strip pulses amber for permission, question, or
review requests and turns off when the roster has no waiting session. The dock
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

Version 0.3.0 is the first Vobot Gallery submission and adds Wi-Fi pairing to
the USB-installed prototype. This is the Vobot package version; it does not
change the AgentDeck daemon or Surface protocol version.

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
that the waiting session moves to the top and the strip turns amber. Resolve the
request and check that the strip goes dark. Leave the app and check that the
dock resumes its ambient light setting.

Regenerate the bundled LCD icons and palette with `python3 integrations/vobot/generate_assets.py` from the repository root after changing their AgentDeck sources.
