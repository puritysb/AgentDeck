"""Portable package regression tests; no signing, Keychain, HTTP or installation."""

import importlib.util
import json
from pathlib import Path
import plistlib
import stat
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import package_plugin as package


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.binary = self.root / "signed-fixture"
        self.binary.write_bytes(b"synthetic executable fixture")
        self.binary.chmod(0o755)
        self.output = self.root / "package"
        self.inspect = patch.object(package, "inspect_executable", side_effect=lambda path: {
            "sha256": package.digest(path), "architectures": ["arm64"], "minimumMacOS": "13.0",
            "developerIDRequirementVerified": True, "hardenedRuntime": True})
        self.inspect.start()
        self.addCleanup(self.inspect.stop)
        self.signature = patch.object(package, "inspect_signature", return_value={})
        self.signature.start()
        self.addCleanup(self.signature.stop)
        self.requirement = patch.object(package, "designated_requirement", return_value="synthetic matching requirement")
        self.requirement.start()
        self.addCleanup(self.requirement.stop)

    def build(self, **kwargs):
        with patch.object(package, "probe", return_value={"tools": ["get_request"], "authorizationOrRequestCalls": 0}) as probe:
            result = package.build(self.binary, self.output, **kwargs)
            self.assertEqual(probe.call_count, 1)
        return result

    def app(self, account="plugin-native-preview", port=9476):
        app = self.root / "Source.app"
        (app / "Contents/MacOS").mkdir(parents=True)
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleExecutable": "agentdeck-connect",
            "AgentDeckConnectionAccount": account, "AgentDeckConnectionPort": port}))
        (app / "Contents/MacOS/agentdeck-connect").write_bytes(b"synthetic GUI executable")
        (app / "Contents/MacOS/agentdeck-connect").chmod(0o755)
        (app / "Contents/Resources/Fonts").mkdir(parents=True)
        (app / "Contents/Resources/design-tokens.css").write_text("/* synthetic token fixture */")
        for name in ("IBMPlexSansKR-Regular.ttf", "IBMPlexSansKR-Bold.ttf", "OFL-IBMPlexSansKR.txt"):
            (app / "Contents/Resources/Fonts" / name).write_bytes(b"synthetic font/license fixture")
        return app

    def test_default_package_has_only_reviewed_payload_and_portable_executable(self):
        (self.root / "auth-token").write_text("do not copy sibling credentials")
        result = self.build()
        payload = self.output / "plugins/agentdeck-native-preview"
        self.assertEqual(set(result["files"]), {"plugin.json", "mcp.json", "README.md", "LICENSE", "bin/agentdeck-local", "skills/agentdeck-report/SKILL.md"})
        self.assertEqual(package.digest(payload / "bin/agentdeck-local"), package.digest(self.binary))
        server = next(iter(package.read_json(payload / "mcp.json")["mcpServers"].values()))
        self.assertEqual(server["command"], "./bin/agentdeck-local")
        self.assertEqual(server["args"], ["serve", "--account", "plugin-native-preview"])
        plugin = package.read_json(payload / "plugin.json")
        self.assertNotIn("onboardingSkill", plugin["extensions"]["com.openai"])
        self.assertFalse((payload / "skills/setup/SKILL.md").exists())
        self.assertEqual(result["port"], package.canonical_contract()[0])
        self.assertIn("no connection GUI", (payload / "README.md").read_text())
        marketplace = package.read_json(self.output / ".agents/plugins/marketplace.json")
        self.assertEqual(marketplace["plugins"][0]["source"]["path"], "./plugins/agentdeck-native-preview")
        with zipfile.ZipFile(self.output / "agentdeck-native-preview.zip") as archive:
            self.assertEqual(set(archive.namelist()), set(result["files"]))
            self.assertEqual(stat.S_IMODE(archive.getinfo("bin/agentdeck-local").external_attr >> 16), 0o755)

    def test_fixture_has_distinct_identity_and_explicit_port(self):
        original = package.digest(package.HERE.parent / "mcp.json")
        result = self.build(account="scenario-test", fixture_port=19476)
        self.assertEqual(result["plugin"], "agentdeck-native-fixture-preview")
        payload = self.output / "plugins" / result["plugin"]
        server = next(iter(package.read_json(payload / "mcp.json")["mcpServers"].values()))
        self.assertEqual(server["args"], ["serve", "--account", "scenario-test", "--port", "19476"])
        self.assertIn("isolated fixture", (payload / "README.md").read_text())
        self.assertEqual(package.digest(package.HERE.parent / "mcp.json"), original)

    def test_existing_output_is_never_replaced(self):
        self.output.mkdir()
        marker = self.output / "keep"
        marker.write_text("existing work")
        with self.assertRaisesRegex(package.PackageError, "must not already exist"):
            package.build(self.binary, self.output)
        self.assertEqual(marker.read_text(), "existing work")

    def test_unsafe_account_and_production_fixture_ports_are_rejected(self):
        for value in ["../other", "account\nextra", "x" * 65]:
            with self.subTest(account=value), self.assertRaises(package.PackageError):
                package.manifests(value, None)
        for port in [1, 9120, 9139, 9476, 9477, 65536]:
            with self.subTest(port=port), self.assertRaises(package.PackageError):
                package.manifests(None, port)

    def test_symlink_binary_is_not_copied(self):
        alias = self.root / "alias"
        alias.symlink_to(self.binary)
        with self.assertRaisesRegex(package.PackageError, "non-symlink"):
            package.build(alias, self.output)
        self.assertFalse(self.output.exists())

    def test_gui_profile_mismatch_and_unreviewed_files_are_rejected(self):
        app = self.app()
        with self.assertRaisesRegex(package.PackageError, "exactly match"):
            package.app_files(app, "other-account", 9476)
        with self.assertRaisesRegex(package.PackageError, "exactly match"):
            package.app_files(app, "plugin-native-preview", 19476)
        (app / "Contents/embedded.provisionprofile").write_text("not a distribution resource")
        with self.assertRaisesRegex(package.PackageError, "Unexpected Connect app file"):
            package.build(self.binary, self.output, connect_app=app)
        self.assertFalse(self.output.exists())

    def test_matching_gui_preserves_signed_inputs_and_replaces_cli_setup_copy(self):
        app = self.app()
        original_info = (app / "Contents/Info.plist").read_bytes()
        result = self.build(connect_app=app)
        payload = self.output / "plugins" / result["plugin"]
        self.assertEqual((payload / package.APP_NAME / "Contents/Info.plist").read_bytes(), original_info)
        self.assertIsNotNone(result["connectApp"])
        self.assertEqual((payload / "OFL-IBMPlexSansKR.txt").read_bytes(), (package.TEMPLATE / "OFL-IBMPlexSansKR.txt").read_bytes())
        onboarding = package.read_json(payload / "plugin.json")["extensions"]["com.openai"]["onboardingSkill"]
        self.assertEqual(onboarding, "./skills/setup/SKILL.md")
        self.assertEqual((payload / onboarding).read_bytes(), (package.TEMPLATE / "skills/setup/SKILL.md").read_bytes())
        self.assertEqual(((payload / onboarding).parent / "../../AgentDeck Connect.app").resolve(), (payload / package.APP_NAME).resolve())
        self.assertIn("choose **Connect**", (payload / "README.md").read_text())
        self.assertNotIn("./bin/agentdeck-local authorize", (payload / "README.md").read_text())

    def test_gui_missing_required_design_resource_is_rejected(self):
        app = self.app()
        (app / "Contents/Resources/Fonts/IBMPlexSansKR-Regular.ttf").unlink()
        with self.assertRaisesRegex(package.PackageError, "incomplete"):
            package.app_files(app, "plugin-native-preview", 9476)

    def test_gui_with_different_keychain_signing_identity_is_rejected(self):
        app = self.app()
        with patch.object(package, "designated_requirement", side_effect=["GUI identity", "different CLI identity"]):
            with self.assertRaisesRegex(package.PackageError, "same designated signing requirement"):
                package.build(self.binary, self.output, connect_app=app)
        self.assertFalse(self.output.exists())

    def test_archive_tamper_is_detected_before_execution(self):
        archive = self.root / "changed.zip"
        with zipfile.ZipFile(archive, "w") as output:
            entry = zipfile.ZipInfo("bin/agentdeck-local")
            entry.external_attr = (stat.S_IFREG | 0o755) << 16
            output.writestr(entry, b"different bytes")
        with self.assertRaisesRegex(package.PackageError, "contents differ"):
            package.verify_archive(archive, self.root / "extracted", {"bin/agentdeck-local": package.digest(self.binary)})

    def test_archive_traversal_is_rejected(self):
        archive = self.root / "unsafe.zip"
        with zipfile.ZipFile(archive, "w") as output:
            entry = zipfile.ZipInfo("../outside")
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            output.writestr(entry, b"bad")
        with self.assertRaisesRegex(package.PackageError, "unsafe entry"):
            package.verify_archive(archive, self.root / "extracted", {"../outside": "unused"})
        self.assertFalse((self.root / "outside").exists())

    def test_probe_uses_discovery_only_and_detects_stale_embedded_schema(self):
        payload = self.root / "probe"
        _, mcp, _, _ = package.manifests(None, None)
        package.write_json(payload / "mcp.json", mcp)
        (payload / "bin").mkdir()
        (payload / "bin/agentdeck-local").write_bytes(self.binary.read_bytes())
        _, version, tools = package.canonical_contract()
        responses = [{"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": version}},
                     {"jsonrpc": "2.0", "id": 2, "result": {"tools": tools}}]
        with patch.object(package, "run", return_value=("\n".join(map(json.dumps, responses)), "")) as run:
            self.assertTrue(package.probe(payload)["canonicalSchemasMatch"])
            sent = [json.loads(line)["method"] for line in run.call_args.kwargs["input"].splitlines()]
            self.assertEqual(sent, ["initialize", "notifications/initialized", "tools/list"])
            self.assertEqual(run.call_args.args[0][0], str((payload / "bin/agentdeck-local").resolve()))
        responses[1]["result"]["tools"] = tools[:-1]
        with patch.object(package, "run", return_value=("\n".join(map(json.dumps, responses)), "")):
            with self.assertRaisesRegex(package.PackageError, "MCP initialize/tools/list"):
                package.probe(payload)

    def test_probe_rejects_nonportable_or_uncontained_commands_before_execution(self):
        payload = self.root / "invalid-command"
        _, mcp, _, _ = package.manifests(None, None)
        server = next(iter(mcp["mcpServers"].values()))
        for command in ["${PLUGIN_ROOT}/bin/agentdeck-local", "/tmp/agentdeck-local", "./../../agentdeck-local"]:
            with self.subTest(command=command):
                server["command"] = command
                package.write_json(payload / "mcp.json", mcp)
                with patch.object(package, "run") as run:
                    with self.assertRaisesRegex(package.PackageError, "contained portable command"):
                        package.probe(payload)
                    run.assert_not_called()


class ConnectBuildDependencyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("connect_build_regression", package.HERE / "ConnectApp/build.py")
        cls.builder = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.builder)

    def inspect(self, listing, universal=True):
        description = "Mach-O universal binary with 2 architectures" if universal else "Mach-O 64-bit executable arm64"
        with patch.object(self.builder, "run", side_effect=[description, listing]):
            self.builder.system_dependencies(Path("/review/agentdeck-connect"))

    def test_universal_system_dependencies_ignore_each_architecture_header(self):
        self.inspect(
            "/review/agentdeck-connect (architecture x86_64):\n"
            "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1359.0.0)\n"
            "/review/agentdeck-connect (architecture arm64):\n"
            "\t/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit (compatibility version 45.0.0, current version 2700.0.0)\n"
            "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1359.0.0)\n"
        )

    def test_universal_rejects_non_system_dependency_in_second_slice(self):
        with self.assertRaisesRegex(ValueError, r"^Non-system GUI dependency: /opt/local/lib/libextra\.dylib$"):
            self.inspect(
                "/review/agentdeck-connect (architecture x86_64):\n"
                "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1359.0.0)\n"
                "/review/agentdeck-connect (architecture arm64):\n"
                "\t/opt/local/lib/libextra.dylib (compatibility version 1.0.0, current version 1.0.0)\n"
                "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1359.0.0)\n"
            )

    def test_thin_system_dependencies_remain_supported(self):
        self.inspect(
            "/review/agentdeck-connect:\n"
            "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1359.0.0)\n",
            universal=False,
        )


if __name__ == "__main__":
    unittest.main()
