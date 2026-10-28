"""Runtime diagnostic regressions using synthetic processes, never Codex or OAuth."""

from contextlib import redirect_stdout
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import verify_plugin_runtime as diagnostic


PLUGIN = "agentdeck-native-preview@test-marketplace"
SERVER = "agentdeck-native-preview"


@unittest.skipUnless(hasattr(os, "killpg"), "Native diagnostic uses POSIX process groups")
class ProcessTests(unittest.TestCase):
    def process(self, source, timeout=3, limit=4096):
        return diagnostic.BoundedProcess([sys.executable, "-u", "-c", source], time.monotonic() + timeout, limit)

    def test_fragmented_frames_preserve_utf8_and_ignore_notifications(self):
        source = """
import json,sys,time
sys.stdout.write(json.dumps({'method':'notice','params':{'unrelated':'not evidence'}})+'\\n');sys.stdout.flush()
data=(json.dumps({'id':1,'result':{'value':'안녕'}},ensure_ascii=False)+'\\n').encode()
split=data.index('안'.encode())+1
sys.stdout.buffer.write(data[:split]);sys.stdout.flush();time.sleep(0.02)
sys.stdout.buffer.write(data[split:]);sys.stdout.flush()
sys.stderr.write('unrelated diagnostic content')
"""
        with self.process(source) as process:
            self.assertEqual(process.response(1), {"value": "안녕"})
        self.assertIsNotNone(process.process.poll())

    def test_wrong_response_id_is_not_accepted(self):
        with self.process("print('{\"id\":true,\"result\":{}}')") as process:
            with self.assertRaisesRegex(diagnostic.DiagnosticError, "response_id_mismatch"):
                process.response(1)

    def test_approval_request_is_never_answered(self):
        with self.process("print('{\"id\":1,\"method\":\"requestApproval\",\"params\":{}}')") as process:
            with self.assertRaisesRegex(diagnostic.DiagnosticError, "unexpected_server_request"):
                process.response(1)

    def test_partial_eof_is_unknown_instead_of_success(self):
        with self.process("import sys;sys.stdout.write('{\"id\":1')") as process:
            with self.assertRaisesRegex(diagnostic.DiagnosticError, "process_exited_or_incomplete_frame"):
                process.response(1)

    def test_timeout_terminates_the_owned_process(self):
        with self.process("import time;time.sleep(30)", timeout=0.1) as process:
            with self.assertRaisesRegex(diagnostic.DiagnosticError, "timeout"):
                process.response(1)
        self.assertIsNotNone(process.process.poll())

    def test_both_output_streams_have_cumulative_limits(self):
        for stream in ("stdout", "stderr"):
            with self.subTest(stream=stream):
                with self.process(f"import sys,time;sys.{stream}.write('x'*4096);sys.{stream}.flush();time.sleep(30)", limit=128) as process:
                    with self.assertRaisesRegex(diagnostic.DiagnosticError, "output_limit"):
                        process.response(1)
                self.assertIsNotNone(process.process.poll())

    def test_cleanup_keeps_an_unrelated_process_alive(self):
        unrelated = subprocess.Popen([sys.executable, "-c", "import time;time.sleep(30)"])
        try:
            with self.process("import time;time.sleep(30)") as process:
                self.assertEqual(os.getpgid(process.process.pid), process.process.pid)
                self.assertNotEqual(os.getpgid(unrelated.pid), process.process.pid)
            self.assertIsNotNone(process.process.poll())
            self.assertIsNone(unrelated.poll())
        finally:
            unrelated.terminate()
            unrelated.wait(timeout=2)


