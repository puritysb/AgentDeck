#!/usr/bin/env python3
"""Read Build Health data from the exact GitHub Actions CI attempt."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
from tempfile import TemporaryDirectory
from xml.etree import ElementTree
from zipfile import BadZipFile, ZipFile

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_DATA_BYTES = 128 * 1024 * 1024
MAX_FILES = 2048
SUITES = ("vitest", "e2e", "android")
OUTCOMES = {"success", "failure", "cancelled", "skipped", ""}
REPORT_FILES = {"coverage-summary.json", "test-report/vitest.json", "test-report/e2e.json"}
ANDROID_XML = re.compile(r"TEST-[\w.$-]+\.xml", re.ASCII)


def api(endpoint, *flags):
    return json.loads(subprocess.check_output(["gh", "api", endpoint, *flags], timeout=60))


def verify_run(run, repository_id, run_id, attempt, revision):
    expected = {
        "id": run_id,
        "run_attempt": attempt,
        "event": "push",
        "path": ".github/workflows/ci.yml",
        "status": "completed",
        "head_branch": "master",
        "head_sha": revision,
    }
    if (
        any(run.get(key) != value for key, value in expected.items())
        or run.get("conclusion") == "cancelled"
        or run["repository"]["id"] != repository_id
        or run["head_repository"]["id"] != repository_id
    ):
        raise ValueError("producer is not the expected completed master CI push attempt")


def select_artifact(artifacts, name, repository_id, run_id, revision, *, required):
    matches = [artifact for artifact in artifacts if artifact["name"] == name]
    if not matches and not required:
        return None
    if len(matches) != 1:
        raise ValueError(f"expected one {name} artifact, found {len(matches)}")
    artifact = matches[0]
    source = artifact["workflow_run"]
    if (
        source["id"] != run_id
        or source["head_sha"] != revision
        or source["head_branch"] != "master"
        or source["repository_id"] != repository_id
        or source["head_repository_id"] != repository_id
        or artifact["expired"] is not False
        or not 0 < artifact["size_in_bytes"] <= MAX_ARCHIVE_BYTES
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", artifact.get("digest") or "")
    ):
        raise ValueError(f"unexpected provenance, size or digest for {name}")
    return artifact


def validate_archive(path, artifact, allowed_name):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    if path.stat().st_size != artifact["size_in_bytes"] or f"sha256:{digest.hexdigest()}" != artifact["digest"]:
        raise ValueError(f"archive size or digest mismatch for {artifact['name']}")

    with ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_FILES or sum(entry.file_size for entry in entries) > MAX_DATA_BYTES:
            raise ValueError(f"archive exceeds data limits for {artifact['name']}")
        names = set()
        files = {}
        for entry in entries:
            name = entry.orig_filename
            kind = stat.S_IFMT(entry.external_attr >> 16)
            if (
                name in names
                or name != entry.filename
                or not allowed_name(name)
                or kind not in (0, stat.S_IFDIR if entry.is_dir() else stat.S_IFREG)
            ):
                raise ValueError(f"archive contains an unexpected, duplicate or non-regular entry: {name!r}")
            names.add(name)
            if not entry.is_dir():
                files[name] = archive.read(entry)
        return files


def require_json_object(data):
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("expected a JSON object")
    return value


def restore(destination, repository, repository_id, run_id, attempt, revision, output):
    repo = f"repos/{repository}"
    run_endpoint = f"{repo}/actions/runs/{run_id}"
    verify_run(api(f"{run_endpoint}/attempts/{attempt}"), repository_id, run_id, attempt, revision)
    artifacts = [
        artifact
        for page in api(f"{run_endpoint}/artifacts?per_page=100", "--paginate", "--slurp")
        for artifact in page["artifacts"]
    ]
    destination.mkdir(exist_ok=False)

    with TemporaryDirectory(prefix="agentdeck-pages-", dir=destination.parent) as scratch:
        def read(prefix, allowed_name, *, required):
            name = f"{prefix}-{attempt}"
            artifact = select_artifact(artifacts, name, repository_id, run_id, revision, required=required)
            if artifact is None:
                return {}
            archive = Path(scratch) / f"{prefix}.zip"
            with archive.open("wb") as stream:
                subprocess.run(
                    ["gh", "api", f"{repo}/actions/artifacts/{int(artifact['id'])}/zip"],
                    stdout=stream, check=True, timeout=120,
                )
            result = validate_archive(archive, artifact, allowed_name)
            print(f"Verified {name} from CI run {run_id}, attempt {attempt}")
            return result

        manifest = read("report-outcomes", lambda name: name == "suites.json", required=True)
        outcomes = require_json_object(manifest["suites.json"])
        if outcomes.get("sha") != revision or any(outcomes.get(suite) not in OUTCOMES for suite in SUITES):
            raise ValueError("invalid suite outcomes for the producer revision")

        reports = read(
            "pages-report-data", lambda name: name == "test-report/" or name in REPORT_FILES,
            required=any(outcomes[suite] == "success" for suite in ("vitest", "e2e")),
        )
        for suite, expected_files in {
            "vitest": {"coverage-summary.json", "test-report/vitest.json"},
            "e2e": {"test-report/e2e.json"},
        }.items():
            if outcomes[suite] == "success" and not expected_files <= reports.keys():
                raise ValueError(f"missing reports for successful {suite} suite")
        for payload in reports.values():
            require_json_object(payload)

        android = {}
        if outcomes["android"] in ("success", "failure"):
            android = read(
                "pages-android-results", ANDROID_XML.fullmatch, required=outcomes["android"] == "success",
            )
            if outcomes["android"] == "success" and not android:
                raise ValueError("missing reports for successful Android suite")
            for payload in android.values():
                text = payload.decode("utf-8")
                if "<!DOCTYPE" in text or ElementTree.fromstring(text).tag != "testsuite":
                    raise ValueError("expected an Android JUnit testsuite without a DOCTYPE")

        (destination / "test-report").mkdir()
        (destination / "android").mkdir()
        for name, payload in reports.items():
            (destination / name).write_bytes(payload)
        for name, payload in android.items():
            (destination / "android" / name).write_bytes(payload)
        with output.open("a", encoding="utf-8") as stream:
            for suite in SUITES:
                stream.write(f"{suite}={outcomes[suite]}\n")


if __name__ == "__main__":
    try:
        restore(
            Path(sys.argv[1]), os.environ["GITHUB_REPOSITORY"], int(os.environ["GITHUB_REPOSITORY_ID"]),
            int(os.environ["PRODUCER_RUN_ID"]), int(os.environ["PRODUCER_ATTEMPT"]),
            os.environ["GITHUB_SHA"], Path(os.environ["GITHUB_OUTPUT"]),
        )
    except (ValueError, KeyError, OSError, BadZipFile, ElementTree.ParseError, subprocess.SubprocessError) as error:
        sys.exit(f"Pages CI data verification failed: {error}")
