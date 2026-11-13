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
is available only after opting into the separate device TLS transport below.

## Opt-in device TLS transport

The source includes a separate HTTPS polling endpoint for Vobot. It requires a
random per-device credential and serves only bounded session and usage fields.
Both Node and Swift implement the same authority format. The device credential
is rejected by the legacy HTTP and WebSocket routes, including local-trust and
IP-approval shortcuts. A Surface profile never grants authority.

Existing installations continue to use their saved pairing unless an operator
provisions `/apps/AgentDeck/device-tls.json` over the trusted USB connection.
Once that file exists, invalid configuration or TLS failure stops the secure
connection; the app does not fall back to its legacy token. Keep `pairing.txt`
and the Wi-Fi settings intact during migration. Existing devices remain on
legacy transport until individually upgraded; this does not encrypt the fleet
or retire its shared credential.

### Local operator workflow

Use a private identity configuration with `version: 1`, `role: "owner"`, a DNS
`hostname`, a dedicated `port` outside 9120–9139, base64 PKCS#12 `pfx`, its
`password`, and base64 DER trust anchor `caDER`. The certificate must include
its DNS name and the server-auth extended key usage. The identity and device
configuration files contain secrets and must stay outside the repository with
owner-only file permissions. The native daemon imports the identity through
Security.framework without an external runtime.

```sh
agentdeck device-security install /absolute/private/identity.json
agentdeck device-security pair Vobot --host 192.168.1.10 --output /absolute/private/device-tls.json
agentdeck device-security status
agentdeck device-security revoke DEVICE_ID
```

The host address must be this computer's device-reachable LAN IPv4 address.
Pairing verifies the running TLS server before issuing a credential and writes
a new file with mode 0600; it refuses to overwrite an existing output. Transfer
that file and the compatible app modules over USB. Do not paste its contents
into logs, a URL, a ticket, or an unverified LAN endpoint. Installation refuses
to replace an existing server identity. Certificate renewal and trust-root
replacement require a coordinated operator migration before expiry; there is
no automatic rotation or downgrade path.

Revocation records a durable tombstone for one device. Every HTTPS request
checks it before collection and again before sending data; each connection
closes after its response. Credentials grant `sessions.read`, `usage.read`, or
both, and cannot invoke controls, hooks, relay, audio, or pairing endpoints.
Only verifiers are retained on the server. The device keeps its bearer secret
in its app filesystem; this is not hardware-backed encrypted storage.

### Firmware verification and owner handover

On the tested Mini Dock firmware 1.2.6, native TLS rejects wrong hostnames and
untrusted issuers but accepts an expired leaf certificate. The client therefore
also checks the owner-provisioned leaf SHA-256 pin and the verified chain's
validity interval before sending its bearer credential. An unset clock or a
clock earlier than provisioning fails closed. This depends on the device's
clock: the firmware has no demonstrated tamper-resistant time source, so the
checks do not establish protection against malicious clock rollback. The
custom stream adapter also avoids `asyncio.Stream`, which this runtime does
not export.

The current owner stops its TLS listener before transferring the identity,
verifiers and revocations to an admitted local same-user successor. Node sends
its transfer only to one registered local native socket and waits for a durable
receipt within the shutdown budget. Node taking over from Swift captures a
fresh sealed response before stand-down. If the Node supervisor restarts first,
the new owner challenges its current local native connection and recovers a
freshly sealed transfer; the receipt is tied to that socket and expires. An
inactive replica never promotes
itself from stale data when its previous owner is unreachable. Interrupted
handover can therefore leave device TLS unavailable and needs operator
recovery from the latest authoritative store; legacy connections remain
independent. Neither cold recovery nor an older daemon may revive a revoked
device credential.

Automated tests cover both TLS listeners, scope projection, revocation during
collection, store interoperability, and failed receipt handling. Physical RAM
tests on firmware 1.2.6 exercised valid, wrong-host, expired and wrong-CA cases,
Node and Swift snapshots, repeated polling, and rejection after revocation.
Those RAM results do not prove that the installed app or a Gallery package has
been updated. Confirm installed hashes, operating TLS traffic and both live
owner transitions before reporting deployment complete.

## Gallery release

Version 0.3.0 was approved on 2026-11-13 with security recommendations.
Approval is not a security certification or evidence that a newer package has
been published. The first submission adds Wi-Fi pairing to the USB prototype.
This is the Vobot package version; it does not change the AgentDeck daemon or
Surface protocol version.

The full-screen input alerts described above are available in development
builds. Use the development install below to try the current source on Mini
Dock firmware 1.2.6 or later. Follow the [security limitations](#security-limitations)
when pairing either build.

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
