#!/usr/bin/env python3
"""Stage a separate native preview; never install, authorize, sign or publish it."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
TEMPLATE = HERE / "package"
APP_NAME = "AgentDeck Connect.app"
DEVELOPER_ID = "anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"


class PackageError(Exception):
    pass


def read_json(path):
    return json.loads(path.read_text())


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command, input=None):
    try:
        result = subprocess.run(command, input=input, capture_output=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PackageError(f"Could not complete {Path(command[0]).name}: {error}") from error
    if result.returncode:
        raise PackageError(f"{Path(command[0]).name} failed: {result.stderr.decode(errors='replace')[:1500]}")
    if len(result.stdout) + len(result.stderr) > 2_000_000:
        raise PackageError("Verification output exceeded its limit")
    return result.stdout.decode(), result.stderr.decode()


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise PackageError(f"Expected a regular, non-symlink file: {path.name}")


def inspect_signature(path):
    run(["/usr/bin/codesign", "--verify", "--strict", "-R=" + DEVELOPER_ID, str(path)])
    _, details = run(["/usr/bin/codesign", "-d", "--verbose=4", str(path)])
    if "(runtime)" not in details:
        raise PackageError("The bundled executable must use hardened runtime")
    fields = dict(line.split("=", 1) for line in details.splitlines() if "=" in line)
    return {"identifier": fields.get("Identifier"), "team": fields.get("TeamIdentifier"),
            "developerIDRequirementVerified": True, "hardenedRuntime": True}


def designated_requirement(path):
    stdout, stderr = run(["/usr/bin/codesign", "-d", "-r-", str(path)])
    requirements = [line.removeprefix("designated => ") for line in (stdout + stderr).splitlines() if line.startswith("designated => ")]
    if len(requirements) != 1:
        raise PackageError("Could not read the executable's designated signing requirement")
    return requirements[0]


def inspect_executable(path):
    regular(path)
    if not os.access(path, os.X_OK):
        raise PackageError("The native binary is not executable")
    signature = inspect_signature(path)
    architectures = run(["/usr/bin/lipo", "-archs", str(path)])[0].split()
    if not architectures or set(architectures) - {"arm64", "x86_64"}:
        raise PackageError("Expected a macOS arm64 and/or x86_64 executable")
    dependencies = run(["/usr/bin/otool", "-L", str(path)])[0]
    libraries = sorted(set(line.strip().split(" (", 1)[0] for line in dependencies.splitlines() if line.startswith("\t")))
    if not libraries or any(not name.startswith(("/System/Library/", "/usr/lib/")) for name in libraries):
        raise PackageError("Unbundled non-system dynamic dependency; make the native executable self-contained")
    load_commands = run(["/usr/bin/otool", "-l", str(path)])[0]
    minimum = re.findall(r"^\s*minos (\d+(?:\.\d+)*)$", load_commands, re.M)
    platforms = re.findall(r"^\s*platform (\d+)$", load_commands, re.M)
    if not minimum or not platforms or any(platform != "1" for platform in platforms):
        raise PackageError("Expected macOS build-version commands in every architecture")
    return {**signature, "architectures": sorted(architectures),
            "minimumMacOS": max(minimum, key=lambda version: tuple(map(int, version.split(".")))),
            "systemLibraries": libraries, "sha256": digest(path)}


def canonical_contract():
    rules = (ROOT / "apple/AgentDeck/Daemon/Dot/DotRules.generated.swift").read_text()
    port = int(re.search(r"enum DotLocalMCP \{.*?static let port = (\d+)", rules, re.S)[1])
    source = (HERE / "Sources/NativeClientCore/Contract.swift").read_text()
    allowed = set(json.loads(re.search(r"static let allowedTools = Set\((\[.*?\])\)", source)[1]))
    contract = read_json(ROOT / "apple/AgentDeck/Resources/dot-mcp-contract.json")
    tools = [tool for tool in contract["tools"] if tool["name"] in allowed]
    if {tool["name"] for tool in tools} != allowed:
        raise PackageError("Canonical contract is missing an allowed native tool")
    protocol = re.search(r"const TOOL_VERSION = '([^']+)'", (ROOT / "services/dot-relay/src/server.ts").read_text())[1]
    return port, protocol, tools


def manifests(account, fixture_port):
    plugin, mcp = read_json(TEMPLATE / "plugin.json"), read_json(TEMPLATE / "mcp.json")
    account = account or ("plugin-native-fixture-preview" if fixture_port is not None else "plugin-native-preview")
    if re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", account) is None:
        raise PackageError("Account must be 1–64 letters, digits, underscores, dots or hyphens")
    default_port, _, _ = canonical_contract()
    if fixture_port is not None:
        rules = (ROOT / "apple/AgentDeck/Daemon/Dot/DotRules.generated.swift").read_text()
        control_port = int(re.search(r"enum DotLocalMCP \{.*?static let controlPort = (\d+)", rules, re.S)[1])
        if not 1024 <= fixture_port <= 65535 or fixture_port in range(9120, 9140) or fixture_port in (default_port, control_port):
            raise PackageError("Use a distinct, non-privileged fixture port, not a production or control port")
        plugin["name"] = "agentdeck-native-fixture-preview"
        plugin["description"] = "Isolated test fixture only. " + plugin["description"]
        plugin["extensions"]["com.openai"]["interface"]["displayName"] = "AgentDeck Native Fixture Preview"
    server = next(iter(mcp["mcpServers"].values()))
    server["args"] = ["serve", "--account", account]
    if fixture_port is not None:
        server["args"] += ["--port", str(fixture_port)]
    mcp["mcpServers"] = {plugin["name"]: server}
    return plugin, mcp, account, fixture_port if fixture_port is not None else default_port


def app_files(app, account, port):
    if app.is_symlink() or not app.is_dir() or app.suffix != ".app":
        raise PackageError("Connect app must be a regular .app directory")
    info_path = app / "Contents/Info.plist"
    regular(info_path)
    info = plistlib.loads(info_path.read_bytes())
    if info.get("AgentDeckConnectionAccount") != account or info.get("AgentDeckConnectionPort") != port:
        raise PackageError("Signed Connect app account/port must exactly match this package profile")
    executable = info.get("CFBundleExecutable", "")
    if re.fullmatch(r"[A-Za-z0-9_.-]+", executable) is None:
        raise PackageError("Connect app has an invalid executable name")
    required = {"Contents/Info.plist", f"Contents/MacOS/{executable}",
                "Contents/Resources/design-tokens.css", "Contents/Resources/Fonts/IBMPlexSansKR-Regular.ttf",
                "Contents/Resources/Fonts/IBMPlexSansKR-Bold.ttf", "Contents/Resources/Fonts/OFL-IBMPlexSansKR.txt"}
    files = []
    for item in sorted(app.rglob("*")):
        if item.is_symlink():
            raise PackageError("Connect app must not contain symlinks")
        if item.is_dir():
            continue
        regular(item)
        relative = item.relative_to(app).as_posix()
        allowed = relative in required | {"Contents/PkgInfo", "Contents/_CodeSignature/CodeResources"}
        if not allowed:
            raise PackageError(f"Unexpected Connect app file: {relative}")
        files.append(relative)
    if not required <= set(files):
        raise PackageError("Connect app is incomplete")
    return files, app / f"Contents/MacOS/{executable}"


def probe(package):
    server = next(iter(read_json(package / "mcp.json")["mcpServers"].values()))
    # Agent Plugins' portable command field accepts contained ./ paths, not
    # ${PLUGIN_ROOT} substitutions. Resolve the manifest command itself so this
    # smoke check cannot silently bypass the actual plugin launch configuration.
    if server.get("type") != "stdio" or server.get("command") != "./bin/agentdeck-local" or not isinstance(server.get("args"), list) or server["args"][:1] != ["serve"]:
        raise PackageError("Package must use the contained portable command ./bin/agentdeck-local")
    executable = package / server["command"]
    regular(executable)
    try:
        executable.resolve().relative_to(package.resolve())
    except ValueError as error:
        raise PackageError("Portable command resolves outside the plugin package") from error
    _, protocol, tools = canonical_contract()
    frames = [
        {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": protocol, "capabilities": {}, "clientInfo": {"name": "package-verification", "version": "1"}}},
        {"jsonrpc": "2.0", "method": "notifications/initialized"},
        {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    ]
    # These methods neither load credentials nor call the local HTTP host.
    stdout, stderr = run([str(executable.resolve()), *server["args"]],
                         input=("\n".join(json.dumps(frame) for frame in frames) + "\n").encode())
    try:
        responses = [json.loads(line) for line in stdout.splitlines()]
        if len(responses) != 2 or stderr or [response["id"] for response in responses] != [1, 2] or any(response["jsonrpc"] != "2.0" for response in responses):
            raise ValueError("Unexpected stdio frames")
        if responses[0]["result"]["protocolVersion"] != protocol or responses[1]["result"]["tools"] != tools:
            raise ValueError("Embedded MCP contract differs from canonical source")
    except (ValueError, KeyError, TypeError) as error:
        raise PackageError("Extracted package failed MCP initialize/tools/list verification") from error
    return {"methods": ["initialize", "tools/list"], "protocolVersion": protocol,
            "tools": [tool["name"] for tool in tools], "canonicalSchemasMatch": True,
            "authorizationOrRequestCalls": 0}


def archive_package(package, archive):
    files = sorted(path for path in package.rglob("*") if path.is_file())
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as output:
        for path in files:
            regular(path)
            entry = zipfile.ZipInfo(path.relative_to(package).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = (stat.S_IFREG | stat.S_IMODE(path.stat().st_mode)) << 16
            output.writestr(entry, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED)
    return {path.relative_to(package).as_posix(): digest(path) for path in files}


def verify_archive(archive, destination, expected):
    with zipfile.ZipFile(archive) as source:
        names = source.namelist()
        if len(set(names)) != len(names) or set(names) != set(expected):
            raise PackageError("ZIP file list does not match the package allowlist")
        for entry in source.infolist():
            relative = Path(entry.filename)
            mode = entry.external_attr >> 16
            if relative.is_absolute() or ".." in relative.parts or not stat.S_ISREG(mode):
                raise PackageError("ZIP contains an unsafe entry")
            path = destination / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(source.read(entry))
            path.chmod(stat.S_IMODE(mode))
            if digest(path) != expected[entry.filename]:
                raise PackageError("ZIP contents differ from the staged package")


def build(binary, output, account=None, fixture_port=None, connect_app=None):
    binary, output = Path(binary).absolute(), Path(output).absolute()
    if output.exists() or output.is_symlink():
        raise PackageError("Output must not already exist; existing files are never replaced")
    if not output.parent.is_dir():
        raise PackageError("Output parent directory must exist")
    plugin, mcp, account, port = manifests(account, fixture_port)
    openai = plugin["extensions"]["com.openai"]
    if connect_app is None:
        # The optional GUI is the setup skill's only connection surface.
        openai.pop("onboardingSkill", None)
    elif openai.get("onboardingSkill") != "./skills/setup/SKILL.md":
        raise PackageError("GUI package must declare its bundled setup onboarding skill")
    binary_info = inspect_executable(binary)
    gui_info, gui_files = None, []
    if connect_app is not None:
        connect_app = Path(connect_app).absolute()
        gui_files, gui_executable = app_files(connect_app, account, port)
        inspect_signature(connect_app)
        gui_info = inspect_executable(gui_executable)
        if gui_info["architectures"] != binary_info["architectures"]:
            raise PackageError("Connect app and stdio executable architectures must match")
        if designated_requirement(connect_app) != designated_requirement(binary):
            raise PackageError("Connect app and stdio client must have the same designated signing requirement for Keychain access")
        gui_info["sameDesignatedRequirementAsCLI"] = True
    with tempfile.TemporaryDirectory(prefix=".agentdeck-package-", dir=output.parent) as temporary:
        staging = Path(temporary) / "staging"
        package = staging / "plugins" / plugin["name"]
        package.mkdir(parents=True)
        write_json(package / "plugin.json", plugin)
        write_json(package / "mcp.json", mcp)
        copies = {"bin/agentdeck-local": binary,
                  "skills/agentdeck-report/SKILL.md": HERE.parent / "skills/agentdeck-report/SKILL.md",
                  "LICENSE": ROOT / "LICENSE"}
        if connect_app is not None:
            copies.update({f"{APP_NAME}/{name}": connect_app / name for name in gui_files})
            copies["OFL-IBMPlexSansKR.txt"] = TEMPLATE / "OFL-IBMPlexSansKR.txt"
            copies["skills/setup/SKILL.md"] = TEMPLATE / "skills/setup/SKILL.md"
        for relative, source in copies.items():
            regular(source)
            destination = package / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, destination)
            destination.chmod(0o755 if relative == "bin/agentdeck-local" or "/Contents/MacOS/" in relative else 0o644)
        command = f'./bin/agentdeck-local {{action}} --account {account} --port {port}'
        connect = (f'Open `{APP_NAME}` in Finder and choose **Connect**. The app uses the signed connection profile above.' if gui_info else
                   'This package has no connection GUI. From the plugin folder, explicitly run:\n\n```sh\n' + command.format(action="authorize") + '\n```')
        disconnect = (f'Open `{APP_NAME}` and choose **Disconnect** before removing the plugin.' if gui_info else
                      'From the same plugin folder, revoke the grant before removing the plugin:\n\n```sh\n' + command.format(action="disconnect") + '\n```')
        minimum = max([binary_info["minimumMacOS"]] + ([gui_info["minimumMacOS"]] if gui_info else []), key=lambda value: tuple(map(int, value.split("."))))
        substitutions = {"MINIMUM_OS": minimum, "ARCHITECTURES": ", ".join(binary_info["architectures"]),
                         "PROFILE": "isolated fixture" if fixture_port is not None else "local host default",
                         "PORT": str(port), "ACCOUNT": account, "CONNECT_INSTRUCTIONS": connect,
                         "DISCONNECT_INSTRUCTIONS": disconnect}
        readme = (TEMPLATE / "README.md").read_text()
        for key, value in substitutions.items():
            readme = readme.replace("{{" + key + "}}", value)
        (package / "README.md").write_text(readme)
        marketplace = {"name": plugin["name"] + "-staging", "interface": {"displayName": plugin["extensions"]["com.openai"]["interface"]["displayName"] + " Staging"},
                       "plugins": [{"name": plugin["name"], "source": {"source": "local", "path": "./plugins/" + plugin["name"]},
                                    "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"}, "category": "Productivity"}]}
        write_json(staging / ".agents/plugins/marketplace.json", marketplace)
        archive = staging / (plugin["name"] + ".zip")
        files = archive_package(package, archive)
        extracted = Path(temporary) / "extracted"
        verify_archive(archive, extracted, files)
        if inspect_executable(extracted / "bin/agentdeck-local") != binary_info:
            raise PackageError("Extracted executable identity changed")
        if gui_info:
            inspect_signature(extracted / APP_NAME)
        discovery = probe(extracted)
        evidence = {"plugin": plugin["name"], "profile": substitutions["PROFILE"], "account": account, "port": port,
                    "binary": binary_info, "connectApp": gui_info, "stdio": discovery,
                    "zipSHA256": digest(archive), "files": files,
                    "notProven": ["Plugin installation or tool exposure in Dot", "GUI consent and Keychain lifecycle from this installed package",
                                  "Notarization and clean-user Gatekeeper acceptance", "Public partner eligibility or review approval"]}
        write_json(staging / "package-evidence.json", evidence)
        output.mkdir()  # exclusive creation; never replace an existing output
        for child in staging.iterdir():
            shutil.move(str(child), output / child.name)
    return evidence


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", type=Path, required=True, help="Already Developer ID-signed hardened native executable")
    parser.add_argument("--output", type=Path, required=True, help="New staging/marketplace directory; parent must exist")
    parser.add_argument("--account", help="Nonsecret Keychain account selector (default is separate for each profile)")
    parser.add_argument("--fixture-port", type=int, help="Separate experimental host port; changes plugin and marketplace identity")
    parser.add_argument("--connect-app", type=Path, help="Optional already signed Connect .app with matching account and port")
    args = parser.parse_args()
    try:
        evidence = build(args.binary, args.output, args.account, args.fixture_port, args.connect_app)
    except (PackageError, OSError, ValueError) as error:
        print(f"Package not created: {error}", file=sys.stderr)
        return 1
    print(json.dumps({"output": str(args.output.absolute()), "plugin": evidence["plugin"], "zipSHA256": evidence["zipSHA256"],
                      "architectures": evidence["binary"]["architectures"], "tools": evidence["stdio"]["tools"],
                      "connectGUIBundled": evidence["connectApp"] is not None, "installed": False}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
