#!/usr/bin/env python3
"""Offline archive guard; never accesses iCloud, provisioning services or user records."""
import argparse
import plistlib
import subprocess
from pathlib import Path

CONTAINER = "iCloud.bound.serendipity.agent.deck"


def verify_identity(info, environment, signed):
    if info.get("CFBundleIdentifier") != "bound.serendipity.agent.deck" or info.get("AgentDeckRemoteObservationContract") != 1:
        raise ValueError("archive has the wrong bundle or remote observation contract identity")
    selected = info.get("AgentDeckRemoteObservationEnvironment")
    if selected not in ("Development", "Production") or (signed and selected != environment):
        raise ValueError("storage environment identity does not match the archive environment")


def verify_entitlements(entitlements, platform, environment):
    if CONTAINER not in entitlements.get("com.apple.developer.icloud-container-identifiers", []):
        raise ValueError("CloudKit container entitlement is missing")
    if "CloudKit" not in entitlements.get("com.apple.developer.icloud-services", []):
        raise ValueError("CloudKit service entitlement is missing")
    if entitlements.get("com.apple.developer.icloud-container-environment") != environment:
        raise ValueError(f"signed CloudKit environment must be {environment}")
    if platform == "ios" and entitlements.get("aps-environment") != environment.lower():
        raise ValueError(f"signed APNs environment must be {environment.lower()}")
    if platform == "macos" and entitlements.get("com.apple.security.app-sandbox") is not True:
        raise ValueError("macOS Sandbox entitlement is missing")
    if environment == "Production" and entitlements.get("get-task-allow") is True:
        raise ValueError("Production archive permits debugging")


def self_test():
    valid = {
        "com.apple.developer.icloud-container-identifiers": [CONTAINER],
        "com.apple.developer.icloud-services": ["CloudKit"],
        "com.apple.developer.icloud-container-environment": "Production",
        "aps-environment": "production",
        "com.apple.security.app-sandbox": True,
    }
    for platform in ("ios", "macos"):
        verify_entitlements(valid, platform, "Production")
    invalid = [
        ("com.apple.developer.icloud-container-identifiers", ["iCloud.other"], "ios"),
        ("com.apple.developer.icloud-services", [], "ios"),
        ("com.apple.developer.icloud-container-environment", "Development", "ios"),
        ("aps-environment", "development", "ios"),
        ("com.apple.security.app-sandbox", False, "macos"),
        ("get-task-allow", True, "macos"),
    ]
    for key, value, platform in invalid:
        try:
            verify_entitlements({**valid, key: value}, platform, "Production")
        except ValueError:
            continue
        raise AssertionError(f"accepted invalid {key}")
    info = {"CFBundleIdentifier": "bound.serendipity.agent.deck", "AgentDeckRemoteObservationContract": 1,
            "AgentDeckRemoteObservationEnvironment": "Production"}
    verify_identity(info, "Production", True)
    try:
        verify_identity({**info, "AgentDeckRemoteObservationEnvironment": "Development"}, "Production", True)
    except ValueError:
        pass
    else:
        raise AssertionError("accepted Development storage in a Production archive")
    print("Remote observation archive guard: 10 entitlement/identity cases passed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("app", nargs="?", type=Path)
    parser.add_argument("--environment", choices=["Development", "Production"], default="Production")
    parser.add_argument("--unsigned", action="store_true", help="check build identity only, without claiming signing readiness")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return
    if args.app is None:
        parser.error("app is required unless --self-test is used")
    macos = (args.app / "Contents/Info.plist").is_file()
    info_path = args.app / ("Contents/Info.plist" if macos else "Info.plist")
    info = plistlib.loads(info_path.read_bytes())
    verify_identity(info, args.environment, not args.unsigned)
    if not args.unsigned:
        result = subprocess.run(["codesign", "-d", "--entitlements", ":-", str(args.app)],
                                check=True, capture_output=True, timeout=15)
        verify_entitlements(plistlib.loads(result.stdout), "macos" if macos else "ios", args.environment)
    print("Remote observation: unsigned build identity verified" if args.unsigned
          else f"Remote observation: signed {args.environment} entitlements verified")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, plistlib.InvalidFileException) as error:
        raise SystemExit(f"Remote observation archive check failed: {error}") from error
