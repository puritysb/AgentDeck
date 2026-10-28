# Native local MCP client preview

This independent macOS client provides a stdio/CLI executable and a separate
SwiftUI connection GUI. Both use the same `NativeClientCore` authorization and
Keychain implementation to connect to AgentDeck's existing loopback MCP host.
They do not launch Node, start a server, open a tunnel, read the operator credential,
or approve their own consent. The GUI lets a user connect and revoke without a
terminal, API key or editable host address.

This is a development preview for a desktop plugin accessory, not part of the App
Store application. Prepared-machine GUI and signed package checks are recorded
below; they do not establish public plugin distribution, clean-user onboarding or
automatic Dot tool inheritance. A Node host can remain the server; a native client
alone does not make that whole deployment Node-free.

Build and test from the repository checkout:

```sh
swift build --package-path integrations/chatgpt-local/native
swift test --package-path integrations/chatgpt-local/native
```

The build plugin consumes the canonical generated Swift rules, generated MCP
contract, and server tools-protocol version. They are embedded in the executable
at build time. No generated contract copy is maintained here and no Node runtime
is required by the resulting executable. The package currently targets macOS 13+
with Swift 6. Local Developer ID signatures have been checked; notarization,
public distribution and clean-machine acceptance remain separate gates.

## Measured validation — 2026-10-25

The native source passed **16 tests** and a Release build. A Developer ID-signed
executable completed actual stdio `initialize` and `tools/list`, exposing the four
canonical tools. The validation task then performed a separate read-only smoke
against the existing Node host on loopback port 9476:

- A new, explicitly approved read/report PKCE grant was saved to this client's
  login Keychain entry. Separate processes read `get_request` and `get_context`.
- A further `get_request` succeeded 343.7 seconds after initial grant approval,
  after the initial access-token lifetime had elapsed (maximum 300 seconds),
  exercising refresh.
- `disconnect` revoked through the client's own refresh credential and removed
  its Keychain entry. A subsequent read exited 1 with authorization required.
  The host confirmed the test grant was absent and the request purged; the two
  pre-existing grants remained.

This was validation-task execution, not actual Dot use of the native client, and
it made no claim/report writes. The earlier actual Dot result used a Node client.
The separate Swift-host harness initially failed launch with `amfid -413: No matching
profile`; the development-fixture resolution is recorded below. These results do not
establish automatic plugin exposure, public partner eligibility or consumer-ready
installation.

### Swift host update — 2026-10-26 KST

The harness launched with an organization Apple Development signature and a profile
for the current Mac. Its dedicated sandbox-container and Data Protection Keychain
checks passed, and the original Swift host listened on `127.0.0.1:19476`.

The first client authorization was denied through the harness UI: the client exited
1 with authorization required and the host retained zero grants. A second attempt
was approved after comparing the displayed code: the client returned `authorized: true`,
stored its credentials in Keychain and the host held one grant. Actual Dot reused
its existing connected-Mac task to process the synthetic request through this native
CLI: `get_request` → `get_context` → `claim_request` → working sequence 1 → completed
sequence 2 → final `get_request`. All six commands exited 0. The marker matched the
shared context and **26 + 84 + 12 = 122**. The host audit independently observed working
at 2026-10-25 15:46:07 UTC and completed at 2026-10-25 15:46:19 UTC. The validation task did not claim or
submit reports on Dot's behalf.

Quitting and relaunching the harness restored its grant and completed request. A
read 419.8 seconds after grant approval returned completed with exit 0, beyond the
initial access token's maximum 300-second lifetime. The refresh path therefore
supported continued access, but the exact refresh time was not measured: Dot's
preceding calls may have refreshed preemptively. After UI revocation, the existing
client read exited 1 with authorization required. Client disconnect succeeded,
another read remained rejected, and the host had zero grants and requests. The
host was stopped and the harness quit after evidence was preserved.

This proves the prepared native-client/Swift-host path and the measured credential
lifecycle. It does not establish installed-plugin tool exposure, full lifecycle
coverage, Developer ID consumer distribution, Store signing, the AgentDeck product
UI or clean-user setup. That trial invoked the CLI explicitly, before the separate
native stdio package was generated and installed. The original HTTP preview
manifest remains unchanged.

