# 2026-11-20 — A Dot-created local task now launches and calls a desktop-plugin stdio MCP server

**What changed since the last measurement.** On 2026-10-11 and again on 2026-10-26, a task Dot created
on the connected Mac exposed no locally configured or locally installed AgentDeck MCP tools — only
cloud plugins (`mcp__codex_apps__*`). The 2026-10-26 run already had a desktop-installed stdio plugin
(`agentdeck-native-fixture-preview` 0.1.2) and still saw zero of its tools. Since then the ChatGPT
desktop app updated (26.1111.71704, bundled Codex CLI 0.169.1, installed 2026-11-19), and OpenAI
documented desktop-only plugins with a bundled stdio MCP server.

**Measured 2026-11-20 (KST), same Mac and account, same fixture plugin, no reinstall.**

- Dot created a new local Codex task on `sbstudio`. Its tool inventory listed the fixture plugin's
  four local tools (`mcp__agentdeck_native_fixture_preview__{get_request,get_context,claim_request,report_update}`)
  alongside the cloud ones.
- The local stdio server process was started at 16:19:16, the moment the task ran, by
  `codex exec-server --remote https://codex-cloud-environments.chatgpt.com/api --environment-id …`,
  a child of `/Applications/ChatGPT.app`. That is the remote executor serving Dot's cloud thread,
  not the user's local Codex app-server.
- A second Dot task called `get_request` exactly once. Dot relayed the fixture server's own answer:
  `Mcp error: -32001: Local authorization is required. Run authorize and approve in AgentDeck`.
  So the call reached the Mac-local server and the server's response returned to Dot. No grant
  existed and no claim or report tool was called.

**What did not work, and why it matters for onboarding.** A new probe plugin installed during the
session (`codex plugin add`, local personal marketplace) was not in the Dot task's inventory, while a
local `codex exec` turn launched and called it. The remote executor had been running since 08:24;
the installed-plugin set appears to be read when that process starts, so a freshly installed plugin
needs the ChatGPT app (or its executor) restarted. Restarting only the executor was not attempted.
Also confirmed: in the Codex `.mcp.json` layout `${PLUGIN_ROOT}` is not expanded (the server got a
literal `…/${PLUGIN_ROOT}` cwd and never started); `command: "node"` with `args: ["./server/index.mjs"]`
and `cwd: "."` works. 2026-10-26 had already found that `command` must be a bare name or a `./` path.

**What this does and does not settle.** G0a's core question — can an existing Dot reach a local
AgentDeck MCP server without a tunnel or hosted endpoint — now has a positive measurement for the
desktop-plugin route. It is not a release: public listing of a plugin with a local MCP server is
limited to OpenAI-approved partners; the stdio executable is a separate program the plugin ships,
which the App Store app cannot install or prompt for under the self-contained rule; and the
authenticated read → claim → report cycle, fresh-user install, lifecycle and signed Swift-only
gates (G0b–G6 in [the release plan](docs/dot-store-release-plan.md)) are untouched. The prepared
OpenAI questions 4–6 can now be asked with this measurement attached.
