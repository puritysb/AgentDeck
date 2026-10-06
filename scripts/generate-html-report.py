#!/usr/bin/env python3
"""
AgentDeck Build Health — HTML Generator

Reads Vitest + E2E JSON, Android JUnit XML, Robot output.xml, coverage-summary.json,
scripts/scenario-matrix.json and scripts/verification-catalog.json, and writes one
self-contained page in the Pages design language (aquarium-tide tokens only):
  - Latest run: result tiles + one card per suite (run here, or linked)
  - Verification tiers: the changed / quick / pre-release step matrix and the
    last recorded pre-release receipt (verification/receipts/)
  - What we verify: every gate, what it proves and does not prove, known gaps
  - Test domains: every test file grouped by the question it answers
  - Platforms (Android / Apple / ESP32 Robot), scenario matrix, coverage, history

Usage:
    python3 scripts/generate-html-report.py
    open coverage/test-report/index.html
"""

import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The BUILD_HEALTH_* overrides exist for scripts/__tests__/build-health-report.test.ts,
# which renders the page from fixtures into a temp directory and lints the output.
REPORT_DIR = Path(os.environ.get("BUILD_HEALTH_REPORT_DIR") or ROOT / "coverage" / "test-report")
VITEST_JSON = REPORT_DIR / "vitest.json"
COVERAGE_JSON = Path(os.environ.get("BUILD_HEALTH_COVERAGE_JSON") or ROOT / "coverage" / "coverage-summary.json")
ANDROID_XML_DIR = Path(os.environ.get("BUILD_HEALTH_ANDROID_DIR") or ROOT / "android" / "app" / "build" / "test-results" / "testDebugUnitTest")
SCENARIO_JSON = ROOT / "scripts" / "scenario-matrix.json"
CATALOG_JSON = ROOT / "scripts" / "verification-catalog.json"
VITEST_CONFIG = ROOT / "vitest.config.ts"
E2E_JSON = REPORT_DIR / "e2e.json"
ROBOT_XML = REPORT_DIR / "robot" / "output.xml"
HISTORY_JSON = REPORT_DIR / "history.json"
METADATA_JSON = REPORT_DIR / "run-metadata.json"
SUMMARY_JSON = REPORT_DIR / "summary.json"
OUTPUT_HTML = REPORT_DIR / "index.html"
# Latest hosted run per workflow, fetched by scripts/fetch-workflow-status.mjs in
# test-report.yml. Absent locally and in fixtures: then nothing is claimed.
WORKFLOW_STATUS_JSON = REPORT_DIR / "workflow-status.json"
# Pre-release receipts committed by `pnpm verify:full --record`.
RECEIPTS_DIR = Path(os.environ.get("BUILD_HEALTH_RECEIPTS_DIR") or ROOT / "verification" / "receipts")
# The receipt of the local verify run that is rendering this page, if any.
THIS_RUN_RECEIPT = os.environ.get("BUILD_HEALTH_RECEIPT")

# ===== Data collection =====

def load_vitest():
    if not VITEST_JSON.exists():
        return None
    with open(VITEST_JSON) as f:
        return json.load(f)

def load_e2e():
    """`pnpm test:e2e` JSON (vitest reporter format), when the run produced one."""
    if not E2E_JSON.exists():
        return None
    try:
        with open(E2E_JSON) as f:
            return json.load(f)
    except (json.JSONDecodeError, ValueError):
        return None

def merge_e2e(vitest, e2e):
    """Fold the E2E files into the per-file views (their own domain tab), keeping totals honest."""
    if not e2e:
        return vitest
    if not vitest:
        return e2e
    merged = dict(vitest)
    merged["testResults"] = list(vitest.get("testResults", [])) + list(e2e.get("testResults", []))
    for key in ("numPassedTests", "numFailedTests", "numTotalTests", "numPendingTests", "numTodoTests"):
        merged[key] = vitest.get(key, 0) + e2e.get(key, 0)
    return merged

def _load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError, ValueError):
        return default

def load_workflow_status():
    """{workflow path: latest completed run} — empty when it was not fetched."""
    data = _load_json(WORKFLOW_STATUS_JSON, {})
    return data.get("workflows", {}) if isinstance(data, dict) else {}

def load_recorded_receipt():
    """The newest committed pre-release receipt, or None."""
    if not RECEIPTS_DIR.is_dir():
        return None
    receipts = [r for r in (_load_json(p, None) for p in sorted(RECEIPTS_DIR.glob("*.json"))) if isinstance(r, dict) and r.get("steps")]
    return max(receipts, key=lambda r: r.get("finished_at", "")) if receipts else None

def load_this_run_receipt():
    return _load_json(THIS_RUN_RECEIPT, None) if THIS_RUN_RECEIPT else None

def load_coverage():
    if not COVERAGE_JSON.exists():
        return None
    with open(COVERAGE_JSON) as f:
        return json.load(f)

def load_android_xml():
    suites = []
    if not ANDROID_XML_DIR.exists():
        return suites
    for xml_file in sorted(ANDROID_XML_DIR.glob("TEST-*.xml")):
        tree = ET.parse(xml_file)
        root = tree.getroot()
        suite = {
            "name": root.get("name", xml_file.stem),
            "tests": int(root.get("tests", 0)),
            "failures": int(root.get("failures", 0)),
            "errors": int(root.get("errors", 0)),
            "skipped": int(root.get("skipped", 0)),
            "time": float(root.get("time", 0)),
            "cases": [],
        }
        for tc in root.findall("testcase"):
            failure = tc.find("failure")
            case = {
                "name": tc.get("name", ""),
                "classname": tc.get("classname", ""),
                "time": float(tc.get("time", 0)),
                "status": "failed" if failure is not None else "passed",
                "failure": failure.text if failure is not None else None,
            }
            suite["cases"].append(case)
        suite["passed"] = suite["tests"] - suite["failures"] - suite["errors"] - suite["skipped"]
        suites.append(suite)
    return suites

BOARD_PREFIXES = [
    ("Box 86 ", "box_86"),
    ("IPS 3.5 ", "ips35"),
    ("Round AMOLED ", "amoled"),
    ("Ulanzi TC001 ", "led8x32"),
]

BOARD_LABELS = {
    "box_86": "86Box",
    "ips35": "IPS 3.5\"",
    "amoled": "Round",
    "led8x32": "TC001",
}


_BDD_PREFIXES = ('Given ', 'When ', 'Then ', 'And ', 'But ')


def _extract_bdd_steps(kw_el):
    """Recursively extract BDD step names from a keyword element.
    Only returns Given/When/Then/And/But steps — skips raw Robot library keywords."""
    steps = []
    for child_kw in kw_el.findall('kw'):
        kw_type = child_kw.get('type', '')
        if kw_type in ('setup', 'teardown', 'for', 'foritem'):
            continue
        name = child_kw.get('name', '')
        if not name:
            continue
        is_bdd = any(name.startswith(prefix) for prefix in _BDD_PREFIXES)
        if is_bdd:
            steps.append(name)
        elif len(child_kw.findall('kw')) > 0:
            # Intermediate keyword (e.g. Template scenario keyword) — recurse
            steps.extend(_extract_bdd_steps(child_kw))
    return steps


def _extract_board(test_name):
    """Extract board ID from test name prefix. Returns (board_id, scenario_name) or (None, test_name)."""
    for prefix, board_id in BOARD_PREFIXES:
        if test_name.startswith(prefix):
            return board_id, test_name[len(prefix):]
    return None, test_name


def load_robot_xml():
    """Parse Robot Framework output.xml into structured suite/scenario/test hierarchy."""
    if not ROBOT_XML.exists():
        return None
    try:
        tree = ET.parse(ROBOT_XML)
    except ET.ParseError:
        # Robot output may have junk after </robot> — truncate and retry
        try:
            raw = ROBOT_XML.read_text(encoding="utf-8")
            end_idx = raw.find("</robot>")
            if end_idx > 0:
                raw = raw[:end_idx + len("</robot>")]
                tree = ET.ElementTree(ET.fromstring(raw))
            else:
                return None
        except Exception:
            return None
    root = tree.getroot()

    # Parse statistics for summary
    stats_el = root.find('.//statistics/total/stat[@name="All Tests"]')
    if stats_el is None:
        # Robot 7+ uses different structure
        stats_el = root.find('.//statistics/total/stat')

    passed = int(stats_el.get('pass', 0)) if stats_el is not None else 0
    failed = int(stats_el.get('fail', 0)) if stats_el is not None else 0
    skipped = int(stats_el.get('skip', 0)) if stats_el is not None else 0

    # Parse individual test cases with suite hierarchy
    flat_cases = []  # backward-compat flat list
    suites_map = {}  # source -> suite data

    # Find leaf suites (suites that directly contain tests, not just sub-suites)
    for suite_el in root.iter('suite'):
        tests = suite_el.findall('test')
        if not tests:
            continue

        source = suite_el.get('source', '')
        suite_name = suite_el.get('name', source)
        # Extract force tags from suite metadata
        suite_tags = set()

        for test_el in tests:
            status_el = test_el.find('status')
            status = status_el.get('status', 'PASS').upper() if status_el is not None else 'PASS'
            case_status = "passed" if status == "PASS" else ("skipped" if status == "SKIP" else "failed")
            msg = ""
            if status_el is not None and status_el.text:
                msg = status_el.text[:300]

            test_name = test_el.get("name", "")
            tags = [t.text for t in test_el.findall('tag') if t.text]
            suite_tags.update(tags)

            # Extract BDD steps from keyword tree
            steps = _extract_bdd_steps(test_el)

            # Extract board from test name
            board_id, scenario_name = _extract_board(test_name)

            # Extract elapsed time
            elapsed_s = float(status_el.get('elapsed', '0')) if status_el is not None else 0

            # Extract [PERF] metrics from log messages
            perf = {}
            if 'perf' in tags:
                for msg_el in test_el.iter('msg'):
                    if msg_el.text and '[PERF]' in msg_el.text:
                        # Parse "[PERF] key=value" patterns
                        for m in re.finditer(r'\[PERF\]\s+(\w+)=([\d.]+)', msg_el.text):
                            perf[m.group(1)] = float(m.group(2))

            case = {
                "name": test_name,
                "status": case_status,
                "message": msg,
                "tags": tags,
                "steps": steps,
                "board": board_id,
                "scenario": scenario_name,
                "elapsed_s": elapsed_s,
                "perf": perf,
            }
            flat_cases.append(case)

            # Group into suites
            if source not in suites_map:
                suites_map[source] = {
                    "name": suite_name,
                    "source": os.path.basename(source) if source else suite_name,
                    "tags": set(),
                    "cases": [],
                }
            suites_map[source]["cases"].append(case)

        if source in suites_map:
            suites_map[source]["tags"].update(suite_tags)

    # Build structured suites with scenario grouping
    suites = []
    all_boards = set()
    total_scenarios = 0
    for _source, suite_data in sorted(suites_map.items()):
        s_passed = sum(1 for c in suite_data["cases"] if c["status"] == "passed")
        s_failed = sum(1 for c in suite_data["cases"] if c["status"] == "failed")
        s_skipped = sum(1 for c in suite_data["cases"] if c["status"] == "skipped")

        # Group cases by scenario name
        scenario_map = {}
        standalone = []
        for case in suite_data["cases"]:
            if case["board"]:
                all_boards.add(case["board"])
                sn = case["scenario"]
                if sn not in scenario_map:
                    scenario_map[sn] = {"name": sn, "cases": [], "boards": [], "steps": []}
                scenario_map[sn]["cases"].append(case)
                if case["board"] not in scenario_map[sn]["boards"]:
                    scenario_map[sn]["boards"].append(case["board"])
                # Use first case's steps as representative BDD steps for scenario
                if not scenario_map[sn]["steps"] and case["steps"]:
                    scenario_map[sn]["steps"] = case["steps"]
            else:
                standalone.append(case)

        # Build ordered scenarios list (maintain insertion order)
        scenarios = []
        seen = set()
        for case in suite_data["cases"]:
            if case["board"] and case["scenario"] not in seen:
                seen.add(case["scenario"])
                scenarios.append(scenario_map[case["scenario"]])
        # Append standalone tests as single-case scenarios
        for case in standalone:
            scenarios.append({
                "name": case["name"],
                "cases": [case],
                "boards": [],
                "steps": case["steps"],
                "standalone": True,
            })

        total_scenarios += len(scenarios)

        suites.append({
            "name": suite_data["name"],
            "source": suite_data["source"],
            "tags": sorted(suite_data["tags"]),
            "passed": s_passed,
            "failed": s_failed,
            "skipped": s_skipped,
            "total": len(suite_data["cases"]),
            "scenarios": scenarios,
        })

    # Build performance summary: board → metrics
    perf_summary = {}
    for case in flat_cases:
        bid = case.get("board")
        if not bid:
            continue
        if bid not in perf_summary:
            perf_summary[bid] = {}
        # Use test elapsed as build/flash/boot time based on scenario name
        scenario = case.get("scenario", "")
        elapsed = case.get("elapsed_s", 0)
        if "Build And Verify" in scenario and elapsed > 0:
            perf_summary[bid]["build_s"] = elapsed
        elif "Flash And Boot" in scenario and elapsed > 0:
            perf_summary[bid]["flash_boot_s"] = elapsed
        # Merge [PERF] metrics from perf-tagged tests
        for key, val in case.get("perf", {}).items():
            perf_summary[bid][key] = val

    return {
        "passed": passed,
        "failed": failed,
        "skipped": skipped,
        "total": passed + failed + skipped,
        "cases": flat_cases,
        "suites": suites,
        "boards": sorted(all_boards),
        "scenario_count": total_scenarios,
        "perf_summary": perf_summary,
    }

