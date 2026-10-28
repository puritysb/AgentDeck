# AgentDeck native desktop preview

Internal preview candidate **0.1.1** repairs the existing 0.1.0 onboarding flow:
GUI packages declare a setup skill so users can request opening the bundled
Connect app without finding the installation cache. This is a preview packaging
patch, not a new product milestone or a public release. Root `VERSION`, AgentDeck
product versions and the local MCP contract are unchanged. Installation, setup
entrypoint visibility and GUI launch still require acceptance on the exact package.

This experimental package bundles a signed Swift MCP client for macOS
{{MINIMUM_OS}} or later, for these architectures: **{{ARCHITECTURES}}**. It
connects to an independently available AgentDeck local host. It needs no user
API key, tunnel, Node installation or publisher relay. It does not install or
start AgentDeck, grant consent or wake Dot. ChatGPT still processes the task
and selected context; this is not offline AI.

Connection profile: **{{PROFILE}}**, loopback port **{{PORT}}**, account
**{{ACCOUNT}}**. Use this same account and port for connection and disconnection.
The test fixture profile is not a production AgentDeck host.

## Connect

{{CONNECT_INSTRUCTIONS}}

For a GUI package, use the plugin's setup action in the ChatGPT desktop app, or
ask its **setup** skill to open AgentDeck Connect in a local conversation.
The setup skill locates the app within that installed package; it does not ask
you to find a cache path or enter a command. The host's available local tools
and approval policy determine whether it can open the app. If that action is
unavailable, setup reports the missing step instead of claiming success.

Start the local AgentDeck host, compare the code shown by the client and
AgentDeck, and approve only the intended read/report connection in AgentDeck.
No credentials are included in this package. The client stores its own grant
in the macOS login Keychain. Existing AgentDeck connections are separate.

The local stdio server starts when the desktop plugin host launches it. It
does not authorize itself. Use a local ChatGPT task with the installed plugin,
explicitly provide a shared request ID and ask it to read, claim and report that
request. These reports describe that request, not global Dot or ChatGPT activity.

Opening Connect, saving a grant, discovering the native MCP tools and completing
a request are separate checks. Setup reports only the stages it can observe;
saved credentials alone do not prove host availability or Dot tool access. The
setup skill never replaces missing MCP tools with direct CLI request reporting.

To use the local path from Dot, connect this Mac through the Dot profile's
**Computers → Your computer → Allow access**, and keep the Mac online with the
ChatGPT app open during local work. Supported plugins must be installed and
enabled for the account; account permissions and execution environment still
apply. Installing this package does not by itself establish native tool exposure
in a Dot task. See [Dot computers and apps](https://learn.chatgpt.com/docs/dots/computers-and-apps).

The documented [onboarding declaration](https://developers.openai.com/plugins/build/plugins#add-an-onboarding-skill)
invokes a packaged skill in a new or existing conversation. It does not declare a
native-app launch action. Opening Connect is a local implementation step that
must be tested separately, both after a fresh installation and when installing
within an existing conversation.

## Recover or disconnect

If Keychain access is unavailable before any refresh is sent, restore access and
try again. If credentials cannot safely be reused, disconnect and connect again.
If a report times out, inspect the request state before deciding whether to send
another report; the client does not retry writes automatically. If AgentDeck is
unavailable during disconnect, the client retains the credential so revocation
can be retried. Removing the plugin alone does not prove the host grant was revoked.

{{DISCONNECT_INSTRUCTIONS}}

## Distribution status

The ZIP contains a portable plugin layout with a bundled stdio executable.
The adjacent staging marketplace can be registered for a separate local desktop
installation test. Package creation does not install the plugin, change existing
connections, prove Dot tool inheritance or publish anything.

Public local MCP distribution requires an approved partner organization,
allowlisting and review under OpenAI's
[desktop-only plugin submission](https://developers.openai.com/plugins/deploy/desktop-only)
process. This preview does not establish that eligibility. Developer ID signature
verification is separate from notarization, Gatekeeper acceptance, clean-user
installation and supported-architecture testing. An AgentDeck App Store release
does not bundle or launch this plugin accessory.
