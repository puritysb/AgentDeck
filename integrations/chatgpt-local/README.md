# AgentDeck local plugin preview

This is a private test package, not a public-directory or zero-configuration release.
The MCP endpoint runs inside AgentDeck on IPv4 loopback. No public server, tunnel,
API key, downloaded helper or ChatGPT account credential is required by the endpoint.

For the native macOS experiment, select the explicit `AgentDeck_DotPreview_macOS`
scheme first. Standard macOS/iOS builds exclude Dot entirely; see the
[build configurations](../../RELEASING.md#dot-development-and-store-builds).
In that preview, open Dot settings, choose **Set up local connection**, then **Start connection**.
For the Node daemon, `agentdeck dot init-local` creates a new private configuration and
refuses to replace an existing one. Activate it with `agentdeck daemon restart`.

`plugin.json` and `mcp.json` follow the portable package format, which has no OAuth client
fields. The loopback host therefore accepts a client that brings no configured client ID, in
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

This enables the local client; it does not establish cloud Dot access. A Dot-created
local task must independently expose the authenticated tools and return a correlated
report before claiming that route works. Ordinary cloud Dot instructions do not
automatically become AgentDeck reports.
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