def load_scenarios():
    if not SCENARIO_JSON.exists():
        return []
    with open(SCENARIO_JSON) as f:
        data = json.load(f)
    return data.get("scenarios", [])

def load_history():
    if not HISTORY_JSON.exists():
        return []
    try:
        with open(HISTORY_JSON) as f:
            return json.load(f)
    except (json.JSONDecodeError, ValueError):
        return []

def load_metadata():
    if not METADATA_JSON.exists():
        return {}
    try:
        with open(METADATA_JSON) as f:
            return json.load(f)
    except (json.JSONDecodeError, ValueError):
        return {}

def update_history(history, total_passed, total_failed, total_all, lines_pct, metadata):
    commit_sha = os.environ.get("GITHUB_SHA", "local")[:7]
    suites = metadata.get("suites", {}) if metadata else {}
    executed = sorted([name for name, suite in suites.items() if suite.get("executed")])
    history.append({
        "date": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
        "commit": commit_sha,
        "total": total_all,
        "passed": total_passed,
        "failed": total_failed,
        "coverage": round(lines_pct, 1),
        "run_profile": metadata.get("run_profile", "unknown") if metadata else "unknown",
        "executed_suites": executed,
    })
    # Keep last 50 entries
    history = history[-50:]
    HISTORY_JSON.write_text(json.dumps(history, indent=2), encoding="utf-8")
    return history

def extract_package_coverage(cov_data):
    """Group per-file coverage into packages."""
    packages = {}
    for filepath, metrics in cov_data.items():
        if filepath == "total":
            continue
        rel = filepath.replace(str(ROOT) + "/", "")
        parts = rel.split("/")
        if len(parts) >= 2 and parts[0] in ("bridge", "plugin", "plugin-ulanzi", "shared", "hooks"):
            pkg = parts[0]
        else:
            pkg = "other"

        if pkg not in packages:
            packages[pkg] = {"lines": {"total": 0, "covered": 0}, "statements": {"total": 0, "covered": 0},
                             "functions": {"total": 0, "covered": 0}, "branches": {"total": 0, "covered": 0},
                             "files": []}

        for metric in ("lines", "statements", "functions", "branches"):
            m = metrics.get(metric, {})
            packages[pkg][metric]["total"] += m.get("total", 0)
            packages[pkg][metric]["covered"] += m.get("covered", 0)

        packages[pkg]["files"].append({
            "path": rel,
            "lines_pct": metrics.get("lines", {}).get("pct", 0),
            "stmts_pct": metrics.get("statements", {}).get("pct", 0),
            "funcs_pct": metrics.get("functions", {}).get("pct", 0),
            "branch_pct": metrics.get("branches", {}).get("pct", 0),
        })

    for pkg, data in packages.items():
        for metric in ("lines", "statements", "functions", "branches"):
            t = data[metric]["total"]
            c = data[metric]["covered"]
            data[metric]["pct"] = round(c / t * 100, 1) if t > 0 else 0

    return packages


# ===== Test categorization =====

# Test layers: purpose-driven grouping of test files. The SSOT is the
# `domains` list of scripts/verification-catalog.json (glob patterns, ordered,
# first match wins); scripts/__tests__/verification-catalog.test.ts fails when a
# tracked test file matches no domain, so "Other Tests" stays empty.
def load_catalog():
    if not CATALOG_JSON.exists():
        return {"gates": [], "domains": [], "levels": {}, "not_verified": []}
    with open(CATALOG_JSON) as f:
        return json.load(f)

CATALOG = load_catalog()

def _glob_re(glob):
    """`*` matches within one path segment — same rule as the catalog test."""
    return re.compile("^" + "[^/]*".join(re.escape(part) for part in glob.split("*")) + "$")

TEST_LAYERS = [
    {**d, "_res": [_glob_re(g) for g in d.get("match", [])]}
    for d in CATALOG.get("domains", [])
]

def classify_test_file(filepath):
    """Domain id for a test file (first matching domain), or "other"."""
    for layer in TEST_LAYERS:
        if any(r.match(filepath) for r in layer["_res"]):
            return layer["id"]
    return "other"

def get_layer_for_file(filepath):
    """Return the layer dict for a file, or None."""
    lid = classify_test_file(filepath)
    for layer in TEST_LAYERS:
        if layer["id"] == lid:
            return layer
    return None

def read_coverage_thresholds():
    """The enforced floor, read from vitest.config.ts so the page never quotes a stale number."""
    try:
        text = VITEST_CONFIG.read_text(encoding="utf-8")
    except OSError:
        return {}
    block = re.search(r"thresholds:\s*\{([^}]*)\}", text)
    if not block:
        return {}
    return {k: float(v) for k, v in re.findall(r"(lines|functions|branches|statements):\s*(\d+(?:\.\d+)?)", block.group(1))}

def suite_meta(metadata, name):
    suites = metadata.get("suites", {}) if metadata else {}
    meta = suites.get(name, {})
    executed = bool(meta.get("executed"))
    status = meta.get("status") or ("pass" if executed else "not-run")
    return {
        "status": status,
        "executed": executed,
        "note": meta.get("note", ""),
    }

def build_default_metadata(vitest, android, robot, e2e=None):
    return {
        "run_profile": "ad-hoc",
        "suites": {
            "vitest": {"status": "pass" if vitest else "not-run", "executed": bool(vitest), "note": ""},
            "e2e": {"status": ("pass" if e2e.get("numFailedTests", 0) == 0 else "fail") if e2e else "not-run", "executed": bool(e2e), "note": ""},
            "android": {"status": "pass" if android else "not-run", "executed": bool(android), "note": ""},
            "apple": {"status": "not-run", "executed": False, "note": "No Apple result parser input"},
            "robot": {"status": "pass" if robot else "not-run", "executed": bool(robot), "note": ""},
        },
    }

def full_assertion_name(assertion):
    ancestors = assertion.get("ancestorTitles", [])
    title = assertion.get("title", "")
    return " > ".join([*ancestors, title]).strip().lower()

def pattern_matches(text, patterns):
    if not patterns or "*" in patterns:
        return True
    lowered = text.lower()
    return any(pattern.lower() in lowered for pattern in patterns)


# ===== Scenario matrix =====

def build_scenario_results(scenarios, vitest, android_suites, metadata):
    """Cross-reference scenario test mappings against actual test results."""
    suite_status = {
        "vitest": suite_meta(metadata, "vitest"),
        "android": suite_meta(metadata, "android"),
        "apple": suite_meta(metadata, "apple"),
        "robot": suite_meta(metadata, "robot"),
    }
    # Build lookup: relative file path -> {status, passed, failed, total}
    vt_lookup = {}
    if vitest:
        for result in vitest.get("testResults", []):
            rel = result["name"].replace(str(ROOT) + "/", "")
            assertions = result.get("assertionResults", [])
            p = sum(1 for a in assertions if a["status"] == "passed")
            f = sum(1 for a in assertions if a["status"] == "failed")
            vt_lookup[rel] = {"status": result["status"], "passed": p, "failed": f, "total": p + f, "assertions": assertions}

    and_lookup = {}
    for suite in android_suites:
        # Android test files use classname like dev.agentdeck.net.ProtocolTest
        and_lookup[suite["name"]] = {"status": "passed" if suite["failures"] == 0 else "failed",
                                     "passed": suite["passed"], "failed": suite["failures"], "total": suite["tests"],
                                     "cases": suite["cases"]}

    def resolve_entry(entry):
        fpath = entry["file"]
        patterns = entry.get("patterns", ["*"])

        if fpath.startswith("apple/"):
            return {"status": "not-run" if not suite_status["apple"]["executed"] else "missing", "passed": 0, "failed": 0}
        if fpath.startswith("esp32/robot/"):
            return {"status": "not-run" if not suite_status["robot"]["executed"] else "missing", "passed": 0, "failed": 0}

        found = vt_lookup.get(fpath)
        if not found:
            basename = Path(fpath).name
            for vpath, vdata in vt_lookup.items():
                if vpath.endswith(basename):
                    found = vdata
                    break
        if found:
            if not suite_status["vitest"]["executed"]:
                return {"status": "not-run", "passed": 0, "failed": 0}
            if "*" in patterns:
                return {"status": "fail" if found["failed"] else "pass", "passed": found["passed"], "failed": found["failed"]}
            matched = [a for a in found.get("assertions", []) if pattern_matches(full_assertion_name(a), patterns)]
            if not matched:
                return {"status": "missing", "passed": 0, "failed": 0}
            passed = sum(1 for a in matched if a["status"] == "passed")
            failed = sum(1 for a in matched if a["status"] == "failed")
            return {"status": "fail" if failed else "pass", "passed": passed, "failed": failed}

        found = None
        for aname, adata in and_lookup.items():
            fname = Path(fpath).stem.replace("Test", "")
            if fname.lower() in aname.lower():
                found = adata
                break
        if found:
            if not suite_status["android"]["executed"]:
                return {"status": "not-run", "passed": 0, "failed": 0}
            if "*" in patterns:
                return {"status": "fail" if found["failed"] else "pass", "passed": found["passed"], "failed": found["failed"]}
            matched = [c for c in found.get("cases", []) if pattern_matches(c.get("name", ""), patterns)]
            if not matched:
                return {"status": "missing", "passed": 0, "failed": 0}
            passed = sum(1 for c in matched if c["status"] == "passed")
            failed = sum(1 for c in matched if c["status"] == "failed")
            return {"status": "fail" if failed else "pass", "passed": passed, "failed": failed}

        if fpath.startswith("android/") and not suite_status["android"]["executed"]:
            return {"status": "not-run", "passed": 0, "failed": 0}
        if not suite_status["vitest"]["executed"]:
            return {"status": "not-run", "passed": 0, "failed": 0}
        return {"status": "missing", "passed": 0, "failed": 0}

    results = []
    for sc in scenarios:
        sc_result = {"id": sc["id"], "name": sc["name"], "description": sc["description"],
                     "priority": sc.get("priority", "medium"), "gaps": sc.get("gaps", []),
                     "categories": {}}

        for cat in ("unit", "integration", "platform", "e2e"):
            test_entries = sc.get("tests", {}).get(cat, [])
            cat_result = {"tests": [], "passed": 0, "failed": 0, "missing": 0, "not_run": 0, "total": len(test_entries)}

            for entry in test_entries:
                resolved = resolve_entry(entry)
                cat_result["tests"].append({"file": entry["file"], "status": resolved["status"],
                                            "passed": resolved["passed"], "failed": resolved["failed"]})
                if resolved["status"] == "fail":
                    cat_result["failed"] += 1
                elif resolved["status"] == "pass":
                    cat_result["passed"] += 1
                elif resolved["status"] == "not-run":
                    cat_result["not_run"] += 1
                else:
                    cat_result["missing"] += 1

            sc_result["categories"][cat] = cat_result

        results.append(sc_result)
    return results



