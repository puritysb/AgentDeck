# Build AgentDeck Connect

This developer builder assembles the separate native connection accessory. It is
not part of the AgentDeck App Store application. The GUI uses the existing
`NativeClientCore` authorization and Keychain implementation described in the
[native client guide](../README.md).

From the repository root, build `agentdeck-connect`, then provide an already
Developer ID-signed CLI and the SHA-1 of the same existing signing identity:

```sh
swift build --package-path integrations/chatgpt-local/native --product agentdeck-connect -c release
python3 integrations/chatgpt-local/native/ConnectApp/build.py \
  --binary integrations/chatgpt-local/native/.build/release/agentdeck-connect \
  --client-binary /path/to/signed/agentdeck-local \
  --output /path/to/new/AgentDeckConnect.app \
  --sign-identity "$AGENTDECK_SIGNING_IDENTITY_SHA1" \
  --account plugin-native-preview
```

The output must not already exist. The builder reads the default port from the
canonical Dot rules; `--port 19476` selects the isolated validation fixture.
Use exactly the same account and port as the plugin's stdio client. These values
are written to `Info.plist` before signing and are not editable in the GUI.

The builder copies the canonical CSS, IBM Plex Sans KR fonts and their OFL
license, checks system-library dependencies, signs the new app, and verifies
that its designated requirement exactly matches the supplied CLI. Matching the
signing identifier alone is insufficient for shared login-Keychain access. Run
signing and verification with access to the system signing services; a restricted
agent sandbox can report an invalid signature for an otherwise valid app.
Do not bypass the signature checks.

Building does not install or launch the app, modify MCP configuration, or create
an authorization. Connecting still requires a user click, code comparison, and
explicit approval in the AgentDeck host. Actual GUI and plugin acceptance remain
separate from this build check.
