# AgentDeck local plugin preview

This is a private test package, not a public-directory or zero-configuration release.
The MCP endpoint runs inside AgentDeck on IPv4 loopback. No public server, tunnel,
API key, downloaded helper or ChatGPT account credential is required by the endpoint.

On macOS, open Dot settings, choose **Set up local connection**, then **Start connection**.
For the Node daemon, `agentdeck dot init-local` creates a new private configuration and
refuses to replace an existing one. Activate it with `agentdeck daemon restart`.

`plugin.json` and `mcp.json` follow the portable package format. A significant client gate
remains: portable MCP configuration has no pre-registered OAuth client fields. The server
currently supports a pre-registered public client with PKCE, not dynamic registration.
Therefore installing this package alone is not yet a verified authentication workflow.
`client-preview.toml` contains the explicit supported client configuration for isolated tests;
merge it through the client configuration UI/workflow, never overwrite existing configuration.
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

Before distribution: verify host support for bundled pre-registration or implement bounded,
validated dynamic registration in both daemons; test actual ChatGPT/Dot invocation and restart,
sleep, consent rejection and revocation. Public local MCP distribution requires OpenAI support.
See [the distribution decision](../../docs/dot-distribution-decision.md).