class IdentityTests(unittest.TestCase):
    def setUp(self):
        _, _, self.expected = diagnostic.canonical_contract()
        self.result = {"data": [{"name": SERVER, "pluginId": PLUGIN, "runtimeStatus": None,
            "authStatus": "unsupported", "toolsError": None,
            "tools": {tool["name"]: copy.deepcopy(tool) for tool in self.expected}}], "nextCursor": None}

    def test_exact_plugin_and_schema_pass_without_claiming_oauth(self):
        result = diagnostic.validate_inventory(self.result, PLUGIN, SERVER, self.expected)
        self.assertTrue(result["pluginIdentityMatches"])
        self.assertTrue(result["canonicalInputSchemasMatch"])
        self.assertNotIn("authStatus", result)

    def test_same_tools_from_a_different_plugin_or_server_are_rejected(self):
        for key, value in [("pluginId", "foreign@other-marketplace"), ("name", "foreign-server")]:
            with self.subTest(key=key):
                changed = copy.deepcopy(self.result)
                changed["data"][0][key] = value
                with self.assertRaisesRegex(diagnostic.DiagnosticError, "runtime_plugin_identity_mismatch"):
                    diagnostic.validate_inventory(changed, PLUGIN, SERVER, self.expected)

    def test_missing_tool_and_different_input_schema_are_rejected(self):
        changed = copy.deepcopy(self.result)
        del changed["data"][0]["tools"]["get_context"]
        with self.assertRaisesRegex(diagnostic.DiagnosticError, "runtime_tool_set_mismatch"):
            diagnostic.validate_inventory(changed, PLUGIN, SERVER, self.expected)
        changed = copy.deepcopy(self.result)
        changed["data"][0]["tools"]["get_context"]["inputSchema"] = {"type": "string"}
        with self.assertRaisesRegex(diagnostic.DiagnosticError, "runtime_tool_schema_mismatch"):
            diagnostic.validate_inventory(changed, PLUGIN, SERVER, self.expected)

    def test_tool_error_and_foreign_rows_are_not_returned_as_payloads(self):
        self.result["data"][0]["toolsError"] = "unrelated sensitive diagnostic"
        with self.assertRaises(diagnostic.DiagnosticError) as error:
            diagnostic.validate_inventory(self.result, PLUGIN, SERVER, self.expected)
        self.assertEqual(str(error.exception), "tool_discovery_failed")
        self.result["data"].append({"name": "foreign", "tools": {}})
        with self.assertRaisesRegex(diagnostic.DiagnosticError, "server_inventory_incomplete_or_absent"):
            diagnostic.validate_inventory(self.result, PLUGIN, SERVER, self.expected)

    def test_version_matched_schema_must_support_server_filter(self):
        def generate(properties):
            def output(arguments, _deadline):
                target = Path(arguments[-1]) / "ListMcpServerStatusParams.json"
                target.write_text(json.dumps({"properties": properties}))
                return b""
            return output
        with patch.object(diagnostic, "command_output", side_effect=generate({"detail": {}})):
            with self.assertRaisesRegex(diagnostic.DiagnosticError, "server_filter_unsupported"):
                diagnostic.verify_filter_support(Path("/synthetic/codex"), time.monotonic() + 1)
        with patch.object(diagnostic, "command_output", side_effect=generate({"serverName": {}, "detail": {}})):
            diagnostic.verify_filter_support(Path("/synthetic/codex"), time.monotonic() + 1)

    def test_cached_manifest_must_match_installed_plugin_identity(self):
        listing = {"installed": [{"pluginId": PLUGIN, "name": SERVER, "marketplaceName": "test-marketplace",
            "version": "0.1.1", "installed": True, "enabled": True},
            {"pluginId": "foreign@other-marketplace", "name": "foreign", "installed": True}]}
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            cache = home / "plugins/cache/test-marketplace" / SERVER / "0.1.1"
            (cache / "bin").mkdir(parents=True)
            binary = cache / "bin/agentdeck-local"
            binary.write_bytes(b"synthetic executable"); binary.chmod(0o755)
            (cache / "mcp.json").write_text(json.dumps({"mcpServers": {SERVER: {"type": "stdio", "command": "./bin/agentdeck-local"}}}))
            manifest = cache / "plugin.json"
            manifest.write_text(json.dumps({"name": SERVER, "version": "0.1.1"}))
            with patch.object(diagnostic, "command_output", return_value=json.dumps(listing).encode()) as command:
                result = diagnostic.installed_manifest(Path("/synthetic/codex"), PLUGIN, SERVER, 0, home)
                command.assert_called_once_with(["/synthetic/codex", "plugin", "list", "--json"], 0)
                self.assertEqual(result["manifestSHA256"], hashlib.sha256(manifest.read_bytes()).hexdigest())
                manifest.write_text(json.dumps({"name": "foreign", "version": "0.1.1"}))
                with self.assertRaisesRegex(diagnostic.DiagnosticError, "cached_manifest_identity_mismatch"):
                    diagnostic.installed_manifest(Path("/synthetic/codex"), PLUGIN, SERVER, 0, home)


    def test_global_registry_failure_stops_before_runtime_and_exposes_no_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            codex = Path(directory) / "codex"
            codex.write_text("synthetic executable"); codex.chmod(0o755)
            arguments = ["verify_plugin_runtime.py", "--codex", str(codex),
                         "--plugin-id", PLUGIN, "--server-name", SERVER]
            output = io.StringIO()
            with patch.object(sys, "argv", arguments), \
                 patch.object(diagnostic, "verify_filter_support"), \
                 patch.object(diagnostic, "command_output", side_effect=[
                     b"codex-cli 0.164.0\n", diagnostic.DiagnosticError("cli_command_failed")]) as command, \
                 patch.object(diagnostic, "inspect_runtime") as runtime, redirect_stdout(output):
                self.assertEqual(diagnostic.main(), 1)
            self.assertEqual(command.call_args_list[-1].args[0],
                             [str(codex), "plugin", "list", "--json"])
            runtime.assert_not_called()
            result = json.loads(output.getvalue())
            self.assertEqual(result["status"], "unknown")
            self.assertEqual(result["reason"], "plugin_registry_unavailable")
            self.assertNotIn("tools", result)


if __name__ == "__main__":
    unittest.main()
