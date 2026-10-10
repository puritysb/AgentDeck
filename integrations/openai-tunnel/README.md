# Private official-tunnel experiment

This operator-only adapter connects the official OpenAI `tunnel-client` stdio
transport to an already running AgentDeck MCP host at `http://127.0.0.1:9476`.
This experiment requires macOS/Linux POSIX file ownership and permissions;
Windows credential custody is not implemented. It is not part of the App Store
application or public plugin distribution.
See [the distribution decision](../../docs/dot-distribution-decision.md).

The adapter opens no listener. It forwards only tools-protocol MCP requests;
the existing server remains responsible for context, claims and reports.
It does not infer Dot activity, issue reports on its own, or support MCP Events.
An authenticated initialize/tools-list probe is not a real Dot acceptance test.

## Authorization and custody

Use a **separate grant** for this personal tunnel. Never extract the Codex token
cache, use the operator token as a tunnel credential, or replace existing grants.
The adapter uses AgentDeck's existing local public-client identity with a fresh
PKCE exchange; it does not register or impersonate a cloud OAuth client.
Only `agentdeck:read` and `agentdeck:report` are requested. A grant can read only
requests explicitly shared with that grant. No subscribe/device/control scope
is accepted by this adapter.

Build the service, then run the following in a private, user-owned directory
(0700); the new credential file is written as 0600. Use an absolute path.

```sh
pnpm --filter @agentdeck/dot-relay build
node services/dot-relay/dist/tunnel-main.js authorize /absolute/private/tunnel-credentials.json
```

The command prints a consent ID and verification code, never tokens. Compare
them with the separate request in AgentDeck and approve using its normal consent
UI or the documented `agentdeck dot approve <id> --code <code>` operator command.
The authorization command polls for up to two minutes, validates issuer/state/
redirect, and saves its own tokens. It never approves itself. Record the new
grant ID from `agentdeck dot status` so it can be revoked independently.

## Official client setup

Create a private tunnel associated with the intended personal ChatGPT workspace
and provision a restricted Tunnels Read + Use runtime key as described by
[OpenAI](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
Use its supported `runtimes connect --mcp-command` option with this command,
substituting absolute paths (and quoting paths containing spaces):

```sh
/absolute/node /absolute/AgentDeck/services/dot-relay/dist/tunnel-main.js serve /absolute/private/tunnel-credentials.json
```

Run only **one** official runtime for this tunnel; stop the previous HTTP binding
before switching to stdio. Verify `runtimes status` and authenticated MCP
initialization separately. Keep both health UI and AgentDeck operator API local.
There is no reason to enable Harpoon plaintext HTTP for this stdio binding.

For the private ChatGPT custom MCP form, select this tunnel and **No Auth** at the
connector layer: OpenAI controls tunnel/workspace access, while the adapter holds
the separately approved local AgentDeck credential. This is an explicit
single-operator arrangement, **not per-user OAuth**. Every authorized user of that
tunnel would act as the same AgentDeck grant, so do not use it in a shared
workspace or advertise it as a public multi-user solution. Keep credentials out
of the connector form, command arguments, repository, logs and chat.

## Refresh, failure and removal

The adapter refreshes on demand within 30 seconds of access-token expiry and
atomically persists rotating tokens. Requests are serialized; concurrent calls
share a refresh. It marks an in-progress refresh durably before sending it. An
uncertain outcome, restart during refresh, or persistence failure stops access
until reauthorization; it never replays a possibly consumed refresh token.
An MCP 401/403 also requires reauthorization. Network errors never automatically
replay a claim or report. Stop and restart the official runtime after resolving
an ordinary connectivity failure; do not report success without a fresh probe.

The private file has a lifetime ownership lock. A second process refuses to
start. After a crash, confirm the recorded PID has exited before manually
removing only that credential file's `.lock`; do not delete another process's
lock or reuse a credential marked `refreshing`. Revoke the grant with
`agentdeck dot disconnect <grantId>` before authorizing a replacement.

To remove this experiment: revoke the separate grant, stop the official managed
runtime, delete its private credential file after the adapter exits, and remove
the personal ChatGPT plugin/tunnel if no longer needed. Revocation is the access
boundary; deleting a file alone does not revoke a grant. Renew/rotate the OpenAI
runtime key separately when it expires.

Tests in `services/dot-relay/src/__tests__/tunnel-stdio.test.ts` cover rotation,
uncertain outcomes, revocation, no automatic report replay, bounded framing,
scope restrictions and credential-file ownership. Actual Dot invocation and
surface reactions remain separate real-account acceptance gates.
