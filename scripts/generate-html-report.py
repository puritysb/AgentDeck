#!/usr/bin/env python3
"""
AgentDeck Build Health — HTML Generator

Reads Vitest + E2E JSON, Android JUnit XML, Robot output.xml, coverage-summary.json,
scripts/scenario-matrix.json and scripts/verification-catalog.json, and writes one
self-contained page in the Pages design language (aquarium-tide tokens only):
  - Latest run: result tiles + one card per suite (run here, or linked)
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
            "vitest": {"status": ("fail" if vitest.get("numFailedTests", 0) or vitest.get("numFailedTestSuites", 0) or any(r.get("status") == "failed" for r in vitest.get("testResults", [])) else "pass") if vitest else "not-run", "executed": bool(vitest), "note": ""},
            "e2e": {"status": ("pass" if e2e.get("numFailedTests", 0) == 0 else "fail") if e2e else "not-run", "executed": bool(e2e), "note": ""},
            "android": {"status": ("fail" if any(x["failures"] or x["errors"] for x in android) else "pass") if android else "not-run", "executed": bool(android), "note": ""},
            "apple": {"status": "not-run", "executed": False, "note": "No Apple result parser input"},
            "robot": {"status": ("fail" if robot["failed"] else "pass") if robot else "not-run", "executed": bool(robot), "note": ""},
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
                return {"status": "fail" if found["failed"] else "pass" if found["passed"] and all(a["status"] == "passed" for a in found["assertions"]) else "partial" if found["passed"] else "not-run", "passed": found["passed"], "failed": found["failed"]}
            matched = [a for a in found.get("assertions", []) if pattern_matches(full_assertion_name(a), patterns)]
            if not matched:
                return {"status": "missing", "passed": 0, "failed": 0}
            passed = sum(1 for a in matched if a["status"] == "passed")
            failed = sum(1 for a in matched if a["status"] == "failed")
            return {"status": "fail" if failed else "pass" if passed == len(matched) else "partial" if passed else "not-run", "passed": passed, "failed": failed}

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
            cat_result = {"tests": [], "passed": 0, "failed": 0, "missing": 0, "not_run": 0, "partial": 0, "total": len(test_entries)}

            for entry in test_entries:
                resolved = resolve_entry(entry)
                cat_result["tests"].append({"file": entry["file"], "status": resolved["status"],
                                            "passed": resolved["passed"], "failed": resolved["failed"]})
                if resolved["status"] == "fail":
                    cat_result["failed"] += 1
                elif resolved["status"] == "pass":
                    cat_result["passed"] += 1
                elif resolved["status"] == "partial":
                    cat_result["partial"] += 1
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

# Same per-page I18N dictionary + data-i18n contract used by the Pages surfaces.
_I18N = {"ko": {}, "ja": {}}
_JA_LABELS = {"Test Report": "テストレポート", "Decision first": "検証結果", "Pass": "合格", "Fail": "失敗", "Not run": "未実行", "Partial verification": "部分検証", "Passed": "合格", "Failed cases": "失敗したケース", "Skipped cases": "スキップしたケース", "Executed / collected": "実行 / 収集", "Next action": "次の対応", "No case evidence": "ケースの証拠なし", "No executed cases": "実行されたケースなし", "Latest run": "今回の実行", "What we verify": "検証範囲", "Test domains": "テスト領域", "Platforms": "プラットフォーム", "Scenarios": "シナリオ", "Coverage": "カバレッジ", "History": "履歴", "Test basis and QA judgment": "テスト根拠とQA判断"}
_KO_LABELS = {"Pass": "통과", "Fail": "실패", "Not run": "미실행", "Partial verification": "부분 검증", "No case evidence": "케이스 증거 없음", "No executed cases": "실행된 케이스 없음", "Passed here": "이번 실행 통과", "Failed here": "이번 실행 실패", "Result": "판정", "Passed": "통과", "Failed": "실패", "Skipped": "건너뜀", "Summed test time": "테스트 시간 합계", "Line coverage": "줄 커버리지", "Files": "파일", "Suites": "suite", "Time": "시간", "TypeScript packages": "TypeScript 패키지", "excluded from executed tests": "실행 수에서 제외", "not wall-clock runtime": "실제 경과 시간이 아님", "across every suite run here": "이 실행의 전체 suite", "TypeScript unit, contract and integration tests.": "TypeScript 단위·계약·통합 테스트.", "The real daemon process, driven from outside.": "외부에서 제어하는 실제 daemon 프로세스.", "macOS app and in-process Swift daemon.": "macOS 앱과 앱 내부 Swift daemon.", "Flash, boot and serial protocol on real boards.": "실제 보드의 flash·부팅·serial 프로토콜."}

def _copy(en, ko, ja=None):
    """English source DOM; translate authored copy, preserve raw evidence."""
    key = f"copy-{len(_I18N['ko'])}"
    _I18N["ko"][key] = ko
    japanese = ja or _JA_LABELS.get(en)
    if japanese:
        _I18N["ja"][key] = japanese
    return f'<span data-i18n="{key}">{_esc(en)}</span>'

def _label(text):
    executed = re.fullmatch(r"([0-9,]+) tests executed", text)
    if executed:
        return _copy(text, f"{executed[1]}개 테스트 실행")
    ratio = re.fullmatch(r"([0-9.]+)% of executed", text)
    if ratio:
        return _copy(text, f"실행 수 중 {ratio[1]}%")
    return _copy(text, _KO_LABELS[text]) if text in _KO_LABELS else _esc(text)

def result_counts(vitest, android, robot):
    assertions = [a for r in (vitest or {}).get("testResults", []) for a in r.get("assertionResults", [])]
    passed = sum(a.get("status") == "passed" for a in assertions) + sum(s["passed"] for s in android) + (robot or {}).get("passed", 0)
    failed = sum(a.get("status") == "failed" for a in assertions) + sum(s["failures"] + s["errors"] for s in android) + (robot or {}).get("failed", 0)
    skipped = sum(a.get("status") not in ("passed", "failed") for a in assertions) + sum(s.get("skipped", 0) for s in android) + (robot or {}).get("skipped", 0)
    available = []
    for r in (vitest or {}).get("testResults", []):
        name = r.get("name", "").replace(str(ROOT) + "/", "")
        suite = "e2e" if name.startswith("tests/e2e/") else "vitest"
        if suite not in available:
            available.append(suite)
    if android:
        available.append("android")
    if robot:
        available.append("robot")
    return {"passed": passed, "failed": failed, "skipped": skipped, "executed": passed + failed, "total": passed + failed + skipped, "available_suites": available}

def run_decision(counts, metadata):
    metas = [suite_meta(metadata, name) for name in ("vitest", "e2e", "android", "apple", "robot")]
    if counts["failed"] or any(_state(m["status"]) == "fail" for m in metas):
        return "fail"
    if not counts["executed"]:
        return "off"
    if counts["skipped"] or len(counts["available_suites"]) < 5 or any(not m["executed"] or _state(m["status"]) != "pass" for m in metas):
        return "partial"
    return "pass"

def reconcile_case_evidence(metadata, vitest, android, robot):
    """A reported command outcome alone cannot prove passing test cases."""
    result = json.loads(json.dumps(metadata))
    suites = result.setdefault("suites", {})
    parsed = {}
    for entry in (vitest or {}).get("testResults", []):
        name = entry.get("name", "").replace(str(ROOT) + "/", "")
        suite = "e2e" if name.startswith("tests/e2e/") else "vitest"
        info = parsed.setdefault(suite, {"executed": 0, "failed": False})
        cases = entry.get("assertionResults", [])
        info["executed"] += sum(a.get("status") in ("passed", "failed") for a in cases)
        info["failed"] |= entry.get("status") == "failed" or any(a.get("status") == "failed" for a in cases)
    if android:
        parsed["android"] = {"executed": sum(s["passed"] + s["failures"] + s["errors"] for s in android),
                             "failed": any(s["failures"] or s["errors"] for s in android)}
    if robot:
        parsed["robot"] = {"executed": robot["passed"] + robot["failed"], "failed": bool(robot["failed"])}
    for name in ("vitest", "e2e", "android", "apple", "robot"):
        meta = suites.setdefault(name, {"status": "not-run", "executed": False, "note": ""})
        info = parsed.get(name)
        if info and info["failed"]:
            meta.update(status="fail", executed=True)
        elif _state(meta.get("status")) == "fail":
            # Preserve reported setup/coverage failures even without failing cases.
            continue
        elif info and info["executed"]:
            meta.update(status="pass", executed=True)
        elif meta.get("executed") or info:
            meta.update(status="unknown", executed=True)
            note = "No parsed executed test cases; reported command completion is not case evidence."
            if note not in meta.get("note", ""):
                meta["note"] = " ".join(x for x in (meta.get("note", ""), note) if x)
    return result

_DECISION_LABEL = {"pass": "Pass", "fail": "Fail", "off": "Not run", "partial": "Partial verification"}

def _render_qa_summary(counts, metadata):
    decision = run_decision(counts, metadata)
    labels = {"pass": "입력된 자동 테스트 통과", "fail": "실패 — 원인 확인 필요", "off": "미실행 — 판단 근거 없음", "partial": "부분 검증 — 실행 범위만 통과"}
    missing = [name for name in ("vitest", "e2e", "android", "apple", "robot") if not suite_meta(metadata, name)["executed"] or suite_meta(metadata, name)["status"] == "unknown" or name not in counts["available_suites"]]
    action = (_copy("Inspect failed cases and suite notes, fix the cause, then rerun the same scope.", "실패 케이스와 suite 메모에서 원인을 확인하고 수정 후 같은 범위를 재실행하세요.") if decision == "fail" else
              _copy("Run missing suites and review manual QA before a release decision.", "누락된 suite와 수동 QA를 확인한 뒤 릴리스를 판단하세요."))
    return f'''<section id="qa-summary" tabindex="-1" class="card qa-summary" aria-labelledby="qa-title">
      <h2 id="qa-title">{_copy("Decision first", "검증 결론부터")}</h2>
      <p><strong>{_copy(_DECISION_LABEL[decision], labels[decision])}</strong></p>
      <dl class="specs">
        <div><dt>{_copy("Passed", "통과")}</dt><dd>{counts["passed"]:,}</dd></div>
        <div><dt>{_copy("Failed cases", "실패 케이스")}</dt><dd>{counts["failed"]:,}</dd></div>
        <div><dt>{_copy("Skipped cases", "건너뛴 케이스")}</dt><dd>{counts["skipped"]:,}</dd></div>
        <div><dt>{_copy("Executed / collected", "실행 / 수집")}</dt><dd>{counts["executed"]:,} / {counts["total"]:,}</dd></div>
      </dl>
      <p>{_copy("Not run or no parsed case evidence here", "이 실행에서 미실행 또는 케이스 근거 없음")}: {_esc(", ".join(missing) or "—")}.</p>
      <p>{_copy("Remaining risk: mocked inputs do not prove physical readability, real permission flows or device recovery. Evidence from other runs keeps its own commit and date.", "잔여 위험: 모의 입력으로 실제 화면 가독성·권한 흐름·기기 복구를 증명할 수 없습니다. 다른 실행의 증거는 해당 커밋과 날짜로 구분합니다.")}</p>
      <p><strong>{_copy("Next action", "다음 행동")}</strong>: {action} <a href="#qa-method">{_copy("Method and manual QA", "검증 방법·수동 QA")}</a></p>
      <details><summary>{_copy("Input scope and counting rules", "입력 범위·집계 기준")}</summary>
      <p class="fine">{_copy("Run profile", "실행 프로필")}: {_esc(metadata.get("run_profile", "unknown"))} · <a href="summary.json">summary.json</a></p>
      <p>{_copy("Parsed input scope", "결과 입력 범위")}: {_esc(", ".join(counts["available_suites"]) or "—")}. {_copy("Only supplied cases are counted; this is not release approval.", "입력된 케이스만 집계하며 릴리스 승인은 아닙니다.")}</p>
      <p class="fine">{_copy("Setup errors or coverage failures can fail a suite with zero failed cases. Skipped cases are excluded from executed tests.", "준비 오류·커버리지 미달은 실패 케이스가 0이어도 suite 실패입니다. 건너뛴 케이스는 실행 분모에서 제외합니다.")}</p></details>
    </section>'''

def _render_qa_method(vt_file_data):
    source = "https://github.com/puritysb/AgentDeck/blob/" + (os.environ.get("GITHUB_SHA") or "master")
    example = next((data for path, data in vt_file_data.items() if path.endswith("/http-auth-gate.test.ts")), None)
    observed = (_copy(f'Example cases: {example["passed"]} passed, {example["failed"]} failed, {example["skipped"]} skipped.',
                      f'이번 실행 예시 결과: {example["passed"]} 통과, {example["failed"]} 실패, {example["skipped"]} 건너뜀.') if example else
                _copy("No case evidence for this example in the supplied inputs.", "현재 입력에는 이 예시의 케이스 증거가 없습니다."))
    cards = [
      ("Why automate?", "왜 자동화하나요?", "Repeated state transitions, access boundaries and protocol mirrors have deterministic expectations. Fast regression tests are appropriate; scenario gaps show what remains unproven.", "상태 전이·접근 경계·프로토콜 미러는 기대 결과가 명확하고 반복됩니다. 회귀 검증을 자동화하고 시나리오 공백으로 남은 위험을 드러냅니다."),
      ("Manual QA still needed", "수동 QA가 필요한 이유", "On the target app and device, observe real permission approval/denial, disconnect/reconnect and text readability. Compare expected state/options with the screen; record app/firmware version, device, date, result and evidence. Not executed by this report.", "대상 앱·실기기에서 실제 권한 승인/거절·연결 끊김/복구·글자 가독성을 관찰하세요. 기대 상태·옵션을 화면과 비교하고 앱/펌웨어 버전·기기·날짜·결과·증거를 기록하세요. 이 보고서는 해당 검증을 실행하지 않습니다."),
      ("Public test example", "공개 가능한 실제 예시", "Risk: unauthenticated LAN access. Input: unauthorized GET /status. Expected: deny; GET /health exposes public health only. Inspect the access-control cases in Test domains when they are included in this run. Unit inputs do not prove a physical network or UI.", "위험: 미인증 LAN 접근. 입력: 미인증 GET /status. 기대: deny, GET /health는 공개 상태만 제공. 이번 실행에 포함된 경우 테스트 영역에서 접근 제어 assertion 결과를 확인하세요. 단위 입력으로 실제 네트워크·UI까지 증명하지 않습니다."),
      ("AI and evidence limits", "AI 사용과 증거의 한계", "Aggregation uses deterministic parsers, not an LLM verdict. Mock hooks do not assess model quality or hallucinations. Review AI-authored code and regression results; missing evidence stays unknown. Only public AgentDeck sources and synthetic fixtures belong here; confidential cases are excluded even when blurred.", "집계는 결정적 파서를 사용하며 LLM 판정이 아닙니다. 모의 hook으로 모델 품질·환각을 검증하지 않습니다. AI 작성 코드는 소스 검토·회귀 검증이 필요하고 증거 누락은 미확인입니다. 공개 AgentDeck 소스·합성 fixture만 사용하며 기밀 TC는 블러 처리해도 공개하지 않습니다."),
    ]
    rendered = "".join(f'<article class="card gap"><h3>{_copy(en, ko)}</h3><p>{_copy(body_en, body_ko)}</p></article>' for en, ko, body_en, body_ko in cards)
    return f'''<section id="qa-method" tabindex="-1"><h2>{_copy("Test basis and QA judgment", "테스트 근거와 QA 판단")}</h2>
      <div class="grid gaps">{rendered}</div>
      <p>{observed}</p>
      <p><a href="{_esc(source)}/bridge/src/__tests__/http-auth-gate.test.ts">http-auth-gate.test.ts</a> · <a href="#domains">{_copy("Observed results", "실제 결과")}</a> · <a href="#scenarios">{_copy("Scenario basis and gaps", "시나리오 테스트 베이스·공백")}</a></p>
      <details class="card files"><summary>{_copy("Reproduce: inputs → execution → evaluation → report", "재현: 입력·환경 → 실행 → 평가 → 보고서")}</summary>
        <p>{_copy("Use Node 22, 24 or 26, locked pnpm dependencies and a POSIX shell. In a fresh checkout, collect a focused public example; JSON results feed the report. This is a narrow example, not full acceptance. Coverage and native evidence require separate runs.", "Node 22·24·26과 lockfile의 pnpm 의존성, POSIX shell을 사용하세요. 새 checkout에서 공개 예시를 실행하고 JSON 결과를 보고서에 공급합니다. 좁은 범위의 예시이며 전체 인수 검증은 아닙니다. 커버리지·네이티브 증거는 별도 실행이 필요합니다.")}</p>
        <p class="cmd"><code>pnpm install --frozen-lockfile
pnpm build
example_dir=$(mktemp -d)
pnpm vitest run bridge/src/__tests__/http-auth-gate.test.ts --reporter=json --outputFile="$example_dir/vitest.json"
BUILD_HEALTH_REPORT_DIR="$example_dir" BUILD_HEALTH_COVERAGE_JSON="$example_dir/no-coverage" BUILD_HEALTH_ANDROID_DIR="$example_dir/no-android" python3 scripts/generate-html-report.py</code></p>
        <p><a href="{_esc(source)}/.github/workflows/test-report.yml">{_copy("Published pipeline", "게시 파이프라인")}</a> · <a href="summary.json">summary.json</a> · <a href="run-metadata.json">{_copy("Run scope and suite notes", "실행 범위·suite 메모")}</a></p>
        <p>{_copy("Troubleshooting: HTML previously counted pass+fail while summary.json included skips. Both now use the same assertions; regression fixtures exercise skip-only runs, suite errors and missing suites. Focused results cannot substitute for release/device evidence. No QA execution video is attached to this run.", "트러블슈팅: 기존 HTML은 통과+실패만, summary.json은 skip도 집계했습니다. 이제 같은 assertion으로 양쪽 수치를 생성하고 skip만 있는 실행·suite 오류·미실행을 회귀 fixture로 검증합니다. 좁은 결과로 릴리스·실기기 증거를 대체할 수 없습니다. 이 실행에 첨부된 QA 검증 영상은 없습니다.")}</p>
      </details></section>'''

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
    return f'<span class="badge {st}">{_label(label or _STATE_LABEL[st])}</span>'

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

def write_summary(metadata, total_passed, total_failed, total_all, counts=None):
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
        "decision": run_decision(counts, metadata) if counts else "unknown",
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "run_profile": metadata.get("run_profile", "unknown") if metadata else "unknown",
        "suites": suites,
        "total": {
            "passed": total_passed,
            "failed": total_failed,
            "total": total_all,
            "skipped": (counts or {}).get("skipped", 0),
            "executed": (counts or {}).get("executed", total_passed + total_failed),
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
        total = history[-1].get("total", 0)
        display = f"{last / total * 100:.1f}%" if total else "—"
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
    titles = {"Latest run": "이번 실행", "What we verify": "무엇을 검증하나요", "Test domains": "테스트 영역", "Platforms": "플랫폼별 결과", "Scenarios": "사용자 시나리오", "Coverage": "커버리지", "History": "이력"}
    title_copy = _copy(title, titles.get(title, title))
    ledes = {
        "run": "이 보고서에 입력된 실행 결과입니다. macOS·실기기 등 다른 실행의 증거는 별도로 표시하며 통과 수에 합산하지 않습니다.",
        "verify": "각 검증의 실행 환경·증명하는 범위·증명하지 못하는 범위를 canonical 검증 catalog에서 가져옵니다.",
        "domains": "검증 질문별 TypeScript·E2E 결과입니다. 영역을 열면 파일·개별 테스트·실패 원인을 확인할 수 있습니다.",
        "platforms": "TypeScript 이외의 네이티브·하드웨어 검증입니다. 다른 workflow와 실험실 증거는 자체 커밋·날짜로 표시합니다.",
        "scenarios": "파일·케이스명으로 사용자 흐름을 실제 결과와 연결합니다. 숫자는 매핑 항목 수이며 assertion 수와 다릅니다. 대시는 해당 수준의 매핑 없음입니다.",
        "coverage": "TypeScript 줄·문장·함수·분기 커버리지입니다. vitest.config.ts의 기준을 읽으며 실기기 품질까지 의미하지 않습니다.",
        "history": "최근 실행의 수집 테스트·통과·커버리지 추이입니다. skip은 수집 수에 포함되며 실행 수에서는 제외합니다.",
    }
    if sid in ledes:
        lede = _copy(re.sub(r"<[^>]+>", "", lede), ledes[sid])
    return f'''<div class="section-head" id="{sid}" tabindex="-1">
      <div><p class="kicker">{_esc(kicker)}</p><h2>{title_copy}</h2></div>
      <p>{lede}</p>
    </div>'''

# --- Latest run --------------------------------------------------------------

def _render_run(stats, suites):
    tiles = "".join(f'''<div class="card tile">
        <p class="kicker">{_label(label)}</p>
        <p class="tile-value {cls}">{_label(str(value))}</p>
        <p class="fine">{_label(note)}</p>
      </div>''' for label, value, cls, note in stats)
    cards = ""
    for s in suites:
        meta = s["meta"]
        st = _state(meta["status"]) if meta["executed"] else "off"
        if st == "pass" and not (s["passed"] + s["failed"]):
            st = "off"
        badge = status_badge(st, "No case evidence" if meta["executed"] and st == "off" else None)
        figures = ""
        if meta["executed"]:
            figures = f'''<dl class="specs">
              <div><dt>{_label("Passed")}</dt><dd>{s["passed"]:,}</dd></div>
              <div><dt>{_label("Failed")}</dt><dd class="{"bad-text" if s["failed"] else ""}">{s["failed"]:,}</dd></div>
              <div><dt>{_label(s["unit"])}</dt><dd>{s["files"]:,}</dd></div>
              <div><dt>{_label("Time")}</dt><dd>{duration_fmt(s["ms"]) if s["ms"] else "—"}</dd></div>
            </dl>'''
        note = f'<p class="fine">{_esc(meta["note"])}</p>' if meta.get("note") else ""
        cards += f'''<article class="card suite">
          <div class="card-top"><h3>{_esc(s["name"])}</h3>{badge}</div>
          <p class="sub">{_label(s["what"])}</p>
          {_bar(s["passed"], s["failed"], s["passed"] + s["failed"]) if meta["executed"] else ""}
          {figures}{note}
        </article>'''
    return f'<div class="grid tiles">{tiles}</div><div class="grid suites">{cards}</div>'

# --- What we verify ----------------------------------------------------------

def _render_verify(catalog, metadata):
    repo = os.environ.get("GITHUB_REPOSITORY", "puritysb/AgentDeck")
    levels = catalog.get("levels", {})
    cards = ""
    for gate in catalog.get("gates", []):
        suite = gate.get("report_suite")
        meta = suite_meta(metadata, suite) if suite else None
        if meta and meta["executed"]:
            label = {"pass": "Passed here", "fail": "Failed here", "off": "No case evidence"}[_state(meta["status"])]
            badge = status_badge(meta["status"], label)
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
                if wf else '<span class="quiet">Lab only — results are not recorded here</span>')
        cards += f'''<article class="card gate">
          <div class="card-top"><div class="tags">{tags}</div>{badge}</div>
          <h3>{_esc(gate["name"])}</h3>
          <p class="sub">{_esc(gate.get("trigger", ""))} · {_esc(gate.get("where", ""))}</p>
          <div class="two">
            <div><p class="label">Proves</p><ul class="ticks">{proves}</ul></div>
            <div><p class="label">Does not prove</p><ul class="ticks no">{not_proves}</ul></div>
          </div>
          <p class="cmd"><code>{_esc(gate.get("command", ""))}</code></p>
          <p class="card-foot">{link}</p>
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
        case_label = "Skipped" if a.get("status") in ("skipped", "pending", "todo") else _STATE_LABEL[st]
        rows += (f'<li class="t {st}"><span class="mark" aria-label="{case_label}">{mark}</span>'
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
        st = "fail" if failed else ("pass" if passed and not skipped else "off")
        cards += f'''<article class="card domain" id="domain-{_esc(layer["id"])}">
          <div class="card-top"><p class="kicker"><span aria-hidden="true">{_esc(layer.get("icon", ""))}</span> {_n(len(files), "file")}</p>{status_badge(st, f"{failed} failing" if failed else "Partial verification" if passed and skipped else None)}</div>
          <h3>{_esc(layer["name"])}</h3>
          <p class="sub">{_esc(layer.get("question", ""))}</p>
          {_bar(passed, failed, passed + failed)}
          <dl class="specs">
            <div><dt>{_label("Passed")}</dt><dd>{passed:,}</dd></div>
            <div><dt>{_label("Failed")}</dt><dd class="{"bad-text" if failed else ""}">{failed:,}</dd></div>
            <div><dt>{_label("Skipped")}</dt><dd>{skipped:,}</dd></div>
            <div><dt>{_label("Time")}</dt><dd>{duration_fmt(dur)}</dd></div>
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

def _render_platforms(android_suites, android_meta, apple_meta, robot, robot_meta):
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
          <div class="card-top"><h3>Android</h3>{status_badge("fail" if a_f else "pass" if a_p else "off", "No executed cases" if not (a_f or a_p) else None)}</div>
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
      <div class="card-top"><h3>Apple (XCTest)</h3>{status_badge(_state(apple_meta["status"]) if apple_meta["executed"] else "off", "No case evidence" if apple_meta["executed"] and _state(apple_meta["status"]) == "off" else None)}</div>
      <p class="sub">{_esc(apple_meta.get("note") or "Runs in the Apple Tests workflow on a macOS runner.")}</p></article>'''
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
          <div class="card-top"><h3>ESP32 Robot Framework</h3>{status_badge("fail" if robot["failed"] else "pass" if robot["passed"] else "off", "No executed cases" if not (robot["failed"] or robot["passed"]) else None)}</div>
          <p class="sub">Physical boards in the maintainer's lab: {", ".join(_esc(BOARD_LABELS.get(b, b)) for b in robot["boards"]) or "no board tags"}.</p>
          {_bar(robot["passed"], robot["failed"], robot["passed"] + robot["failed"])}
          {_build_robot_perf_table(robot)}
          <details class="files"{" open" if robot["failed"] else ""}><summary>{_n(len(robot["suites"]), "suite")}</summary>{suites}</details>
        </article>'''
    else:
        robot_card = f'''<article class="card platform">
          <div class="card-top"><h3>ESP32 Robot Framework</h3>{status_badge("off")}</div>
          <p class="sub">{_esc(robot_meta.get("note") or "Physical hardware suite; not run on GitHub-hosted runners.")}</p></article>'''
    return f'<div class="grid platforms">{android}{apple}{robot_card}</div>'

# --- Scenarios ---------------------------------------------------------------

def _scenario_cell(cat):
    t = cat["total"]
    if t == 0:
        return '<td class="num quiet" title="No tests mapped">—</td>'
    p, f, m, nr = cat["passed"], cat["failed"], cat["missing"], cat.get("not_run", 0)
    st = "fail" if f else ("pass" if p == t else "off")
    parts = [x for x in (f"{p} passed" if p else "", f"{f} failed" if f else "",
                         f"{m} not found in this run" if m else "", f"{nr} not executed here" if nr else "", f'{cat.get("partial", 0)} partially executed' if cat.get("partial") else "") if x]
    return f'<td class="num"><span class="dot {st}"></span>{p}/{t}<span class="fine"> — {", ".join(parts)}</span></td>'

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

def generate_html(vitest, android_suites, cov_data, scenarios, scenario_results, history, metadata, robot=None):
    _I18N["ko"].clear()
    _I18N["ja"].clear()
    metadata = reconcile_case_evidence(metadata, vitest, android_suites, robot)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    commit = os.environ.get("GITHUB_SHA", "")[:7]
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

    counts = result_counts(vitest, android_suites, robot)
    total_passed, total_failed = counts["passed"], counts["failed"]
    total_all = counts["executed"]
    overall = run_decision(counts, metadata)

    cov_total = cov_data.get("total", {}) if cov_data else {}
    lines_pct = cov_total.get("lines", {}).get("pct", 0)
    pkg_cov = extract_package_coverage(cov_data) if cov_data else {}

    stats = [
        ("Result", _DECISION_LABEL[overall], "ok-text" if overall == "pass" else "bad-text" if overall == "fail" else "quiet",
         f"{total_all:,} tests executed"),
        ("Passed", f"{total_passed:,}", "", f"{(total_passed / total_all * 100) if total_all else 0:.2f}% of executed"),
        ("Failed", f"{total_failed:,}", "bad-text" if total_failed else "", "across every suite run here"),
        ("Skipped", f'{counts["skipped"]:,}', "", "excluded from executed tests"),
        ("Summed test time", duration_fmt(vt_ms + e2_ms + an_ms), "", "not wall-clock runtime"),
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
         "passed": 0, "failed": 0, "files": 0, "unit": "Suites", "ms": 0},
        {"name": "ESP32 Robot", "what": "Flash, boot and serial protocol on real boards.", "meta": robot_meta,
         "passed": rb_p, "failed": rb_f, "files": len(robot["suites"]) if robot else 0, "unit": "Suites", "ms": 0},
    ]

    sparks = "".join(x for x in (sparkline_svg(history, "total", "Tests"),
                                 sparkline_svg(history, "passed", "Pass rate"),
                                 sparkline_svg(history, "coverage", "Line coverage")) if x)
    history_html = (f'<div class="grid tiles three">{sparks}</div>' if sparks
                    else '<p class="quiet">Trends appear once two or more master runs are recorded.</p>')

    sections = [
        ("run", "Latest run", "Every suite this page executed, and the ones it only links to."),
        ("verify", "What we verify", "Each gate, where it runs, and what it does not prove."),
        ("domains", "Test domains", "Every test file, grouped by the question it answers."),
        ("platforms", "Platforms", "Android, Apple and hardware suites."),
        ("scenarios", "Scenarios", "User flows mapped to the tests that cover them."),
        ("coverage", "Coverage", "TypeScript coverage against the enforced floor."),
        ("history", "History", "Trends across recent master runs."),
    ]
    if not scenario_results:
        sections = [s for s in sections if s[0] != "scenarios"]
    if not cov_data:
        sections = [s for s in sections if s[0] != "coverage"]
    sections += [("qa-method", "Method / manual QA", "")]
    jump_labels = {"run": "이번 실행", "verify": "검증 범위", "domains": "테스트 영역", "platforms": "플랫폼", "scenarios": "시나리오", "coverage": "커버리지", "history": "이력", "qa-method": "검증 방법·수동 QA"}
    jump = "".join(f'<a href="#{sid}">{_copy(title, jump_labels[sid])}</a>' for sid, title, _ in sections)

    body = ""
    body += f'<section>{_section_head("run", "Build health", "Latest run", "What this page ran on the merged master commit. Suites that need a macOS runner or physical boards run elsewhere and are marked as not run here — never counted as passing.")}{_render_run(stats, suites)}</section>'
    body += f'<section>{_section_head("verify", "Transparency", "What we verify", "Every check the project runs, where it runs, and what it does <em>not</em> prove. Generated from <code>scripts/verification-catalog.json</code>; CI fails if that file stops matching the repository.")}{_render_verify(CATALOG, metadata)}</section>'
    body += f'<section>{_section_head("domains", "Vitest + E2E", "Test domains", "Every TypeScript and end-to-end test file, grouped by the question it answers. Open a domain for its files and each test.")}{_render_domains(vt_file_data)}</section>'
    body += f'<section>{_section_head("platforms", "Native and hardware", "Platforms", "Suites outside the TypeScript toolchain. Apple and hardware results are recorded by their own workflows and the lab.")}{_render_platforms(android_suites, android_meta, apple_meta, robot, robot_meta)}</section>'
    if scenario_results:
        body += f'<section>{_section_head("scenarios", "User flows", "Scenarios", "Each flow maps to specific tests by file and case name (<code>scripts/scenario-matrix.json</code>). A dash means no test at that level — listed with the known gaps.")}{_render_scenarios(scenario_results)}</section>'
    if cov_data:
        body += f'<section>{_section_head("coverage", "Vitest --coverage", "Coverage", "Line, statement, function and branch coverage of bridge, shared, plugin and hooks. The floors are read from <code>vitest.config.ts</code> and enforced on every pull request.")}{_render_coverage(cov_total, pkg_cov)}</section>'
    body += f'<section>{_section_head("history", "Trend", "History", "Totals from the last runs of this page on master.")}{history_html}</section>'

    body += _render_qa_method(vt_file_data)

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
.tags {{ display:flex; flex-wrap:wrap; gap:4px; }}
.tag {{ font-family:var(--font-mono); font-size:10px; font-weight:600; letter-spacing:var(--tr-chip); text-transform:uppercase; padding:2px 6px; border-radius:var(--r-sm); background:var(--tide-200); color:var(--ink-700); }}
.dot {{ display:inline-block; width:6px; height:6px; border-radius:var(--r-pill); margin-right:6px; vertical-align:middle; }}
.dot.pass {{ background:var(--status-processing); box-shadow:0 0 0 2px color-mix(in srgb, var(--status-processing) 33%, transparent); }}
.dot.fail {{ background:var(--status-error); box-shadow:0 0 0 2px color-mix(in srgb, var(--status-error) 33%, transparent); }}
.dot.partial, .dot.off {{ background:var(--status-idle); box-shadow:0 0 0 2px color-mix(in srgb, var(--status-idle) 33%, transparent); }}
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
.qa-summary {{ margin-top:var(--s-6); }}
.qa-summary h2 {{ margin:0; }}
.qa-summary .specs dt {{ font-family:var(--font-sans); font-size:var(--t-caption); letter-spacing:normal; text-transform:none; }}
.qa-summary .specs dd {{ font-size:var(--t-card-title); color:var(--ink-900); }}
:focus-visible {{ outline:2px solid var(--kelp-700); outline-offset:4px; }}
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
  .legend dl {{ grid-template-columns:repeat(2,minmax(0,1fr)); }}
}}
@media (max-width:900px) {{
  .gates, .domains, .platforms, .gaps, .tiles.four, .tiles.three {{ grid-template-columns:repeat(2,minmax(0,1fr)); }}
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
    <h1>{_copy("Test Report", "테스트 보고서")}</h1>
    <p class="lede">{_copy("Review the decision, remaining risk and next action first; inspect the exact test evidence below.", "현재 판정·잔여 위험·다음 행동을 먼저 확인하고, 아래에서 구체적인 테스트 증거를 검토하세요.")}</p>
    <p class="run-chip"><span class="dot {overall}"></span>{_label(_DECISION_LABEL[overall])} · {_copy(f"{total_all:,} tests{commit_bit} · generated {now}", f"{total_all:,}개 실행{commit_bit} · 생성 {now}")}</p>
  </header>
  {_render_qa_summary(counts, metadata)}
  <nav class="jump" aria-label="Sections">{jump}</nav>
  {body}
</main>
<footer>
  Generated by <code>scripts/generate-html-report.py</code> from this run's Vitest, E2E, JUnit and Robot results.
  Machine-readable: <a href="summary.json">summary.json</a> · <a href="run-metadata.json">run-metadata.json</a> · <a href="history.json">history.json</a> · <a href="verification-catalog.json">verification-catalog.json</a>.
</footer>
<script>
// Pages-compatible locale selection: saved choice, then English; no browser sniffing.
(function () {{
  var el = document.getElementById('lang');
  if (!el) return;
  var KEY = 'agentdeck-design-locale';
  var I18N = {json.dumps(_I18N, ensure_ascii=False, indent=2).replace('<', chr(92) + 'u003c').replace('>', chr(92) + 'u003e').replace('&', chr(92) + 'u0026')};
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-i18n]'));
  var original = new Map();
  nodes.forEach(function (node) {{ original.set(node, node.textContent); }});
  function apply(locale) {{
    document.documentElement.lang = locale;
    nodes.forEach(function (node) {{
      var key = node.getAttribute('data-i18n');
      node.textContent = (I18N[locale] && I18N[locale][key]) || original.get(node);
    }});
  }}
  var saved = 'en';
  try {{
    saved = localStorage.getItem(KEY) || 'en';
    if (['en', 'ko', 'ja'].indexOf(saved) < 0) saved = 'en';
  }} catch (e) {{}}
  el.value = saved;
  apply(saved);
  el.addEventListener('change', function () {{ apply(el.value); try {{ localStorage.setItem(KEY, el.value); }} catch (e) {{}} }});
}})();
</script>
</body>
</html>
'''


def main():
    REPORT_DIR.mkdir(parents=True, exist_ok=True)

    e2e = load_e2e()
    raw_vitest = load_vitest()
    vitest = merge_e2e(raw_vitest, e2e)
    android = load_android_xml()
    cov = load_coverage()
    robot = load_robot_xml()
    scenarios = load_scenarios()
    history = load_history()
    metadata = load_metadata()
    if not metadata:
        metadata = build_default_metadata(raw_vitest, android, robot, e2e)
    metadata = reconcile_case_evidence(metadata, vitest, android, robot)
    METADATA_JSON.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    if not vitest and not android and not robot:
        print("No test results found. Run 'pnpm test:report' first.")
        sys.exit(1)

    # Build scenario cross-reference
    scenario_results = build_scenario_results(scenarios, vitest, android, metadata) if scenarios else []

    # One counting source for the HTML, summary and history.
    counts = result_counts(vitest, android, robot)
    total_passed, total_failed, total_all = counts["passed"], counts["failed"], counts["total"]
    cov_total = cov.get("total", {}) if cov else {}
    lines_pct = cov_total.get("lines", {}).get("pct", 0)

    # Update history
    history = update_history(history, total_passed, total_failed, total_all, lines_pct, metadata)

    write_summary(metadata, total_passed, total_failed, total_all, counts)
    html = generate_html(vitest, android, cov, scenarios, scenario_results, history, metadata, robot)
    OUTPUT_HTML.write_text(html, encoding="utf-8")
    print(f"HTML report: {OUTPUT_HTML}")


if __name__ == "__main__":
    main()
