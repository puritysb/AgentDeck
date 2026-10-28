# AgentDeck local plugin preview

This is a private test package, not a public-directory or zero-configuration release.
The MCP endpoint runs inside AgentDeck on IPv4 loopback. No public server, tunnel,
API key, downloaded helper or ChatGPT account credential is required by the endpoint.

## Current development checkpoint — 2026-10-25

An actual Dot delegated a shared synthetic request to its connected Mac, where the
task explicitly invoked a Node client against localhost and completed the correlated
request with sum **163**. That Node result alone did not prove the later native route
or automatic plugin exposure and clean-user installation. The [sanitized evidence](../../docs/dot-distribution-decision.md#local-executor-checkpoint-2026-10-25)
keeps those results separate from the earlier local-MCP inheritance failure.

The preferred route now packages a native stdio client on the ChatGPT plugin side.
The [native client](native/README.md#measured-validation-2026-10-25) passed 16 tests,
a Release build, signed stdio discovery and a read-only validation-task smoke against
the Node host: consent, Keychain custody, separate-process reads, refresh and revocation.
That smoke did not involve actual Dot or report writes. On **2026-10-26**, the isolated
Swift-host harness launched with organization Apple Development signing and a
current-Mac provisioning profile, resolving the earlier `amfid -413` failure.
Dedicated sandbox/Data Protection Keychain checks and the listener on 19476 passed.
Native-client UI denial left zero grants; a later code-matched approval stored its
credentials and created one grant. Actual Dot's existing local task then used the
native CLI for request → context → claim → working → completed → final read, with
six exit-0 results and matching **26 + 84 + 12 = 122**. The validation task did not
claim or report on Dot's behalf. Quit/relaunch restored the grant and completed
request, a read beyond the initial token lifetime succeeded, and revocation followed
by client disconnect left zero host grants/requests and rejected later reads. Exact
refresh timing was not measured. The harness was stopped and quit after validation.
AgentDeck's product app and installed runtime remain unchanged. The app will not bundle or launch the client
or prompt users to install a companion. The local route needs no publisher-operated
relay, API key or tunnel configuration; OpenAI still processes the task and selected
context, so this is not a local-only processing claim.

Public packaging must declare the local MCP server explicitly in `mcp.json` and
include its executable/dependencies. [Desktop-only submission](https://developers.openai.com/plugins/deploy/desktop-only)
requires approved-partner eligibility and organization allowlisting before review.
Its **Skills only** portal upload step is specific to that approved local-MCP path;
the general `requires_local_executor` flag does not grant MCP distribution approval
or replace persistent credential handling. Keep credentials out of skills, manifests,
archives and tool results. The checked-in MCP manifest is still the HTTP preview;
native stdio is a packaging template, and this test invoked the CLI explicitly.
Installed-plugin exposure, the full lifecycle matrix and clean-user installation
must pass before claiming install-and-consent onboarding.
The development profile and test UI do not establish consumer signing or product setup.

## Existing direct HTTP preview

For the native macOS experiment, select the explicit `AgentDeck_DotPreview_macOS`
scheme first. Standard macOS/iOS builds exclude Dot entirely; see the
[build configurations](../../RELEASING.md#dot-development-and-store-builds).
In that preview, open Dot settings, choose **Set up local connection**, then **Start connection**.
For the Node daemon, `agentdeck dot init-local` creates a new private configuration and
refuses to replace an existing one. Activate it with `agentdeck daemon restart`.

`plugin.json` and `mcp.json` use the portable package format. This preview does not
embed OAuth client credentials. The current OpenAI format supports non-secret
[MCP authentication settings](https://developers.openai.com/plugins/build/plugins#configure-mcp-authentication)
under each server's extension; those settings alone do not prove desktop localhost
onboarding. The loopback host accepts a client that brings no configured client ID, in
both daemons: a Client ID Metadata Document fetched over HTTPS from an allow-listed host
(`chatgpt.com`, no redirects, size and time bounded), or a secretless loopback registration
(RFC 7591, bounded and evicting only clients with no live grant or pending consent). Neither
grants access: every connection still needs the native consent below, and codes, refresh
tokens and revocation are bound to the client that started the flow. The loopback host has no
Events surface, so it neither advertises nor grants `agentdeck:subscribe` to any client,
pre-registered included. The pre-registered
`client-preview.toml` configuration keeps working; merge it through the client configuration
UI/workflow, never overwrite existing configuration.

Measured 2026-10-11 against an isolated host with Codex CLI 0.160.1 and a configuration that
named only the URL: `codex mcp login` with registration `auto` and `cimd` used the Codex
metadata document on `chatgpt.com`, `dcr` registered a loopback client, and all three
completed consent, token exchange and `tools/list`. The ChatGPT desktop **Add server** GUI
was not driven in that measurement; that it uses the same client is the documented claim.
The desktop app and CLI share this local-host configuration. Start the normal OAuth
login with only `agentdeck:read,agentdeck:report`. Let resource metadata discovery
supply the OAuth resource: Codex CLI 0.160.1 duplicates the `resource` authorization
parameter when the same `oauth_resource` override is also configured, which this
server rejects. No token or account credential belongs in this file.

This enables the direct HTTP local client; it does not establish automatic exposure
of those tools to Dot. The 2026-10-25 result used an explicitly invoked client instead.
A Dot-created local task must expose the intended transport and return a correlated
report before claiming that particular route works. Ordinary cloud Dot instructions
do not automatically become AgentDeck reports.
Do not add secrets or invent unsupported fields in `mcp.json` to bypass this gate.

The 2026-10-09 real-account test reached Dot-created task creation on the connected
Mac, but that child (host `durable`) reported no AgentDeck MCP tools before its first
request read. No claim or report reached AgentDeck. This is a tool-availability
failure, not evidence that another local consent is needed. The local Codex host
exposes the tools; that success must not be generalized to a cloud-coordinated task
with a local working directory. See the [recorded result](../../docs/dot-distribution-decision.md#real-account-validation).

Compare the browser's code with AgentDeck's pending consent and approve it. Select that grant,
prepare a request, and give its request ID to the connected agent. The agent reads, claims and
reports it. Disconnect revokes its grant. Local requests never imply cloud event delivery.

Before distribution: verify the desktop Add server flow end to end on the shipped Swift host;
test actual ChatGPT/Dot invocation and restart,
sleep, consent rejection and revocation. Public local MCP distribution requires OpenAI support.
See [the distribution decision](../../docs/dot-distribution-decision.md).
