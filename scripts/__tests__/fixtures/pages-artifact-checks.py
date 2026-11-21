import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo

spec = importlib.util.spec_from_file_location(
    "restore_pages", Path(__file__).resolve().parents[2] / "restore-pages-data.py",
)
pages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pages)

REPOSITORY = "owner/project"
REPOSITORY_ID = 20
RUN_ID = 31
ATTEMPT = 2
SHA = "a" * 40


class PagesArtifactChecks(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.run = {
            "id": RUN_ID, "run_attempt": ATTEMPT, "event": "push",
            "path": ".github/workflows/ci.yml", "status": "completed",
            "head_branch": "master", "head_sha": SHA, "conclusion": "success",
            "repository": {"id": REPOSITORY_ID}, "head_repository": {"id": REPOSITORY_ID},
        }
        self.source = {
            "id": RUN_ID, "head_branch": "master", "head_sha": SHA,
            "repository_id": REPOSITORY_ID, "head_repository_id": REPOSITORY_ID,
        }
        self.artifacts = []
        self.archives = {}

    def artifact(self, name, files):
        artifact_id = len(self.artifacts) + 1
        path = self.root / f"{artifact_id}.zip"
        with ZipFile(path, "w") as archive:
            for key, data in files.items():
                archive.writestr(key, data)
        artifact = {
            "name": name, "id": artifact_id, "workflow_run": self.source.copy(), "expired": False,
            "size_in_bytes": path.stat().st_size,
            "digest": f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}",
        }
        self.artifacts.append(artifact)
        self.archives[artifact_id] = path
        return artifact, path

    def outcomes(self, **overrides):
        values = {"sha": SHA, "vitest": "success", "e2e": "success", "android": "skipped"}
        values.update(overrides)
        self.artifact("report-outcomes-2", {"suites.json": json.dumps(values)})

    def restore(self):
        def api(endpoint, *_flags):
            if endpoint.endswith("/attempts/2"):
                return self.run
            return [{"artifacts": self.artifacts}]

        def download(command, *, stdout, **_options):
            self.assertEqual(command[:2], ["gh", "api"])
            artifact_id = int(command[2].split("/")[-2])
            stdout.write(self.archives[artifact_id].read_bytes())

        with patch.object(pages, "api", side_effect=api), patch.object(pages.subprocess, "run", side_effect=download):
            pages.restore(self.root / "data", REPOSITORY, REPOSITORY_ID, RUN_ID, ATTEMPT, SHA, self.root / "outputs")

    def test_current_attempt_restores_only_report_data(self):
        self.outcomes(android="success")
        self.artifact("pages-report-data-1", {"ignored.js": "prior attempt"})
        self.artifact("pages-report-data-2", {name: "{}" for name in pages.REPORT_FILES})
        self.artifact("pages-android-results-2", {"TEST-dev.agentdeck.Sample.xml": "<testsuite />"})
        self.restore()
        self.assertTrue((self.root / "data" / "test-report" / "vitest.json").is_file())
        self.assertTrue((self.root / "data" / "android" / "TEST-dev.agentdeck.Sample.xml").is_file())
        self.assertIn("android=success", (self.root / "outputs").read_text())

    def test_foreign_or_pull_request_run_fails_before_downloading(self):
        for field, value in (
            ("event", "pull_request"), ("path", ".github/workflows/other.yml"), ("head_sha", "b" * 40),
            ("head_repository", {"id": 99}), ("run_attempt", 1),
        ):
            with self.subTest(field=field):
                wrong_run = {**self.run, field: value}
                with self.assertRaisesRegex(ValueError, "producer"):
                    pages.verify_run(wrong_run, REPOSITORY_ID, RUN_ID, ATTEMPT, SHA)

    def test_stale_or_mismatched_artifact_is_rejected(self):
        self.outcomes()
        artifact, _ = self.artifact("pages-report-data-1", {"coverage-summary.json": "{}"})
        with self.assertRaisesRegex(ValueError, "expected one pages-report-data-2"):
            self.restore()
        artifact["name"] = "pages-report-data-2"
        artifact["workflow_run"]["head_sha"] = "b" * 40
        with self.assertRaisesRegex(ValueError, "provenance"):
            pages.select_artifact(self.artifacts, artifact["name"], REPOSITORY_ID, RUN_ID, SHA, required=True)

    def test_digest_must_match_before_opening_archive(self):
        artifact, path = self.artifact("data", {"coverage-summary.json": "{}"})
        artifact["digest"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            pages.validate_archive(path, artifact, pages.REPORT_FILES.__contains__)

    def test_rejects_executables_unexpected_paths_and_non_regular_files(self):
        symlink = ZipInfo("coverage-summary.json")
        symlink.create_system = 3
        symlink.external_attr = stat.S_IFLNK << 16
        for name in ("bridge/dist/main.js", "../coverage-summary.json", symlink):
            with self.subTest(name=name):
                metadata, path = self.artifact("data", {name: "{}"})
                with self.assertRaisesRegex(ValueError, "unexpected"):
                    pages.validate_archive(path, metadata, pages.REPORT_FILES.__contains__)

    def test_success_requires_each_promised_output(self):
        self.outcomes()
        self.artifact("pages-report-data-2", {"test-report/vitest.json": "{}"})
        with self.assertRaisesRegex(ValueError, "missing reports for successful vitest"):
            self.restore()

    def test_failed_suites_can_publish_without_reports(self):
        self.outcomes(vitest="failure", e2e="", android="failure")
        self.restore()
        self.assertIn("vitest=failure", (self.root / "outputs").read_text())
        self.assertEqual(list((self.root / "data" / "test-report").iterdir()), [])


if __name__ == "__main__":
    unittest.main()
