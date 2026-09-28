#!/usr/bin/env python3
"""
AgentDeck Build Health — HTML Generator

Reads vitest JSON, Android JUnit XML, coverage-summary.json, scenario-matrix.json,
and produces a single self-contained HTML dashboard with:
  - Summary cards + history trend sparklines
  - Suite progress bars (Vitest, Android, Apple, Robot)
  - Scenario coverage matrix (user scenarios → test mapping)
  - Expandable test file tables with category tags
  - Coverage per-package gauges + file-level coverage table

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
REPORT_DIR = ROOT / "coverage" / "test-report"
VITEST_JSON = REPORT_DIR / "vitest.json"
COVERAGE_JSON = ROOT / "coverage" / "coverage-summary.json"
ANDROID_XML_DIR = ROOT / "android" / "app" / "build" / "test-results" / "testDebugUnitTest"
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
        if len(parts) >= 2 and parts[0] in ("bridge", "plugin", "shared", "hooks"):
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

def category_badge_html(category):
    """Badge for legacy unit/integration/snapshot or layer-based category."""
    for layer in TEST_LAYERS:
        if layer["id"] == category:
            fg = layer["color"]
            bg = fg + "22"
            return f'<span style="font-size:0.65rem;font-weight:600;padding:1px 6px;border-radius:3px;background:{bg};color:{fg};margin-left:0.5rem">{layer["name"]}</span>'
    colors = {
        "unit": ("#38bdf8", "#38bdf822"),
        "integration": ("#a78bfa", "#a78bfa22"),
        "snapshot": ("#f472b6", "#f472b622"),
    }
    fg, bg = colors.get(category, ("#64748b", "#64748b22"))
    return f'<span style="font-size:0.65rem;font-weight:600;padding:1px 6px;border-radius:3px;background:{bg};color:{fg};margin-left:0.5rem">{category}</span>'

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



# ===== "What we verify" tab =====

def _esc(text):
    return (str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

def build_verification_html(catalog, metadata, vt_file_data):
    """Every verification gate the project runs, where and when, what it proves and
    what it does not — rendered from scripts/verification-catalog.json."""
    repo = os.environ.get("GITHUB_REPOSITORY", "puritysb/AgentDeck")
    levels = catalog.get("levels", {})

    def run_cell(gate):
        suite = gate.get("report_suite")
        if suite:
            meta = suite_meta(metadata, suite)
            if meta["executed"]:
                ok = meta["status"] == "pass"
                colour = "var(--kelp-500)" if ok else "var(--coral-500)"
                label = "passed in this run" if ok else f'{meta["status"]} in this run'
                return f'<span style="color:{colour};font-weight:600">{label}</span>'
        wf = gate.get("workflow")
        if wf:
            name = wf.rsplit("/", 1)[-1]
            return f'<a href="https://github.com/{repo}/actions/workflows/{name}">{_esc(name)} runs &rarr;</a>'
        return '<span style="color:var(--dim)">lab only &mdash; not recorded here</span>'

    gate_rows = ""
    for gate in catalog.get("gates", []):
        lv = " ".join(f'<span class="vlevel" title="{_esc(levels.get(l, ""))}">{_esc(l)}</span>' for l in gate.get("level", []))
        proves = "".join(f"<li>{_esc(x)}</li>" for x in gate.get("proves", []))
        not_proves = "".join(f"<li>{_esc(x)}</li>" for x in gate.get("does_not_prove", []))
        blocking = "blocks merge/release" if gate.get("blocking") else "informational"
        gate_rows += f"""<tr>
          <td><strong>{_esc(gate["name"])}</strong><div class="vmeta">{lv}</div>
              <div class="vmeta"><code>{_esc(gate.get("command", ""))}</code></div></td>
          <td>{_esc(gate.get("trigger", ""))}<div class="vmeta">{_esc(gate.get("where", ""))} &middot; {blocking}</div></td>
          <td><ul class="vlist">{proves}</ul></td>
          <td><ul class="vlist vneg">{not_proves}</ul></td>
          <td>{run_cell(gate)}</td>
        </tr>"""

    domain_rows = ""
    for layer in TEST_LAYERS:
        files = [f for f in vt_file_data if classify_test_file(f) == layer["id"]]
        passed = sum(vt_file_data[f]["passed"] for f in files)
        failed = sum(vt_file_data[f]["failed"] for f in files)
        state = f'<span style="color:var(--coral-500);font-weight:600">{failed} failing</span>' if failed else f"{passed} passing"
        domain_rows += f"""<tr onclick="document.querySelector('[data-tab=layer-{layer["id"]}]')?.click()" style="cursor:pointer">
          <td><span style="color:{layer.get("color", "var(--accent)")}">{layer.get("icon", "")}</span> {_esc(layer["name"])}</td>
          <td style="color:var(--dim)">{_esc(layer.get("question", ""))}</td>
          <td style="text-align:right">{len(files)}</td>
          <td style="text-align:right">{state}</td>
        </tr>"""

    gaps = "".join(
        f"""<tr><td><strong>{_esc(g["what"])}</strong></td><td>{_esc(g["why"])}</td><td>{_esc(g["instead"])}</td></tr>"""
        for g in catalog.get("not_verified", []))

    legend = "".join(f"<li><strong>{_esc(k)}</strong> &mdash; {_esc(v)}</li>" for k, v in levels.items())

    return f"""<div class="verify">
      <p class="vintro">Every check AgentDeck runs, where it runs, and &mdash; just as important &mdash; what it does
      <em>not</em> prove. Generated from <code>scripts/verification-catalog.json</code>; a test fails CI if that file
      stops matching the repository (a workflow missing, a path gone, a test file with no domain).</p>
      <h3>Gates</h3>
      <div class="vscroll"><table class="vtable">
        <thead><tr><th>Gate</th><th>When</th><th>Proves</th><th>Does not prove</th><th>This page</th></tr></thead>
        <tbody>{gate_rows}</tbody>
      </table></div>
      <h3>Test domains</h3>
      <p class="vintro">Every TypeScript and E2E test file, grouped by the question it answers. Select a row for its tests.</p>
      <div class="vscroll"><table class="vtable">
        <thead><tr><th>Domain</th><th>Question</th><th style="text-align:right">Files</th><th style="text-align:right">Tests</th></tr></thead>
        <tbody>{domain_rows}</tbody>
      </table></div>
      <h3>Not verified automatically</h3>
      <div class="vscroll"><table class="vtable">
        <thead><tr><th>What</th><th>Why not</th><th>What we do instead</th></tr></thead>
        <tbody>{gaps}</tbody>
      </table></div>
      <h3>Evidence levels</h3>
      <ul class="vlegend">{legend}</ul>
    </div>"""


# ===== HTML generation =====

def pct_color(pct):
    if pct >= 80: return "#22c55e"
    if pct >= 50: return "#eab308"
    if pct >= 20: return "#f97316"
    return "#ef4444"

def gauge_svg(pct, size=48):
    color = pct_color(pct)
    r = size / 2 - 4
    circ = 2 * 3.14159 * r
    offset = circ * (1 - pct / 100)
    return f'''<svg width="{size}" height="{size}" viewBox="0 0 {size} {size}">
      <circle cx="{size/2}" cy="{size/2}" r="{r}" fill="none" stroke="#1e293b" stroke-width="5"/>
      <circle cx="{size/2}" cy="{size/2}" r="{r}" fill="none" stroke="{color}" stroke-width="5"
        stroke-dasharray="{circ}" stroke-dashoffset="{offset}"
        transform="rotate(-90 {size/2} {size/2})" stroke-linecap="round"/>
      <text x="{size/2}" y="{size/2 + 4}" text-anchor="middle" fill="{color}" font-size="11" font-weight="700">{pct:.0f}%</text>
    </svg>'''

def status_badge(status):
    if status in ("passed", "pass"):
        return '<span class="badge pass">PASS</span>'
    elif status in ("failed", "fail", "error"):
        return '<span class="badge fail">FAIL</span>'
    elif status == "not-run":
        return '<span class="badge skip">NOT RUN</span>'
    return '<span class="badge skip">SKIP</span>'

def suite_progress_color(status):
    if status in ("failed", "fail", "error"):
        return "#ef4444"
    if status in ("passed", "pass"):
        return "#22c55e"
    return "#64748b"

def duration_fmt(ms):
    if ms < 1000:
        return f"{ms:.0f}ms"
    s = ms / 1000
    if s < 60:
        return f"{s:.1f}s"
    m = int(s // 60)
    return f"{m}m {s % 60:.0f}s"

def scenario_cell_html(cat_data):
    """Generate a colored cell for a scenario category."""
    t = cat_data["total"]
    if t == 0:
        return '<td class="sc-cell sc-none" title="No tests">—</td>'
    p = cat_data["passed"]
    f = cat_data["failed"]
    m = cat_data["missing"]
    nr = cat_data.get("not_run", 0)
    if f > 0:
        cls = "sc-fail"
        label = f"{p}/{t}"
    elif m > 0 or nr > 0:
        cls = "sc-warn"
        label = f"{p}/{t}"
    else:
        cls = "sc-pass"
        label = f"{p}/{t}"
    title_parts = []
    if p: title_parts.append(f"{p} passed")
    if f: title_parts.append(f"{f} failed")
    if m: title_parts.append(f"{m} not found in CI")
    if nr: title_parts.append(f"{nr} not executed in this report")
    return f'<td class="sc-cell {cls}" title="{", ".join(title_parts)}">{label}</td>'

def write_summary(metadata, total_passed, total_failed, total_all):
    suites_meta = metadata.get("suites", {}) if metadata else {}
    suites = []
    for name in ("vitest", "android", "apple", "robot"):
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

def sparkline_svg(history, key, color, label, w=200, h=40):
    """Generate an SVG sparkline for a history metric."""
    values = [entry.get(key, 0) for entry in history]
    if not values or len(values) < 2:
        return ""
    max_v = max(values) if max(values) > 0 else 1
    min_v = min(values)
    range_v = max_v - min_v if max_v != min_v else 1
    n = len(values)
    points = []
    for i, v in enumerate(values):
        x = (i / (n - 1)) * (w - 8) + 4
        y = h - 6 - ((v - min_v) / range_v) * (h - 12)
        points.append(f"{x:.1f},{y:.1f}")
    polyline = " ".join(points)
    last_v = values[-1]
    # Format display value
    if key == "coverage":
        display = f"{last_v:.1f}%"
    elif key == "total":
        display = str(last_v)
    else:
        display = f"{last_v / values[-1] * 100 if values[-1] else 0:.0f}%" if key == "passed" else str(last_v)
    # For pass rate, compute percentage
    if key == "passed":
        totals = [entry.get("total", 1) for entry in history]
        rate = last_v / totals[-1] * 100 if totals[-1] else 0
        display = f"{rate:.1f}%"

    return f'''<div class="sparkline-card">
      <div class="sparkline-label">{label}</div>
      <svg width="{w}" height="{h}" viewBox="0 0 {w} {h}">
        <polyline points="{polyline}" fill="none" stroke="{color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="{points[-1].split(',')[0]}" cy="{points[-1].split(',')[1]}" r="3" fill="{color}"/>
      </svg>
      <div class="sparkline-value" style="color:{color}">{display}</div>
    </div>'''


def _fmt_perf(val, unit="", decimals=1):
    """Format a perf value for table display."""
    if val is None:
        return '<span style="color:var(--dim)">—</span>'
    if unit == "ms":
        return f"{val:,.{decimals}f} ms"
    if unit == "s":
        return f"{val:,.{decimals}f}s"
    if unit == "KB":
        return f"{val / 1024:,.0f} KB"
    if unit == "msg/s":
        return f"{val:,.0f} msg/s"
    return f"{val:,.{decimals}f}{unit}"


def _build_robot_perf_table(robot):
    """Build a board × metric performance comparison table."""
    perf = robot.get("perf_summary", {})
    if not perf:
        return ""
    boards = robot.get("boards", sorted(perf.keys()))
    if not boards:
        return ""

    # Define metrics to display
    metrics = [
        ("build_s", "Build", "s"),
        ("flash_boot_s", "Flash+Boot", "s"),
        ("boot_time_ms", "Boot Time", "ms"),
        ("firmware_size_bytes", "FW Size", "KB"),
        ("boot_heap_bytes", "Boot Heap", "KB"),
        ("response_latency_ms", "Latency", "ms"),
    ]

    # Check if any metric has data
    has_data = any(perf.get(b, {}).get(m[0]) for b in boards for m in metrics)
    if not has_data:
        return ""

    header = "<tr><th>Board</th>"
    for _, label, _ in metrics:
        header += f"<th>{label}</th>"
    header += "</tr>"

    rows = ""
    for bid in boards:
        bdata = perf.get(bid, {})
        label = BOARD_LABELS.get(bid, bid)
        rows += f"<tr><td style=\"font-weight:600\">{label}</td>"
        for key, _, unit in metrics:
            val = bdata.get(key)
            rows += f"<td>{_fmt_perf(val, unit)}</td>"
        rows += "</tr>"

    return f'''<div class="perf-table-wrap">
      <table class="perf-table">
        <thead>{header}</thead>
        <tbody>{rows}</tbody>
      </table>
    </div>'''



def render_gnb():
    """Render the shared Pages GNB from the canonical partial so Build Health
    can never drift from the other four surfaces (scripts/pages-nav.html)."""
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
    styling stays byte-identical to the four committed surfaces. The braces in
    this string are inserted into the stylesheet f-string as a *substituted*
    value, so its `{ }` are never re-parsed as f-string fields."""
    css_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pages-nav.css")
    with open(css_path, encoding="utf-8") as fh:
        css = fh.read()
    return re.sub(r"/\*[\s\S]*?\*/\s*", "", css, count=1).rstrip()