### Recovery reassessment — 2026-10-26 KST

The current source passes **20 tests**, including four new recovery regressions.
The review found that a failed Keychain write before sending a refresh request
was incorrectly treated as an uncertain refresh and quarantined the connection.
That failure now preserves the Keychain error. Once storage is available, the
same client can try again without replacing a grant that was never used by a
refresh request. Failures after refresh transmission still require reconnection
and never replay a possibly consumed token.

The source also distinguishes an existing connection, explicit consent denial,
and credentials requiring reconnection. Initial authorization HTTP 429/5xx
responses report host unavailability instead of asking for consent again.
These changes were first tested with in-memory credentials and mock responses.
The earlier signed executable's complete request and credential-lifecycle evidence
above still applies to that earlier binary. The updated source was subsequently
built and signed for the GUI and package checks below; those measurements must be
kept separate from the earlier six-call result.

### GUI and package acceptance — 2026-10-26 KST

The revised Release CLI and the separate `agentdeck-connect` SwiftUI executable
were signed with Developer ID and hardened runtime. The GUI and CLI have matching
designated requirements, enabling the same login-Keychain connection to be used
by both programs. The reproducible [GUI builder](ConnectApp/README.md) created a
new app, verified that requirement match, and checked the fixed account/port plus
the canonical CSS, two KR fonts and OFL license. It did not install, launch or
authorize the app.

The package/GUI dependency suite now passes **15 regression tests**, including
three regressions for thin and universal Mach-O dependency output. The initial
package trial passed its then-existing 12 tests. Four profiles were built:
CLI-only and GUI-inclusive packages, each for the default port 9476 and the
isolated fixture port 19476. The final GUI outputs replaced earlier GUI package
candidates. All **8 manifest checks** passed the official portable plugin and MCP
JSON schemas. Extracted packages retained the signed executable and the four
canonical MCP tool schemas; GUI packages also retained their signature and shared
Keychain designated requirement. These artifacts are arm64 builds, not Intel Mac
or notarization acceptance results.

A separate installation step registered and installed the fixture package through
the desktop plugin path. Its installed CLI was present at:

```text
~/.codex/plugins/cache/agentdeck-native-fixture-preview-staging/agentdeck-native-fixture-preview/0.1.0/bin/agentdeck-local
```

The prepared connection GUI displayed the verification code and requested scopes.
After code comparison and explicit approval in the Swift host, the GUI saved the
connection. The existing actual Dot connected-Mac worker then invoked the revised
signed CLI against an intentionally deleted synthetic request. It received
`Request not found.` in **2.984 seconds**, with process exit code 1 and the expected
MCP `isError: true`. This establishes GUI-to-CLI credential sharing and an
authenticated read reaching the request layer. It is not a successful request
lookup, a claim/report round trip, or automatic MCP tool use.

An earlier first read attempt had timed out after **10.030 seconds** and stopped
without further calls or writes. The later read used a newly approved grant and
completed, but the initial timeout's cause remains unknown. Independently, the
Swift host fixture's dynamic window layout had obscured request-creation controls.
A fixed **780 × 640** layout restored the creation button and normal screenshots;
that UI repair does not establish the timeout's cause.

After plugin installation, a new turn in that same existing Dot connected-Mac
worker still exposed only the nine previously available cloud AgentDeck tools
(four hosted-path tools and five Mac Studio tools). No native fixture server tools
were visible in that observation. This is a result for the tested worker and turn,
not a claim that every Dot execution path lacks local MCP support. Installation,
explicit CLI execution and automatic tool exposure remain distinct evidence.

The package checks are recorded in the task's `package-verification.json` and
`package-schema-validation.json`; GUI builder and authenticated-read evidence are
in `connect-builder-check.json` and `dot-gui-authenticated-read.json`. The prepared
GUI test does not establish a clean user's complete directory-install and setup
flow.

