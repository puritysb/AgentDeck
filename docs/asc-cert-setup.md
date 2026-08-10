# App Store Connect Signing Setup

AgentDeck signs iOS and macOS App Store releases with persistent manual signing assets for the organization team `QF36NDHYHD` (Serendipity Bound). Both platforms use the Universal Purchase bundle ID `bound.serendipity.agent.deck`.

## Why signing is manual

From 2026-07-10 through 2026-08-10, `apple-release.yml` used automatic signing with an App Store Connect API key on ephemeral GitHub runners. The archive phase asked Apple for a new development identity on a runner that could not retain its private key. Certificate-cap failures recurred on 2026-07-21, 2026-08-04, and 2026-08-10.

The 2026-08-10 account inventory made the leak concrete: five active `DEVELOPMENT` certificates had the same creation date, four named `Created via API`. macOS failed with `No signing certificate "Mac Development"`; iOS failed while looking for an iOS App Development profile. Distribution upload signing was not the exhausted type.

The current workflow therefore:

- imports one persistent organization `Apple Distribution` identity;
- imports one persistent organization `Mac Installer Distribution` identity for the macOS `.pkg`;
- installs explicit iOS and macOS App Store provisioning profiles;
- archives with `CODE_SIGN_STYLE=Manual`, without `-allowProvisioningUpdates`;
- keeps the App Store Connect API key only for the final upload; and
- validates the team and application identifier before Xcode starts.

An Apple signing certificate belongs to a developer team, not a bundle ID. The March 2026 secrets are unusable because their private-key identities belong to the retired personal team `R22679GY5Z`; the profiles additionally predate the current bundle ID.

## Required GitHub secrets

| Secret                                  | Contents                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `APPLE_DISTRIBUTION_CERTIFICATE_BASE64` | Password-protected `.p12` containing the organization Apple Distribution certificate and private key         |
| `APPLE_INSTALLER_CERTIFICATE_BASE64`    | Password-protected `.p12` containing the organization Mac Installer Distribution certificate and private key |
| `APPLE_CERTIFICATE_PASSWORD`            | The password used for both `.p12` files                                                                      |
| `IOS_PROVISIONING_PROFILE_BASE64`       | App Store profile for `QF36NDHYHD.bound.serendipity.agent.deck`                                              |
| `MACOS_PROVISIONING_PROFILE_BASE64`     | Mac App Store profile for `QF36NDHYHD.bound.serendipity.agent.deck`                                          |
| `ASC_API_KEY_ID`                        | Organization App Store Connect API key ID                                                                    |
| `ASC_ISSUER_ID`                         | Organization App Store Connect issuer ID                                                                     |
| `ASC_API_KEY_BASE64`                    | Base64-encoded organization `.p8`; used only for upload and certificate inventory                            |

The legacy `APPLE_CERTIFICATE_BASE64` secret is not read by the current workflow. Remove it only after the manual-signing dry-run succeeds.

## 1. Create the organization signing identities

Use the Apple Developer portal while the `Serendipity Bound` team is selected. Generate a separate CSR/private-key pair for each certificate and retain each private key until its `.p12` has been exported.

1. Create an **Apple Distribution** certificate for team `QF36NDHYHD`.
2. Create a **Mac Installer Distribution** certificate for the same team.
3. Install both downloaded `.cer` files into the keychain that contains their CSR private keys.
4. Confirm both identities are usable:

```bash
security find-identity -v -p codesigning | grep 'Apple Distribution: .* (QF36NDHYHD)'
security find-identity -v -p basic | grep '3rd Party Mac Developer Installer: .* (QF36NDHYHD)'
```

The word `identity` is important: a certificate without its private key may appear in Keychain Access but will not appear in `security find-identity` and cannot sign a build.

Export the two identities separately as `.p12`, using the same strong password:

- Apple Distribution → `agentdeck-apple-distribution.p12`
- Mac Installer Distribution → `agentdeck-mac-installer.p12`

