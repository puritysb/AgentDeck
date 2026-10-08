# AgentDeck direct HTTPS MCP hosting

AgentDeck terminates HTTPS itself. No cloud relay, external identity provider, tunnel helper or Node dependency in the macOS app is required. The directory name is historical. The Node runtime is bundled into `bridge/dist/dot-runtime.mjs`; the macOS app uses native Network/Security frameworks and Keychain. Both remain opt-in. Real Dot interoperability and public ingress remain unverified; see [the implementation plan](../../docs/dot-mcp-events-plan.md).

## macOS app

Settings → Integrations → Dot accepts a public HTTPS origin, a dedicated local port (9476 by default), an exact registered OAuth redirect and a user-selected PKCS#12 certificate with its password. The app validates hostname, chain and validity, stores configuration and identity in Keychain and imports the identity into memory for TLS. Start hosting explicitly, or opt into resuming it when AgentDeck starts. It stops when the app releases daemon ownership or quits; sleeping makes it unreachable. Import a renewed certificate before expiration. Replacing configuration revokes existing connections.

Register the displayed client ID and explicitly copied secret in the ChatGPT plugin configuration. Connect its MCP endpoint, compare the browser code with the local pending connection, and approve in AgentDeck. Ask Dot to subscribe to the `desk` integration profile. Then explicitly share context with **Ask Dot**. Results describe that request, never all Dot work. The app sends no automatic transcript, screen capture or device credentials.

## Node daemon

Create private `dot-host.json` in the Node daemon data directory (`~/.agentdeck` for the usual installation). Use owner-only permissions for the file and private key. Example structure (replace every placeholder; never commit credentials):

```json
{
  "enabled": true,
  "origin": "https://your-public-host.example",
  "port": 9476,
  "bind": "127.0.0.1",
  "certificatePath": "/absolute/private/fullchain.pem",
  "keyPath": "/absolute/private/key.pem",
  "clientId": "a-random-registered-client-id",
  "clientSecret": "replace-with-at-least-32-random-characters",
  "redirectURI": "https://chatgpt.com/connector_platform_oauth_redirect",
  "controlPort": 9477
}
```

Use the exact redirect supplied by your plugin registration. Set `bind` to `0.0.0.0` or `::` only when deliberately enabling inbound reachability. The default is loopback. A daemon started with `--loopback` refuses a conflicting public Dot binding. Normal `agentdeck daemon restart` loads this configuration after the daemon wins ownership. An invalid Dot configuration leaves the LAN daemon running and logs a sanitized failure.

Forward only the dedicated TLS listener when configuring internet ingress. **Never forward 9120–9139.** Public DNS, a publicly trusted certificate and inbound reachability must be supplied and tested separately. Node validates certificate hostname, dates and matching key; that alone does not prove public CA trust. Certificate replacement requires restart. No router, DNS, firewall or CA account is modified automatically.

Local operator commands:

```bash
agentdeck dot status
agentdeck dot approve REQUEST_ID --code BROWSER_CODE
agentdeck dot deny REQUEST_ID
agentdeck dot request GRANT_ID --context-file /absolute/context.txt --profile desk
agentdeck dot disconnect GRANT_ID
```

The operator listener binds only `127.0.0.1`, authenticates with a separately generated private `dot-operator-token`, and is never exposed through the public listener. Do not place it behind a public proxy. This local operator credential is distinct from the LAN pairing token. The development harness uses the same runtime with `AGENTDECK_DOT_CONFIG=/absolute/dot-host.json pnpm --filter @agentdeck/dot-relay start`; do not run it against a store already owned by the daemon.

## Authorization and lifecycle

Local OAuth implements predefined confidential clients, authorization code + S256 PKCE, exact resource and redirect matching, one-use codes, five-minute opaque access tokens, rotating refresh tokens and grant revocation on refresh replay. Refresh grants expire after 30 days. Consent expires after two minutes. Only token hashes are persisted. Dynamic client registration and external identity federation are not implemented. Scope changes require a new consent flow.

Public ingress contains OAuth metadata/authorization/status/token/revocation routes and `/mcp`. No daemon health, hooks, pairing or operator actions are present. The plugin receives only `agentdeck:read`, `agentdeck:report` and `agentdeck:subscribe`. Events use verified public HTTPS callbacks, DNS pinning, no redirects, Standard Webhooks signatures and finite retries. A delivery receipt is not task completion.

Context becomes unreadable at request expiry (30 minutes) and is erased on the next maintenance pass. Reports and deduplication records expire after seven days; disconnect purges the grant's requests and subscriptions. Maintenance resumes when AgentDeck starts again. No missed-report recovery is promised while offline. Node and sandboxed macOS use separate credential stores and require separate connection setup; they do not transfer grants across ownership changes.

## Interaction reports

The fifth tool, `report_interaction`, records a relationship scoped to a claimed briefing: `relationId`, increasing `sequence`, `kind` (delegation/message/control/result/attention), `direction` (dot_to_agent/agent_to_dot), `stage`, nullable `targetRef`, and a bounded summary. Reuse the same idempotency key on retry. Identity cannot change within a relation; terminal relations cannot restart; the request holds at most 16 events. This tool reports actions taken elsewhere and never executes or approves them.

The server assigns `evidence: dot_report` and receipt time. A reported acceptance is not target-side acknowledgement; target references remain unverified. `get_request` returns the bounded history. Both stores validate histories on restart and purge them on disconnect. Native 2D/3D companions and the relationship panel use this evidence; pull-feed clients receive inert direction/stage cards. Actual device and Dot-account acceptance are still unverified.

## Verification

```bash
pnpm build
pnpm typecheck
pnpm vitest run services/dot-relay/src/__tests__
pnpm generate-dot-contract
```

Tests cover real loopback TLS with hostname verification, local approval through token exchange, restart/revocation, official SDK tools-only interoperability, callback failure handling, claim/report idempotency and native manifest drift. Native XCTest covers parsing, SSRF address classification, OAuth and a subscription-to-report lifecycle. Checked-in certificates are public test fixtures and must never be used for deployment.

The pinned official TypeScript SDK 1.32.1 supports tools protocol `2025-11-25`; the custom Events adapter implements documented `2026-07-28` methods. Passing local tests does not prove actual Dot discovery or subscription acceptance. The native dashboard shows a separate report-driven light-orb companion. Both daemons produce read-only Dot result cards for pull-feed clients; actual device display is not yet verified. Physical-button initiation, global Dot status and remote OpenAI approval are not provided by this implementation. [OpenAI Events](https://developers.openai.com/plugins/build/mcp-events) and [authentication](https://developers.openai.com/plugins/build/auth) are the external contracts.
