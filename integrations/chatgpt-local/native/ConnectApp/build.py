#!/usr/bin/env python3
"""Assemble a separate preview GUI; never install, launch or authorize a client.

The finished GUI and the supplied signed CLI must share the same designated
requirement so the two programs can use the same existing login-Keychain item.
This developer builder is not part of the AgentDeck App Store application.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys

IDENTIFIER = "dev.agentdeck.local-client.preview"
NATIVE = Path(__file__).resolve().parent.parent
REPOSITORY = NATIVE.parent.parent.parent


def run(*arguments: str) -> str:
    result = subprocess.run(arguments, capture_output=True, text=True, timeout=60, check=False)
    if result.returncode:
        # Codesign diagnostics contain no OAuth credentials; this builder never reads them.
        raise RuntimeError(f"{Path(arguments[0]).name} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout + result.stderr


def local_ports() -> tuple[int, int]:
    source = (REPOSITORY / "apple/AgentDeck/Daemon/Dot/DotRules.generated.swift").read_text()
    block = re.search(r"enum DotLocalMCP \{([^}]+)\}", source)
    if not block:
        raise ValueError("Missing canonical DotLocalMCP rules")
    def number(name: str) -> int:
        found = re.search(rf"static let {name} = ([0-9]+)\b", block.group(1))
        if not found:
            raise ValueError(f"Missing canonical {name}")
        return int(found.group(1))
    return number("port"), number("controlPort")


def checked_file(path: Path) -> Path:
    resolved = path.resolve(strict=True)
    if not resolved.is_file() or resolved.stat().st_size == 0:
        raise ValueError(f"Expected a nonempty file: {path}")
    return resolved


def designated_requirement(path: Path) -> str:
    run("/usr/bin/codesign", "--verify", "--strict", str(path))
    details = run("/usr/bin/codesign", "--display", "--requirements", "-", "--verbose=4", str(path))
    if f"Identifier={IDENTIFIER}\n" not in details:
        raise ValueError(f"Signing identifier must be {IDENTIFIER}: {path}")
    if "Authority=Developer ID Application:" not in details:
        raise ValueError(f"A Developer ID Application signature is required: {path}")
    match = re.search(r"^designated => (.+)$", details, re.MULTILINE)
    if not match:
        raise ValueError(f"No designated requirement: {path}")
    return match.group(1)


def system_dependencies(binary: Path) -> None:
    if "Mach-O" not in run("/usr/bin/file", "--brief", str(binary)):
        raise ValueError("The GUI source must be a compiled Mach-O executable")
    listing = run("/usr/bin/otool", "-L", str(binary)).splitlines()
    for line in listing:
        # Universal files have a header for each architecture; only indented
        # rows are dependencies. Inspect all slices without treating headers as paths.
        if not line.startswith("\t"):
            continue
        dependency = line.strip().split(" (", 1)[0]
        if dependency and not dependency.startswith(("/System/Library/", "/usr/lib/")):
            raise ValueError(f"Non-system GUI dependency: {dependency}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True, help="Already built agentdeck-connect executable")
    parser.add_argument("--client-binary", type=Path, required=True, help="Signed CLI whose designated requirement must match")
    parser.add_argument("--output", type=Path, required=True, help="A new .app directory; existing paths are rejected")
    parser.add_argument("--sign-identity", required=True, help="SHA-1 of an existing Developer ID Application signing identity")
    parser.add_argument("--account", default="plugin-native-preview", help="Fixed Keychain account namespace shared with the MCP package")
    parser.add_argument("--port", type=int, help="Fixed loopback port; defaults to the canonical local MCP port")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", args.account):
        raise ValueError("Invalid account namespace")
    if not re.fullmatch(r"[A-Fa-f0-9]{40}", args.sign_identity):
        raise ValueError("Provide the SHA-1 of an existing signing identity")
    default_port, operator_port = local_ports()
    port = default_port if args.port is None else args.port
    # Same public client endpoint policy as NativeClientCore.Endpoint. The host
    # itself remains fixed to canonical loopback in that type.
    if not 1024 <= port <= 65535 or 9120 <= port <= 9139 or port == operator_port:
        raise ValueError("Port is outside the public local-client endpoint policy")
    output = args.output.expanduser().absolute()
    if output.suffix != ".app" or os.path.lexists(output):
        raise ValueError("Output must be a new, nonexistent .app path")
    if not output.parent.is_dir():
        raise ValueError("Output parent must already exist")
    binary, client = checked_file(args.binary), checked_file(args.client_binary)
    system_dependencies(binary)
    expected_requirement = designated_requirement(client)
    sources = {
        "design-tokens.css": checked_file(REPOSITORY / "design/tokens.css"),
        "Fonts/IBMPlexSansKR-Regular.ttf": checked_file(REPOSITORY / "design/fonts/IBMPlexSansKR-Regular.ttf"),
        "Fonts/IBMPlexSansKR-Bold.ttf": checked_file(REPOSITORY / "design/fonts/IBMPlexSansKR-Bold.ttf"),
        "Fonts/OFL-IBMPlexSansKR.txt": checked_file(NATIVE / "package/OFL-IBMPlexSansKR.txt"),
    }
    with (Path(__file__).parent / "Info.plist").open("rb") as handle:
        info = plistlib.load(handle)
    if info.get("CFBundleIdentifier") != IDENTIFIER or info.get("CFBundleExecutable") != "agentdeck-connect":
        raise ValueError("Unexpected GUI bundle identity in Info.plist template")
    info["AgentDeckConnectionAccount"] = args.account
    info["AgentDeckConnectionPort"] = port
    output.mkdir()  # Exclusive creation also rejects a concurrent creator.
    contents = output / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    resources = contents / "Resources"
    resources.mkdir()
    destination = contents / "MacOS/agentdeck-connect"
    shutil.copyfile(binary, destination)
    destination.chmod(0o755)
    for relative, source in sources.items():
        target = resources / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        target.chmod(0o644)
    with (contents / "Info.plist").open("wb") as handle:
        plistlib.dump(info, handle, sort_keys=False)
    run("/usr/bin/codesign", "--force", "--options", "runtime", "--timestamp",
        "--sign", args.sign_identity, "--identifier", IDENTIFIER, str(output))
    actual_requirement = designated_requirement(output)
    if actual_requirement != expected_requirement:
        raise ValueError("GUI and CLI designated requirements differ; the app is not ready for shared Keychain use")
    system_dependencies(destination)
    print(json.dumps({"app": str(output), "identifier": IDENTIFIER, "account": args.account,
                      "port": port, "designated_requirement_matches_cli": True,
                      "installed": False, "launched": False, "authorization_created": False}, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"AgentDeck Connect build failed: {error}", file=sys.stderr)
        raise SystemExit(1)