# ===== Presentation =====
#
# The page follows the same grammar as the other Pages surfaces (Devices,
# Overview): the shared GNB, a hero with kicker + page title + lede, a jump bar,
# then sections opened by a `.section-head`, holding bordered `--tide-100` cards.
# Every colour is a token reference — the :root block below is gated by
# design/verify-tokens-sync.py, which also sweeps this file for stray hex — and
# status hues follow DESIGN.md §2.7: kelp = passing/healthy, coral = failure,
# ink-300 = not run / unknown. Amber is reserved for "needs you" and unused here.
# scripts/__tests__/build-health-report.test.ts renders the page from fixtures
# and lints the OUTPUT, because design/lint.sh never sees a generated file.

def _esc(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;"))

def _state(status):
    """Normalize a suite/test status to one of pass / fail / off."""
    if status in ("passed", "pass", "PASS"):
        return "pass"
    if status in ("failed", "fail", "error", "FAIL"):
        return "fail"
    return "off"

_STATE_LABEL = {"pass": "Pass", "fail": "Fail", "off": "Not run"}

def status_badge(status, label=None):
    st = _state(status)
    return f'<span class="badge {st}">{_esc(label or _STATE_LABEL[st])}</span>'

def _n(count, noun):
    return f"{count:,} {noun}" + ("" if count == 1 else "s")

def duration_fmt(ms):
    if ms < 1000:
        return f"{ms:.0f} ms"
    s = ms / 1000
    if s < 60:
        return f"{s:.1f} s"
    m = int(s // 60)
    return f"{m} min {s % 60:.0f} s"

def _bar(passed, failed, total):
    """Proportional pass/fail rail. Total 0 renders an empty track."""
    if total <= 0:
        return '<div class="rail"></div>'
    p = passed / total * 100
    f = failed / total * 100
    return (f'<div class="rail" role="img" aria-label="{passed} of {total} passed">'
            f'<span class="ok" style="width:{p:.2f}%"></span>'
            f'<span class="bad" style="width:{f:.2f}%"></span></div>')

def write_summary(metadata, total_passed, total_failed, total_all):
    suites_meta = metadata.get("suites", {}) if metadata else {}
    suites = []
    for name in ("vitest", "e2e", "android", "apple", "robot"):
        meta = suites_meta.get(name, {})
        suites.append({
            "name": name,
            "status": meta.get("status", "not-run"),
            "executed": bool(meta.get("executed")),
            "note": meta.get("note", ""),
        })
    report = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "run_profile": metadata.get("run_profile", "unknown") if metadata else "unknown",
        "suites": suites,
        "total": {
            "passed": total_passed,
            "failed": total_failed,
            "total": total_all,
        },
    }
    SUMMARY_JSON.write_text(json.dumps(report, indent=2), encoding="utf-8")

def sparkline_svg(history, key, label):
    """A small trend line for one history metric. Needs two or more runs."""
    values = [entry.get(key, 0) for entry in history]
    if len(values) < 2:
        return ""
    w, h = 240, 48
    max_v, min_v = max(values), min(values)
    span = (max_v - min_v) or 1
    n = len(values)
    pts = [((i / (n - 1)) * (w - 8) + 4, h - 6 - ((v - min_v) / span) * (h - 12)) for i, v in enumerate(values)]
    poly = " ".join(f"{x:.1f},{y:.1f}" for x, y in pts)
    last = values[-1]
    if key == "coverage":
        display = f"{last:.1f}%"
    elif key == "passed":
        # Of the tests that ran: skipped cases are not failures (a run with 0
        # failed and 16 skipped read 99.7% when divided by the total).
        executed = history[-1].get("passed", 0) + history[-1].get("failed", 0)
        display = f"{last / executed * 100:.1f}%" if executed else "—"
    else:
        display = f"{last:,}"
    lx, ly = pts[-1]
    return f'''<div class="card spark">
      <p class="kicker">{_esc(label)}</p>
      <p class="spark-value">{display}</p>
      <svg viewBox="0 0 {w} {h}" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="{poly}" style="fill:none;stroke:var(--kelp-500);stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round"/>
        <circle cx="{lx:.1f}" cy="{ly:.1f}" r="3" style="fill:var(--kelp-700)"/>
      </svg>
      <p class="fine">last {n} runs on master</p>
    </div>'''

def _fmt_perf(val, unit="", decimals=1):
    """Format a perf value for table display."""
    if val is None:
        return '<span class="quiet">—</span>'
    if unit == "ms":
        return f"{val:,.{decimals}f} ms"
    if unit == "s":
        return f"{val:,.{decimals}f} s"
    if unit == "KB":
        return f"{val / 1024:,.0f} KB"
    if unit == "msg/s":
        return f"{val:,.0f} msg/s"
    return f"{val:,.{decimals}f}{unit}"

def _build_robot_perf_table(robot):
    """Board × metric performance comparison table."""
    perf = robot.get("perf_summary", {})
    boards = robot.get("boards", sorted(perf.keys()))
    metrics = [
        ("build_s", "Build", "s"),
        ("flash_boot_s", "Flash + boot", "s"),
        ("boot_time_ms", "Boot time", "ms"),
        ("firmware_size_bytes", "Firmware", "KB"),
        ("boot_heap_bytes", "Boot heap", "KB"),
        ("response_latency_ms", "Latency", "ms"),
    ]
    if not perf or not boards or not any(perf.get(b, {}).get(m[0]) for b in boards for m in metrics):
        return ""
    head = "".join(f"<th>{label}</th>" for _, label, _ in metrics)
    rows = ""
    for bid in boards:
        bdata = perf.get(bid, {})
        cells = "".join(f"<td class='num'>{_fmt_perf(bdata.get(key), unit)}</td>" for key, _, unit in metrics)
        rows += f"<tr><th scope='row'>{_esc(BOARD_LABELS.get(bid, bid))}</th>{cells}</tr>"
    return f'<div class="scroll"><table class="data"><thead><tr><th>Board</th>{head}</tr></thead><tbody>{rows}</tbody></table></div>'

def render_gnb():
    """Render the shared Pages GNB from the canonical partial so Build Health
    can never drift from the other surfaces (scripts/pages-nav.html)."""
    partial_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pages-nav.html")
    with open(partial_path, encoding="utf-8") as fh:
        partial = fh.read()
    partial = re.sub(r"<!--[\s\S]*?-->\s*", "", partial, count=1)
    partial = partial.replace("{{base}}", "../")
    partial = re.sub(
        r"\{\{active:([a-z]+)\}\}",
        lambda m: ' class="active"' if m.group(1) == "reports" else "",
        partial,
    )
    return partial.rstrip()

def render_gnb_css():
    """Return the canonical GNB CSS (scripts/pages-nav.css) so Build Health's nav
    styling stays byte-identical to the committed surfaces. The braces in this
    string are inserted into the stylesheet f-string as a *substituted* value,
    so its `{ }` are never re-parsed as f-string fields."""
    css_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pages-nav.css")
    with open(css_path, encoding="utf-8") as fh:
        css = fh.read()
    return re.sub(r"/\*[\s\S]*?\*/\s*", "", css, count=1).rstrip()

def _section_head(sid, kicker, title, lede):
    return f'''<div class="section-head" id="{sid}">
      <div><p class="kicker">{_esc(kicker)}</p><h2>{_esc(title)}</h2></div>
      <p>{lede}</p>
    </div>'''

# --- Latest run --------------------------------------------------------------

def _elsewhere_badge(elsewhere):
    """A result recorded by another workflow or the pre-release receipt. Outlined,
    never the solid pass badge, and never added to this page's totals."""
    st = elsewhere["state"]
    cls = {"pass": "elsewhere", "fail": "fail"}.get(st, "off")
    return f'<span class="badge {cls}">{_esc(elsewhere["label"])}</span>'

def _skipped_cases(vt_file_data, catalog):
    """Every case skipped in this run, with the gate (if any) whose runner executes it."""
    owners = {}
    for gate in catalog.get("gates", []):
        for f in gate.get("files", []):
            owners.setdefault(f, []).append(gate)
    rows = []
    for f in sorted(vt_file_data):
        for a in vt_file_data[f]["assertions"]:
            if a.get("status") in ("passed", "failed"):
                continue
            rows.append((f, " › ".join([*a.get("ancestorTitles", []), a.get("title", "")]), owners.get(f, [])))
    return rows

def _render_skipped(rows):
    if not rows:
        return ""
    body = ""
    for f, name, gates in rows:
        runs = ("; ".join(f'{_esc(g["name"])} <span class="fine">({_esc(g["workflow"].rsplit("/", 1)[-1])} › {_esc(g.get("job") or "")})</span>' for g in gates)
                if gates else '<span class="quiet">no CI runner: runs on a developer host whose platform or toolchain matches</span>')
        body += f'<tr><td><code>{_esc(f)}</code><span class="fine">{_esc(name)}</span></td><td>{runs}</td></tr>'
    hosted = sum(1 for _, _, g in rows if g)
    return f'''<details class="card files skipped"><summary>{_n(len(rows), "case")} skipped here: {hosted} run on another CI runner, {len(rows) - hosted} on no CI runner</summary>
      <div class="scroll"><table class="data"><thead><tr><th>Skipped case</th><th>Where it runs</th></tr></thead><tbody>{body}</tbody></table></div></details>'''

def _render_run(stats, suites, skipped_html=""):
    tiles = "".join(f'''<div class="card tile">
        <p class="kicker">{_esc(label)}</p>
        <p class="tile-value {cls}">{value}</p>
        <p class="fine">{note}</p>
      </div>''' for label, value, cls, note in stats)
    cards = ""
    for s in suites:
        meta = s["meta"]
        st = _state(meta["status"]) if meta["executed"] else "off"
        elsewhere = None if meta["executed"] else s.get("elsewhere")
        badge = _elsewhere_badge(elsewhere) if elsewhere else status_badge(st)
        figures = ""
        if meta["executed"]:
            figures = f'''<dl class="specs">
              <div><dt>Passed</dt><dd>{s["passed"]:,}</dd></div>
              <div><dt>Failed</dt><dd class="{"bad-text" if s["failed"] else ""}">{s["failed"]:,}</dd></div>
              <div><dt>{_esc(s["unit"])}</dt><dd>{s["files"]:,}</dd></div>
              <div><dt>Time</dt><dd>{duration_fmt(s["ms"]) if s["ms"] else "—"}</dd></div>
            </dl>'''
        note = f'<p class="fine">{_esc(meta["note"])}</p>' if meta.get("note") else ""
        if elsewhere:
            note += elsewhere["line"]
        cards += f'''<article class="card suite">
          <div class="card-top"><h3>{_esc(s["name"])}</h3>{badge}</div>
          <p class="sub">{_esc(s["what"])}</p>
          {_bar(s["passed"], s["failed"], s["passed"] + s["failed"]) if meta["executed"] else ""}
          {figures}{note}
        </article>'''
    return f'<div class="grid tiles">{tiles}</div><div class="grid suites">{cards}</div>{skipped_html}'

# --- Verification tiers ------------------------------------------------------

TIER_LABEL = {"changed": "Changed", "quick": "Quick", "full": "Pre-release"}
_RUN_STATE = {"success": "pass", "failure": "fail", "timed_out": "fail", "startup_failure": "fail"}

def _steps_by_gate(catalog):
    out = {}
    for step in catalog.get("steps", []):
        out.setdefault(step["gate"], []).append(step)
    return out

def _hosted_run(workflow_status, gate):
    wf = gate.get("workflow") if gate else None
    return workflow_status.get(wf) if wf else None

def _hosted_line(run, commit):
    """One line naming the latest completed hosted run of a gate's workflow."""
    if not run:
        return ""
    st = _RUN_STATE.get(run.get("conclusion"), "off")
    verdict = {"pass": "passed", "fail": "failed"}.get(st, run.get("conclusion") or "unknown")
    sha = (run.get("head_sha") or "")[:7]
    if commit and (run.get("head_sha") or "").startswith(commit):
        where = "this commit"
    elif run.get("scope") == "master":
        where = "master"
    else:
        where = f'{run.get("event", "run")} on {run.get("head_branch", "?")}'
    return (f'<p class="hosted"><span class="dot {st}"></span>Latest hosted run {_esc(verdict)} · '
            f'<a href="{_esc(run.get("html_url", ""))}">{_esc(sha)}</a> · {_esc(where)} · {_esc((run.get("created_at") or "")[:10])}</p>')

def _receipt_step(receipt, gate_id):
    if not receipt:
        return None
    return next((s for s in receipt.get("steps", []) if s.get("gate") == gate_id), None)

def _needs_text(step):
    req = step.get("requires", {})
    bits = []
    plat = req.get("platform")
    if plat:
        bits.append({"darwin": "macOS", "win32": "Windows", "posix": "macOS or Linux"}.get(plat, plat))
    bits += [c for c in req.get("commands", []) if c != "python3"]
    if req.get("jdk"):
        bits.append(f'JDK {req["jdk"]}')
    if step.get("opt_in"):
        bits.append("opt-in on macOS (--allow-keychain)")
    if step.get("manual"):
        bits.append("a person and the lab hardware")
    return ", ".join(_esc(b) for b in bits) or '<span class="quiet">Node only</span>'

def _matrix_cell(step, tier):
    if tier not in step.get("tiers", []):
        return '<td class="c quiet">–</td>'
    if step.get("manual"):
        return '<td class="c"><span class="in">●</span><span class="fine">attested</span></td>'
    if tier == "changed" and step.get("paths"):
        paths = step["paths"]
        more = f" +{len(paths) - 1}" if len(paths) > 1 else ""
        return f'<td class="c" title="{_esc(", ".join(paths))}"><span class="in">●</span><span class="fine">{_esc(paths[0])}{more}</span></td>'
    note = "related tests" if step.get("builtin") == "vitest-related" else "always"
    return f'<td class="c"><span class="in">●</span><span class="fine">{note}</span></td>'

_RECEIPT_MARK = {"pass": ("pass", "✓"), "fail": ("fail", "×"), "skip": ("off", "○"), "manual": ("off", "?")}
_RECEIPT_VERB = {"pass": "passed", "fail": "failed", "skip": "skipped", "manual": "not attested"}

def _render_receipt(receipt, title, empty_text):
    if not receipt:
        return (f'<article class="card receipt"><div class="card-top"><h3>{_esc(title)}</h3>{status_badge("off", "None recorded")}</div>'
                f'<p class="sub">{empty_text}</p></article>')
    steps = receipt.get("steps", [])
    counts = {k: sum(1 for x in steps if x.get("status") == k) for k in ("pass", "fail", "skip", "manual")}
    tier = next((t for t in CATALOG.get("tiers", []) if t["id"] == receipt.get("tier")), {})
    host = receipt.get("host", {})
    rows = ""
    for x in steps:
        st, mark = _RECEIPT_MARK.get(x.get("status"), ("off", "○"))
        detail = x.get("reason") or x.get("note") or ""
        if x.get("attested"):
            detail = f'attested {_RECEIPT_VERB.get(x.get("status"), "")}' + (f' — {x["note"]}' if x.get("note") else "")
        dur = x.get("duration_ms")
        rows += (f'<li class="t {st}"><span class="mark">{mark}</span>'
                 f'<span class="tname">{_esc(x.get("name") or x.get("id"))}<span class="fine"> {_esc(detail)}</span></span>'
                 f'<span class="tdur">{duration_fmt(dur) if dur else ""}</span></li>')
    dirty = ' · <span class="bad-text">uncommitted changes</span>' if receipt.get("dirty") else ""
    when = (receipt.get("finished_at") or "")[:16].replace("T", " ")
    sub = (f'{_esc(tier.get("name", receipt.get("tier", "")))} · commit <code>{_esc((receipt.get("commit") or "")[:7])}</code>{dirty}'
           f' · {_esc(when)} UTC · {_esc(host.get("platform", ""))}/{_esc(host.get("arch", ""))}, Node {_esc(host.get("node", ""))}')
    return f'''<article class="card receipt">
      <div class="card-top"><h3>{_esc(title)}</h3>{status_badge("fail" if counts["fail"] else "pass")}</div>
      <p class="sub">{sub}</p>
      <dl class="specs">
        <div><dt>Passed</dt><dd>{counts["pass"]}</dd></div>
        <div><dt>Failed</dt><dd class="{"bad-text" if counts["fail"] else ""}">{counts["fail"]}</dd></div>
        <div><dt>Skipped</dt><dd>{counts["skip"]}</dd></div>
        <div><dt>Lab, unattested</dt><dd>{counts["manual"]}</dd></div>
      </dl>
      <details class="files"{" open" if counts["fail"] else ""}><summary>{_n(len(steps), "step")} · {duration_fmt(receipt.get("duration_ms") or 0)}</summary><ul class="tests">{rows}</ul></details>
    </article>'''

def _render_tiers(catalog, recorded, this_run):
    gates = {g["id"]: g for g in catalog.get("gates", [])}
    cards = ""
    for tier in catalog.get("tiers", []):
        cards += f'''<article class="card tier">
          <p class="kicker">{_esc(TIER_LABEL.get(tier["id"], tier["id"]))}</p>
          <h3>{_esc(tier["name"])}</h3>
          <p class="sub">{_esc(tier["when"])} · {_esc(tier["budget"])}</p>
          <p class="cmd"><code>{_esc(tier["command"])}</code></p>
          <p class="label">Runs</p><p class="prose">{_esc(tier["selects"])}</p>
          <p class="label">Does not replace</p><p class="prose quiet">{_esc(tier["does_not_replace"])}</p>
        </article>'''
    rows = ""
    for step in catalog.get("steps", []):
        gate = gates.get(step["gate"], {})
        wf = gate.get("workflow")
        hosted = (f'{_esc(wf.rsplit("/", 1)[-1])} › {_esc(gate.get("job") or "")}<span class="fine">{_esc(gate.get("trigger", ""))}</span>'
                  if wf else '<span class="quiet">no hosted runner</span>')
        cmd = "" if step.get("manual") else (step.get("run") or step.get("builtin") or "")
        rows += f'''<tr><th scope="row"><strong>{_esc(step["name"])}</strong><span class="fine"><code>{_esc(step["id"])}</code>{" · " + _esc(cmd) if cmd else ""}</span></th>
          {_matrix_cell(step, "changed")}{_matrix_cell(step, "quick")}{_matrix_cell(step, "full")}
          <td>{hosted}</td><td>{_needs_text(step)}</td></tr>'''
    matrix = f'''<div class="card flush"><div class="scroll"><table class="data matrix">
      <thead><tr><th>Step</th><th class="c">Changed</th><th class="c">Quick</th><th class="c">Pre-release</th><th>Hosted CI</th><th>Needs</th></tr></thead>
      <tbody>{rows}</tbody></table></div></div>'''
    receipts = _render_receipt(recorded, "Last recorded pre-release check",
                               "Run <code>pnpm verify:full --record</code> on a clean tree before a release tag and commit the file it writes under <code>verification/receipts/</code>. This card then lists every step's result, including the lab gates a person attested.")
    if this_run:
        receipts = _render_receipt(this_run, "This run (local)", "") + receipts
    return f'''<div class="grid tiers">{cards}</div>
      <h3 class="sub-head">Which step runs in which tier</h3>
      {matrix}
      <p class="fine matrix-note">A changed-area step runs when a file matching one of its paths (hover a cell for all of them) changed since the merge base. Each selected step runs, is skipped with its reason (missing toolchain, other platform), or, for a lab gate, waits for a person to attest it. Nothing counts as passing without running.</p>
      <h3 class="sub-head">Receipts</h3>
      <div class="grid receipts">{receipts}</div>'''

# --- What we verify ----------------------------------------------------------

def _render_verify(catalog, metadata, workflow_status=None, recorded=None, commit=""):
    repo = os.environ.get("GITHUB_REPOSITORY", "puritysb/AgentDeck")
    levels = catalog.get("levels", {})
    steps_by_gate = _steps_by_gate(catalog)
    cards = ""
    for gate in catalog.get("gates", []):
        suite = gate.get("report_suite")
        meta = suite_meta(metadata, suite) if suite else None
        if meta and meta["executed"]:
            badge = status_badge(meta["status"], "Passed here" if _state(meta["status"]) == "pass" else "Failed here")
        else:
            # Only a check branch protection requires stops a merge; a red
            # workflow alone does not (catalog `required` vs `blocking`).
            if gate.get("required"):
                badge = '<span class="badge gate">Required to merge</span>'
            else:
                badge = f'<span class="badge off">{"Fails CI" if gate.get("blocking") else "Informational"}</span>'
        tags = "".join(f'<span class="tag" title="{_esc(levels.get(l, ""))}">{_esc(l)}</span>' for l in gate.get("level", []))
        proves = "".join(f"<li>{_esc(x)}</li>" for x in gate.get("proves", []))
        not_proves = "".join(f"<li>{_esc(x)}</li>" for x in gate.get("does_not_prove", []))
        wf = gate.get("workflow")
        link = (f'<a href="https://github.com/{repo}/actions/workflows/{_esc(wf.rsplit("/", 1)[-1])}">{_esc(wf.rsplit("/", 1)[-1])} runs</a>'
                if wf else '<span class="quiet">No hosted runner — the pre-release receipt records it</span>')
        tiers = sorted({t for st in steps_by_gate.get(gate["id"], []) for t in st["tiers"]}, key=list(TIER_LABEL).index)
        tier_tags = "".join(f'<span class="tag">{_esc(TIER_LABEL[t])}</span>' for t in tiers) or '<span class="quiet">hosted only</span>'
        evidence = "" if gate["id"] == "pages-report" else _hosted_line(_hosted_run(workflow_status or {}, gate), commit)
        attested = None if wf else _receipt_step(recorded, gate["id"])
        if attested:
            st = _RECEIPT_MARK.get(attested.get("status"), ("off", ""))[0]
            evidence = (f'<p class="hosted"><span class="dot {st}"></span>Last pre-release check: {_esc(_RECEIPT_VERB.get(attested.get("status"), ""))}'
                        f' · <code>{_esc((recorded.get("commit") or "")[:7])}</code> · {_esc((recorded.get("finished_at") or "")[:10])}</p>')
        cards += f'''<article class="card gate">
          <div class="card-top"><div class="tags">{tags}</div>{badge}</div>
          <h3>{_esc(gate["name"])}</h3>
          <p class="sub">{_esc(gate.get("trigger", ""))} · {_esc(gate.get("where", ""))}</p>
          <div class="two">
            <div><p class="label">Proves</p><ul class="ticks">{proves}</ul></div>
            <div><p class="label">Does not prove</p><ul class="ticks no">{not_proves}</ul></div>
          </div>
          <p class="cmd"><code>{_esc(gate.get("command", ""))}</code></p>
          <p class="tierline"><span class="label">Local tiers</span>{tier_tags}</p>
          <div class="card-foot">{evidence}<p>{link}</p></div>
        </article>'''
    gaps = "".join(f'''<article class="card gap">
        <h3>{_esc(g["what"])}</h3>
        <p class="label">Why not</p><p>{_esc(g["why"])}</p>
        <p class="label">What we do instead</p><p>{_esc(g["instead"])}</p>
      </article>''' for g in catalog.get("not_verified", []))
    legend = "".join(f"<div><dt>{_esc(k)}</dt><dd>{_esc(v)}</dd></div>" for k, v in levels.items())
    policy = catalog.get("merge_policy") or {}
    merge_note = (f'<div class="card legend"><p class="kicker">Merge policy · checked {_esc(policy.get("as_of", ""))}</p>'
                  f'<p>{_esc(policy["summary"])}</p></div>' if policy.get("summary") else "")
    return f'''{merge_note}<div class="grid gates">{cards}</div>
      <h3 class="sub-head">Not verified automatically</h3>
      <div class="grid gaps">{gaps}</div>
      <div class="card legend"><p class="kicker">Evidence levels</p><dl>{legend}</dl></div>'''

# --- Test domains ------------------------------------------------------------

def _test_rows(assertions):
    rows = ""
    for a in assertions:
        st = {"passed": "pass", "failed": "fail"}.get(a.get("status"), "off")
        mark = {"pass": "✓", "fail": "×", "off": "○"}[st]
        name = " › ".join([*a.get("ancestorTitles", []), a.get("title", "")])
        detail = ""
        if st == "fail" and a.get("failureMessages"):
            detail = f'<pre class="failure">{_esc(a["failureMessages"][0][:2000])}</pre>'
        dur = a.get("duration")
        rows += (f'<li class="t {st}"><span class="mark" aria-label="{_STATE_LABEL[st]}">{mark}</span>'
                 f'<span class="tname">{_esc(name)}</span>'
                 f'<span class="tdur">{duration_fmt(dur) if dur else ""}</span>{detail}</li>')
    return rows

def _render_domains(vt_file_data):
    cards = ""
    for layer in TEST_LAYERS:
        files = sorted(f for f in vt_file_data if classify_test_file(f) == layer["id"])
        passed = sum(vt_file_data[f]["passed"] for f in files)
        failed = sum(vt_file_data[f]["failed"] for f in files)
        skipped = sum(vt_file_data[f]["skipped"] for f in files)
        dur = sum(vt_file_data[f]["dur"] for f in files)
        items = ""
        for f in files:
            d = vt_file_data[f]
            items += f'''<details class="file"{" open" if d["failed"] else ""}>
              <summary><span class="fpath">{_esc(f)}</span><span class="fcount {"bad-text" if d["failed"] else ""}">{d["passed"]}/{d["passed"] + d["failed"]}</span></summary>
              <ul class="tests">{_test_rows(d["assertions"])}</ul>
            </details>'''
        st = "fail" if failed else ("pass" if files else "off")
        cards += f'''<article class="card domain" id="domain-{_esc(layer["id"])}">
          <div class="card-top"><p class="kicker"><span aria-hidden="true">{_esc(layer.get("icon", ""))}</span> {_n(len(files), "file")}</p>{status_badge(st, f"{failed} failing" if failed else None)}</div>
          <h3>{_esc(layer["name"])}</h3>
          <p class="sub">{_esc(layer.get("question", ""))}</p>
          {_bar(passed, failed, passed + failed)}
          <dl class="specs">
            <div><dt>Passed</dt><dd>{passed:,}</dd></div>
            <div><dt>Failed</dt><dd class="{"bad-text" if failed else ""}">{failed:,}</dd></div>
            <div><dt>Skipped</dt><dd>{skipped:,}</dd></div>
            <div><dt>Time</dt><dd>{duration_fmt(dur)}</dd></div>
          </dl>
          <details class="files"{" open" if failed else ""}><summary>{_n(len(files), "test file")}</summary>{items}</details>
        </article>'''
    other = sorted(f for f in vt_file_data if classify_test_file(f) == "other")
    if other:
        cards += f'''<article class="card domain"><div class="card-top"><p class="kicker">{_n(len(other), "file")}</p>{status_badge("fail", "Unclassified")}</div>
          <h3>No domain</h3><p class="sub">These files match no domain in scripts/verification-catalog.json — the catalog test should have failed.</p>
          <ul class="plain">{"".join(f"<li><code>{_esc(f)}</code></li>" for f in other)}</ul></article>'''
    return f'<div class="grid domains">{cards}</div>'

# --- Platform suites ---------------------------------------------------------

def _render_platforms(android_suites, android_meta, apple_meta, robot, robot_meta, apple_elsewhere=None, robot_elsewhere=None):
    # Android
    if android_suites:
        rows = ""
        for s in android_suites:
            failed = s["failures"] + s["errors"]
            short = s["name"].replace("dev.agentdeck.", "")
            rows += f'''<details class="file"{" open" if failed else ""}>
              <summary><span class="fpath">{_esc(short)}</span><span class="fcount {"bad-text" if failed else ""}">{s["passed"]}/{s["tests"]}</span></summary>
              <ul class="tests">{_test_rows([{"title": c["name"], "status": c["status"], "duration": c["time"] * 1000,
                                               "failureMessages": [c["failure"]] if c.get("failure") else []} for c in s["cases"]])}</ul>
            </details>'''
        a_p = sum(s["passed"] for s in android_suites)
        a_f = sum(s["failures"] + s["errors"] for s in android_suites)
        android = f'''<article class="card platform">
          <div class="card-top"><h3>Android</h3>{status_badge("fail" if a_f else "pass")}</div>
          <p class="sub">JUnit + Robolectric on the JVM (ubuntu), {_n(len(android_suites), "suite")}.</p>
          {_bar(a_p, a_f, a_p + a_f)}
          <details class="files"{" open" if a_f else ""}><summary>{_n(len(android_suites), "suite")}</summary>{rows}</details>
        </article>'''
    else:
        android = f'''<article class="card platform">
          <div class="card-top"><h3>Android</h3>{status_badge("off")}</div>
          <p class="sub">{_esc(android_meta.get("note") or "No JUnit results in this run.")}</p></article>'''
    # Apple
    apple = f'''<article class="card platform">
      <div class="card-top"><h3>Apple (XCTest)</h3>{_elsewhere_badge(apple_elsewhere) if apple_elsewhere and not apple_meta["executed"] else status_badge(_state(apple_meta["status"]) if apple_meta["executed"] else "off")}</div>
      <p class="sub">{_esc(apple_meta.get("note") or "Runs in the Apple Tests workflow on a macOS runner.")}</p>{apple_elsewhere["line"] if apple_elsewhere and not apple_meta["executed"] else ""}</article>'''
    # Robot
    if robot:
        suites = ""
        for s in robot["suites"]:
            cases = [c for sc in s["scenarios"] for c in sc["cases"]]
            suites += f'''<details class="file"{" open" if s["failed"] else ""}>
              <summary><span class="fpath">{_esc(s["source"])}</span><span class="fcount {"bad-text" if s["failed"] else ""}">{s["passed"]}/{s["total"]}</span></summary>
              <ul class="tests">{_test_rows([{"title": c["name"], "status": c["status"], "duration": c["elapsed_s"] * 1000,
                                               "failureMessages": [c["message"]] if c["status"] == "failed" and c.get("message") else []} for c in cases])}</ul>
            </details>'''
        robot_card = f'''<article class="card platform wide">
          <div class="card-top"><h3>ESP32 Robot Framework</h3>{status_badge("fail" if robot["failed"] else "pass")}</div>
          <p class="sub">Physical boards in the maintainer's lab: {", ".join(_esc(BOARD_LABELS.get(b, b)) for b in robot["boards"]) or "no board tags"}.</p>
          {_bar(robot["passed"], robot["failed"], robot["passed"] + robot["failed"])}
          {_build_robot_perf_table(robot)}
          <details class="files"{" open" if robot["failed"] else ""}><summary>{_n(len(robot["suites"]), "suite")}</summary>{suites}</details>
        </article>'''
    else:
        robot_card = f'''<article class="card platform">
          <div class="card-top"><h3>ESP32 Robot Framework</h3>{_elsewhere_badge(robot_elsewhere) if robot_elsewhere else status_badge("off")}</div>
          <p class="sub">{_esc(robot_meta.get("note") or "Physical hardware suite; not run on GitHub-hosted runners.")}</p>{robot_elsewhere["line"] if robot_elsewhere else ""}</article>'''
    return f'<div class="grid platforms">{android}{apple}{robot_card}</div>'

# --- Scenarios ---------------------------------------------------------------

def _scenario_cell(cat):
    t = cat["total"]
    if t == 0:
        return '<td class="num quiet" title="No tests mapped">—</td>'
    p, f, m, nr = cat["passed"], cat["failed"], cat["missing"], cat.get("not_run", 0)
    st = "fail" if f else ("pass" if p == t else "off")
    parts = [x for x in (f"{p} passed" if p else "", f"{f} failed" if f else "",
                         f"{m} not found in this run" if m else "", f"{nr} not executed here" if nr else "") if x]
    return f'<td class="num"><span class="dot {st}"></span>{p}/{t}<span class="sr"> — {", ".join(parts)}</span></td>'

def _render_scenarios(scenario_results):
    rows = ""
    for sc in scenario_results:
        cats = sc["categories"]
        gaps = "".join(f"<li>{_esc(g)}</li>" for g in sc.get("gaps", []))
        rows += f'''<tr>
          <th scope="row"><strong>{_esc(sc["name"])}</strong><span class="fine">{_esc(sc["description"])}</span></th>
          <td><span class="tag">{_esc(sc["priority"])}</span></td>
          {_scenario_cell(cats["unit"])}{_scenario_cell(cats["integration"])}{_scenario_cell(cats["platform"])}{_scenario_cell(cats["e2e"])}
          <td><ul class="ticks no">{gaps}</ul></td>
        </tr>'''
    return f'''<div class="card flush"><div class="scroll"><table class="data">
      <thead><tr><th>Scenario</th><th>Priority</th><th class="num">Unit</th><th class="num">Integration</th><th class="num">Platform</th><th class="num">E2E</th><th>Known gaps</th></tr></thead>
      <tbody>{rows}</tbody></table></div></div>'''

# --- Coverage ----------------------------------------------------------------

def _render_coverage(cov_total, pkg_cov):
    thresholds = read_coverage_thresholds()
    floors = ""
    for label, key in (("Lines", "lines"), ("Statements", "statements"), ("Functions", "functions"), ("Branches", "branches")):
        pct = cov_total.get(key, {}).get("pct", 0)
        floor = thresholds.get(key)
        ok = floor is None or pct >= floor
        floors += f'''<div class="card tile">
          <p class="kicker">{label}</p>
          <p class="tile-value {"" if ok else "bad-text"}">{pct:.1f}%</p>
          <div class="meter"><span class="{"ok" if ok else "bad"}" style="width:{min(pct, 100):.1f}%"></span>{f'<i style="left:{floor:.1f}%" title="floor {floor:g}%"></i>' if floor is not None else ""}</div>
          <p class="fine">{f"floor {floor:g}% · {'above' if ok else 'BELOW'}" if floor is not None else "no floor configured"}</p>
        </div>'''
    pkgs = ""
    for name in sorted(pkg_cov):
        data = pkg_cov[name]
        lp = data["lines"]["pct"]
        pkgs += f'''<div class="card tile">
          <p class="kicker">{_esc(name)}</p>
          <p class="tile-value">{lp:.1f}%</p>
          <div class="meter"><span class="ok" style="width:{min(lp, 100):.1f}%"></span></div>
          <p class="fine">{data["lines"]["covered"]:,} / {data["lines"]["total"]:,} lines · {_n(len(data["files"]), "file")}</p>
        </div>'''
    files = sorted((f for d in pkg_cov.values() for f in d["files"]), key=lambda f: (f["lines_pct"], f["path"]))
    rows = "".join(f'''<tr><td><code>{_esc(f["path"])}</code></td>
        <td class="num">{f["lines_pct"]:.0f}%</td><td class="num">{f["stmts_pct"]:.0f}%</td>
        <td class="num">{f["funcs_pct"]:.0f}%</td><td class="num">{f["branch_pct"]:.0f}%</td></tr>''' for f in files)
    return f'''<div class="grid tiles four">{floors}</div>
      <h3 class="sub-head">By package</h3>
      <div class="grid tiles four">{pkgs}</div>
      <details class="card files"><summary>{len(files)} source files, least covered first</summary>
        <div class="scroll"><table class="data"><thead><tr><th>File</th><th class="num">Lines</th><th class="num">Stmts</th><th class="num">Funcs</th><th class="num">Branch</th></tr></thead>
        <tbody>{rows}</tbody></table></div></details>'''

# --- Page --------------------------------------------------------------------

def _apple_elsewhere(workflow_status, commit):
    run = workflow_status.get(".github/workflows/apple-test.yml")
    if not run:
        return None
    st = _RUN_STATE.get(run.get("conclusion"), "off")
    label = {"pass": "Passed in CI", "fail": "Failed in CI"}.get(st, "Apple Tests: " + (run.get("conclusion") or "unknown"))
    return {"state": st, "label": label, "line": _hosted_line(run, commit)}

def _robot_elsewhere(recorded):
    step = _receipt_step(recorded, "esp32-robot")
    if not step or not step.get("attested"):
        return None
    st = {"pass": "pass", "fail": "fail"}.get(step.get("status"), "off")
    label = {"pass": "Attested pass", "fail": "Attested fail"}.get(st, "Attested skip")
    line = (f'<p class="hosted"><span class="dot {st}"></span>Pre-release check <code>{_esc((recorded.get("commit") or "")[:7])}</code>'
            f' · {_esc((recorded.get("finished_at") or "")[:10])}{" · " + _esc(step["note"]) if step.get("note") else ""}</p>')
    return {"state": st, "label": label, "line": line}

def generate_html(vitest, android_suites, cov_data, scenarios, scenario_results, history, metadata, robot=None,
                  workflow_status=None, recorded=None, this_run=None):
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    commit = os.environ.get("GITHUB_SHA", "")[:7]
    workflow_status = workflow_status or {}
    apple_elsewhere = _apple_elsewhere(workflow_status, commit)
    robot_elsewhere = _robot_elsewhere(recorded)
    vitest_meta = suite_meta(metadata, "vitest")
    e2e_meta = suite_meta(metadata, "e2e")
    android_meta = suite_meta(metadata, "android")
    apple_meta = suite_meta(metadata, "apple")
    robot_meta = suite_meta(metadata, "robot")

    # Per-file data (Vitest + E2E share the reporter format).
    vt_file_data = {}
    for result in (vitest or {}).get("testResults", []):
        name = result["name"].replace(str(ROOT) + "/", "")
        assertions = result.get("assertionResults", [])
        vt_file_data[name] = {
            "passed": sum(1 for a in assertions if a["status"] == "passed"),
            "failed": sum(1 for a in assertions if a["status"] == "failed"),
            "skipped": sum(1 for a in assertions if a["status"] not in ("passed", "failed")),
            "dur": max(0, result.get("endTime", 0) - result.get("startTime", 0)),
            "assertions": assertions,
        }
    is_e2e = lambda f: f.startswith("tests/e2e/")
    def agg(pred):
        files = [f for f in vt_file_data if pred(f)]
        return (sum(vt_file_data[f]["passed"] for f in files), sum(vt_file_data[f]["failed"] for f in files),
                len(files), sum(vt_file_data[f]["dur"] for f in files))
    vt_p, vt_f, vt_n, vt_ms = agg(lambda f: not is_e2e(f))
    e2_p, e2_f, e2_n, e2_ms = agg(is_e2e)
    an_p = sum(s["passed"] for s in android_suites)
    an_f = sum(s["failures"] + s["errors"] for s in android_suites)
    an_ms = sum(s["time"] for s in android_suites) * 1000
    rb_p = robot["passed"] if robot else 0
    rb_f = robot["failed"] if robot else 0

    total_passed = vt_p + e2_p + an_p + rb_p
    total_failed = vt_f + e2_f + an_f + rb_f
    total_all = total_passed + total_failed
    overall = "fail" if total_failed else "pass"

    cov_total = cov_data.get("total", {}) if cov_data else {}
    lines_pct = cov_total.get("lines", {}).get("pct", 0)
    pkg_cov = extract_package_coverage(cov_data) if cov_data else {}

    stats = [
        ("Result", "Pass" if overall == "pass" else "Fail", "ok-text" if overall == "pass" else "bad-text",
         f"{total_all:,} tests executed"),
        ("Passed", f"{total_passed:,}", "", f"{(total_passed / total_all * 100) if total_all else 0:.2f}% of executed"),
        ("Failed", f"{total_failed:,}", "bad-text" if total_failed else "", "across every suite run here"),
        ("Wall time", duration_fmt(vt_ms + e2_ms + an_ms), "", "summed per-file test time"),
        ("Line coverage", f"{lines_pct:.1f}%" if cov_data else "—", "", "TypeScript packages"),
    ]
    suites = [
        {"name": "Vitest", "what": "TypeScript unit, contract and integration tests.", "meta": vitest_meta,
         "passed": vt_p, "failed": vt_f, "files": vt_n, "unit": "Files", "ms": vt_ms},
        {"name": "Daemon E2E", "what": "The real daemon process, driven from outside.", "meta": e2e_meta,
         "passed": e2_p, "failed": e2_f, "files": e2_n, "unit": "Files", "ms": e2_ms},
        {"name": "Android", "what": "JUnit + Robolectric.", "meta": android_meta,
         "passed": an_p, "failed": an_f, "files": len(android_suites), "unit": "Suites", "ms": an_ms},
        {"name": "Apple (XCTest)", "what": "macOS app and in-process Swift daemon.", "meta": apple_meta,
         "passed": 0, "failed": 0, "files": 0, "unit": "Suites", "ms": 0, "elsewhere": apple_elsewhere},
        {"name": "ESP32 Robot", "what": "Flash, boot and serial protocol on real boards.", "meta": robot_meta,
         "passed": rb_p, "failed": rb_f, "files": len(robot["suites"]) if robot else 0, "unit": "Suites", "ms": 0,
         "elsewhere": robot_elsewhere},
    ]

    sparks = "".join(x for x in (sparkline_svg(history, "total", "Tests"),
                                 sparkline_svg(history, "passed", "Pass rate"),
                                 sparkline_svg(history, "coverage", "Line coverage")) if x)
    history_html = (f'<div class="grid tiles three">{sparks}</div>' if sparks
                    else '<p class="quiet">Trends appear once two or more master runs are recorded.</p>')

    sections = [
        ("run", "Latest run", "Every suite this page executed, and the ones it only links to."),
        ("tiers", "Verification tiers", "Changed-area, quick and pre-release checks, and the last receipt."),
        ("verify", "What we verify", "Each gate, where it runs, and what it does not prove."),
        ("domains", "Test domains", "Every test file, grouped by the question it answers."),
        ("platforms", "Platforms", "Android, Apple and hardware suites."),
        ("scenarios", "Scenarios", "User flows mapped to the tests that cover them."),
        ("coverage", "Coverage", "TypeScript coverage against the enforced floor."),
        ("history", "History", "Trends across recent master runs."),
    ]
    if not scenario_results:
        sections = [s for s in sections if s[0] != "scenarios"]
    jump = "".join(f'<a href="#{sid}">{_esc(title)}</a>' for sid, title, _ in sections)

    body = ""
    body += f'<section>{_section_head("run", "Build health", "Latest run", "What this page ran on the merged master commit. Suites that need a macOS runner or physical boards run elsewhere and are marked as not run here — never counted as passing.")}{_render_run(stats, suites, _render_skipped(_skipped_cases(vt_file_data, CATALOG)))}</section>'
    body += f'<section>{_section_head("tiers", "Layers", "Verification tiers", "Three local tiers run the same catalog steps at three depths: <code>pnpm verify:changed</code> while iterating, <code>pnpm verify:quick</code> before a push, <code>pnpm verify:full</code> before a release. The pre-release receipt is committed, so this page shows what the last release check ran, skipped and attested.")}{_render_tiers(CATALOG, recorded, this_run)}</section>'
    body += f'<section>{_section_head("verify", "Transparency", "What we verify", "Every check the project runs, where it runs, and what it does <em>not</em> prove. Generated from <code>scripts/verification-catalog.json</code>; CI fails if that file stops matching the repository.")}{_render_verify(CATALOG, metadata, workflow_status, recorded, commit)}</section>'
    body += f'<section>{_section_head("domains", "Vitest + E2E", "Test domains", "Every TypeScript and end-to-end test file, grouped by the question it answers. Open a domain for its files and each test.")}{_render_domains(vt_file_data)}</section>'
    body += f'<section>{_section_head("platforms", "Native and hardware", "Platforms", "Suites outside the TypeScript toolchain. Apple and hardware results are recorded by their own workflows and the lab.")}{_render_platforms(android_suites, android_meta, apple_meta, robot, robot_meta, apple_elsewhere, robot_elsewhere)}</section>'
    if scenario_results:
        body += f'<section>{_section_head("scenarios", "User flows", "Scenarios", "Each flow maps to specific tests by file and case name (<code>scripts/scenario-matrix.json</code>). A dash means no test at that level — listed with the known gaps.")}{_render_scenarios(scenario_results)}</section>'
    if cov_data:
        body += f'<section>{_section_head("coverage", "Vitest --coverage", "Coverage", "Line, statement, function and branch coverage of bridge, shared, plugin and hooks. The floors are read from <code>vitest.config.ts</code> and enforced on every pull request.")}{_render_coverage(cov_total, pkg_cov)}</section>'
    body += f'<section>{_section_head("history", "Trend", "History", "Totals from the last runs of this page on master.")}{history_html}</section>'

    commit_bit = f" · commit {_esc(commit)}" if commit else ""
    gnb = render_gnb()
    gnb_css = render_gnb_css()
    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentDeck — Test Report</title>
<meta name="description" content="AgentDeck build health: every test suite run on master, what each verification gate proves, and what is not verified automatically.">
<link rel="icon" type="image/png" href="../icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&amp;family=IBM+Plex+Sans+KR:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500;600;700&amp;display=swap" rel="stylesheet">
<style>
:root {{
  --tide-50:#f5f3ec; --tide-100:#ebe6d6; --tide-200:#d8cfb6; --tide-300:#a8b09a;
  --ink-900:#0e1f1f; --ink-800:#15302f; --ink-700:#1f4544; --ink-500:#426664; --ink-300:#7c9694;
  --kelp-700:#1f6157; --kelp-500:#2f8a7c; --kelp-300:#6fb6a8;
  --coral-500:#c0573a; --coral-700:#8c3a23; --amber-500:#c8923a;
  --status-idle:var(--ink-300); --status-processing:var(--kelp-500); --status-error:var(--coral-500);
  --font-sans:"IBM Plex Sans","IBM Plex Sans KR","IBM Plex Sans JP",-apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  --font-mono:"JetBrains Mono","IBM Plex Mono",ui-monospace,monospace;
  --s-1:4px; --s-2:8px; --s-3:12px; --s-4:16px; --s-5:20px; --s-6:24px; --s-8:32px; --s-10:40px; --s-12:48px; --s-16:64px; --s-20:80px;
  --t-page-title:clamp(38px, 5vw, 64px); --tr-hero:-0.035em; --t-h2:44px; --tr-h2:-0.02em; --t-lede:18px;
  --t-card-title:19px; --t-small:14.5px; --t-caption:13px; --t-kicker:12px; --tr-kicker:0.18em; --tr-chip:0.08em;
  --container-max:1240px; --container-pad:32px;
  --r-sm:4px; --r-md:8px; --r-xl:12px; --r-2xl:14px; --r-pill:999px;
  --sh-card:0 6px 20px -8px rgba(14, 31, 31, 0.45);
}} /* canonical names mirror design/tokens.css — gated by verify-tokens-sync.py */
* {{ box-sizing:border-box; }}
html {{ -webkit-text-size-adjust:100%; scroll-behavior:smooth; }}
body {{ margin:0; font-family:var(--font-sans); font-feature-settings:"ss01","cv11"; color:var(--ink-900); background:var(--tide-50); line-height:1.55; -webkit-font-smoothing:antialiased; }}
a {{ color:var(--kelp-700); }}
code, pre, .mono {{ font-family:var(--font-mono); font-feature-settings:"zero","ss01"; }}
{gnb_css}
.wrap {{ max-width:var(--container-max); margin:0 auto; padding:var(--s-10) var(--container-pad) var(--s-20); }}
.kicker {{ font-family:var(--font-mono); font-size:var(--t-kicker); font-weight:600; letter-spacing:var(--tr-kicker); text-transform:uppercase; color:var(--kelp-700); margin:0 0 var(--s-3); }}
h1 {{ font-size:var(--t-page-title); letter-spacing:var(--tr-hero); line-height:1.02; margin:0 0 var(--s-4); }}
.lede {{ font-size:var(--t-lede); color:var(--ink-700); max-width:68ch; margin:0; }}
.run-chip {{ display:inline-flex; align-items:center; gap:var(--s-2); margin:var(--s-6) 0 0; padding:6px 14px; background:var(--tide-100); border-radius:var(--r-pill); font-family:var(--font-mono); font-size:12.5px; letter-spacing:var(--tr-chip); color:var(--ink-700); }}
.jump {{ display:flex; gap:var(--s-2); flex-wrap:wrap; margin:var(--s-10) 0 0; padding:var(--s-3); background:var(--tide-100); border:1px solid var(--tide-200); border-radius:var(--r-xl); }}
.jump a {{ text-decoration:none; font-family:var(--font-mono); font-size:var(--t-kicker); padding:6px 10px; border-radius:var(--r-pill); }}
.jump a:hover {{ background:var(--tide-200); }}
.section-head {{ display:grid; grid-template-columns:minmax(0,1fr) minmax(280px,44%); gap:var(--s-8); align-items:end; margin:var(--s-20) 0 var(--s-6); padding-bottom:var(--s-4); border-bottom:2px solid var(--tide-200); scroll-margin-top:var(--s-16); }}
.section-head .kicker {{ margin-bottom:var(--s-2); }}
h2 {{ font-size:clamp(30px,4vw,var(--t-h2)); letter-spacing:var(--tr-h2); line-height:1.08; margin:0; }}
.section-head p:last-child {{ color:var(--ink-500); margin:0; }}
.sub-head {{ font-size:var(--t-card-title); letter-spacing:-0.01em; margin:var(--s-10) 0 var(--s-4); }}
.grid {{ display:grid; gap:var(--s-4); }}
.tiles {{ grid-template-columns:repeat(5,minmax(0,1fr)); }}
.tiles.four {{ grid-template-columns:repeat(4,minmax(0,1fr)); }}
.tiles.three {{ grid-template-columns:repeat(3,minmax(0,1fr)); }}
.suites {{ grid-template-columns:repeat(5,minmax(0,1fr)); margin-top:var(--s-4); }}
.gates, .domains, .platforms {{ grid-template-columns:repeat(3,minmax(0,1fr)); }}
.gaps {{ grid-template-columns:repeat(3,minmax(0,1fr)); }}
.card {{ display:flex; flex-direction:column; background:var(--tide-100); border:1px solid var(--tide-200); border-radius:var(--r-2xl); padding:var(--s-4); box-shadow:var(--sh-card); min-width:0; }}
.card.flush {{ padding:0; overflow:hidden; }}
.card h3 {{ font-size:var(--t-card-title); letter-spacing:-0.01em; line-height:1.25; margin:0; }}
.card .sub {{ color:var(--ink-500); font-size:var(--t-caption); margin:4px 0 var(--s-4); }}
.card-top {{ display:flex; align-items:flex-start; justify-content:space-between; gap:var(--s-3); margin-bottom:var(--s-2); }}
.card-top .kicker {{ margin:0; }}
.card-foot {{ margin:auto 0 0; padding-top:var(--s-3); font-size:var(--t-caption); }}
.tile .kicker {{ margin-bottom:var(--s-2); }}
.tile-value {{ font-size:34px; font-weight:600; letter-spacing:-0.02em; line-height:1.1; margin:0 0 var(--s-2); font-variant-numeric:tabular-nums; }}
.fine {{ color:var(--ink-500); font-size:var(--t-caption); margin:0; }}
.quiet {{ color:var(--ink-500); }}
.ok-text {{ color:var(--kelp-700); }}
.bad-text {{ color:var(--coral-700); }}
.badge {{ flex:0 0 auto; font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:var(--tr-chip); text-transform:uppercase; padding:3px 8px; border-radius:var(--r-pill); white-space:nowrap; }}
.badge.pass {{ background:var(--kelp-700); color:var(--tide-50); }}
.badge.fail {{ background:var(--coral-500); color:var(--tide-50); }}
.badge.off {{ background:var(--tide-200); color:var(--ink-700); }}
.badge.gate {{ background:var(--ink-800); color:var(--tide-50); }}
.badge.elsewhere {{ background:transparent; color:var(--kelp-700); box-shadow:inset 0 0 0 1px var(--kelp-700); }}
.tiers, .receipts {{ grid-template-columns:repeat(3,minmax(0,1fr)); }}
.receipts {{ grid-template-columns:repeat(2,minmax(0,1fr)); }}
.tier .cmd {{ margin:0 0 var(--s-2); }}
.prose {{ margin:0; font-size:var(--t-caption); color:var(--ink-700); }}
.prose.quiet {{ color:var(--ink-500); }}
table.matrix td.c, table.matrix th.c {{ text-align:center; white-space:nowrap; }}
table.matrix .in {{ color:var(--kelp-700); font-size:var(--t-caption); }}
table.matrix td .fine, table.matrix th .fine {{ display:block; font-size:11px; }}
table.matrix td.c .fine {{ max-width:16ch; margin:0 auto; overflow:hidden; text-overflow:ellipsis; }}
.matrix-note {{ margin:var(--s-3) 0 0; max-width:96ch; }}
.hosted {{ margin:0 0 4px; font-size:var(--t-caption); color:var(--ink-700); }}
.card-foot p {{ margin:0; }}
.tierline {{ display:flex; flex-wrap:wrap; align-items:center; gap:4px; margin:var(--s-3) 0 0; }}
.tierline .label {{ margin:0 var(--s-2) 0 0; }}
details.skipped {{ margin-top:var(--s-4); }}
details.skipped > summary {{ padding:0; }}
details.skipped td .fine {{ display:block; }}
.tags {{ display:flex; flex-wrap:wrap; gap:4px; }}
.tag {{ font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:var(--tr-chip); text-transform:uppercase; padding:2px 6px; border-radius:var(--r-sm); background:var(--tide-200); color:var(--ink-700); }}
.dot {{ display:inline-block; width:6px; height:6px; border-radius:var(--r-pill); margin-right:6px; vertical-align:middle; }}
.dot.pass {{ background:var(--status-processing); box-shadow:0 0 0 2px color-mix(in srgb, var(--status-processing) 33%, transparent); }}
.dot.fail {{ background:var(--status-error); box-shadow:0 0 0 2px color-mix(in srgb, var(--status-error) 33%, transparent); }}
.dot.off {{ background:var(--status-idle); box-shadow:0 0 0 2px color-mix(in srgb, var(--status-idle) 33%, transparent); }}
.rail, .meter {{ position:relative; display:flex; height:6px; border-radius:var(--r-pill); background:var(--tide-200); overflow:hidden; margin:0 0 var(--s-3); }}
.rail .ok, .meter .ok {{ background:var(--kelp-500); }}
.rail .bad, .meter .bad {{ background:var(--coral-500); }}
.meter i {{ position:absolute; top:0; bottom:0; width:2px; background:var(--ink-900); }}
.specs {{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:var(--s-3); margin:0; }}
.suite .specs {{ grid-template-columns:1fr 1fr; }}
.specs div {{ padding-top:var(--s-2); border-top:1px solid var(--tide-200); min-width:0; }}
.specs dt {{ font-family:var(--font-mono); font-size:10px; letter-spacing:var(--tr-chip); text-transform:uppercase; color:var(--ink-500); }}
.specs dd {{ margin:2px 0 0; font-size:var(--t-caption); font-weight:600; font-variant-numeric:tabular-nums; }}
.label {{ font-family:var(--font-mono); font-size:10px; letter-spacing:var(--tr-chip); text-transform:uppercase; color:var(--ink-500); margin:var(--s-3) 0 4px; }}
.two {{ display:grid; grid-template-columns:1fr 1fr; gap:var(--s-4); }}
.ticks {{ margin:0; padding:0; list-style:none; font-size:var(--t-caption); }}
.ticks li {{ position:relative; padding-left:16px; margin-bottom:6px; }}
.ticks li::before {{ content:"✓"; position:absolute; left:0; color:var(--kelp-700); }}
.ticks.no li {{ color:var(--ink-500); }}
.ticks.no li::before {{ content:"–"; color:var(--ink-500); }}
.cmd {{ margin:var(--s-3) 0 0; }}
.cmd code {{ display:block; font-size:11.5px; color:var(--tide-50); background:var(--ink-900); padding:var(--s-2) var(--s-3); border-radius:var(--r-md); overflow-x:auto; white-space:pre-wrap; word-break:break-word; }}
.gap p:not(.label) {{ margin:0; color:var(--ink-700); font-size:var(--t-caption); }}
.legend {{ margin-top:var(--s-6); }}
.legend + .grid {{ margin-top:var(--s-6); }}
.legend dl {{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:var(--s-3) var(--s-6); margin:0; }}
.legend dt {{ font-family:var(--font-mono); font-size:var(--t-kicker); font-weight:600; }}
.legend dd {{ margin:2px 0 0; color:var(--ink-500); font-size:var(--t-caption); }}
details summary {{ cursor:pointer; }}
details.files {{ margin-top:var(--s-4); }}
details.files > summary {{ font-family:var(--font-mono); font-size:var(--t-kicker); color:var(--kelp-700); padding:var(--s-2) 0; }}
details.card.files > summary {{ padding:0; }}
details.file {{ border-top:1px solid var(--tide-200); }}
details.file > summary {{ display:flex; justify-content:space-between; gap:var(--s-3); padding:var(--s-2) 0; font-size:var(--t-caption); list-style-position:inside; }}
.fpath {{ font-family:var(--font-mono); font-size:11.5px; overflow-wrap:anywhere; }}
.fcount {{ font-family:var(--font-mono); font-size:11.5px; color:var(--ink-500); flex:0 0 auto; }}
.fcount.bad-text {{ color:var(--coral-700); }}
.tests {{ list-style:none; margin:0 0 var(--s-3); padding:0; }}
.t {{ display:grid; grid-template-columns:16px minmax(0,1fr) auto; gap:var(--s-2); padding:3px 0; font-size:12.5px; color:var(--ink-700); }}
.t .mark {{ font-family:var(--font-mono); }}
.t.pass .mark {{ color:var(--kelp-700); }}
.t.fail .mark, .t.fail .tname {{ color:var(--coral-700); }}
.t.off .mark, .t.off .tname {{ color:var(--ink-500); }}
.tdur {{ font-family:var(--font-mono); font-size:11px; color:var(--ink-500); }}
.failure {{ grid-column:2 / -1; margin:4px 0; padding:var(--s-2) var(--s-3); background:var(--tide-50); border:1px solid var(--coral-500); border-radius:var(--r-md); font-size:11px; white-space:pre-wrap; overflow-x:auto; color:var(--ink-900); }}
.scroll {{ position:relative; overflow-x:auto; min-width:0; max-width:100%; }}
table.data {{ width:100%; border-collapse:collapse; font-size:var(--t-caption); }}
table.data th, table.data td {{ text-align:left; vertical-align:top; padding:var(--s-3) var(--s-4); border-bottom:1px solid var(--tide-200); }}
table.data thead th {{ font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:var(--tr-chip); text-transform:uppercase; color:var(--ink-500); background:var(--tide-100); }}
table.data tbody th {{ font-weight:400; min-width:220px; }}
table.data tbody th strong {{ display:block; font-weight:600; }}
table.data tbody tr:last-child > * {{ border-bottom:0; }}
table.data .num {{ text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }}
table.data code {{ font-size:11.5px; }}
.card table.data {{ background:var(--tide-50); }}
.sr {{ position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }}
.plain {{ margin:0; padding-left:var(--s-4); font-size:var(--t-caption); }}
.spark svg {{ width:100%; height:48px; display:block; margin:var(--s-2) 0; }}
.spark-value {{ font-size:28px; font-weight:600; letter-spacing:-0.02em; margin:0; font-variant-numeric:tabular-nums; }}
footer {{ max-width:var(--container-max); margin:0 auto; padding:var(--s-10) var(--container-pad) var(--s-16); border-top:2px solid var(--tide-200); color:var(--ink-500); font-size:var(--t-caption); }}
@media (max-width:1100px) {{
  .tiles, .suites {{ grid-template-columns:repeat(3,minmax(0,1fr)); }}
  .tiers {{ grid-template-columns:1fr; }}
  .legend dl {{ grid-template-columns:repeat(2,minmax(0,1fr)); }}
}}
@media (max-width:900px) {{
  .gates, .domains, .platforms, .gaps, .tiles.four, .tiles.three {{ grid-template-columns:repeat(2,minmax(0,1fr)); }}
  .receipts {{ grid-template-columns:1fr; }}
  .section-head {{ grid-template-columns:1fr; gap:var(--s-2); }}
}}
@media (max-width:640px) {{
  /* Tokens stay canonical (this :root is a gated mirror); narrow gutters
     are applied to the elements with the 16px spacing token instead. */
  .wrap {{ padding:var(--s-12) var(--s-4) var(--s-16); }}
  footer {{ padding-left:var(--s-4); padding-right:var(--s-4); }}
  .tiles, .suites, .gates, .domains, .platforms, .gaps, .tiles.four, .tiles.three, .two, .legend dl {{ grid-template-columns:1fr; }}
  .specs {{ grid-template-columns:1fr 1fr; }}
}}
</style>
</head>
<body>
{gnb}
<main class="wrap">
  <header>
    <p class="kicker">AgentDeck · Build health</p>
    <h1>Test Report</h1>
    <p class="lede">The latest master run, in full: what passed, what each check proves and does not prove, and where the gaps are. This is the maintainer's evidence that the build works — not a product analytics dashboard.</p>
    <p class="run-chip"><span class="dot {overall}"></span>{"Pass" if overall == "pass" else "Fail"} · {total_all:,} tests{commit_bit} · generated {now}</p>
  </header>
  <nav class="jump" aria-label="Sections">{jump}</nav>
  {body}
</main>
<footer>
  Generated by <code>scripts/generate-html-report.py</code> from this run's Vitest, E2E, JUnit and Robot results.
  Machine-readable: <a href="summary.json">summary.json</a> · <a href="run-metadata.json">run-metadata.json</a> · <a href="history.json">history.json</a> · <a href="verification-catalog.json">verification-catalog.json</a>.
</footer>
<script>
// Site-wide language choice (Build Health's body stays English — CI evidence,
// not authored copy); the selector only persists the choice for other routes.
(function () {{
  var el = document.getElementById('lang');
  if (!el) return;
  var KEY = 'agentdeck-design-locale';
  try {{
    var saved = localStorage.getItem(KEY) || 'en';
    if (['en', 'ko', 'ja'].indexOf(saved) >= 0) el.value = saved;
  }} catch (e) {{}}
  el.addEventListener('change', function () {{ try {{ localStorage.setItem(KEY, el.value); }} catch (e) {{}} }});
}})();
</script>
</body>
</html>
'''


def main():
    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    e2e = load_e2e()
    vitest = merge_e2e(load_vitest(), e2e)
    android = load_android_xml()
    cov = load_coverage()
    robot = load_robot_xml()
    scenarios = load_scenarios()
    history = load_history()
    metadata = load_metadata()
    if not metadata:
        metadata = build_default_metadata(vitest, android, robot, e2e)
        METADATA_JSON.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    else:
        # Reconcile metadata with actual data presence — override stale not-run flags
        suites = metadata.setdefault("suites", {})
        if vitest and not suites.get("vitest", {}).get("executed"):
            suites["vitest"] = {"status": "pass" if vitest.get("numFailedTests", 0) == 0 else "fail", "executed": True, "note": ""}
        if e2e and not suites.get("e2e", {}).get("executed"):
            suites["e2e"] = {"status": "pass" if e2e.get("numFailedTests", 0) == 0 else "fail", "executed": True, "note": ""}
        if android and not suites.get("android", {}).get("executed"):
            af = sum(s["failures"] + s["errors"] for s in android)
            suites["android"] = {"status": "pass" if af == 0 else "fail", "executed": True, "note": ""}
        if robot and not suites.get("robot", {}).get("executed"):
            suites["robot"] = {"status": "pass" if robot["failed"] == 0 else "fail", "executed": True, "note": ""}

    if not vitest and not android and not robot:
        print("No test results found. Run 'pnpm test:report' first.")
        sys.exit(1)

    # Build scenario cross-reference
    scenario_results = build_scenario_results(scenarios, vitest, android, metadata) if scenarios else []

    # Compute stats for history
    vt_passed = vitest["numPassedTests"] if vitest else 0
    vt_failed = vitest["numFailedTests"] if vitest else 0
    vt_total = vitest["numTotalTests"] if vitest else 0
    and_passed = sum(s["passed"] for s in android)
    and_failed = sum(s["failures"] + s["errors"] for s in android)
    and_total = sum(s["tests"] for s in android)
    rob_passed = robot["passed"] if robot else 0
    rob_failed = robot["failed"] if robot else 0
    rob_total = robot["total"] if robot else 0
    total_passed = vt_passed + and_passed + rob_passed
    total_failed = vt_failed + and_failed + rob_failed
    total_all = vt_total + and_total + rob_total
    cov_total = cov.get("total", {}) if cov else {}
    lines_pct = cov_total.get("lines", {}).get("pct", 0)

    # Update history
    history = update_history(history, total_passed, total_failed, total_all, lines_pct, metadata)

    write_summary(metadata, total_passed, total_failed, total_all)
    html = generate_html(vitest, android, cov, scenarios, scenario_results, history, metadata, robot,
                         load_workflow_status(), load_recorded_receipt(), load_this_run_receipt())
    OUTPUT_HTML.write_text(html, encoding="utf-8")
    print(f"HTML report: {OUTPUT_HTML}")


if __name__ == "__main__":
    main()
