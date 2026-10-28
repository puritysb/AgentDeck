# Native Dot local host experiment

Private developer fixture for the signed, sandboxed Swift loopback host. This is
not an AgentDeck release or an end-user distribution package. It never installs,
launches or stops the Store app or Node daemon, and never starts a device module.

## Build without launching

From the repository root:

```bash
bash experiments/dot-native-local-host/build.sh --compile-only
bash experiments/dot-native-local-host/build.sh --sign B82C56894E31CEBCABB07E60543F440E0367B22A --profile /path/to/independent.provisionprofile
python3 experiments/dot-native-local-host/verify.py experiments/dot-native-local-host/build/signed/AgentDeckDotLocalHost.app
```

Use only the explicitly approved existing Apple Development identity
`B82C56894E31CEBCABB07E60543F440E0367B22A` for team `QF36NDHYHD`; never export a
signing key or issue a new certificate. A matching Mac profile must permit this
independent bundle ID and dedicated Keychain group, include the actual signing
certificate, remain unexpired and permit this Mac. The script refuses Store-only
or product-only profiles. It never creates a certificate or edits an Apple account.
Device matching uses the Mac's **Provisioning UDID**, as required by Apple's
[Apple silicon registration instructions](https://developer.apple.com/help/account/devices/register-a-single-device/),
and never prints either that value or the hardware UUID.
The second command signs and verifies the artifact but does not launch it. The
first only checks compilation and must not count as sandbox or Keychain proof.
Unsigned output goes to `build/unsigned/`; signed output goes to `build/signed/`,
so a compile-only gate cannot overwrite a signed artifact. All build output is
ignored. No product Xcode project is regenerated.

`sources.txt` lists canonical repository Swift files passed directly to the
compiler. They are not copied, patched, stubbed or regenerated. The MCP contract
is copied byte-for-byte from the native resource. The signed bundle contains a
source SHA-256 manifest. `HostApp.swift` supplies only a developer app lifecycle,
native consent/request buttons, isolation checks and token-free receipts. It does
not replace a production type or use `serveForTesting`.

The verifier requests XML explicitly with `codesign --entitlements - --xml`.
Public certificate extraction uses `--extract-certificates=<prefix>`: its optional
prefix must be attached to the option, or `codesign` can interpret it as another
input path. Extracted public certificates live only in a temporary directory;
their leaf SHA-1 is checked against both the approved B82 identity and the embedded
profile. This never exports a private key.

## Isolation and operation

- Bundle: `dev.agentdeck.dot-native-local-host`.
- Keychain access group: `QF36NDHYHD.dev.agentdeck.dot-native-local-host`, the sole
  permitted group. The fixed production DotVault service remains unchanged.
- Loopback MCP: `http://127.0.0.1:19476/mcp`. No 9120–9139, 9476 or 9477 listener,
  discovery, daemon lifecycle or device access is started by this fixture.
- Data: the dedicated sandbox container, through the original `AgentDeckPaths`.
  An inherited `AGENTDECK_DATA_DIR` or XCTest environment refuses startup.
- Before any DotVault/configuration access, runtime verification checks the
  running signature, exact entitlements, sandbox container, own data path and a
  temporary Data Protection Keychain item in the sole allowed access group.
  A missing/invalid entitlement or Keychain error is a hard failure. The fixture
  does not fall back to the login keychain, a file credential or an unsandboxed run.
- Only the **격리 확인 후 호스트 시작** button starts the host. Existing fixture
  configuration is loaded without replacement. A different saved origin is
  refused. After stopping, quit and reopen the fixture to start again.
- Compare the client's OAuth code in the window before approving. Select a grant
  to create a synthetic request containing a random marker and three numbers.
  Give the external agent only its request ID; its final report should include the
  marker and sum obtained from the actual request context.
- Use the window to approve/deny consent, create synthetic requests, revoke a
  grant or stop the host. There is no fixture HTTP administration route, command
  auto-approval, app subprocess or automatic report submission.

The current native validation client uses the canonical pre-registered
`agentdeck-local-plugin` client ID and `http://127.0.0.1:1455/callback` redirect URI.
It polls the authorization status and inspects the returned redirect without
following it or opening a callback listener. Neither this fixture nor that client
binds port 1455. The host also supports DCR for other compatible clients, but this
validation path does not use it. The client keeps its own grant and credentials,
separately from existing Node/tunnel connections.

After an explicitly authorized launch, the operator should confirm 19476 belongs
to this app and existing Node/Store processes and shared ports remain unchanged.
Test consent rejection, read/claim/working/completed, app restart persistence,
refresh, grant revocation and rejection of the revoked token. The fixture's
Keychain check succeeds only at runtime; static signature verification cannot
prove that macOS will authorize the entitlement or grant Keychain access.

## Evidence and limits

After startup, the original request store is at `AgentDeck/dot/requests.json`
inside the dedicated container's Application Support directory. The fixture
additionally writes `AgentDeck/native-host-validation/receipt.json` with bundle,
team, Keychain group, process ID, listener status, synthetic request context and
last report, plus UI action timestamps. It never serializes OAuth codes, bearer
tokens, refresh tokens, PKCE verifiers or the authorization Keychain item. Receipt
files are mode 0600 and their directory is 0700. The receipt is a local snapshot;
it does not invent intermediate reports that its polling did not observe.

The 2026-10-25 first Developer ID artifact had a valid static signature but no
eligible provisioning profile. Actual launch failed before Swift startup:
`taskgated-helper` reported no eligible profiles and AMFI returned `-413`, "No
matching profile found". This did not test the native listener or Keychain. The
builder now requires a matching profile and verifies the signed leaf certificate
against it. A provisioning check is still a prerequisite, not runtime proof.

### Measured native run — 2026-10-26 KST

The subsequent QF36 Apple Development build used the approved existing B82
certificate and the dedicated **AgentDeck Dot Local Validation Mac 20261026**
profile. Actual launch and the following checks passed on the registered Mac:

| Check | Observed result |
|---|---|
| Runtime isolation | Signed app, dedicated sandbox container and Data Protection Keychain group passed startup checks; the original Swift host listened on IPv4 loopback port 19476 |
| Consent denial | Client exited 1; no grant was created |
| Consent approval | Client returned `authorized: true`; host held one grant |
| Actual Dot request | `get_request` → `get_context` → `claim_request` → `report_update` working/sequence 1 → `report_update` completed/sequence 2 → `get_request`; all six native client commands exited 0 |
| Independent host observation | Host audit recorded both working/1 and completed/2; final stored report matched the request context |
| Restart and refresh | App PID changed from 86336 to 98635; the grant and completed request persisted. Read succeeded 419.8 seconds after approval, beyond the initial access token's maximum 300-second lifetime |
| Revocation and cleanup | UI revocation made the next client read exit 1 with authorization required. Client disconnect succeeded and removed its own Keychain state; host ended with zero grants and zero requests, then was stopped and quit |

The correlated request was `req_4FF56181-E3A5-43B8-994B-C9D81FB2FF0B`. Dot obtained
marker `native-dot-5696b750-23b3-4050-94f5-5368f302a5f7` and numbers **26, 84, 12**
from `get_context`, and reported **122**, checked using two groupings. The numbers
were not supplied in the task prompt. The host receipt independently matched
the same marker, request ID, report sequence and result.

Private task-local evidence is retained under `dot-native-validation/`:
`swift-host-before-dot.json`, `swift-host-dot-completed.json`,
`swift-host-restart-refresh.json`, `swift-host-revocation.json`, and
`swift-dot-task-evidence.json`. These artifacts are not repository files and do
not contain OAuth token values. The Dot evidence records an explicitly authorized
native CLI invocation through the executor's normal approval path.

This run proves the original native host's transport/OAuth/store and the explicit
Dot → native Swift client → native Swift host path under this development signing
identity and container, without a user API key or tunnel. The Development profile
authorizes this registered Mac; it is not a consumer Store distribution artifact.
AgentDeck's actual settings UI, `DaemonServer` ownership/handover, device state
delivery, automatic MCP tool exposure in Dot, public plugin installation and
consumer onboarding still need their own acceptance. The fixture must remain
outside the product targets and never enable Dot in a Store artifact. The
[distribution decision](../../docs/dot-distribution-decision.md) tracks those
remaining release gates.
