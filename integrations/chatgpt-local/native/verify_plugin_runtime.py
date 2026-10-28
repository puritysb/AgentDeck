#!/usr/bin/env python3
"""Opt-in local plugin-loader diagnosis; no installation, approval or tool calls."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import subprocess
import sys
import tempfile
import time

from package_plugin import canonical_contract

OUTPUT_LIMIT = 512 * 1024


class DiagnosticError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class BoundedProcess:
    """Drain both pipes, retain only bounded stdout, and own a separate process group."""
    def __init__(self, command, deadline, output_limit=OUTPUT_LIMIT):
        self.deadline, self.limit = deadline, output_limit
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, start_new_session=True)
        self.selector = selectors.DefaultSelector()
        self.counts = {"stdout": 0, "stderr": 0}
        self.buffer = bytearray()
        for name in self.counts:
            pipe = getattr(self.process, name)
            os.set_blocking(pipe.fileno(), False)
            self.selector.register(pipe, selectors.EVENT_READ, name)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise DiagnosticError("timeout")
        return remaining

    def pump(self):
        events = self.selector.select(min(self.remaining(), 0.1))
        for key, _ in events:
            data = os.read(key.fileobj.fileno(), min(65536, self.limit + 1))
            if not data:
                self.selector.unregister(key.fileobj)
                continue
            name = key.data
            self.counts[name] += len(data)
            if self.counts[name] > self.limit:
                raise DiagnosticError("output_limit")
            if name == "stdout":
                self.buffer.extend(data)
            # Do not retain or emit other MCP servers' stderr or payloads.

    def send(self, value):
        self.remaining()
        data = (json.dumps(value, separators=(",", ":")) + "\n").encode()
        if len(data) > 4096:
            raise DiagnosticError("request_limit")
        try:
            self.process.stdin.write(data)
            self.process.stdin.flush()
        except (BrokenPipeError, OSError):
            raise DiagnosticError("process_exited") from None

    def response(self, expected_id):
        while True:
            self.remaining()
            if b"\n" in self.buffer:
                line, _, remainder = self.buffer.partition(b"\n")
                self.buffer = bytearray(remainder)
                if not line.strip():
                    continue
                try:
                    value = json.loads(line)
                except (ValueError, UnicodeDecodeError):
                    raise DiagnosticError("invalid_json_frame") from None
                if not isinstance(value, dict):
                    raise DiagnosticError("invalid_rpc_frame")
                if "id" not in value:
                    if not isinstance(value.get("method"), str):
                        raise DiagnosticError("invalid_rpc_frame")
                    continue  # Notifications are not evidence and are not printed.
                if "method" in value:
                    raise DiagnosticError("unexpected_server_request")  # Never approve or elicit.
                if type(value["id"]) is not int or value["id"] != expected_id:
                    raise DiagnosticError("response_id_mismatch")
                if "error" in value:
                    raise DiagnosticError("rpc_error")
                if not isinstance(value.get("result"), dict):
                    raise DiagnosticError("invalid_rpc_result")
                return value["result"]
            if not self.selector.get_map():
                raise DiagnosticError("process_exited_or_incomplete_frame")
            self.pump()

    def collect(self):
        self.process.stdin.close()
        while self.selector.get_map():
            self.pump()
        try:
            code = self.process.wait(timeout=self.remaining())
        except subprocess.TimeoutExpired:
            raise DiagnosticError("timeout") from None
        if code != 0:
            raise DiagnosticError("cli_command_failed")
        return bytes(self.buffer)

    def close(self):
        if not self.process.stdin.closed:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        try:
            self.process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            pass
        # Only this newly created group is signalled, including inherited MCP children.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(self.process.pid, sig)
            except ProcessLookupError:
                pass
            try:
                self.process.wait(timeout=0.5)
            except subprocess.TimeoutExpired:
                continue
        self.selector.close()
        self.process.stdout.close()
        self.process.stderr.close()


def command_output(command, deadline):
    with BoundedProcess(command, deadline) as process:
        return process.collect()


def object_json(data):
    try:
        value = json.loads(data)
    except (ValueError, UnicodeDecodeError):
        raise DiagnosticError("invalid_json") from None
    if not isinstance(value, dict):
        raise DiagnosticError("invalid_json")
    return value


def read_small(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size > OUTPUT_LIMIT:
        raise DiagnosticError("manifest_unavailable")
    return path.read_bytes()


def verify_filter_support(codex, deadline):
    # The version-matched public schema prevents a silently ignored serverName
    # filter from querying unrelated MCP servers on older clients.
    with tempfile.TemporaryDirectory(prefix="agentdeck-runtime-schema-") as directory:
        command_output([str(codex), "app-server", "generate-json-schema", "--out", directory], deadline)
        matches = list(Path(directory).rglob("ListMcpServerStatusParams.json"))
        if len(matches) != 1:
            raise DiagnosticError("server_filter_support_unknown")
        schema = object_json(read_small(matches[0]))
        properties = schema.get("properties", {})
        if "serverName" not in properties or "detail" not in properties:
            raise DiagnosticError("server_filter_unsupported")


def installed_manifest(codex, plugin_id, server_name, deadline, codex_home):
    plugin_name, marketplace = plugin_id.split("@")
    # A scoped marketplace query can hide a broken registration elsewhere in the
    # global plugin registry. Require that registry to load before narrowing by ID.
    try:
        inventory = object_json(command_output(
            [str(codex), "plugin", "list", "--json"], deadline))
    except DiagnosticError as error:
        if error.code == "cli_command_failed":
            raise DiagnosticError("plugin_registry_unavailable") from None
        raise
    installed = inventory.get("installed")
    if not isinstance(installed, list):
        raise DiagnosticError("plugin_inventory_unknown")
    matches = [row for row in installed if isinstance(row, dict) and row.get("pluginId") == plugin_id]
    if len(matches) != 1 or matches[0].get("installed") is not True:
        raise DiagnosticError("plugin_not_installed")
    row = matches[0]
    if row.get("enabled") is not True:
        raise DiagnosticError("plugin_disabled")
    if row.get("name") != plugin_name or row.get("marketplaceName") != marketplace:
        raise DiagnosticError("plugin_identity_mismatch")
    version = row.get("version")
    if not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.+-]{0,63}", version) or ".." in version:
        raise DiagnosticError("plugin_version_unknown")
    cache = codex_home / "plugins/cache" / marketplace / plugin_name
    package = cache / version
    if not package.is_dir():
        package = cache / "local"  # Documented local-marketplace cache layout.
    manifest_bytes = read_small(package / "plugin.json")
    mcp_bytes = read_small(package / "mcp.json")
    manifest, mcp = object_json(manifest_bytes), object_json(mcp_bytes)
    if manifest.get("name") != plugin_name or manifest.get("version") != version:
        raise DiagnosticError("cached_manifest_identity_mismatch")
    server = mcp.get("mcpServers", {}).get(server_name)
    if not isinstance(server, dict) or server.get("type") != "stdio":
        raise DiagnosticError("cached_server_mismatch")
    if server.get("command") != "./bin/agentdeck-local":
        raise DiagnosticError("native_portable_command_invalid")
    executable = package / "bin/agentdeck-local"
    if executable.is_symlink() or not executable.is_file() or not os.access(executable, os.X_OK):
        raise DiagnosticError("bundled_executable_unavailable")
    return {"pluginVersion": version, "manifestSHA256": hashlib.sha256(manifest_bytes).hexdigest(),
            "mcpManifestSHA256": hashlib.sha256(mcp_bytes).hexdigest()}


def validate_inventory(result, plugin_id, server_name, expected_tools):
    rows = result.get("data")
    if not isinstance(rows, list) or len(rows) != 1 or result.get("nextCursor") is not None:
        raise DiagnosticError("server_inventory_incomplete_or_absent")
    row = rows[0]
    if not isinstance(row, dict) or row.get("name") != server_name or row.get("pluginId") != plugin_id:
        raise DiagnosticError("runtime_plugin_identity_mismatch")
    if row.get("toolsError") is not None:
        raise DiagnosticError("tool_discovery_failed")
    tools = row.get("tools")
    expected = {tool["name"]: tool for tool in expected_tools}
    if not isinstance(tools, dict) or set(tools) != set(expected):
        raise DiagnosticError("runtime_tool_set_mismatch")
    for name, definition in tools.items():
        if not isinstance(definition, dict) or definition.get("name") != name or definition.get("inputSchema") != expected[name]["inputSchema"]:
            raise DiagnosticError("runtime_tool_schema_mismatch")
    return {"tools": sorted(expected), "canonicalInputSchemasMatch": True, "pluginIdentityMatches": True}


def inspect_runtime(codex, plugin_id, server_name, deadline, expected_tools):
    with BoundedProcess([str(codex), "app-server", "--listen", "stdio://"], deadline) as process:
        process.send({"id": 1, "method": "initialize", "params": {
            "clientInfo": {"name": "agentdeck_local_plugin_diagnostic", "version": "0.1.0"}}})
        process.response(1)
        process.send({"method": "initialized", "params": {}})
        process.send({"id": 2, "method": "mcpServerStatus/list", "params": {
            "serverName": server_name, "detail": "toolsAndAuthOnly", "limit": 10}})
        return validate_inventory(process.response(2), plugin_id, server_name, expected_tools)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codex", type=Path, required=True, help="Absolute path to the CLI to diagnose, preferably the desktop-bundled CLI")
    parser.add_argument("--plugin-id", required=True, help="Exact installed name@marketplace identity")
    parser.add_argument("--server-name", required=True, help="Exact server key from this installed plugin's mcp.json")
    parser.add_argument("--timeout-seconds", type=float, default=30, help="Overall deadline, 1–60 seconds, plus bounded process cleanup")
    args = parser.parse_args()
    identifier = r"[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?"
    if not re.fullmatch(identifier + "@" + identifier, args.plugin_id) or ".." in args.plugin_id:
        parser.error("Use an exact kebab-case plugin-name@marketplace-name")
    if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", args.server_name):
        parser.error("Invalid server name")
    if not args.codex.is_absolute() or not args.codex.is_file() or not os.access(args.codex, os.X_OK):
        parser.error("--codex must name an existing absolute executable path")
    if not 1 <= args.timeout_seconds <= 60:
        parser.error("--timeout-seconds must be between 1 and 60")
    start = time.monotonic()
    deadline = start + args.timeout_seconds
    evidence = {"status": "unknown", "pluginId": args.plugin_id, "serverName": args.server_name,
                "cliPath": str(args.codex), "scope": "installed local plugin loader and MCP discovery only",
                "dotToolInheritanceProven": False, "authorizationOrToolCalls": 0}
    try:
        raw_version = command_output([str(args.codex), "--version"], deadline).decode()
        version = re.search(r"^codex-cli ([A-Za-z0-9.+_-]+)$", raw_version, re.M)
        if not version:
            raise DiagnosticError("cli_version_unknown")
        evidence["cliVersion"] = version[1]
        verify_filter_support(args.codex, deadline)
        home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
        evidence.update(installed_manifest(args.codex, args.plugin_id, args.server_name, deadline, home))
        _, _, expected = canonical_contract()
        evidence.update(inspect_runtime(args.codex, args.plugin_id, args.server_name, deadline, expected))
        evidence["status"] = "pass"
    except DiagnosticError as error:
        evidence["reason"] = error.code
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        evidence["reason"] = "diagnostic_unavailable"
    evidence["elapsedSeconds"] = round(time.monotonic() - start, 3)
    print(json.dumps(evidence, indent=2))
    return 0 if evidence["status"] == "pass" else 1


if __name__ == "__main__":
    sys.exit(main())
