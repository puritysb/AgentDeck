# App Store Connect Certificate + Provisioning Setup

Step-by-step guide to provision the certificates and provisioning profiles that CI needs for the `apple-release.yml` workflow. The workflow ships both `build-ios` and `build-macos` jobs that upload to the same `bound.serendipity.agent.deck` record so the app sells as a **Universal Purchase** (one App Store entry, both platforms).

> The `APPLE_CERTIFICATE_BASE64` secret must contain a `.p12` with both the Apple Distribution identity (signs the iOS `.ipa` *and* the macOS `.app`) and the 3rd Party Mac Developer Installer identity (signs the macOS `.pkg`). The same certificate bundle is used by both iOS and macOS jobs; the macOS job does not use separate `APPLE_MAC_INSTALLER_*` secrets.

---

## Prerequisites

- Apple Developer Program membership (paid — $99/year).
- Admin or App Manager role on the AgentDeck team in [App Store Connect](https://appstoreconnect.apple.com/).
- macOS machine with Xcode 16+ and the same Apple ID signed in.
- Bundle ID `bound.serendipity.agent.deck` already registered in the Apple Developer portal (it is — iOS TestFlight uses it).

---

## Step 1 — Create the App Store Connect record (macOS)

Skip if already created.

1. Open [App Store Connect → My Apps](https://appstoreconnect.apple.com/apps).
2. Click **+** → **New App**.
3. Platforms: check **macOS** (if iOS record already exists, this adds a Mac version to it — "Add new platform" flow).
4. Name: **AgentDeck Dashboard** (30-char limit).
5. Primary Language: Korean or English (pick one; you can localize later).
6. Bundle ID: `bound.serendipity.agent.deck` (the same one the `.app` ships with).
7. SKU: `agentdeck-dashboard-macos` (internal id, any unique string).
8. User Access: Full access.
9. Click **Create**.

The record starts in **"Prepare for Submission"** state. Metadata/screenshots come later; the record just needs to exist so the profile below can attach to it.

---

## Step 2 — Confirm App ID capabilities

AgentDeck uses the app's own sandbox container for App Store state. Do **not** add the optional App Groups capability unless a future helper, extension, or login item is added and the entitlement is restored in code first.

1. Open [Apple Developer → Certificates, Identifiers & Profiles → Identifiers](https://developer.apple.com/account/resources/identifiers/list).
2. App IDs tab → find `bound.serendipity.agent.deck` → click it.
3. Confirm the App ID exists and is available for Mac App Store profiles.
4. Leave **App Groups** unchecked for the current 1.0 submission.

---

## Step 3 — Create the Mac Installer Distribution certificate

This is the certificate that signs the `.pkg` the App Store ingests. Separate from the "Apple Distribution" cert that signs the `.app` itself.

1. Open **Keychain Access** on your Mac.
2. Keychain Access menu → **Certificate Assistant** → **Request a Certificate from a Certificate Authority**.
3. **User Email Address**: your Apple ID email.
4. **Common Name**: `AgentDeck Mac Installer` (or anything meaningful).
5. **CA Email Address**: leave blank.
6. **Request is**: check **Saved to disk**. Next.
7. Save the `.certSigningRequest` file (CSR) somewhere you can find it.

Then upload the CSR to Apple:

1. [Apple Developer → Certificates, Identifiers & Profiles → Certificates](https://developer.apple.com/account/resources/certificates/list).
2. Click **+**.
3. Section **Production**: select **Mac Installer Distribution**. Continue.
4. Upload the `.certSigningRequest` from Keychain Access. Continue.
5. Download the resulting `.cer` file.
6. Double-click the `.cer` to install into Keychain Access. It should appear under **login** keychain with the private key (from the CSR) attached.

Verify the cert is usable:

```bash
security find-identity -p basic -v
# Look for a line like:
#   N) XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX "3rd Party Mac Developer Installer: Your Name (TEAMID)"
```

If the line shows `unavailable`, the private key isn't in the same keychain as the public cert — re-download the cert or re-import the `.p12` from a previous export.

---

## Step 4 — Create the macOS Provisioning Profile

1. [Apple Developer → Profiles](https://developer.apple.com/account/resources/profiles/list) → **+**.
2. **Distribution** section: select **Mac App Store**. Continue.
3. App ID: `bound.serendipity.agent.deck`. Continue.
4. Select the **Apple Distribution** certificate (the one for signing the `.app`, not the Mac Installer one). Continue.
5. Profile Name: `AgentDeck Dashboard macOS AppStore` (must match `PROVISIONING_PROFILE_SPECIFIER` in `apple/project.yml` and `.github/workflows/apple-release.yml`).
6. Generate. Download the `.provisionprofile` file.

Install it locally:

```bash
cp ~/Downloads/AgentDeck_Dashboard_macOS_AppStore.provisionprofile \
   ~/Library/MobileDevice/Provisioning\ Profiles/
```

---

## Step 4.5 — Create the iOS App Store Provisioning Profile

Required for the `build-ios` job. Without this profile the iOS half of the Universal Purchase cannot ship.

1. [Apple Developer → Profiles](https://developer.apple.com/account/resources/profiles/list) → **+**.
2. **Distribution** section: select **App Store** (the iOS one, not Mac App Store). Continue.
3. App ID: `bound.serendipity.agent.deck` (same App ID as macOS — Universal Purchase requires identical Bundle ID across both platforms). Continue.
4. Select the **Apple Distribution** certificate (same one used in Step 4). Continue.
5. Profile Name: `AgentDeck Dashboard AppStore` (must match `PROVISIONING_PROFILE_SPECIFIER` on the `AgentDeck_iOS` target in `apple/project.yml`). Note: the iOS profile name does **not** include the word "macOS" — keep the two profile names distinct.
6. Generate. Download the `.mobileprovision` file.

Install it locally (optional — only needed for local signed iOS builds):

```bash
cp ~/Downloads/AgentDeck_Dashboard_AppStore.mobileprovision \
   ~/Library/MobileDevice/Provisioning\ Profiles/
```

Base64-encode for GitHub Secrets:

```bash
base64 -i ~/Downloads/AgentDeck_Dashboard_AppStore.mobileprovision | pbcopy
```

The base64 string is now on your clipboard — paste it into the `IOS_PROVISIONING_PROFILE_BASE64` secret in Step 6.

---

## Step 5 — Export the signing identities as `.p12`

GitHub Actions needs the signing certs + private keys as a base64-encoded `.p12`. Export a bundle that includes:

- `Apple Distribution: … (R22679GY5Z)` — signs the `.app`.
- `3rd Party Mac Developer Installer: … (R22679GY5Z)` — signs the Mac App Store `.pkg`.

Recommended path:

1. Open **Keychain Access**.
2. Select both identities above, including their private keys.
3. Right-click → **Export 2 items…**.
4. File Format: **Personal Information Exchange (.p12)**.
5. Save to `~/Desktop/apple-appstore-identities.p12`.
6. Set a strong password if desired. A passwordless `.p12` is also supported; leave `APPLE_CERTIFICATE_PASSWORD` empty in that case.

Base64-encode for GitHub Secrets:

```bash
base64 -i ~/Desktop/apple-appstore-identities.p12 | pbcopy
```

The base64 string is now on your clipboard.

---

## Step 6 — Upload secrets to GitHub

Go to [github.com/puritysb/AgentDeck/settings/secrets/actions](https://github.com/puritysb/AgentDeck/settings/secrets/actions) and add these secrets:

| Secret name | Value | Notes |
|---|---|---|
| `APPLE_CERTIFICATE_BASE64` | paste from `pbcopy` above | Combined `.p12` containing Apple Distribution + 3rd Party Mac Developer Installer identities (used by both iOS and macOS jobs) |
| `APPLE_CERTIFICATE_PASSWORD` | password from Step 5, or empty for a passwordless `.p12` | Used to decrypt the combined `.p12` on the runner |
| `IOS_PROVISIONING_PROFILE_BASE64` | clipboard from the `base64` command in Step 4.5 | The iOS App Store profile from Step 4.5 (`AgentDeck Dashboard AppStore`). Required for `build-ios`. |
| `MACOS_PROVISIONING_PROFILE_BASE64` | `base64 -i ~/Library/MobileDevice/Provisioning\ Profiles/AgentDeck_Dashboard_macOS_AppStore.provisionprofile \| pbcopy` | The macOS profile from Step 4 (`AgentDeck Dashboard macOS AppStore`). Required for `build-macos`. |

Independent App Store Connect API key (existing — needed for `xcrun altool` upload from both jobs):
- `ASC_API_KEY_ID` / `ASC_ISSUER_ID` / `ASC_API_KEY_BASE64`

---

## Step 7 — Verify `apple-release.yml`

The workflow already runs both `build-ios` and `build-macos`. Verify that the macOS lane imports the combined certificate bundle:

```yaml
      - name: Install Apple certificate
        env:
          APPLE_CERTIFICATE_BASE64: ${{ secrets.APPLE_CERTIFICATE_BASE64 }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
        run: |
          test -n "$APPLE_CERTIFICATE_BASE64"

          CERTIFICATE_PATH=$RUNNER_TEMP/certificate.p12
          P12_PASSWORD="${APPLE_CERTIFICATE_PASSWORD:-}"
          ...
          security import $CERTIFICATE_PATH -P "$P12_PASSWORD" \
            -A -k $KEYCHAIN_PATH >/dev/null
          security find-identity -v -p codesigning $KEYCHAIN_PATH
```

Also verify that the `release` job depends on both Apple platforms:

```yaml
  release:
    needs: [build-ios, build-macos]
```

---

## Step 8 — Verify `apple/ExportOptions-macOS.plist`

The file at `apple/ExportOptions-macOS.plist` is intentionally manual so GitHub Actions uses the uploaded profile instead of attempting cloud-managed signing:

```xml
<key>method</key>
<string>app-store-connect</string>
<key>teamID</key>
<string>R22679GY5Z</string>
<key>signingStyle</key>
<string>manual</string>
<key>signingCertificate</key>
<string>Apple Distribution</string>
<key>installerSigningCertificate</key>
<string>3rd Party Mac Developer Installer: SEUNG BEOM CHOI (R22679GY5Z)</string>
<key>provisioningProfiles</key>
<dict>
  <key>bound.serendipity.agent.deck</key>
  <string>AgentDeck Dashboard macOS AppStore</string>
</dict>
```

Use the exact installed installer identity common name here. Xcode documents `Mac Installer Distribution` as an automatic selector, but local export validation on Xcode 26 failed to resolve that selector for this project while the exact `3rd Party Mac Developer Installer: SEUNG BEOM CHOI (R22679GY5Z)` value exported successfully.

---

## Step 9 — Trigger a dry-run tag

```bash
git tag apple-v1.0.0-rc1
git push origin apple-v1.0.0-rc1
```

Watch the `Apple Release (TestFlight)` workflow in GitHub Actions. Both `build-ios` and `build-macos` should run. The first run often surfaces missing entitlement values or cert-chain issues — iterate on `-rc2`, `-rc3` until you see the green `Upload macOS to App Store Connect` step.

After the upload, App Store Connect shows the build under **TestFlight → macOS**. Install via TestFlight on your Mac (not the archived build directly — Gatekeeper will refuse unsigned dev archives).

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `security: SecKeychainItemImport: The specified item already exists in the keychain` | Duplicate cert from a prior CI run that didn't clean up | The existing Cleanup step deletes the keychain on `if: always()` — usually safe. If stuck, regenerate the cert on Apple Developer and re-upload. |
| `xcodebuild: error: No account for team "R22679GY5Z"` | Runner keychain missing the Apple Distribution cert | Check `APPLE_CERTIFICATE_BASE64` secret is set, base64 is clean (no newlines), and the `.p12` includes the Apple Distribution private key. |
| `exportArchive No certificate ... matching 'Mac Installer Distribution' found` | Xcode failed to resolve the automatic installer certificate selector, or `APPLE_CERTIFICATE_BASE64` lacks the `3rd Party Mac Developer Installer` private-key identity | Keep `apple/ExportOptions-macOS.plist` on the exact installer identity common name and re-export the combined `.p12` from Keychain Access with both `Apple Distribution: ... (R22679GY5Z)` and `3rd Party Mac Developer Installer: ... (R22679GY5Z)`, then update the GitHub secret. |
| `altool: error: The packaged app bundle is missing a Mach-O executable` | Archive was skipped (xcodebuild archive failed silently) | Scroll earlier in the log. The Archive step must emit `ARCHIVE SUCCEEDED`. |
| `altool: error: ITMS-90296: App sandbox not enabled` | Missing `com.apple.security.app-sandbox` | It IS in our entitlements file. Check `verify-appstore-archive.sh` output for the signed .app. |
| `altool: error: ITMS-90237: Apple Installer Package not signed` | Mac Installer cert didn't make it into the signing keychain | Re-export `APPLE_CERTIFICATE_BASE64` as the combined `.p12`; it must include the 3rd Party Mac Developer Installer private key. |
| TestFlight shows "Missing Compliance" banner | Standard cryptographic-use question | App Store Connect → TestFlight build → Export Compliance → answer "No" (AgentDeck doesn't ship custom cryptography beyond what macOS provides). |

---

## What can the user skip?

- **Mac Installer Distribution cert + provisioning profile**: Required for Mac App Store. Cannot skip.
- **App Group registration**: Not used for the current App Store build. Do not add it unless the entitlement and data-path contract are intentionally changed.
- **App Store Connect record creation (Step 1)**: Required before you can upload.
- **Metadata (icons, screenshots, description)**: Can be filled in App Store Connect after the first successful TestFlight upload. See [appstore-metadata-draft.md](appstore-metadata-draft.md) for copy.

Once Steps 1–7 are done once, subsequent releases just need `git tag apple-v1.X.Y && git push origin apple-v1.X.Y`.