The subsequent final trial used the **installed** executable through `serve`, with
newline-delimited MCP initialization, discovery and six request calls. The existing
Dot-created connected-Mac worker read the new context and performed its own claim,
working report, completed report and final read. All six calls succeeded in
**0.014–0.212 seconds** each. The returned marker matched, and **25 + 98 + 35 = 158**.
The host independently observed working/1 at **22:27:28 UTC** and completed/2 at
**22:27:40 UTC on 2026-10-25**. This was a follow-up to the existing Dot-created
worker, not a new delegation issued from the Dot's main conversation. It explicitly
invoked the installed stdio executable and did not use automatically exposed tools.

The GUI then revoked its own grant and cleared its Keychain entry. A read through
the installed executable failed in **0.0222 seconds** with authorization required;
the host had zero grants and zero requests. The fixture host was stopped and both
validation apps quit. The temporary native fixture plugin and marketplace were
removed through the official CLI. Signed ZIPs and token-free evidence remain.
The original HTTP plugin and production daemon were not changed by this trial.

Final correlation and cleanup evidence: `dot-installed-stdio-completed.json`,
`host-installed-stdio-completed.json`, and `gui-revocation-verification.json` in the
task's private `dot-native-final/` artifact directory. The earliest read timeout
remains unexplained; later successful calls do not establish its root cause.

### Portable loader and local API acceptance — 2026-10-26 KST

The desktop-bundled Codex CLI (`0.164.0-alpha.11.1`) identified a concrete loader
error in the 0.1.0 package: a portable stdio `command` cannot contain the
`${PLUGIN_ROOT}/...` form. Schema validation and direct execution had bypassed
that loader rule. The 0.1.1 preview uses `./bin/agentdeck-local`; the actual plugin
loader then discovered the installed native server and all four tools with the
correct plugin identity. The earlier worker observation therefore cannot, by
itself, establish a platform-wide lack of local MCP support.

The installed 0.1.1 connection GUI created a new consent, which was explicitly
approved in the Swift host. An independent public app-server, using an ephemeral
thread and its automatically loaded native MCP connection, completed six calls:
request, context, claim, working, completed and final request. The synthetic
context calculation was **50 + 41 + 88 = 179**; the host independently observed
working sequence 1 and completed sequence 2. No model turn was run. This proves
local plugin-loader discovery and the installed GUI-to-MCP request lifecycle;
it is separate from automatic tool exposure in a Dot model turn.

After GUI revocation, the same local API read returned authorization error
`-32001` in **0.246 seconds**. The host had zero grants and requests, was stopped,
and the validation apps were closed. Developer ID signing is still insufficient
for consumer distribution: a `spctl` assessment of the prepared installed GUI
returned **rejected**, with source **Unnotarized Developer ID**.

