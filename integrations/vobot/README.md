# AgentDeck for Vobot Mini Dock

A stock-firmware app for Vobot Mini Dock. It connects to a paired AgentDeck daemon
using the [read-only Surface profile](../../docs/surface-protocol.md). This
limits app behavior, not the authority of its shared pairing credential. The LCD
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

## Security limitations

**Use only on trusted, isolated local networks. Never expose the daemon port
(default 9120) to the public internet or use public or untrusted networks.**
Pairing uses HTTP and data uses unencrypted WebSocket connections. The token
travels in the WebSocket URL. Network observers or an active attacker may read
credentials, session names, status and usage. A one-time pairing code does not
encrypt later traffic or authenticate the server.

The current daemon issues a shared token, not a device-specific read-only
credential. The app's Surface declaration does not prevent someone with that
token from using other daemon operations. The app stores the token in plaintext
at `/apps/AgentDeck/pairing.txt`. Device filesystem isolation and secure erase
have not been verified; do not assume other apps or USB access cannot read it.
Removing a local file does not invalidate a stolen token.

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

## Forget a connection

In Application Settings → AgentDeck, type `UNPAIR` into **Forget saved
connection**, save, leave Settings and reopen AgentDeck. Opening Settings
pauses the app and closes its connection; reopening processes the removal
before any connection attempt. The app deletes `pairing.txt` and any interrupted
`pairing.txt.new`, clears the saved one-time code and returns to the pairing
screen. A deletion failure stops connection and keeps the request pending.
This is local deletion, not cryptographic erasure or server-side revocation.

If a token may have leaked, run `agentdeck token rotate` on the daemon computer.
Rotation retires the **shared** credential for the active daemon owner and can
disconnect other paired devices; plan to pair affected devices again. Global
revocation across every inactive profile or older daemon is incomplete; follow
the [rotation scope and limitations](../../docs/daemon.md#lan-security-model-issue-145).
Check other hosts and inactive profiles separately; an unreachable or older
daemon may still accept the previous credential.
Do not rotate automatically just to forget one dock. Device-specific revocation
requires the daemon changes described below.

## Remaining security work

Before claiming secure remote use, implement and test all of the following:

- Verified HTTPS pairing and WSS data transport on the actual Mini Dock runtime,
  including certificate/hostname or pinned-identity validation, expiry, wrong
  server and interception tests. Never silently fall back to plaintext.
- Random per-device credentials stored as verifiers on the server, with scopes
  bound at issuance. Enforce the read-only allow-list on both HTTP and WebSocket
  paths before any startup data or command dispatch in **both Node and Swift**.
  Client-declared profiles must not grant authority. Test rejected commands,
  impersonated registration and endpoints outside the read-only allow-list.
- Individual revocation that closes active sockets and rejects reconnections,
  plus persistence, restart and Node/Swift ownership-handover tests. Keep legacy
  credentials explicit during migration; do not silently unpair the fleet or
  turn a scoped device token into an unrestricted shared token.
- Remove long-lived credentials from URLs only after both shipped daemons accept
  the replacement authentication mechanism. Verify device storage isolation
  and platform credential protection; do not present obfuscation as encryption.

The local deletion changes here do not complete these items. Validate the
settings flow on physical firmware before packaging a new Gallery release.

### Server implementation and migration sequence

The current source has two distinct boundaries that must not be conflated:

- `bridge/src/ws-server.ts` and the Swift `WebSocketServer` authenticate before
  the daemon associates a Surface offer with the connection. Initial data is
  scheduled independently of that offer. A delay awaiting registration is not
  an authorization check.
- Node's `surfaceAllowsEvent` currently filters only the portable-reader
  profile. Swift additionally checks negotiated command capabilities, but a
  new connection with the shared credential can omit that negotiation. Neither
  behavior makes the credential itself read-only.
- `shared/src/pairing-credentials.ts` defines the existing credential adoption
  format as `token`, `accepted`, `revision` and `eventId`. Do not append device
  scope to a token and pass it through this legacy adoption path: scope is not
  part of that persisted/adopted authority. Native sandbox and CLI stores can
  also differ, so sharing a filename is not a handover protocol.

Implement the next phase in this order, leaving legacy clients unchanged:

1. Define a versioned device-credential record with a random opaque identifier,
   a hash of a high-entropy secret, immutable granted scopes, revocation state
   and an owner generation. Use common fixtures for the TypeScript and Swift
   readers. Reject corrupt or unknown versions without a legacy fallback.
2. Add explicit read-only issuance under the existing operator-held pairing
   window. Return the credential kind and granted scopes; a new Vobot client
   must reject a response that silently substitutes a shared unrestricted
   token. Keep old clients on the explicit legacy path until upgraded.
3. Resolve the credential to a server-owned principal at the handshake, before
   any connect callback or queued startup data. Put a deny-by-default check
   before **every** HTTP dispatch, WebSocket raw/relay path, command callback,
   binary/audio path and outbound send. Permit only the agreed session/usage
   projection. Registration may describe a device, never raise its authority.
4. Add owner-only list/revoke operations that return metadata, never secrets.
   Revocation must durably commit before success, invalidate already-open
   sockets, fence pending asynchronous sends and survive restart. Device self-
   deletion is not server revocation. Do not use an IP address as a token's
   fallback identity or admit revoked credentials through approval fallback.
5. Extend the explicit Node/Swift custody exchange to carry device verifiers
   and revocation generation atomically. An old or incompatible owner must
   refuse scoped authentication, never convert it into a shared token. Test
   stale-owner return and interrupted handover before enabling issuance in
   either production daemon.
6. Ship compatible daemon support first, then opt the Vobot client into the
   new credential kind. Test wrong scope, missing registration, re-registration
   as an internal worker, raw relay commands, binary audio, concurrent revoke,
   reconnect after restart, and both custody directions. Only then validate
   the TLS/device-storage release separately on the physical Mini Dock.

Until those acceptance checks pass, do not enable a partial device-token
implementation or describe per-device revocation as delivered.

## Gallery release

Version 0.3.0 was approved on 2026-11-13 with security recommendations.
Approval is not a security certification or evidence that a newer package has
been published. The first submission adds Wi-Fi pairing to the USB prototype.
This is the Vobot package version; it does not change the AgentDeck daemon or
Surface protocol version.

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