def generate_html(vitest, android_suites, cov_data, scenarios, scenario_results, history, metadata, robot=None):
    """Generate tab-based SPA test report."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    vitest_meta = suite_meta(metadata, "vitest")
    android_meta = suite_meta(metadata, "android")
    apple_meta = suite_meta(metadata, "apple")
    robot_meta = suite_meta(metadata, "robot")

    # --- Aggregate stats ---
    vt_passed = vitest["numPassedTests"] if vitest else 0
    vt_failed = vitest["numFailedTests"] if vitest else 0
    vt_total = vitest["numTotalTests"] if vitest else 0
    vt_suites = len(vitest.get("testResults", [])) if vitest else 0
    vt_duration = (vitest["testResults"][-1]["endTime"] - vitest["startTime"]) if vitest and vitest.get("testResults") else 0

    and_passed = sum(s["passed"] for s in android_suites)
    and_failed = sum(s["failures"] + s["errors"] for s in android_suites)
    and_total = sum(s["tests"] for s in android_suites)
    and_duration = sum(s["time"] for s in android_suites) * 1000

    rob_passed = robot["passed"] if robot else 0
    rob_failed = robot["failed"] if robot else 0
    rob_skipped = robot["skipped"] if robot else 0
    rob_total = robot["total"] if robot else 0

    total_passed = vt_passed + and_passed + rob_passed
    total_failed = vt_failed + and_failed + rob_failed
    total_all = vt_total + and_total + rob_total
    total_duration = vt_duration + and_duration

    # Coverage
    cov_total = cov_data.get("total", {}) if cov_data else {}
    lines_pct = cov_total.get("lines", {}).get("pct", 0)
    stmts_pct = cov_total.get("statements", {}).get("pct", 0)
    funcs_pct = cov_total.get("functions", {}).get("pct", 0)
    branch_pct = cov_total.get("branches", {}).get("pct", 0)

    pkg_cov = extract_package_coverage(cov_data) if cov_data else {}

    lines_covered = cov_total.get("lines", {}).get("covered", 0) if cov_total else 0
    lines_total_n = cov_total.get("lines", {}).get("total", 0) if cov_total else 0

    # --- Build vitest file data ---
    vt_file_data = {}
    if vitest:
        for result in vitest["testResults"]:
            name = result["name"].replace(str(ROOT) + "/", "")
            st = result["status"]
            assertions = result.get("assertionResults", [])
            passed = sum(1 for a in assertions if a["status"] == "passed")
            failed = sum(1 for a in assertions if a["status"] == "failed")
            dur = result["endTime"] - result["startTime"]
            vt_file_data[name] = {
                "status": st, "passed": passed, "failed": failed,
                "dur": dur, "assertions": assertions,
            }

    # --- Overall status ---
    overall_status = "PASS" if total_failed == 0 else "FAIL"
    overall_color = "#22c55e" if total_failed == 0 else "#ef4444"

    # --- History sparklines ---
    sparklines_html = ""
    if len(history) >= 2:
        sparklines_html = f'''<div class="sparkline-row">
            {sparkline_svg(history, "total", "#38bdf8", "Total Tests")}
            {sparkline_svg(history, "passed", "#22c55e", "Pass Rate")}
            {sparkline_svg(history, "coverage", "#a78bfa", "Line Coverage")}
        </div>'''

    # --- Build layer tab contents ---
    # Compute which layers have data
    active_layers = []
    assigned_files = set()
    layer_stats = {}
    for layer in TEST_LAYERS:
        layer_files = sorted(f for f in vt_file_data if classify_test_file(f) == layer["id"])
        if layer_files:
            assigned_files.update(layer_files)
            lp = sum(vt_file_data[f]["passed"] for f in layer_files)
            lf = sum(vt_file_data[f]["failed"] for f in layer_files)
            ld = sum(vt_file_data[f]["dur"] for f in layer_files)
            layer_stats[layer["id"]] = {"passed": lp, "failed": lf, "total": lp + lf, "dur": ld, "files": layer_files}
            active_layers.append(layer)

    # Helper: build test cases HTML for a file (grouped by top-level describe)
    def build_file_tests_html(name, data):
        """Build HTML for one file with tests grouped by describe blocks."""
        assertions = data["assertions"]
        st = data["status"]
        passed = data["passed"]
        failed = data["failed"]
        dur = data["dur"]
        color = "#22c55e" if st == "passed" else "#ef4444"
        icon = "&#10003;" if st == "passed" else "&#10007;"
        short_name = name.split("__tests__/")[-1] if "__tests__/" in name else name

        # Group assertions by top-level describe (ancestorTitles[0])
        describe_groups = {}
        for a in assertions:
            ancestors = a.get("ancestorTitles", [])
            group_name = ancestors[0] if ancestors else "(top-level)"
            if group_name not in describe_groups:
                describe_groups[group_name] = []
            describe_groups[group_name].append(a)

        groups_html = ""
        for group_name, group_assertions in describe_groups.items():
            g_passed = sum(1 for a in group_assertions if a["status"] == "passed")
            g_failed = sum(1 for a in group_assertions if a["status"] == "failed")
            g_color = "#ef4444" if g_failed else "#22c55e"
            g_icon = "&#10007;" if g_failed else "&#10003;"

            cases_html = ""
            for a in group_assertions:
                a_icon = "&#10003;" if a["status"] == "passed" else "&#10007;"
                a_color = "#22c55e" if a["status"] == "passed" else "#ef4444"
                ancestors = a.get("ancestorTitles", [])
                # Build full path from ancestors (skip first which is the group)
                sub_path = " &#8250; ".join(ancestors[1:]) if len(ancestors) > 1 else ""
                prefix = f'<span class="test-ancestors">{sub_path} &#8250; </span>' if sub_path else ""
                a_dur = f'{a.get("duration", 0)}ms' if a.get("duration") else ""
                fail_msg = ""
                if a.get("failureMessages"):
                    escaped = a["failureMessages"][0][:300].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                    fail_msg = f'<div class="fail-msg">{escaped}</div>'
                cases_html += f'''<div class="test-case">
                  <span class="test-icon" style="color:{a_color}">{a_icon}</span>
                  <div class="test-body">
                    <div class="test-title">{prefix}{a["title"]}</div>
                    {fail_msg}
                  </div>
                  <span class="test-dur">{a_dur}</span>
                </div>'''

            groups_html += f'''<div class="describe-group">
              <div class="describe-header">
                <span class="describe-icon" style="color:{g_color}">{g_icon}</span>
                <span class="describe-name">{group_name}</span>
                <span class="describe-stats"><span style="color:#22c55e">{g_passed}</span> / <span style="color:{"#ef4444" if g_failed else "var(--dim)"}">{g_passed + g_failed}</span></span>
              </div>
              <div class="describe-cases">{cases_html}</div>
            </div>'''

        return f'''<div class="file-block">
          <div class="file-header">
            <span class="file-icon" style="color:{color}">{icon}</span>
            <span class="file-name">{short_name}</span>
            <div class="file-stats">
              <span style="color:#22c55e">{passed}</span>
              <span class="file-sep">/</span>
              <span style="color:{"#ef4444" if failed else "var(--dim)"}">{passed + failed}</span>
              <span class="file-dur">{duration_fmt(dur)}</span>
            </div>
          </div>
          {groups_html}
        </div>'''

    # Build each layer tab content
    layer_tab_contents = {}
    for layer in active_layers:
        files_html = ""
        for f in layer_stats[layer["id"]]["files"]:
            files_html += build_file_tests_html(f, vt_file_data[f])
        layer_tab_contents[layer["id"]] = files_html

    # Unassigned files
    unassigned = [f for f in vt_file_data if f not in assigned_files]
    unassigned_html = ""
    if unassigned:
        for f in sorted(unassigned):
            unassigned_html += build_file_tests_html(f, vt_file_data[f])

    # --- Build android tab content ---
    android_tab_html = ""
    for suite in android_suites:
        short_name = suite["name"].replace("dev.agentdeck.", "")
        color = "#22c55e" if suite["failures"] == 0 else "#ef4444"
        icon = "&#10003;" if suite["failures"] == 0 else "&#10007;"

        cases_html = ""
        for c in suite["cases"]:
            c_icon = "&#10003;" if c["status"] == "passed" else "&#10007;"
            c_color = "#22c55e" if c["status"] == "passed" else "#ef4444"
            c_dur = f'{c["time"]*1000:.0f}ms' if c["time"] > 0 else ""
            fail_msg = ""
            if c.get("failure"):
                escaped = c["failure"][:300].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                fail_msg = f'<div class="fail-msg">{escaped}</div>'
            cases_html += f'''<div class="test-case">
              <span class="test-icon" style="color:{c_color}">{c_icon}</span>
              <div class="test-body">
                <div class="test-title">{c["name"]}</div>
                {fail_msg}
              </div>
              <span class="test-dur">{c_dur}</span>
            </div>'''

        android_tab_html += f'''<div class="file-block">
          <div class="file-header">
            <span class="file-icon" style="color:{color}">{icon}</span>
            <span class="file-name">{short_name}</span>
            <div class="file-stats">
              <span style="color:#22c55e">{suite["passed"]}</span>
              <span class="file-sep">/</span>
              <span style="color:{"#ef4444" if suite["failures"] else "var(--dim)"}">{suite["tests"]}</span>
              <span class="file-dur">{duration_fmt(suite["time"]*1000)}</span>
            </div>
          </div>
          <div class="describe-group">
            <div class="describe-cases">{cases_html}</div>
          </div>
        </div>'''

    # --- Build robot tab content ---
    robot_tab_html = ""
    if robot and robot.get("suites"):
        for suite in robot["suites"]:
            s_color = "#22c55e" if suite["failed"] == 0 else "#ef4444"
            s_icon = "&#10003;" if suite["failed"] == 0 else "&#10007;"
            tags_html = "".join(
                f'<span class="robot-tag">{t}</span>' for t in suite["tags"]
            )

            scenarios_html = ""
            for scenario in suite["scenarios"]:
                is_standalone = scenario.get("standalone", False)
                sc_cases = scenario["cases"]
                sc_passed = sum(1 for c in sc_cases if c["status"] == "passed")
                sc_failed = sum(1 for c in sc_cases if c["status"] == "failed")
                sc_skipped = sum(1 for c in sc_cases if c["status"] == "skipped")
                sc_color = "#22c55e" if sc_failed == 0 else "#ef4444"
                sc_icon = "&#10003;" if sc_failed == 0 else ("&#9675;" if sc_passed == 0 and sc_skipped > 0 else "&#10007;")

                if is_standalone:
                    # Render as simple test case
                    c = sc_cases[0]
                    c_icon = "&#10003;" if c["status"] == "passed" else ("&#9675;" if c["status"] == "skipped" else "&#10007;")
                    c_color = "#22c55e" if c["status"] == "passed" else ("#64748b" if c["status"] == "skipped" else "#ef4444")
                    fail_msg = ""
                    if c.get("message") and c["status"] == "failed":
                        escaped = c["message"][:300].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                        fail_msg = f'<div class="fail-msg">{escaped}</div>'
                    sc_elapsed = duration_fmt(c.get("elapsed_s", 0) * 1000) if c.get("elapsed_s", 0) >= 0.1 else ""
                    scenarios_html += f'''<div class="test-case">
                      <span class="test-icon" style="color:{c_color}">{c_icon}</span>
                      <div class="test-body">
                        <div class="test-title">{c["name"]}</div>
                        {fail_msg}
                      </div>
                      <span class="test-dur">{sc_elapsed}</span>
                    </div>'''
                    continue

                # Multi-board scenario
                boards = scenario.get("boards", [])
                board_count = len(boards)

                # BDD steps
                steps_html = ""
                if scenario.get("steps"):
                    step_lines = ""
                    for step in scenario["steps"]:
                        # Color-code BDD keywords
                        if step.startswith("Given "):
                            kw, rest = "Given", step[6:]
                            kw_color = "#60a5fa"
                        elif step.startswith("When "):
                            kw, rest = "When", step[5:]
                            kw_color = "#fbbf24"
                        elif step.startswith("Then "):
                            kw, rest = "Then", step[5:]
                            kw_color = "#34d399"
                        elif step.startswith("And "):
                            kw, rest = "And", step[4:]
                            kw_color = "#94a3b8"
                        elif step.startswith("But "):
                            kw, rest = "But", step[4:]
                            kw_color = "#f87171"
                        else:
                            kw, rest = "", step
                            kw_color = "#94a3b8"
                        escaped_rest = rest.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                        if kw:
                            step_lines += f'<div class="bdd-step"><span class="bdd-kw" style="color:{kw_color}">{kw}</span> <span class="bdd-text">{escaped_rest}</span></div>'
                        else:
                            step_lines += f'<div class="bdd-step"><span class="bdd-text">{escaped_rest}</span></div>'
                    steps_html = f'<div class="bdd-steps">{step_lines}</div>'

                # Board matrix
                board_chips = ""
                for board_id in ["box_86", "ips35", "amoled", "led8x32"]:
                    label = BOARD_LABELS.get(board_id, board_id)
                    case_for_board = next((c for c in sc_cases if c.get("board") == board_id), None)
                    if case_for_board:
                        if case_for_board["status"] == "passed":
                            chip_style = "background:rgba(34,197,94,0.15);color:#22c55e;border-color:rgba(34,197,94,0.3)"
                            chip_icon = "&#10003;"
                        elif case_for_board["status"] == "skipped":
                            chip_style = "background:rgba(100,116,139,0.15);color:#64748b;border-color:rgba(100,116,139,0.3)"
                            chip_icon = "&#9675;"
                        else:
                            chip_style = "background:rgba(239,68,68,0.15);color:#ef4444;border-color:rgba(239,68,68,0.3)"
                            chip_icon = "&#10007;"
                        board_chips += f'<span class="board-chip" style="{chip_style}">{chip_icon} {label}</span>'
                    else:
                        board_chips += f'<span class="board-chip board-chip-na">— {label}</span>'
                board_matrix_html = f'<div class="board-matrix">{board_chips}</div>'

                # Individual test cases per board
                board_cases_html = ""
                for case in sc_cases:
                    c_icon = "&#10003;" if case["status"] == "passed" else ("&#9675;" if case["status"] == "skipped" else "&#10007;")
                    c_color = "#22c55e" if case["status"] == "passed" else ("#64748b" if case["status"] == "skipped" else "#ef4444")
                    fail_msg = ""
                    if case.get("message") and case["status"] == "failed":
                        escaped = case["message"][:500].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                        fail_msg = f'<div class="fail-msg">{escaped}</div>'
                    c_elapsed = duration_fmt(case.get("elapsed_s", 0) * 1000) if case.get("elapsed_s", 0) >= 0.1 else ""
                    board_cases_html += f'''<div class="test-case">
                      <span class="test-icon" style="color:{c_color}">{c_icon}</span>
                      <div class="test-body">
                        <div class="test-title">{case["name"]}</div>
                        {fail_msg}
                      </div>
                      <span class="test-dur">{c_elapsed}</span>
                    </div>'''

                # Scenario block
                scenarios_html += f'''<div class="describe-group">
                  <div class="describe-header">
                    <span class="describe-icon" style="color:{sc_color}">{sc_icon}</span>
                    <span class="describe-name">{scenario["name"]}</span>
                    <span class="robot-board-badge">{board_count} board{"s" if board_count != 1 else ""}</span>
                    <span class="describe-stats"><span style="color:#22c55e">{sc_passed}</span> / <span style="color:{"#ef4444" if sc_failed else "var(--dim)"}">{len(sc_cases)}</span></span>
                  </div>
                  {steps_html}
                  {board_matrix_html}
                  <div class="describe-cases">{board_cases_html}</div>
                </div>'''

            robot_tab_html += f'''<div class="file-block">
              <div class="file-header">
                <span class="file-icon" style="color:{s_color}">{s_icon}</span>
                <span class="file-name">{suite["source"]}</span>
                <span class="robot-tags">{tags_html}</span>
                <div class="file-stats">
                  <span style="color:#22c55e">{suite["passed"]}</span>
                  <span class="file-sep">/</span>
                  <span style="color:{"#ef4444" if suite["failed"] else "var(--dim)"}">{suite["total"]}</span>
                </div>
              </div>
              {scenarios_html}
            </div>'''
    elif robot:
        # Fallback: flat list (no suite structure available)
        for c in robot["cases"]:
            c_icon = "&#10003;" if c["status"] == "passed" else ("&#9675;" if c["status"] == "skipped" else "&#10007;")
            c_color = "#22c55e" if c["status"] == "passed" else ("#64748b" if c["status"] == "skipped" else "#ef4444")
            fail_msg = ""
            if c.get("message") and c["status"] == "failed":
                escaped = c["message"][:300].replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                fail_msg = f'<div class="fail-msg">{escaped}</div>'
            fb_elapsed = duration_fmt(c.get("elapsed_s", 0) * 1000) if c.get("elapsed_s", 0) >= 0.1 else ""
            robot_tab_html += f'''<div class="test-case">
              <span class="test-icon" style="color:{c_color}">{c_icon}</span>
              <div class="test-body">
                <div class="test-title">{c["name"]}</div>
                {fail_msg}
              </div>
              <span class="test-dur">{fb_elapsed}</span>
            </div>'''

    # --- Build scenario tab content ---
    scenario_tab_html = ""
    if scenario_results:
        sc_total = len(scenario_results)
        sc_full = sum(1 for s in scenario_results
                      if all(s["categories"][c]["total"] == 0 or (s["categories"][c]["failed"] == 0 and s["categories"][c]["missing"] == 0 and s["categories"][c].get("not_run", 0) == 0)
                             for c in ("unit", "integration", "platform", "e2e"))
                      and any(s["categories"][c]["total"] > 0 for c in ("unit", "integration", "platform", "e2e")))
        sc_gaps = sum(1 for s in scenario_results if s["gaps"])

        scenario_rows = ""
        for sc in scenario_results:
            priority_colors = {"critical": "#ef4444", "high": "#f97316", "medium": "#eab308", "low": "#64748b"}
            p_color = priority_colors.get(sc["priority"], "#64748b")
            unit_cell = scenario_cell_html(sc["categories"]["unit"])
            integ_cell = scenario_cell_html(sc["categories"]["integration"])
            plat_cell = scenario_cell_html(sc["categories"]["platform"])
            e2e_cell = scenario_cell_html(sc["categories"]["e2e"])

            all_passed_sc = sum(sc["categories"][c]["passed"] for c in ("unit", "integration", "platform", "e2e"))
            all_total_sc = sum(sc["categories"][c]["total"] for c in ("unit", "integration", "platform", "e2e"))
            all_failed_sc = sum(sc["categories"][c]["failed"] for c in ("unit", "integration", "platform", "e2e"))
            all_missing_sc = sum(sc["categories"][c]["missing"] for c in ("unit", "integration", "platform", "e2e"))
            all_not_run_sc = sum(sc["categories"][c].get("not_run", 0) for c in ("unit", "integration", "platform", "e2e"))

            if all_total_sc == 0:
                score_cls = "sc-none"
            elif all_failed_sc > 0:
                score_cls = "sc-fail"
            elif all_missing_sc > 0 or all_not_run_sc > 0:
                score_cls = "sc-warn"
            else:
                score_cls = "sc-pass"

            gaps_html = ""
            if sc["gaps"]:
                gaps_items = "".join(f"<li>{g}</li>" for g in sc["gaps"])
                gaps_html = f'<ul class="sc-gaps">{gaps_items}</ul>'

            detail_html = ""
            for cat in ("unit", "integration", "platform", "e2e"):
                for t in sc["categories"][cat]["tests"]:
                    t_icon = "&#10003;" if t["status"] == "pass" else ("&#10007;" if t["status"] == "fail" else "&#9675;" if t["status"] == "not-run" else "?")
                    t_color = "#22c55e" if t["status"] == "pass" else ("#ef4444" if t["status"] == "fail" else "#94a3b8" if t["status"] == "not-run" else "#64748b")
                    t_fail_color = "#ef4444" if t["failed"] else "#64748b"
                    detail_html += f'''<tr class="sc-detail-row" data-scenario="{sc["id"]}" style="display:none">
                        <td style="padding-left:2rem;color:{t_color}">{t_icon}</td>
                        <td class="file-path" style="font-size:0.75rem">{t["file"]}</td>
                        <td>{category_badge_html(cat)}</td>
                        <td style="text-align:right;color:#22c55e;font-size:0.8rem">{t["passed"]}</td>
                        <td style="text-align:right;color:{t_fail_color};font-size:0.8rem">{t["failed"]}</td>
                        <td></td>
                    </tr>'''

            scenario_rows += f'''<tr class="sc-row" onclick="toggleScenario('{sc["id"]}')" style="cursor:pointer">
                <td class="{score_cls}" style="font-weight:600;text-align:center">{all_passed_sc}/{all_total_sc}</td>
                <td>
                    <div style="font-weight:500">{sc["name"]}</div>
                    <div style="font-size:0.75rem;color:var(--dim)">{sc["description"]}</div>
                    {gaps_html}
                </td>
                <td style="text-align:center"><span style="color:{p_color};font-size:0.75rem;font-weight:600;text-transform:uppercase">{sc["priority"]}</span></td>
                {unit_cell}{integ_cell}{plat_cell}{e2e_cell}
            </tr>{detail_html}'''

        scenario_tab_html = f'''<div class="sc-summary-bar">
          <span class="sc-summary-item"><span style="color:#22c55e;font-weight:600">{sc_full}</span> covered</span>
          <span class="sc-summary-item"><span style="color:#eab308;font-weight:600">{sc_total - sc_full}</span> partial/missing</span>
          <span class="sc-summary-item"><span style="color:#f97316;font-weight:600">{sc_gaps}</span> with identified gaps</span>
        </div>
        <table class="scenario-table">
          <thead><tr>
            <th style="width:60px;text-align:center">Score</th>
            <th>Scenario</th>
            <th style="width:70px;text-align:center">Priority</th>
            <th style="width:70px;text-align:center">Unit</th>
            <th style="width:70px;text-align:center">Integ.</th>
            <th style="width:70px;text-align:center">Platform</th>
            <th style="width:70px;text-align:center">E2E</th>
          </tr></thead>
          <tbody>{scenario_rows}</tbody>
        </table>'''

    # --- Build coverage tab content ---
    coverage_tab_html = ""
    if cov_data:
        pkg_cards = ""
        for pkg_name in ("bridge", "plugin", "shared", "hooks"):
            if pkg_name not in pkg_cov:
                continue
            pkg = pkg_cov[pkg_name]
            pkg_cards += f'''<div class="cov-card">
                <div class="cov-card-header">{pkg_name}</div>
                <div class="cov-card-gauges">
                    <div class="gauge-item">{gauge_svg(pkg["lines"]["pct"])}<span>Lines</span></div>
                    <div class="gauge-item">{gauge_svg(pkg["statements"]["pct"])}<span>Stmts</span></div>
                    <div class="gauge-item">{gauge_svg(pkg["functions"]["pct"])}<span>Funcs</span></div>
                    <div class="gauge-item">{gauge_svg(pkg["branches"]["pct"])}<span>Branch</span></div>
                </div>
                <div class="cov-card-detail">{pkg["lines"]["covered"]}/{pkg["lines"]["total"]} lines covered</div>
            </div>'''

        cov_file_rows = ""
        for pkg_name in sorted(pkg_cov.keys()):
            pkg = pkg_cov[pkg_name]
            for fi in sorted(pkg["files"], key=lambda x: x["lines_pct"]):
                bar_w = min(fi["lines_pct"], 100)
                bar_color = pct_color(fi["lines_pct"])
                fi_pkg = fi["path"].split("/")[0] if "/" in fi["path"] else "other"
                cov_file_rows += f'''<tr data-pkg="{fi_pkg}">
                    <td class="file-path">{fi["path"]}</td>
                    <td style="text-align:right;color:{pct_color(fi["stmts_pct"])}">{fi["stmts_pct"]:.0f}%</td>
                    <td style="text-align:right;color:{pct_color(fi["branch_pct"])}">{fi["branch_pct"]:.0f}%</td>
                    <td style="text-align:right;color:{pct_color(fi["funcs_pct"])}">{fi["funcs_pct"]:.0f}%</td>
                    <td style="text-align:right;color:{pct_color(fi["lines_pct"])}">{fi["lines_pct"]:.0f}%</td>
                    <td style="width:100px"><div class="cov-bar"><div class="cov-fill" style="width:{bar_w}%;background:{bar_color}"></div></div></td>
                </tr>'''

        thresholds = read_coverage_thresholds()
        threshold_rows = ""
        for label, key, pct in (("Lines", "lines", lines_pct), ("Functions", "functions", funcs_pct),
                                ("Branches", "branches", branch_pct), ("Statements", "statements", stmts_pct)):
            floor = thresholds.get(key)
            if floor is None:
                threshold_rows += f'<div class="threshold"><div class="dot" style="background:var(--dim)"></div>{label}: {pct:.1f}% (no floor configured)</div>'
                continue
            dot = "#22c55e" if pct >= floor else "#ef4444"
            threshold_rows += f'<div class="threshold"><div class="dot" style="background:{dot}"></div>{label} &ge;{floor:g}%: {pct:.1f}%</div>'
        coverage_tab_html = f'''<div style="margin-bottom:1rem">
          {threshold_rows}
          <div class="threshold" style="color:var(--dim)">Floors are read from vitest.config.ts and enforced on every PR.</div>
        </div>
        <div class="cov-cards">{pkg_cards}</div>
        <div class="cov-filter">
          <button class="active" onclick="filterCov('all',this)">All</button>
          <button onclick="filterCov('bridge',this)">bridge</button>
          <button onclick="filterCov('plugin',this)">plugin</button>
          <button onclick="filterCov('shared',this)">shared</button>
          <button onclick="filterCov('uncovered',this)">0% only</button>
        </div>
        <table id="cov-table">
          <thead><tr>
            <th>File</th>
            <th style="text-align:right;width:70px">Stmts</th>
            <th style="text-align:right;width:70px">Branch</th>
            <th style="text-align:right;width:70px">Funcs</th>
            <th style="text-align:right;width:70px">Lines</th>
            <th style="width:110px"></th>
          </tr></thead>
          <tbody>{cov_file_rows}</tbody>
        </table>'''

    # --- Build sidebar nav items ---
    sidebar_items = ""

    # Overview tab
    sidebar_items += f'''<div class="nav-item active" data-tab="overview" onclick="switchTab('overview',this)">
      <div class="nav-indicator" style="background:var(--accent)"></div>
      <div class="nav-label">
        <span class="nav-icon">&#9670;</span>
        <span>Overview</span>
      </div>
      <span class="nav-badge" style="color:{overall_color}">{overall_status}</span>
    </div>'''

    # What we verify
    sidebar_items += f'''<div class="nav-item" data-tab="verify" onclick="switchTab('verify',this)">
      <div class="nav-indicator" style="background:var(--kelp-700)"></div>
      <div class="nav-label">
        <span class="nav-icon">&#9745;</span>
        <span>What we verify</span>
      </div>
      <span class="nav-badge" style="color:var(--dim)">{len(CATALOG.get("gates", []))}</span>
    </div>'''

    # Layer tabs
    for layer in active_layers:
        ls = layer_stats[layer["id"]]
        l_status_color = "#22c55e" if ls["failed"] == 0 else "#ef4444"
        l_badge = f'{ls["passed"]}/{ls["total"]}'
        sidebar_items += f'''<div class="nav-item" data-tab="layer-{layer["id"]}" onclick="switchTab('layer-{layer["id"]}',this)">
          <div class="nav-indicator" style="background:{layer["color"]}"></div>
          <div class="nav-label">
            <span class="nav-icon">{layer["icon"]}</span>
            <span>{layer["name"]}</span>
          </div>
          <span class="nav-badge" style="color:{l_status_color}">{l_badge}</span>
        </div>'''

    # Unassigned vitest files tab
    if unassigned:
        ua_p = sum(vt_file_data[f]["passed"] for f in unassigned)
        ua_f = sum(vt_file_data[f]["failed"] for f in unassigned)
        ua_color = "#22c55e" if ua_f == 0 else "#ef4444"
        sidebar_items += f'''<div class="nav-item" data-tab="layer-other" onclick="switchTab('layer-other',this)">
          <div class="nav-indicator" style="background:var(--dim)"></div>
          <div class="nav-label">
            <span class="nav-icon">&#9675;</span>
            <span>Other Tests</span>
          </div>
          <span class="nav-badge" style="color:{ua_color}">{ua_p}/{ua_p + ua_f}</span>
        </div>'''

    # Android tab
    and_badge_color = "#22c55e" if and_failed == 0 and and_total > 0 else ("#ef4444" if and_failed > 0 else "var(--dim)")
    sidebar_items += f'''<div class="nav-item nav-separator" data-tab="android" onclick="switchTab('android',this)">
      <div class="nav-indicator" style="background:#a3e635"></div>
      <div class="nav-label">
        <span class="nav-icon">&#9635;</span>
        <span>Android</span>
      </div>
      <span class="nav-badge" style="color:{and_badge_color}">{and_passed}/{and_total if and_total else "—"}</span>
    </div>'''

    # Robot tab
    rob_badge_color = "#22c55e" if rob_failed == 0 and rob_total > 0 else ("#ef4444" if rob_failed > 0 else "var(--dim)")
    sidebar_items += f'''<div class="nav-item" data-tab="robot" onclick="switchTab('robot',this)">
      <div class="nav-indicator" style="background:#fb923c"></div>
      <div class="nav-label">
        <span class="nav-icon">&#9641;</span>
        <span>Robot</span>
      </div>
      <span class="nav-badge" style="color:{rob_badge_color}">{rob_passed}/{rob_total if rob_total else "—"}</span>
    </div>'''

    # Scenarios tab
    if scenario_results:
        sidebar_items += f'''<div class="nav-item nav-separator" data-tab="scenarios" onclick="switchTab('scenarios',this)">
          <div class="nav-indicator" style="background:#f472b6"></div>
          <div class="nav-label">
            <span class="nav-icon">&#9638;</span>
            <span>Scenarios</span>
          </div>
          <span class="nav-badge" style="color:var(--dim)">{len(scenario_results)}</span>
        </div>'''

    # Coverage tab
    if cov_data:
        sidebar_items += f'''<div class="nav-item" data-tab="coverage" onclick="switchTab('coverage',this)">
          <div class="nav-indicator" style="background:#a78bfa"></div>
          <div class="nav-label">
            <span class="nav-icon">&#9636;</span>
            <span>Coverage</span>
          </div>
          <span class="nav-badge" style="color:{pct_color(lines_pct)}">{lines_pct:.0f}%</span>
        </div>'''

    # --- Build tab panels ---
    tab_panels = ""

    # Overview panel
    tab_panels += f'''<div class="tab-panel" id="tab-verify">{build_verification_html(CATALOG, metadata, vt_file_data)}</div>'''

    tab_panels += f'''<div class="tab-panel active" id="tab-overview">
      <div class="summary">
        <div class="card">
          <div class="card-label">Status</div>
          <div class="card-value" style="color:{overall_color}">{overall_status}</div>
          <div class="card-sub">{total_all} executed tests</div>
        </div>
        <div class="card">
          <div class="card-label">Passed</div>
          <div class="card-value" style="color:#22c55e">{total_passed}</div>
          <div class="card-sub">{total_passed/total_all*100 if total_all else 0:.1f}% pass rate</div>
        </div>
        <div class="card">
          <div class="card-label">Failed</div>
          <div class="card-value" style="color:{"#ef4444" if total_failed else "#64748b"}">{total_failed}</div>
          <div class="card-sub">&nbsp;</div>
        </div>
        <div class="card">
          <div class="card-label">Duration</div>
          <div class="card-value" style="color:var(--accent)">{duration_fmt(total_duration)}</div>
          <div class="card-sub">{duration_fmt(vt_duration)} vitest + {duration_fmt(and_duration)} android</div>
        </div>
        <div class="card">
          <div class="card-label">TS Line Coverage</div>
          <div class="card-value" style="color:{pct_color(lines_pct)}">{lines_pct:.1f}%</div>
          <div class="card-sub">{lines_covered:,}/{lines_total_n:,} TypeScript lines</div>
        </div>
      </div>

      {sparklines_html}

      <div class="suite-bars">
        <div class="suite-bar">
          <div class="suite-bar-header">
            <h3>Vitest</h3>
            {status_badge(vitest_meta["status"])}
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width:{vt_passed/vt_total*100 if vt_total else 0:.1f}%;background:{suite_progress_color(vitest_meta["status"])}"></div>
          </div>
          <div class="suite-stats">
            <span>Pass {vt_passed}</span>
            <span>Fail {vt_failed}</span>
            <span>{vt_suites} files</span>
            <span>{vitest_meta["note"] or duration_fmt(vt_duration)}</span>
          </div>
        </div>
        <div class="suite-bar">
          <div class="suite-bar-header">
            <h3>Android</h3>
            {status_badge(android_meta["status"])}
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width:{and_passed/and_total*100 if and_total else 0:.1f}%;background:{suite_progress_color(android_meta["status"])}"></div>
          </div>
          <div class="suite-stats">
            <span>Pass {and_passed}</span>
            <span>Fail {and_failed}</span>
            <span>{len(android_suites)} files</span>
            <span>{android_meta["note"] or duration_fmt(and_duration)}</span>
          </div>
        </div>
        <div class="suite-bar">
          <div class="suite-bar-header">
            <h3>Apple (XCTest)</h3>
            {status_badge(apple_meta["status"])}
          </div>
          <div class="progress-bar"><div class="progress-fill" style="width:0;background:{suite_progress_color(apple_meta["status"])}"></div></div>
          <div class="suite-stats"><span style="color:var(--dim)">{apple_meta["note"] or "Requires macOS runner"}</span></div>
        </div>
        <div class="suite-bar">
          <div class="suite-bar-header">
            <h3>Robot Framework</h3>
            {status_badge(robot_meta["status"])}
          </div>
          <div class="progress-bar">
            <div class="progress-fill" style="width:{rob_passed/rob_total*100 if rob_total else 0:.1f}%;background:{suite_progress_color(robot_meta["status"])}"></div>
          </div>
          <div class="suite-stats">
            {f"<span>Pass {rob_passed}</span><span>Fail {rob_failed}</span><span>Skip {rob_skipped}</span>" if robot else f'<span style="color:var(--dim)">{robot_meta["note"] or "Not available"}</span>'}
          </div>
        </div>
      </div>
    </div>'''

    # Layer panels
    for layer in active_layers:
        ls = layer_stats[layer["id"]]
        l_status = "PASS" if ls["failed"] == 0 else "FAIL"
        l_status_color = "#22c55e" if ls["failed"] == 0 else "#ef4444"
        content = layer_tab_contents.get(layer["id"], "")
        tab_panels += f'''<div class="tab-panel" id="tab-layer-{layer["id"]}">
          <div class="layer-tab-header" style="border-left:4px solid {layer["color"]}">
            <div class="layer-tab-title">
              <span style="color:{layer["color"]};font-size:1.25rem;margin-right:0.5rem">{layer["icon"]}</span>
              <span style="font-size:1.1rem;font-weight:600">{layer["name"]}</span>
              <span class="layer-tab-badge" style="color:{l_status_color}">{l_status}</span>
            </div>
            <div class="layer-tab-question">{layer["question"]}</div>
            <div class="layer-tab-stats">
              <span style="color:#22c55e">{ls["passed"]} passed</span>
              <span style="color:{"#ef4444" if ls["failed"] else "var(--dim)"}">{ls["failed"]} failed</span>
              <span style="color:var(--dim)">{len(ls["files"])} files</span>
              <span style="color:var(--dim)">{duration_fmt(ls["dur"])}</span>
            </div>
          </div>
          {content}
        </div>'''

    # Unassigned panel
    if unassigned:
        ua_p = sum(vt_file_data[f]["passed"] for f in unassigned)
        ua_f = sum(vt_file_data[f]["failed"] for f in unassigned)
        tab_panels += f'''<div class="tab-panel" id="tab-layer-other">
          <div class="layer-tab-header" style="border-left:4px solid var(--dim)">
            <div class="layer-tab-title">
              <span style="color:var(--dim);font-size:1.25rem;margin-right:0.5rem">&#9675;</span>
              <span style="font-size:1.1rem;font-weight:600">Other Tests</span>
            </div>
            <div class="layer-tab-question">Uncategorized test files</div>
            <div class="layer-tab-stats">
              <span style="color:#22c55e">{ua_p} passed</span>
              <span style="color:{"#ef4444" if ua_f else "var(--dim)"}">{ua_f} failed</span>
              <span style="color:var(--dim)">{len(unassigned)} files</span>
            </div>
          </div>
          {unassigned_html}
        </div>'''

    # Android panel
    tab_panels += f'''<div class="tab-panel" id="tab-android">
      <div class="layer-tab-header" style="border-left:4px solid #a3e635">
        <div class="layer-tab-title">
          <span style="color:#a3e635;font-size:1.25rem;margin-right:0.5rem">&#9635;</span>
          <span style="font-size:1.1rem;font-weight:600">Android</span>
          <span class="layer-tab-badge" style="color:{and_badge_color}">{status_badge(android_meta["status"])}</span>
        </div>
        <div class="layer-tab-question">JUnit + Robolectric &middot; {len(android_suites)} files &middot; {and_total} tests</div>
      </div>
      {android_tab_html if android_suites else '<div class="empty-state">No Android test results available.</div>'}
    </div>'''

    # Robot panel
    tab_panels += f'''<div class="tab-panel" id="tab-robot">
      <div class="layer-tab-header" style="border-left:4px solid #fb923c">
        <div class="layer-tab-title">
          <span style="color:#fb923c;font-size:1.25rem;margin-right:0.5rem">&#9641;</span>
          <span style="font-size:1.1rem;font-weight:600">ESP32 Firmware Verification</span>
          <span class="layer-tab-badge">{status_badge(robot_meta["status"])}</span>
        </div>
      <div class="layer-tab-question">Robot Framework &middot; physical hardware behavior when an HW-tagged run is supplied &middot; {len(robot.get("suites", [])) if robot else 0} suites &middot; {robot.get("scenario_count", 0) if robot else 0} scenarios &middot; {rob_total} tests &middot; {len(robot.get("boards", [])) if robot else 0} boards</div>
      </div>
      {_build_robot_perf_table(robot) if robot and robot.get("perf_summary") else ""}
      {robot_tab_html if robot else '<div class="empty-state">No Robot Framework test results available.</div>'}
    </div>'''

    # Scenario panel
    if scenario_results:
        tab_panels += f'''<div class="tab-panel" id="tab-scenarios">
          <div class="layer-tab-header" style="border-left:4px solid #f472b6">
            <div class="layer-tab-title">
              <span style="color:#f472b6;font-size:1.25rem;margin-right:0.5rem">&#9638;</span>
              <span style="font-size:1.1rem;font-weight:600">Scenario Coverage</span>
            </div>
            <div class="layer-tab-question">User scenario mapping against actual test results</div>
          </div>
          {scenario_tab_html}
        </div>'''

    # Coverage panel
    if cov_data:
        tab_panels += f'''<div class="tab-panel" id="tab-coverage">
          <div class="layer-tab-header" style="border-left:4px solid #a78bfa">
            <div class="layer-tab-title">
              <span style="color:#a78bfa;font-size:1.25rem;margin-right:0.5rem">&#9636;</span>
              <span style="font-size:1.1rem;font-weight:600">Coverage</span>
            </div>
            <div class="layer-tab-question">v8 provider &middot; {lines_total_n:,} lines tracked</div>
          </div>
          {coverage_tab_html}
        </div>'''

    gnb = render_gnb()
    gnb_css = render_gnb_css()
    html = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AgentDeck — Test Report</title>
<meta name="description" content="Latest AgentDeck automated checks, scenario coverage, test history, and known quality gaps.">
<link rel="icon" type="image/png" href="../icon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&amp;family=IBM+Plex+Sans+KR:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500;600&amp;display=swap" rel="stylesheet">
<style>
:root {{ --tide-50:#f5f3ec; --tide-100:#ebe6d6; --tide-200:#d8cfb6; --ink-900:#0e1f1f; --ink-700:#1f4544; --ink-500:#426664; --kelp-500:#2f8a7c; --ink-800:#15302f; --kelp-700:#1f6157; --tide-300:#a8b09a; --coral-500:#c0573a; --bg:var(--tide-50); --surface:var(--tide-100); --surface2:var(--tide-200); --text:var(--ink-900); --dim:var(--ink-500); --accent:var(--kelp-500); }} /* canonical names mirror design/tokens.css — gated by verify-tokens-sync.py */
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
body {{ --sidebar-w: 240px; background: var(--bg); color: var(--text); font-family:'IBM Plex Sans','IBM Plex Sans KR',-apple-system,BlinkMacSystemFont,system-ui,sans-serif; line-height: 1.5; }}

/* Layout */
.app {{ display: flex; min-height: 100vh; max-width: 1240px; margin: 0 auto; padding: 0 32px; gap: 0; }}
.sidebar {{ width: var(--sidebar-w); flex: 0 0 var(--sidebar-w); position: sticky; top: 55px; align-self: flex-start; max-height: calc(100vh - 55px); background: var(--surface); border-right: 1px solid var(--surface2); overflow-y: auto; z-index: 10; display: flex; flex-direction: column; }}
.sidebar-header {{ padding: 1.25rem 1rem 1rem; border-bottom: 1px solid var(--surface2); }}
.sidebar-header h1 {{ font-size: 1rem; font-weight: 700; }}
.sidebar-header .subtitle {{ color: var(--dim); font-size: 0.7rem; margin-top: 0.25rem; }}
.sidebar-nav {{ flex: 1; padding: 0.5rem 0; overflow-y: auto; }}
.content {{ flex: 1; padding: 2rem; min-width: 0; }}

/* Public Pages shell — GNB styling injected from scripts/pages-nav.css so it
   cannot drift from the other four surfaces. */
{gnb_css}
.report-intro {{ max-width:850px; margin:0 0 2rem; padding-bottom:1.5rem; border-bottom:2px solid var(--surface2); }}
.report-intro .kicker {{ color:var(--kelp-700); font:600 12px/1.4 'JetBrains Mono',monospace; letter-spacing:.18em; text-transform:uppercase; }}
.report-intro h2 {{ margin:.5rem 0; font-size:clamp(2rem,5vw,3.5rem); letter-spacing:-.035em; line-height:1.03; }}
.report-intro p {{ color:var(--dim); font-size:1.05rem; max-width:64ch; }}
.report-intro .freshness {{ margin-top:.75rem; font:500 .75rem/1.4 'JetBrains Mono',monospace; color:var(--kelp-700); }}

/* Nav items */
.nav-item {{ display: flex; align-items: center; padding: 0.5rem 0.75rem; cursor: pointer; transition: background 0.15s; position: relative; gap: 0.5rem; }}
.nav-item:hover {{ background: var(--surface2); }}
.nav-item.active {{ background: rgba(47, 138, 124, 0.12); }}
.nav-item.active .nav-indicator {{ opacity: 1; }}
.nav-indicator {{ width: 3px; border-radius: 2px; align-self: stretch; opacity: 0.3; transition: opacity 0.15s; flex-shrink: 0; }}
.nav-label {{ display: flex; align-items: center; gap: 0.4rem; flex: 1; min-width: 0; }}
.nav-label span:last-child {{ overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.8rem; }}
.nav-icon {{ font-size: 0.9rem; flex-shrink: 0; width: 1.2rem; text-align: center; }}
.nav-badge {{ font-size: 0.7rem; font-weight: 600; flex-shrink: 0; }}
.nav-separator {{ margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--surface2); }}

/* Tab panels */
.tab-panel {{ display: none; animation: fadeIn 0.2s ease; }}
.tab-panel.active {{ display: block; }}
@keyframes fadeIn {{ from {{ opacity: 0; transform: translateY(4px); }} to {{ opacity: 1; transform: translateY(0); }} }}

/* Layer tab header */
.layer-tab-header {{ padding: 1.25rem; background: var(--surface); border-radius: 12px; margin-bottom: 1.5rem; }}
.layer-tab-title {{ display: flex; align-items: center; gap: 0.25rem; }}
.layer-tab-badge {{ font-size: 0.8rem; font-weight: 700; margin-left: 0.75rem; }}
.layer-tab-question {{ color: var(--dim); font-size: 0.85rem; margin-top: 0.5rem; }}
.layer-tab-stats {{ display: flex; gap: 1.25rem; margin-top: 0.75rem; font-size: 0.8rem; }}

/* File blocks */
.file-block {{ background: var(--surface); border-radius: 10px; margin-bottom: 0.75rem; overflow: hidden; }}
.file-header {{ display: flex; align-items: center; padding: 0.75rem 1rem; gap: 0.5rem; }}
.file-icon {{ font-size: 0.9rem; font-weight: 600; flex-shrink: 0; }}
.file-name {{ font-family:'JetBrains Mono','IBM Plex Mono',monospace; font-size: 0.8rem; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
.file-stats {{ display: flex; align-items: center; gap: 0.25rem; font-size: 0.8rem; flex-shrink: 0; }}
.file-sep {{ color: var(--dim); }}
.file-dur {{ color: var(--dim); font-size: 0.75rem; margin-left: 0.5rem; }}

/* Describe groups */
.describe-group {{ border-top: 1px solid var(--surface2); }}
.describe-header {{ display: flex; align-items: center; padding: 0.5rem 1rem; gap: 0.5rem; background: rgba(14,31,31,0.04); }}
.describe-icon {{ font-size: 0.8rem; flex-shrink: 0; }}
.describe-name {{ font-size: 0.8rem; font-weight: 600; flex: 1; }}
.describe-stats {{ font-size: 0.75rem; color: var(--dim); }}
.describe-cases {{ padding: 0 0 0.25rem; }}

/* Robot BDD & Board matrix */
.robot-tags {{ display: flex; gap: 0.25rem; margin-left: 0.5rem; }}
.robot-tag {{ font-size: 0.65rem; padding: 1px 6px; border-radius: 3px; background: rgba(251,146,60,0.15); color: #fb923c; border: 1px solid rgba(251,146,60,0.25); }}
.robot-board-badge {{ font-size: 0.7rem; padding: 1px 6px; border-radius: 3px; background: rgba(96,165,250,0.12); color: #60a5fa; }}
.bdd-steps {{ padding: 0.4rem 1rem 0.25rem 2.5rem; }}
.bdd-step {{ font-size: 0.78rem; line-height: 1.6; font-family: 'SF Mono', 'Fira Code', monospace; }}
.bdd-kw {{ font-weight: 700; display: inline-block; min-width: 3.5em; }}
.bdd-text {{ color: var(--text); }}
.board-matrix {{ display: flex; gap: 0.35rem; padding: 0.35rem 1rem 0.5rem 2.5rem; flex-wrap: wrap; }}
.board-chip {{ font-size: 0.7rem; padding: 2px 8px; border-radius: 4px; border: 1px solid; white-space: nowrap; }}
.board-chip-na {{ background: rgba(51,65,85,0.3); color: #475569; border-color: rgba(51,65,85,0.4); }}
.perf-table-wrap {{ margin: 0 0 1rem; }}
.perf-table {{ width: 100%; border-collapse: collapse; background: var(--surface); border-radius: 10px; overflow: hidden; }}
.perf-table th {{ text-align: left; padding: 0.6rem 0.75rem; color: var(--dim); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--surface2); }}
.perf-table td {{ padding: 0.5rem 0.75rem; font-size: 0.8rem; font-family:'JetBrains Mono','IBM Plex Mono',monospace; border-bottom: 1px solid var(--surface2); }}
.perf-table tr:last-child td {{ border-bottom: none; }}

/* Test cases */
.test-case {{ display: flex; align-items: flex-start; padding: 0.3rem 1rem 0.3rem 2rem; gap: 0.5rem; }}
.test-icon {{ font-size: 0.75rem; flex-shrink: 0; margin-top: 2px; }}
.test-body {{ flex: 1; min-width: 0; }}
.test-title {{ font-size: 0.8rem; }}
.test-ancestors {{ color: var(--dim); font-size: 0.75rem; }}
.test-dur {{ font-size: 0.7rem; color: var(--dim); flex-shrink: 0; }}

/* Summary cards */
.summary {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }}
.card {{ background: var(--surface); border-radius: 12px; padding: 1.25rem; }}
.card-label {{ color: var(--dim); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }}
.card-value {{ font-size: 2rem; font-weight: 700; }}
.card-sub {{ color: var(--dim); font-size: 0.8rem; margin-top: 0.25rem; }}

/* Sparkline row */
.sparkline-row {{ display: flex; gap: 1.5rem; margin-bottom: 2rem; padding: 0.75rem 1rem; background: var(--surface); border-radius: 12px; }}
.sparkline-card {{ flex: 1; text-align: center; }}
.sparkline-label {{ font-size: 0.7rem; color: var(--dim); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.25rem; }}
.sparkline-value {{ font-size: 0.85rem; font-weight: 600; margin-top: 0.25rem; }}

/* Suite bars */
.suite-bars {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2rem; }}
.suite-bar {{ background: var(--surface); border-radius: 12px; padding: 1rem 1.25rem; }}
.suite-bar-header {{ display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }}
.suite-bar-header h3 {{ font-size: 0.95rem; font-weight: 600; }}
.badge {{ font-size: 0.7rem; font-weight: 700; padding: 2px 8px; border-radius: 4px; display: inline-block; }}
.badge.pass {{ background: #16a34a22; color: #22c55e; }}
.badge.fail {{ background: #dc262622; color: #ef4444; }}
.badge.skip {{ background: #ca8a0422; color: #eab308; }}
.progress-bar {{ height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden; }}
.progress-fill {{ height: 100%; border-radius: 3px; transition: width 0.5s; }}
.suite-stats {{ display: flex; gap: 1rem; margin-top: 0.5rem; font-size: 0.8rem; color: var(--dim); }}

/* Fail messages */
.fail-msg {{ color: #ef4444; font-size: 0.75rem; margin-top: 0.25rem; font-family: monospace; white-space: pre-wrap; max-height: 100px; overflow: auto; }}

/* Coverage cards */
.cov-cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }}
.cov-card {{ background: var(--surface); border-radius: 12px; padding: 1rem; }}
.cov-card-header {{ font-weight: 600; font-size: 0.95rem; margin-bottom: 0.75rem; }}
.cov-card-gauges {{ display: flex; justify-content: space-around; }}
.gauge-item {{ text-align: center; }}
.gauge-item span {{ display: block; font-size: 0.7rem; color: var(--dim); margin-top: 2px; }}
.cov-card-detail {{ text-align: center; color: var(--dim); font-size: 0.75rem; margin-top: 0.75rem; }}
.cov-bar {{ height: 6px; background: var(--surface2); border-radius: 3px; overflow: hidden; }}
.cov-fill {{ height: 100%; border-radius: 3px; }}
.cov-filter {{ margin-bottom: 1rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }}
.cov-filter button {{ background: var(--surface); color: var(--text); border: 1px solid var(--surface2); padding: 4px 12px; border-radius: 6px; font-size: 0.8rem; cursor: pointer; }}
.cov-filter button.active {{ background: var(--accent); color: var(--bg); border-color: var(--accent); }}

/* Threshold indicators */
.threshold {{ display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.8rem; background: var(--surface); padding: 4px 12px; border-radius: 6px; margin-right: 0.5rem; margin-bottom: 0.5rem; }}
.verify h3 {{ margin: 1.75rem 0 .5rem; font-size: 1.05rem; }}
.verify .vintro {{ color: var(--dim); font-size: .9rem; max-width: 80ch; margin-bottom: .75rem; }}
.vscroll {{ overflow-x: auto; }}
.vtable td {{ vertical-align: top; font-size: .8rem; padding: .6rem .75rem; border-bottom: 1px solid var(--surface2); }}
.vtable code {{ font-family: 'JetBrains Mono', monospace; font-size: .7rem; color: var(--ink-700); }}
.verify a {{ color: var(--kelp-700); }}
.vmeta {{ color: var(--dim); font-size: .72rem; margin-top: .25rem; }}
.vlevel {{ display: inline-block; font: 600 .65rem/1.4 'JetBrains Mono', monospace; padding: 0 6px; margin-right: 4px; border-radius: 4px; background: var(--surface2); color: var(--ink-700); }}
.vlist {{ margin: 0; padding-left: 1rem; }}
.vlist li {{ margin-bottom: .2rem; }}
.vneg li {{ color: var(--dim); }}
.vlegend {{ padding-left: 1rem; font-size: .8rem; color: var(--dim); }}
.threshold .dot {{ width: 8px; height: 8px; border-radius: 50%; }}

/* Tables */
table {{ width: 100%; border-collapse: collapse; }}
th {{ text-align: left; color: var(--dim); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--surface2); }}
td {{ padding: 0.5rem 0.75rem; border-bottom: 1px solid #1e293b; font-size: 0.85rem; }}
.file-path {{ font-family:'JetBrains Mono','IBM Plex Mono',monospace; font-size: 0.8rem; }}

/* Scenario matrix */
.scenario-table {{ margin-top: 1rem; }}
.sc-row:hover {{ background: var(--surface); cursor: pointer; }}
.sc-cell {{ text-align: center; font-size: 0.85rem; font-weight: 600; border-radius: 4px; }}
.sc-pass {{ color: #22c55e; }}
.sc-fail {{ color: #ef4444; }}
.sc-warn {{ color: #eab308; }}
.sc-none {{ color: var(--dim); }}
.sc-gaps {{ list-style: none; margin-top: 0.25rem; }}
.sc-gaps li {{ font-size: 0.7rem; color: #f97316; padding-left: 0.75rem; position: relative; }}
.sc-gaps li::before {{ content: "!"; position: absolute; left: 0; font-weight: 700; }}
.sc-detail-row {{ background: rgba(14,31,31,.035); }}
.sc-detail-row td {{ border-bottom: 1px solid var(--surface2); }}
.sc-summary-bar {{ display: flex; gap: 1.5rem; margin-bottom: 1rem; margin-top: 1rem; }}
.sc-summary-item {{ font-size: 0.85rem; }}

/* Empty state */
.empty-state {{ color: var(--dim); font-size: 0.9rem; padding: 2rem; text-align: center; }}

/* Responsive: collapse sidebar on small screens */
@media (max-width: 768px) {{
  /* GNB responsive rules come from the injected canonical GNB-CSS block. */
  .app {{ flex-direction: column; padding: 0; }}
  .sidebar {{ width: 100%; flex: none; position: relative; top:0; max-height: none; border-right: none; border-bottom: 1px solid var(--surface2); }}
  .sidebar-nav {{ display: flex; flex-wrap: wrap; padding: 0.5rem; gap: 0.25rem; }}
  .nav-item {{ padding: 0.35rem 0.6rem; border-radius: 6px; }}
  .nav-indicator {{ display: none; }}
  .nav-separator {{ margin-top: 0; padding-top: 0; border-top: none; }}
  .app {{ flex-direction: column; padding: 0; }}
  .content {{ margin-left: 0; padding: 1rem; }}
  .summary {{ grid-template-columns: repeat(2, 1fr); }}
  .sparkline-row {{ flex-direction: column; }}
}}
</style>
</head>
<body>
{gnb}
<div class="app">
  <aside class="sidebar">
    <div class="sidebar-header">
      <h1>Test Report</h1>
      <div class="subtitle">{overall_status} · generated {now}<br>profile {metadata.get("run_profile", "unknown") if metadata else "unknown"}</div>
    </div>
    <nav class="sidebar-nav">
      {sidebar_items}
    </nav>
  </aside>
  <main class="content">
    <header class="report-intro">
      <p class="kicker">AgentDeck · Continuous integration</p>
      <h2>Test Report</h2>
      <p>The most recent CI run, in full: which tests passed, which user scenarios are covered, how the numbers are trending, and where the gaps are. This is the maintainer's evidence that the build works — not a product analytics dashboard. <a href="#verify" onclick="document.querySelector('[data-tab=verify]').click();return false">What we verify, and what we don't &rarr;</a></p>
      <p class="freshness">LATEST RUN · {overall_status} · GENERATED {now}</p>
    </header>
    {tab_panels}
  </main>
</div>

<script>
function switchTab(tabId, navEl) {{
  // Deactivate all
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  // Activate selected
  navEl.classList.add('active');
  const panel = document.getElementById('tab-' + tabId);
  if (panel) panel.classList.add('active');
  // Update URL hash
  history.replaceState(null, '', '#' + tabId);
}}

function filterCov(pkg, btn) {{
  document.querySelectorAll('.cov-filter button').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const rows = document.querySelectorAll('#cov-table tbody tr');
  rows.forEach(r => {{
    const path = r.querySelector('.file-path')?.textContent || '';
    const linesPct = parseFloat(r.querySelectorAll('td')[4]?.textContent) || 0;
    if (pkg === 'all') {{ r.style.display = ''; }}
    else if (pkg === 'uncovered') {{ r.style.display = linesPct === 0 ? '' : 'none'; }}
    else {{ r.style.display = path.startsWith(pkg + '/') ? '' : 'none'; }}
  }});
}}

function toggleScenario(id) {{
  const rows = document.querySelectorAll('.sc-detail-row[data-scenario="' + id + '"]');
  const anyHidden = Array.from(rows).some(r => r.style.display === 'none');
  rows.forEach(r => r.style.display = anyHidden ? '' : 'none');
}}

// Restore tab from URL hash on load
(function() {{
  const hash = location.hash.slice(1);
  if (hash) {{
    const langEl = document.getElementById('lang');
    if (langEl) {{
      const KEY = 'agentdeck-design-locale';
      const saved = localStorage.getItem(KEY) || 'en';
      if (['en', 'ko', 'ja'].indexOf(saved) >= 0) langEl.value = saved;
      langEl.addEventListener('change', function () {{
        localStorage.setItem(KEY, langEl.value);
      }});
    }}
    const navEl = document.querySelector('.nav-item[data-tab="' + hash + '"]');
    if (navEl) switchTab(hash, navEl);
  }}
}})();
</script>
</body>
</html>'''
    return html


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
    html = generate_html(vitest, android, cov, scenarios, scenario_results, history, metadata, robot)
    OUTPUT_HTML.write_text(html, encoding="utf-8")
    print(f"HTML report: {OUTPUT_HTML}")


if __name__ == "__main__":
    main()
