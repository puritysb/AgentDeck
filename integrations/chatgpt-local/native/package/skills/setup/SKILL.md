---
name: setup
description: Open this AgentDeck native plugin's connection GUI and guide local consent when the user runs setup or asks to connect, reconnect or disconnect AgentDeck. Does not read or report requests.
---

# Set up AgentDeck's local connection

Use this workflow when the user requests setup or connection management. Explain
that AgentDeck Connect opens on their Mac, then they choose Connect and approve
the displayed code and read/report scopes in the independently running AgentDeck
host. Selected context and results are processed by OpenAI; this local path does
not use an AgentDeck publisher relay. Opening the app does not grant consent.

## Open the installed connection app

Work on the Mac where this desktop plugin is installed. Resolve
`../../AgentDeck Connect.app` relative to this installed `SKILL.md` directory;
it is at the same plugin root as `mcp.json`. Use the exact resolved app path,
not a product bundle ID, a repository build or another cached plugin version.
Do not assume the current working directory is the plugin root. `PLUGIN_ROOT`
is documented for MCP configuration and plugin hooks, not as an automatically
available variable in every skill's command environment.

Use an available local app-opening or computer-use tool to open that exact app.
If authorized local command execution is available, macOS `/usr/bin/open` with
the resolved app path as one argument is an implementation option; preserve
spaces and quote the argument safely. Do not open Terminal or ask the user to
type commands. This is a local launch step, not a manifest action or an MCP tool.
Follow the host's execution and approval policy.

If this skill has no installed file location, the app is missing, or the current
environment cannot open local apps, report that setup cannot open Connect here.
Do not search other plugin caches, install helpers, modify plugin configuration
or start the AgentDeck host. Offer to continue in a supported local desktop
conversation. Do not mark setup complete.

## Guide consent and report observable state

When the app has no stored connection, let the user choose **연결 시작 / Connect**.
Have them compare the code and scopes with the AgentDeck host and approve there.
If a connection is already stored, preserve it unless the user requested
reconnection; do not initiate new consent merely because tools are missing.
Never click an approval for them, read credentials or Keychain contents,
substitute a device token, or run CLI authorization. If the host is unavailable,
ask the user to open the host they intend to connect; do not start or replace it
automatically.

Keep these states distinct:

- App opened: the connection window was observed; authorization is not implied.
- Stored connection: the GUI reports a saved grant; host availability is not proven.
- Authorized: the GUI reports that this consent flow completed. If the UI is not
  observable, attribute the user's report instead of presenting it as measured.
- Tools available: the current task actually exposes this package's MCP tools
  `get_request`, `get_context`, `claim_request` and `report_update`. Inspect available
  tool metadata when supported and match the server identity in this package's
  `mcp.json`; similarly named tools from another plugin do not count. Do not invent
  a tool listing or call unavailable tools.

If the native MCP tools are absent, say that consent and task tool availability
are separate and this task is not ready to use the connection. A new local chat
may be needed after installation; do not promise that restarting a chat exposes
tools in Dot. Keep `mcp.json` as the transport configuration. Never replace missing
MCP tools with direct CLI or HTTP request calls, and never read, claim or report a
request just to prove setup. The separate report skill handles explicitly shared
request IDs through the installed MCP tools.

For a requested disconnect, open the same app and let the user choose
**연결 해제 / Disconnect**. Report success only when observed or explicitly reported
by the user. An unavailable host can leave revocation pending; removing the plugin
does not prove revocation. Revoking this grant does not cancel a Dot task, delete
copies of context already shared with OpenAI or revoke Dot's separate computer
access. Report any local host request cleanup separately when it is observed.

For Dot local work, guide the user to the Dot profile's **Computers → Your computer
→ Allow access** when that connection is missing. The Mac must be online with the
ChatGPT app open while local work runs. Plugin installation, account permissions,
local consent and the current task's native tool exposure are separate requirements.