A later user-initiated main-Dot request explicitly created a fresh connected-Mac
Codex task, `01a1755e-6f81-737f-b626-73effe9e600c` (**Check native AgentDeck visibility**).
Its first and only turn (`01a1755e-79aa-7161-a4ed-398ee2b64d37`) reported none of the
four native tools, without CLI execution, consent or actual AgentDeck calls.
A contemporaneous independent local app-server still discovered the exact installed
0.1.1 plugin and all four canonical input schemas. The failure is therefore not
explained solely by reusing the older Dot worker. Application-wide cache,
execution-environment routing and platform/account policy remain unresolved;
this is not proof that every Dot environment rejects native MCP. See the
[distribution evidence](../../../docs/dot-distribution-decision.md#installed-native-package-checkpoint-2026-10-26)
for the current release blocker and prepared support questions.

A subsequent global registry check found that the original HTTP preview marketplace
pointed to a deleted worktree. Unfiltered `codex plugin list --json` failed even
though the earlier marketplace-scoped native check passed. Re-registering the
original source from its unchanged installed payload restored the global listing;
the original plugin stayed installed and enabled, with no credential or endpoint
change. The fresh Dot result above predates this recovery. Its causal relation to
Dot tool exposure is unknown; the post-recovery result below tests whether the
repair alone restored the observed path.
The runtime diagnostic now requires the unfiltered registry check to prevent a
scoped success from masking this failure.

After global registry recovery, main Dot created **Inspect native fixture tools**
(`01a1757c-edba-7402-b3e4-fe29c7ce9022`). Its first and only turn
(`01a1757c-f794-763f-9959-55921921ee8d`, 16.159 seconds) again reported no native
fixture tools and made no tool calls. The contemporaneous strengthened local
control passed unfiltered enumeration, exact plugin identity and all four schemas
in **0.964 seconds**. The two known configuration repairs therefore did not restore
automatic exposure in this tested Dot path. The effective Dot process configuration,
application cache and account/platform policy remain unverified; neither a Mac
working directory nor host label alone identifies its actual MCP loader. This
does not establish universal platform non-support. The temporary fixture plugin
and its staging marketplace were removed after observation; the original HTTP
plugin remains installed, enabled and byte-identical with its source repaired.

## Dot executor registration and local CLI state

A local loader pass does not prove that an already-running desktop executor has
refreshed the plugin roots it advertises to Dot. The 2026-10-26 installed-app
inspection found a separate cloud-coordinated `exec-server` path and an in-memory
`registeredPluginRoots` list. The actual local desktop app-server loaded the
fixture, but Dot metadata remained empty. The two processes had both been running
since before fixture installation. No per-project override, AgentDeck tool deny
filter or bundled/plugin-appserver binary mismatch was found.

Installed-app code rereads `plugin/installed` during executor registration. A
network reconnect or wake only reports cached roots. The installed desktop
plugin UI explicitly refreshes executor registration after Enable/Disable;
this is a narrower controlled refresh than a full app restart, which also takes
the registration path again. The CLI custom-plugin install does not execute
that renderer callback. A user-confirmed SBStudio Disable/Enable test updated
the configuration but did not restore the four native tools. Two subsequent
metadata-only turns in the existing Dot worker saw both fixture skills with the
exact installed 0.1.1 cache root. Skills were not measured before the toggle, so
this does not establish that they newly appeared. Complete package omission or
an old registration list alone cannot explain the result; MCP-specific discovery,
configuration, routing or policy remain unresolved.

A separate 0.1.2 diagnostic package compares the documented Codex compatibility
layout (`.codex-plugin/plugin.json` and `.mcp.json`) with the portable 0.1.1
package. The signed payload, isolated account and port are unchanged. Relative
and placeholder command forms failed local legacy startup; the comparison uses
the absolute installed binary path to remove that confound. It is a
machine-specific diagnostic, not a distributable workaround. The public local
app-server discovered all four canonical schemas in 3.057 seconds. The next Dot
metadata turn still advertised 0.1.1. After the user repeated the SBStudio UI
toggle, the existing Dot worker reported neither fixture skills nor native tools;
it could not identify a 0.1.2 root. Actual desktop processes and logs nevertheless
showed 0.1.2 starting successfully. Independent public `plugin/installed` and
`skills/list` checks found it enabled, installed and supplying both skills, with
no fixture errors. Adding all 14 local project paths returned by `list_projects`
to the inventory query preserved that result; unreported multi-root project paths
remain outside that control. The desktop registration code prefers `localVersion`,
so a null remote `version` is not an exclusion condition. Global readiness warnings
had no correlation with this diagnostic worker or turn.

This narrows the unresolved boundary to desktop registration and capability
handoff/discovery in Dot. It does not prove that the legacy root reached Dot, nor
that every Dot environment rejects local MCP. Repeating the same UI toggle has
not established recovery. No grants or actual AgentDeck calls were made in these
metadata checks. Check the
[runtime investigation](../../../docs/dot-distribution-decision.md) for the latest
observation boundary before treating either refresh or repackaging as a fix.

## Terminal-free connection GUI

[AgentDeck Connect](ConnectApp/README.md) is a real native accessory, separate from
the Store app. Open the prepared `AgentDeck Connect.app`, choose **연결 시작**
(Connect), compare its code with the AgentDeck host, and approve in the host.
The GUI shows the actual requested scopes and completes only after the existing
client has exchanged and saved the authorized credentials. It performs no
self-approval and does not start the host.

On launch, the GUI checks only whether a connection is stored. It explicitly
separates that state from current host availability, Dot tool discovery and a
successful request round trip. Choose **연결 철회** (Revoke) to revoke this client's
own grant and remove its Keychain item. A failed revocation remains a failure and
does not silently discard the credential needed for another attempt. Waiting,
denial, timeout, unavailable-host, busy-client and Keychain errors are visible;
blocking client operations run away from the UI's main executor.

The account and port are fixed in the signed app's `Info.plist` and must match the
plugin's stdio command. The GUI exposes no API-key, remote-host or tunnel setting.
It explains that selected context and results are processed by OpenAI, and that
revocation does not retroactively delete shared context, cancel a Dot task or
revoke Dot's separate computer permission. This GUI implements local consent;
it does not make plugin installation or Dot execution automatic.

## CLI authorization and use

Use one stable signed executable and an explicit account name. The examples assume
the executable is on PATH; use its actual built or installed absolute path.

```sh
agentdeck-local authorize --account preview
agentdeck-local serve --account preview
agentdeck-local disconnect --account preview
```

`authorize` prints only the consent ID, verification code and scopes to stderr.
Compare the code and approve in AgentDeck within two minutes. It refuses to
replace existing credentials. `serve` must not start an authorization flow or
approve itself. It exposes the canonical schemas for `get_request`, `get_context`,
`claim_request`, and `report_update` through newline-delimited stdio MCP. Only
requests explicitly shared with that connection are available. The default
`serve` is grant-scoped; `--request-id ID` optionally restricts it to one request.

For a synthetic task, `call` requires `--request-id ID` and reads exactly one
newline-terminated JSON object from stdin, followed by EOF:

```json
{"tool":"get_request","arguments":{"requestId":"req_example"}}
```

Use `agentdeck-local call --account preview --request-id req_example`. The same
invocation accepts the other three tool schemas. The caller reads context,
claims, and reports its own work. The client does not manufacture reports or
retry writes. It preserves tool errors and exits nonzero for a failed raw call.

`--port PORT` selects an isolated loopback test host (1024–65535), excluding the
hub/session-bridge ports 9120–9139 and privileged operator port 9477. The default
is canonical port 9476. It never accepts a host, remote URL, or operator route.
A different port is a different Keychain connection and must be authorized.

## Separate desktop plugin package

The [package generator](package_plugin.py) creates a reviewable local marketplace
and upload ZIP from an already Developer ID-signed, hardened-runtime executable.
The [native manifest](package/plugin.json) and [stdio configuration](package/mcp.json)
use a different plugin identity from the existing HTTP preview. The binary is
bundled under `bin/agentdeck-local`, launched with the contained portable command
`./bin/agentdeck-local`, and uses the
canonical default loopback port. No user API key, tunnel, Node installation or
publisher relay is needed by this client. The AgentDeck host must already exist.

Run from the checkout; the output directory must be new and its parent must exist:

```sh
python3 integrations/chatgpt-local/native/package_plugin.py \
  --binary /path/to/signed/agentdeck-local \
  --output /path/to/new-native-package
```

To include the optional connection GUI, also pass `--connect-app` with a completed,
signed `AgentDeck Connect.app` from the [GUI builder](ConnectApp/README.md).
The app's signed `Info.plist` must contain
`AgentDeckConnectionAccount` matching `--account` (default `plugin-native-preview`)
and `AgentDeckConnectionPort` matching the canonical default port. The builder
does not edit or sign an app. It rejects a mismatched profile or designated signing
requirement (the GUI and CLI must be eligible for the same Keychain access),
non-system dynamic dependencies, unknown app files and symbolic links. A package without the GUI
states that authorization still requires the explicit CLI setup step.
GUI packages also declare the bundled `setup` onboarding skill, which opens that
package's connection app when invoked. CLI-only packages omit both that skill and
the `onboardingSkill` field.

Use `--fixture-port 19476` for the isolated Swift-host experiment, optionally with
`--account NAME` matching its grant. This produces the separate
`agentdeck-native-fixture-preview` identity, label and marketplace; it cannot be
mistaken for the default-port package. A GUI bundled with it must have been signed
with that same fixture account and port. The current package output supports only
the architectures actually found in its binaries; an arm64 build is not an Intel
Mac acceptance result.

The output contains:

- `plugins/agentdeck-native-preview/`: portable plugin, exact report skill,
  license, connection instructions, executable and optional signed GUI.
  GUI packages also include the IBM Plex Sans KR OFL license from
  [Google Fonts](https://github.com/google/fonts/blob/main/ofl/ibmplexsanskr/OFL.txt).
- `.agents/plugins/marketplace.json`: a separate local marketplace rooted at the
  output directory. It does not change the user's registered marketplaces.
- `agentdeck-native-preview.zip`: only the plugin payload, with manifests at the
  ZIP root and executable modes preserved; fixture filenames use their own name.
- `package-evidence.json`: hashes, architectures, signature checks and MCP
  discovery evidence. No credentials, provisioning profiles or host requests.

The builder extracts the ZIP into a temporary directory, verifies the executable's
Developer ID signature and exact bytes, then runs `initialize` and `tools/list`
through the packaged stdio command. Tool definitions must match the canonical
generated contract. Discovery neither loads credentials nor makes a local HTTP
call. Notarization, installation, GUI consent and actual Dot use are separate
acceptance steps; the dated checkpoint above records which were exercised on the
prepared Mac. Local package regression tests run without macOS
signing tools, Keychain, network calls or installation:

```sh
python3 -m unittest discover -s integrations/chatgpt-local/native -p 'test_package_plugin.py' -v
```

To reproduce the local installation test, the output is a marketplace root suitable for
`codex plugin marketplace add /path/to/new-native-package`, followed by installation
in the desktop Plugins Directory and a new local chat. The generator never runs
that command or writes cache/config files. An `ON_INSTALL` marketplace policy
does not implement an OAuth or GUI launch flow; explicit local consent remains
required. See the official [local marketplace instructions](https://developers.openai.com/plugins/build/plugins#install-a-local-plugin-manually).

Public local MCP submissions still require an approved partner organization,
allowlisting and review under the official
[desktop-only submission path](https://developers.openai.com/plugins/deploy/desktop-only).
Package creation proves neither that eligibility nor clean-user installation,
notarization, a clean user's GUI-only onboarding or automatic Dot tool inheritance.

The default packaged MCP configuration is:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "agentdeck-native-preview": {
      "type": "stdio",
      "command": "./bin/agentdeck-local",
      "args": ["serve", "--account", "plugin-native-preview"]
    }
  }
}
```

## Opt-in installed-plugin runtime diagnosis

The [runtime diagnostic](verify_plugin_runtime.py) checks the actual Codex plugin
loader after installation. It is a manual acceptance step, not a mandatory CI
gate. JSON schema validation and direct execution of the binary do not establish
loader acceptance: the portable `command` field requires a bare executable name
or a contained `./` path. A `${PLUGIN_ROOT}/...` command was accepted by our former
direct smoke check but rejected by the desktop loader. The placeholder remains
valid in documented argument examples; this package uses the contained path above.

Run against the exact CLI used by the desktop app, specifying the installed
plugin identity and its MCP server key. For example, after installing the default
staging package:

```sh
python3 integrations/chatgpt-local/native/verify_plugin_runtime.py \
  --codex /Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex \
  --plugin-id agentdeck-native-preview@agentdeck-native-preview-staging \
  --server-name agentdeck-native-preview
```

For the isolated fixture, substitute
`agentdeck-native-fixture-preview@agentdeck-native-fixture-preview-staging` and
`agentdeck-native-fixture-preview`. A Homebrew CLI and the desktop-bundled CLI can
have different versions; each result records the exact CLI path and version.

The command requires the official unfiltered `plugin list --json` to succeed,
then selects the exact plugin identity. A failed global listing is reported as
`plugin_registry_unavailable` without exposing unrelated plugin output. It also
uses the version-matched public schema generator, then starts an independent `app-server --listen stdio://` process. It
checks that this version supports `serverName` filtering before sending only
`initialize`, `initialized` and the documented `mcpServerStatus/list` request.
The response must name the exact installed `pluginId` and server, and expose the
four canonical tool names and input schemas. The cached plugin and MCP manifest
hashes are recorded with the result.

It does not install a plugin, edit configuration, reload a shared server, create
a thread, call a tool, log in or approve a request. It prints no raw MCP payloads
or stderr from other servers. The overall deadline defaults to 30 seconds
(`--timeout-seconds`, 1–60); each process's stdout and stderr are capped at 512 KiB.
Cleanup closes stdin and terminates only the process group it created, with
bounded grace periods. Temporary generated schemas are removed afterward.

A successful result proves local loader discovery. It does not prove OAuth grant
validity, notarization, public distribution or automatic tool exposure in Dot.
In particular, a stdio server's `authStatus: unsupported` is not a verdict about
the native client's local grant. An incomplete observation returns `status:
unknown` with a safe reason code and a nonzero exit; it must not be described as
a general platform limitation. The API surface and initialization sequence are
documented in [Codex app-server](https://developers.openai.com/codex/app-server).

The bounded framing, timeout, output-limit, identity and cleanup regressions use
synthetic processes, without calling Codex, Keychain, a model or an HTTP host:

```sh
python3 -m unittest discover -s integrations/chatgpt-local/native -p 'test_*.py' -v
```

## Credential custody and failures

Credentials use a separate Keychain service,
`bound.serendipity.agentdeck.local-client.preview`, keyed by account and port.
They are never printed, placed in arguments, or written as plaintext files. The
client requests no interactive Keychain prompt during operations; a locked or
denied Keychain is an explicit error with no fallback. A stable signing identity
and successful signed Keychain round trip must be verified before distribution.

A fixed private directory under `~/Library/Application Support/AgentDeckLocalClient`
holds only nonsecret lock files. Kernel advisory locks serialize each account's
authorize, call and disconnect across processes, release on process exit, and are
never unlinked during normal use. A running stdio frontend releases the lock
between calls, so disconnect followed by a new authorization can repair its
connection while the frontend remains open.

Before rotating a refresh token, the client durably marks it in Keychain. Failure
to save that marker sends no refresh request and preserves the storage error.
A crash, unknown response or failed replacement save after transmission requires
disconnect and a new consent. The client never reuses a possibly consumed refresh
token. `disconnect` uses the stored
token at the public revocation endpoint before deleting its own Keychain item.
An expired or already revoked grant can also be disconnected. The host's grant
lifetime is not extended by token rotation. Existing app or tunnel grants are
never imported or replaced.

Use the same `--account` and `--port` throughout recovery. Changing either selects
a different connection and does not repair the old one.

| Failure | Recovery |
|---|---|
| No local authorization | Use the connection GUI or run `authorize`, then compare the code and approve in AgentDeck |
| Connection declined in AgentDeck | No client credentials were saved. Leave it disconnected, or start a new authorization if the user wants to connect |
| Account already has local credentials | Use the existing connection. To replace it, revoke in the GUI or run `disconnect`, then request fresh consent |
| Keychain unavailable before refresh transmission | Restore Keychain access, then retry the operation. No refresh request was sent by the failed marker write |
| Credentials can no longer be used safely | With AgentDeck available, revoke in the GUI or run `disconnect`, then request fresh consent. The client does not replay the old refresh token |
| Local AgentDeck unavailable or a new authorization attempt returns 429/5xx | Check that the intended AgentDeck host is available before another attempt. A service failure does not itself mean consent was denied |
| Another client owns the connection | Let that operation finish before trying again |
| Timeout while a report was being sent | The write outcome may be unknown. Inspect the request state before deciding whether another report is needed; writes are never retried automatically |

If revocation cannot reach the host, `disconnect` fails and retains the local
credential. It must not claim the remote grant was revoked or silently discard
the credential needed to revoke it later.

Input frames, HTTP bodies and output are bounded by the canonical contract.
HTTP operations and partial stdio frames have deadlines; an idle MCP connection
can wait for its next complete request. Raw `call` also bounds the wait for EOF.
Redirects are never followed; authorization accepts only the exact local status
URL and validates the callback's issuer, state and redirect before token exchange.
Unit tests use in-memory credentials and isolated file descriptors, not real user
Keychain items or production grants. Actual Dot execution is measured separately
in the dated runtime checkpoints above.
