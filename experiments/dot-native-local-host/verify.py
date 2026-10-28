#!/usr/bin/env python3
"""Static artifact verification; never starts the harness or accesses credentials."""
import hashlib
import json
import plistlib
import subprocess
import sys
import datetime
import fnmatch
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
BUNDLE_ID = "dev.agentdeck.dot-native-local-host"
TEAM_ID = "QF36NDHYHD"
SIGNER_SHA1 = "B82C56894E31CEBCABB07E60543F440E0367B22A"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def check_profile(path, signer_sha1):
    require(signer_sha1.upper() == SIGNER_SHA1, "only the explicitly approved existing development certificate is permitted")
    decoded = subprocess.run(["security", "cms", "-D", "-i", str(path)], check=True, capture_output=True).stdout
    profile = plistlib.loads(decoded)
    entitlements = profile.get("Entitlements", {})
    app_id = TEAM_ID + "." + BUNDLE_ID
    require(profile.get("TeamIdentifier") == [TEAM_ID], "profile belongs to a different team")
    require("OSX" in profile.get("Platform", []), "not a Mac provisioning profile")
    expiration = profile["ExpirationDate"].replace(tzinfo=datetime.timezone.utc)
    require(expiration > datetime.datetime.now(datetime.timezone.utc), "profile expired")
    pattern = entitlements.get("com.apple.application-identifier", entitlements.get("application-identifier", ""))
    require(pattern.startswith(TEAM_ID + ".") and fnmatch.fnmatchcase(app_id, pattern), "profile does not permit the isolated bundle ID")
    require(entitlements.get("com.apple.developer.team-identifier") == TEAM_ID, "profile entitlement team mismatch")
    require(any(fnmatch.fnmatchcase(app_id, group) for group in entitlements.get("keychain-access-groups", [])), "profile does not permit the dedicated Keychain group")
    certificates = {hashlib.sha1(cert).hexdigest().upper() for cert in profile.get("DeveloperCertificates", [])}
    require(signer_sha1.upper() in certificates, "signing certificate is not included in the profile")
    if not profile.get("ProvisionsAllDevices", False):
        devices = profile.get("ProvisionedDevices", [])
        require(devices, "Store-only profile is not permitted for this local harness")
        # Apple silicon registration uses Provisioning UDID, not hardware UUID.
        # Keep both the raw metadata and device identifiers out of diagnostics.
        hardware = json.loads(subprocess.run(["system_profiler", "SPHardwareDataType", "-json"],
                                             check=True, capture_output=True, timeout=30).stdout)
        machine = hardware["SPHardwareDataType"][0]
        provisioning_udid = machine.get("provisioning_UDID")
        require(isinstance(provisioning_udid, str) and bool(provisioning_udid), "could not read this Mac's provisioning UDID")
        require(provisioning_udid.upper() in {device.upper() for device in devices}, "current Mac provisioning UDID is not included in the profile")
    return {"profileUUID": profile["UUID"], "profileName": profile["Name"], "teamId": TEAM_ID,
            "permittedAppId": pattern, "signerSHA1": signer_sha1.upper(), "currentMacEligible": True,
            "expiresAt": expiration.isoformat()}


def source_hashes():
    paths = (HERE / "sources.txt").read_text().splitlines()
    paths += ["apple/AgentDeck/Resources/dot-mcp-contract.json"]
    paths += [f"experiments/dot-native-local-host/{name}" for name in
              ("HostApp.swift", "Host.entitlements", "Info.plist", "sources.txt", "build.sh", "verify.py")]
    return {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest() for name in paths if name}


def verify(app):
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    require(info["CFBundleIdentifier"] == BUNDLE_ID, "wrong bundle identifier")
    require(info["CFBundleExecutable"] == "AgentDeckDotLocalHost", "wrong executable")
    require(info["AgentDeckDotSupport"] == "preview", "not a preview")
    manifest = json.loads((app / "Contents/Resources/source-manifest.json").read_text())
    require(manifest["sources"] == source_hashes(), "source hashes differ from this checkout")
    contract = app / "Contents/Resources/dot-mcp-contract.json"
    require(contract.read_bytes() == (ROOT / "apple/AgentDeck/Resources/dot-mcp-contract.json").read_bytes(), "contract changed")
    require(sorted(path.name for path in (app / "Contents/MacOS").iterdir()) == ["AgentDeckDotLocalHost"], "unexpected executable")
    subprocess.run(["codesign", "--verify", "--strict", "--verbose=2", str(app)], check=True, capture_output=True)
    details = subprocess.run(["codesign", "-dvvv", str(app)], check=True, capture_output=True, text=True).stderr
    require(f"TeamIdentifier={TEAM_ID}" in details, "wrong signer team")
    require(any(authority in details for authority in ("Authority=Developer ID Application:", "Authority=Apple Development:")), "a permitted development signer is required")
    require("Signature=adhoc" not in details, "ad-hoc signing is not acceptance")
    entitlement_bytes = subprocess.run(["codesign", "-d", "--entitlements", "-", "--xml", str(app)],
                                       check=True, capture_output=True).stdout
    entitlements = plistlib.loads(entitlement_bytes)
    expected = plistlib.loads((HERE / "Host.entitlements").read_bytes())
    require(entitlements == expected, "signed entitlements differ from isolation contract")
    require(entitlements["keychain-access-groups"] == [TEAM_ID + "." + BUNDLE_ID], "unexpected Keychain group")
    profile_path = app / "Contents/embedded.provisionprofile"
    require(profile_path.is_file(), "missing provisioning profile; static signature validity is not runtime eligibility")
    # These are public certificates only, not private signing keys.
    with tempfile.TemporaryDirectory(prefix="dot-public-certificate-") as temporary:
        prefix = str(Path(temporary) / "certificate")
        subprocess.run(["codesign", "-d", "--extract-certificates=" + prefix, str(app)], check=True, capture_output=True)
        signer_sha1 = hashlib.sha1(Path(prefix + "0").read_bytes()).hexdigest().upper()
    profile = check_profile(profile_path, signer_sha1)
    print(json.dumps({"artifact": str(app), "bundleId": BUNDLE_ID, "teamId": TEAM_ID,
                      "signedSandboxStaticCheck": "passed", "runtime": "not verified by this script",
                      "sourceFiles": len(manifest["sources"]), "provisioning": profile}, indent=2))


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "--check-profile":
            print(json.dumps(check_profile(Path(sys.argv[2]), sys.argv[3]), indent=2))
        elif len(sys.argv) == 3 and sys.argv[1] == "--record-sources":
            app = Path(sys.argv[2]).resolve()
            manifest = {"schema": 1, "scope": "isolated synthetic native Dot host experiment", "sources": source_hashes()}
            (app / "Contents/Resources/source-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        elif len(sys.argv) == 2:
            verify(Path(sys.argv[1]).resolve())
        else:
            raise ValueError("usage: verify.py [--record-sources] APP | --check-profile PROFILE SIGNER_SHA1")
    except (AssertionError, ValueError, OSError, KeyError, IndexError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        sys.exit("FAIL: " + str(error))