Separate files avoid relying on Keychain Access to export a multi-private-key PKCS#12 bundle. `apple/scripts/install-ci-signing-assets.sh` imports and validates both.

## 2. Create the App Store profiles

Create two distribution profiles in Certificates, Identifiers & Profiles:

| Platform | Profile type  | App ID                         | Profile name                         |
| -------- | ------------- | ------------------------------ | ------------------------------------ |
| iOS      | App Store     | `bound.serendipity.agent.deck` | `AgentDeck Dashboard AppStore`       |
| macOS    | Mac App Store | `bound.serendipity.agent.deck` | `AgentDeck Dashboard macOS AppStore` |

Select the new organization Apple Distribution certificate for both. Do not select an old `R22679GY5Z` certificate.

## 3. Upload the secrets

Base64-encode the four binary files without copying them into the repository:

```bash
base64 -i agentdeck-apple-distribution.p12 | gh secret set APPLE_DISTRIBUTION_CERTIFICATE_BASE64
base64 -i agentdeck-mac-installer.p12 | gh secret set APPLE_INSTALLER_CERTIFICATE_BASE64
base64 -i AgentDeck_Dashboard_AppStore.mobileprovision | gh secret set IOS_PROVISIONING_PROFILE_BASE64
base64 -i AgentDeck_Dashboard_macOS_AppStore.provisionprofile | gh secret set MACOS_PROVISIONING_PROFILE_BASE64
gh secret set APPLE_CERTIFICATE_PASSWORD
```

`gh secret set APPLE_CERTIFICATE_PASSWORD` prompts without echoing the password. Do not pass the password on the command line or put it in shell history.

## 4. Dry-run before the next release

Run **Apple Release (TestFlight)** with `workflow_dispatch`:

- `release_version`: the current Apple version, for example `1.0.5`
- `upload`: `false`

Both jobs must pass archive, export, and `verify-appstore-archive.sh`. With `upload=false`, no binary reaches App Store Connect and no submitted version is replaced. The workflow dynamically reads the exact imported Mac installer identity and adds it to a temporary export plist; the common name is not hard-coded in the repository.

After the dry-run, dispatch **ASC Certificates** with `action=list`. A successful manual-signing run must not create another `DEVELOPMENT` certificate.

Only after those checks pass should an `apple-v*` tag use the new signing path. A tag always uploads; GitHub Release creation remains tag-only.

## Troubleshooting

| Error                                                            | Meaning / action                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `No Apple Distribution private-key identity for team QF36NDHYHD` | The distribution `.p12` is from the wrong team, has the wrong password, or lacks its private key.                                                                                                                             |
| `No Mac Installer Distribution private-key identity`             | The installer `.p12` is missing its private key or belongs to the retired personal team.                                                                                                                                      |
| `Provisioning profile belongs to team ...`                       | Recreate the profile under `QF36NDHYHD`.                                                                                                                                                                                      |
| `Provisioning profile targets ...`                               | Recreate it for `bound.serendipity.agent.deck`.                                                                                                                                                                               |
| `No profile for ... was found`                                   | Confirm the expected profile name and that the profile secret was refreshed.                                                                                                                                                  |
| `MAC verification failed during PKCS12 import`                   | Confirm the password first. If OpenSSL created the `.p12`, re-export with macOS-compatible algorithms (`openssl pkcs12 -export -legacy ...`) and verify it locally with `security import` before replacing the secret.        |
| `Choose a certificate to revoke`                                 | The job is still asking for automatic development signing somewhere. Search the archive command and generated Release settings for `Automatic` or `-allowProvisioningUpdates`; do not reflexively revoke another certificate. |
| `ITMS-90237: Apple Installer Package not signed`                 | Confirm the installer identity imported successfully and inspect the temporary export-options step.                                                                                                                           |

The release invariant verifier remains mandatory for both exported platforms; signing changes never weaken App Review Guidelines 2.5.2, 4.2, or 4.2.3.
