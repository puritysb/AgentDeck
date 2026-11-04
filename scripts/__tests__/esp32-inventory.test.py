"""Offline synthetic resolver/content tests; no package script or real credential executes."""
import importlib.util
import json
from pathlib import Path
import tempfile
import os
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("inventory", Path(__file__).parents[1] / "inventory-esp32-dependencies.py")
inventory = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(inventory)


class InventoryTests(unittest.TestCase):
    def test_inherited_environment_list_includes_test_and_shipping_targets(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "platformio.ini").write_text("[env]\nlib_deps = library@^1\n[env:one]\n[env:two]\n")
            self.assertEqual(inventory.environments(root), ["one", "two"])

    def test_different_platform_specs_cannot_share_framework_and_tool_paths(self):
        first = inventory.store_for_platform('/temporary', 'pioarduino-pinned-url')
        second = inventory.store_for_platform('/temporary', 'espressif32@^6.9.0')
        self.assertNotEqual(first, second)
        self.assertEqual(first, inventory.store_for_platform('/temporary', 'pioarduino-pinned-url'))
        a, b = inventory.isolated_store_environment(first), inventory.isolated_store_environment(second)
        for key in a:
            self.assertNotEqual(a[key], b[key])

    def test_dependency_graph_retains_transitives_cycles_and_framework_unknowns(self):
        graph = {"root": ["child"], "child": ["root", "WiFi"]}
        result = inventory.resolve_graph(["root"], lambda n: n if n in graph else None,
                                         lambda n: graph[n], lambda n: {"name": n, "version": "1.2.3"}, lambda n: n == "WiFi")
        self.assertEqual(len(result["packages"]), 2)
        self.assertEqual(len(result["edges"]), 3)
        self.assertEqual(result["frameworkReferences"][0]["resolution"], "framework-bundled; independent version unknown")

    def test_missing_transitive_fails_collection(self):
        with self.assertRaisesRegex(ValueError, "Unresolved dependency"):
            inventory.resolve_graph(["root"], lambda n: n if n == "root" else None,
                                    lambda n: ["missing"], lambda n: {"name": n, "version": "1"})

    def test_local_tool_alias_requires_exact_version_origin_and_same_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            core = Path(tmp)
            source = core / 'tools/tool-fixture'
            source.mkdir(parents=True)
            (source / 'source.py').write_text('synthetic tool source')
            installed = core / 'packages/tool-fixture'
            installed.parent.mkdir()
            installed.symlink_to(source)
            metadata = {'name': 'tool-fixture', 'version': '5.3.0', 'spec': {'uri': source.as_uri()}}
            inventory.validate_tool_alias('tool-fixture', '5.3.0', metadata, installed, core)
            with self.assertRaises(ValueError):
                inventory.validate_tool_alias('tool-fixture', '5.2.0', metadata, installed, core)
            with self.assertRaises(ValueError):
                inventory.validate_tool_alias('tool-fixture', '5.3.0', {**metadata, 'spec': {'uri': 'https://example.com/file'}}, installed, core)
            with self.assertRaises(ValueError):
                inventory.validate_tool_alias('tool-fixture', '5.3.0', metadata, core / 'other-cache', core)
            installed.unlink()
            installed.mkdir()
            (installed / 'source.py').write_text('changed source')
            with self.assertRaisesRegex(ValueError, 'content differs'):
                inventory.validate_tool_alias('tool-fixture', '5.3.0', metadata, installed, core)

    def test_unknown_version_and_conflicting_identity_fail(self):
        for version in [None, "", "None", "unknown", "unspecified"]:
            with self.assertRaises(ValueError):
                inventory.resolve_graph(["root"], lambda n: n, lambda n: [], lambda n: {"name": n, "version": version})
        with self.assertRaisesRegex(ValueError, "Ambiguous"):
            inventory.resolve_graph(["first", "second"], lambda n: n, lambda n: [], lambda n: {"name": "same", "version": "1", "source": n})

    def test_source_edits_affect_content_hash_even_when_manifest_is_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "package.json").write_text('{"name":"fixture","version":"1"}')
            (root / "source.c").write_text("original")
            first = inventory.tree_evidence(root)
            (root / "source.c").write_text("project-patched")
            second = inventory.tree_evidence(root)
            self.assertNotEqual(first["treeSha256"], second["treeSha256"])
            self.assertEqual(first["embeddedManifests"], second["embeddedManifests"])
            self.assertIn("unknown", second["embeddedManifests"][0]["versionMapping"])

    def test_empty_content_refused_and_external_symlink_not_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(ValueError, "Empty"):
                inventory.tree_evidence(root)
            (root / "external").symlink_to("/unreadable-secret-not-opened")
            self.assertEqual(inventory.tree_evidence(root)["files"], 1)

    def test_failed_resolution_replaces_stale_success_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp)
            (output / "receipt.json").write_text('{"status":"complete"}')
            # A fake adapter version reaches our injected failure before any install.
            import types
            with patch.dict("sys.modules", {"platformio": types.SimpleNamespace(__version__="6.1.19")}), patch.object(inventory, 'platform_request', return_value='fixture-platform'), patch.object(inventory, "install", side_effect=RuntimeError("fixture resolution failed")), patch.dict("os.environ", {}, clear=False):
                with self.assertRaisesRegex(RuntimeError, "fixture resolution failed"):
                    inventory.run(output, "ttgo")
            result = json.loads((output / "receipt.json").read_text())
            self.assertEqual(result["status"], "error")
            self.assertEqual(result["targets"], [])

    def test_inherited_store_and_sdk_overrides_are_isolated_and_restored(self):
        with tempfile.TemporaryDirectory() as tmp:
            import types
            overrides = {'PLATFORMIO_PACKAGES_DIR': '/not-the-users-store', 'IDF_TOOLS_PATH': '/not-the-users-sdk'}
            def inspect(project, name, log):
                self.assertTrue(os.environ['PLATFORMIO_PACKAGES_DIR'].startswith(str(project.parent)))
                self.assertTrue(os.environ['IDF_TOOLS_PATH'].startswith(str(project.parent)))
                raise RuntimeError('isolation verified')
            with patch.dict('sys.modules', {'platformio': types.SimpleNamespace(__version__='6.1.19')}), patch.object(inventory, 'platform_request', return_value='fixture-platform'), patch.dict('os.environ', overrides), patch.object(inventory, 'install', side_effect=inspect):
                with self.assertRaisesRegex(RuntimeError, 'isolation verified'):
                    inventory.run(Path(tmp), 'ttgo')
                for key, value in overrides.items():
                    self.assertEqual(os.environ[key], value)


if __name__ == "__main__":
    unittest.main()
