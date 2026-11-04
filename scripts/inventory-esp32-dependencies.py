#!/usr/bin/env python3
"""Resolve dependencies in a disposable project/core; never build, upload or open a TTY.

The PlatformIO adapter is deliberately pinned: 6.1.19 has no JSON pkg-list API.
SDK manifests are evidence/unknowns, not an advisory-coverage claim.
"""
import argparse
import configparser
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from urllib.parse import urlsplit, unquote

ROOT = Path(__file__).resolve().parent.parent
PIO_VERSION = "6.1.19"
LIMITS = [
    "Package resolution only: no compilation, upload, device or installed-firmware acceptance.",
    "Installed package content is hashed; project build-time patch inputs are recorded but not applied.",
    "Embedded SDK/component manifests without a mapped version remain unknown; no complete SDK SBOM is claimed.",
    "No advisory matching or zero-CVE claim. PlatformIO versions are not automatically OSV/CPE identities.",
    "A dated selected-version receipt is not a dependency lock; ranges can resolve differently on a later run.",
    "Content hashes exclude VCS, Python caches and installer metadata; symlinks hash their target text without following it.",
]


def environments(project):
    parser = configparser.ConfigParser(interpolation=None, strict=True)
    with (Path(project) / "platformio.ini").open() as stream:
        parser.read_file(stream)
    if parser.get('platformio', 'extra_configs', fallback='').strip():
        raise ValueError('External config includes require an explicit inventory adapter update')
    names = [s[4:] for s in parser.sections() if s.startswith("env:")]
    if not names or any(not n or not all(c.isalnum() or c in "_-" for c in n) for n in names):
        raise ValueError("Invalid or empty environment inventory")
    return names


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


SDK_HEADERS = {
    "esp_idf_version.h": ("esp-idf", "ESP_IDF_VERSION"),
    "esp_arduino_version.h": ("arduino-esp32", "ESP_ARDUINO_VERSION"),
}


def sdk_version_evidence(path, expected_hash):
    """Observe numeric declarations, never execute C or infer a release/advisory ID."""
    with Path(path).open("rb") as stream:
        content = stream.read(64 * 1024 + 1)
    if len(content) > 64 * 1024:
        return {"versionMapping": "unknown; version header exceeds parsing limit"}
    if hashlib.sha256(content).hexdigest() != expected_hash:
        raise ValueError("SDK version header changed during collection")
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return {"versionMapping": "unknown; version header is not UTF-8"}
    component, prefix = SDK_HEADERS[Path(path).name]
    # Ignore commented-out examples. Expressions, duplicate definitions and
    # missing fields remain unknown rather than evaluating a preprocessor.
    text = re.sub(r"/\*.*?\*/|//[^\n]*", "", text, flags=re.S)
    parts = []
    for field in ("MAJOR", "MINOR", "PATCH"):
        declarations = re.findall(r"^[ \t]*#[ \t]*define[ \t]+" + prefix + "_" + field + r"\b([^\n]*)", text, re.M)
        if len(declarations) != 1 or not re.fullmatch(r"[ \t]*[0-9]{1,4}[ \t\r]*", declarations[0]):
            return {"versionMapping": "unknown; missing, ambiguous or non-literal numeric declarations"}
        parts.append(str(int(declarations[0].strip())))
    return {
        "versionMapping": "numeric declarations observed; full release identity unknown",
        "component": component,
        "numericVersion": ".".join(parts),
        "releaseIdentity": "unknown; numeric macros do not distinguish releases, prereleases or downstream patches",
        "advisoryMapping": "unknown; no OSV/CPE identity inferred",
    }


def tree_evidence(directory):
    """Hash complete package bytes, not just a package manifest/cache label."""
    root = Path(directory)
    h = hashlib.sha256()
    count = total = 0
    embedded = []
    for current, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = sorted(d for d in dirs if d not in (".git", "__pycache__"))
        # Directory symlinks must be recorded too; do not silently omit them.
        files = sorted(files + [d for d in dirs if (Path(current) / d).is_symlink()])
        dirs[:] = [d for d in dirs if not (Path(current) / d).is_symlink()]
        for name in files:
            if name in (".DS_Store", ".piopm") or name.endswith(".pyc"):
                continue
            path = Path(current) / name
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                value = "symlink:" + os.readlink(path)
            elif path.is_file():
                total += path.stat().st_size
                if total > 8 * 1024**3 or count > 300_000:
                    raise ValueError("Package content exceeds inventory limit")
                value = digest(path)
                if name in ("idf_component.yml", "library.properties", "library.json", "package.json", *SDK_HEADERS):
                    # Embedded manifests are not automatically independent package versions.
                    evidence = sdk_version_evidence(path, value) if name in SDK_HEADERS else {"versionMapping": "unknown; manual upstream mapping required"}
                    embedded.append({"path": relative, "sha256": value, **evidence})
            else:
                raise ValueError("Non-regular package content")
            h.update(relative.encode() + b"\0" + value.encode() + b"\n")
            count += 1
    if not count:
        raise ValueError("Empty package content")
    return {"treeSha256": h.hexdigest(), "files": count, "bytes": total, "embeddedManifests": embedded}


def resolve_graph(roots, lookup, dependencies, describe, builtin=lambda spec: False):
    """Missing transitives fail; cycles retain edges without infinite recursion."""
    nodes, edges, builtin_refs = {}, [], []

    def visit(spec, parent=None):
        package = lookup(spec)
        if package is None:
            if builtin(spec):
                builtin_refs.append({"from": parent, "request": str(spec), "resolution": "framework-bundled; independent version unknown"})
                return
            raise ValueError("Unresolved dependency: " + str(spec))
        info = describe(package)
        if not isinstance(info.get("name"), str) or not info["name"] or not isinstance(info.get("version"), str) or info["version"] in ("", "None", "unknown", "unspecified"):
            raise ValueError("Package has no selected version")
        key = info["name"] + "@" + info["version"]
        edges.append({"from": parent, "to": key, "request": str(spec)})
        if key in nodes:
            if nodes[key] != info:
                raise ValueError("Ambiguous package identity")
            return
        nodes[key] = info
        for dependency in dependencies(package):
            visit(dependency, key)

    for root in roots:
        visit(root)
    return {"packages": sorted(nodes.values(), key=lambda n: (n["name"], n["version"])), "edges": edges, "frameworkReferences": builtin_refs}


def validate_tool_alias(name, required, metadata, installed, core):
    """pioarduino relocates selected tools to core/tools then installs a file alias.

    Accept that documented installer shape only with exact name/version and the
    same source bytes at the expected paths; never substitute a same-named cache.
    """
    if not required or Path(name).name != name or metadata.get('name') != name or metadata.get('version') != required:
        raise ValueError('Unverified local tool alias version')
    source = urlsplit((metadata.get('spec') or {}).get('uri') or '')
    expected = (Path(core) / 'tools' / name).resolve()
    if source.scheme != 'file' or source.netloc or Path(unquote(source.path)).resolve() != expected or Path(installed).absolute() != (Path(core) / 'packages' / name).absolute():
        raise ValueError('Unverified local tool alias source')
    if tree_evidence(expected)['treeSha256'] != tree_evidence(installed)['treeSha256']:
        raise ValueError('Local tool alias content differs from selected source')


def collect(project, name, hash_cache):
    from platformio.project.config import ProjectConfig
    from platformio.platform.factory import PlatformFactory
    from platformio.package.manager.platform import PlatformPackageManager
    from platformio.package.manager.library import LibraryPackageManager
    from platformio.package.meta import PackageCompatibility, PackageSpec

    os.chdir(project)
    config = ProjectConfig.get_instance()
    platform = PlatformFactory.from_env(name, autoinstall=False)

    def describe(package):
        metadata = package.metadata.as_dict()
        if not metadata["name"] or metadata["version"] in ("", "None", "unknown", "unspecified"):
            raise ValueError("Package has no selected version")
        path = str(Path(package.path).resolve())
        if path not in hash_cache:
            hash_cache[path] = tree_evidence(path)
        return {"name": metadata["name"], "version": metadata["version"],
                "source": metadata["spec"], **hash_cache[path]}

    platform_package = PlatformPackageManager().get_package(platform.get_dir())
    if platform_package is None:
        raise ValueError("Selected platform metadata is unavailable")
    tools = []
    for package_name, options in sorted(platform.packages.items()):
        if options.get("optional"):
            continue
        package = platform.get_package(package_name)
        alias = False
        if package is None and options.get('package-version'):
            core = Path(os.environ['PLATFORMIO_CORE_DIR'])
            candidate = platform.pm.get_package(str(core / 'packages' / package_name))
            if candidate is not None:
                validate_tool_alias(package_name, options['package-version'], candidate.metadata.as_dict(), candidate.path, core)
                package, alias = candidate, True
        if package is None:
            raise ValueError("Required platform/framework/tool package is absent: " + package_name)
        tools.append({"role": options.get("type", "platform dependency"), "localAliasVerified": alias, **describe(package)})
    manager = LibraryPackageManager(str(Path(config.get("platformio", "libdeps_dir")) / name))
    compatibility = PackageCompatibility(platforms=[platform.name], frameworks=config.get("env:" + name, "framework", []))

    def dependencies(package):
        result = []
        for dep in manager.get_pkg_dependencies(package) or []:
            qualifiers = {k: v for k, v in dep.items() if k in ("frameworks", "platforms")}
            if not PackageCompatibility(**qualifiers).is_compatible(compatibility):
                continue
            result.append(manager.dependency_to_spec(dep))
        return result

    libraries = resolve_graph(config.get("env:" + name, "lib_deps", []), manager.get_package,
                              dependencies, describe,
                              lambda spec: manager.is_builtin_lib(spec.name if isinstance(spec, PackageSpec) else PackageSpec(spec).name))
    return {"environment": name, "platformRequest": config.get("env:" + name, "platform"),
            "board": config.get("env:" + name, "board", None), "framework": config.get("env:" + name, "framework", []),
            "platform": describe(platform_package), "requiredTools": tools, "libraries": libraries}


def install(project, name, log):
    with log.open("w") as stream:
        process = subprocess.Popen([sys.executable, "-m", "platformio", "pkg", "install", "-d", str(project), "-e", name],
                                   stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            if process.wait(timeout=1200) != 0:
                raise RuntimeError("PlatformIO resolution failed; see target install.log")
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise RuntimeError("PlatformIO resolution timed out") from None


def collect_fresh(project, name, logs):
    # PlatformIO caches package lookups per interpreter. Different environments
    # can replace the same framework/tool path with another selected version.
    # Read each resolved graph in a fresh process, never through a prior cache.
    with (logs / 'collect.log').open('w') as stream:
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), '--_collect-target', str(project), name, str(logs / 'inventory.json')],
                                   stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            if process.wait(timeout=600) != 0:
                raise RuntimeError('Resolved target collection failed; see collect.log')
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise RuntimeError('Resolved target collection timed out') from None
    return json.loads((logs / 'inventory.json').read_text())


def platform_request(project, name):
    from platformio.project.config import ProjectConfig
    return ProjectConfig.get_instance(str(project / 'platformio.ini')).get('env:' + name, 'platform')


def store_for_platform(workspace, request):
    # pioarduino and official platforms use overlapping tool/framework names.
    # Separate their stores, rather than let one installer overwrite the other.
    return Path(workspace) / 'cores' / hashlib.sha256(request.encode()).hexdigest()[:16]


def isolated_store_environment(core):
    return {'PLATFORMIO_CORE_DIR': str(core), 'PLATFORMIO_PLATFORMS_DIR': str(core / 'platforms'),
            'PLATFORMIO_PACKAGES_DIR': str(core / 'packages'), 'PLATFORMIO_CACHE_DIR': str(core / '.cache'),
            'PLATFORMIO_GLOBALLIB_DIR': str(core / 'lib'), 'IDF_TOOLS_PATH': str(core / 'tools')}


def run(output, selected=None):
    if os.name != "posix":
        raise RuntimeError("Firmware inventory requires a POSIX build host")
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    receipt = {"schema": 1, "capturedAt": datetime.now(timezone.utc).isoformat(), "status": "unknown", "coverageLimits": LIMITS, "targets": []}
    target = output / "receipt.json"

    def save():
        target.write_text(json.dumps(receipt, indent=2) + "\n")

    save()
    workspace = None
    previous_cwd = Path.cwd()
    # Ignore inherited directory/SDK overrides as well as the default core.
    # Otherwise PLATFORMIO_PACKAGES_DIR or IDF_TOOLS_PATH can escape isolation.
    previous_environment = {key: value for key, value in os.environ.items() if key.startswith(('PLATFORMIO_', 'IDF_'))}
    try:
        import platformio
        if platformio.__version__ != PIO_VERSION:
            raise RuntimeError("Inventory adapter requires PlatformIO " + PIO_VERSION)
        # Refuse reuse: a failed previous run must not turn cached observations into fresh resolution.
        marker = output / 'resolution-started.json'
        if marker.exists() or (output / 'project').exists() or (output / 'core').exists():
            raise RuntimeError("Use a fresh output directory; an earlier resolution exists")
        marker.write_text(json.dumps({'capturedAt': receipt['capturedAt']}) + '\n')
        workspace = tempfile.TemporaryDirectory(prefix='agentdeck-firmware-inventory-')
        project = Path(workspace.name) / "project"
        core = Path(workspace.name) / "core"
        core.mkdir()
        project.mkdir()
        shutil.copy2(ROOT / "esp32/platformio.ini", project / "platformio.ini")
        shutil.copytree(ROOT / "esp32/boards", project / "boards")
        for key in previous_environment:
            os.environ.pop(key)
        os.environ.update(isolated_store_environment(core))
        os.environ["PLATFORMIO_SETTING_ENABLE_TELEMETRY"] = "no"
        os.environ["PLATFORMIO_LIBDEPS_DIR"] = str(project / ".pio/libdeps")
        os.environ["PLATFORMIO_BUILD_DIR"] = str(project / ".pio/build")
        names = environments(project)
        chosen = [selected] if selected else names
        if any(name not in names for name in chosen):
            raise ValueError("Unknown target environment")
        receipt.update({"platformioVersion": platformio.__version__, "configuredEnvironments": names, "requestedEnvironments": chosen,
                        "commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, timeout=10).strip(),
                        "dirty": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True, timeout=10).strip()),
                        "sourceInputs": {str(p.relative_to(ROOT)): digest(p) for p in [ROOT / "esp32/platformio.ini", Path(__file__), *sorted((ROOT / "esp32/scripts").glob("*.py")), *sorted((ROOT / "esp32/boards").glob("*.json"))]}})
        # Cache hashes only while this isolated resolver owns all package writes.
        # Clear each target: package install scripts can modify shared framework bytes.
        for name in chosen:
            print('Resolving environment:', name, flush=True)
            target_core = store_for_platform(workspace.name, platform_request(project, name))
            target_core.mkdir(parents=True, exist_ok=True)
            os.environ.update(isolated_store_environment(target_core))
            logs = output / name
            logs.mkdir()
            install(project, name, logs / "install.log")
            inventory = collect_fresh(project, name, logs)
            inventory['isolatedPlatformStore'] = target_core.name
            os.chdir(previous_cwd)
            (logs / "inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
            receipt["targets"].append(inventory)
            save()
            print('Captured environment:', name, flush=True)
        receipt["status"] = "complete"
        save()
        return receipt
    except Exception as error:
        receipt["status"] = "error"
        receipt["error"] = str(error)
        save()
        raise
    finally:
        os.chdir(previous_cwd)
        for key in list(os.environ):
            if key.startswith(('PLATFORMIO_', 'IDF_')):
                os.environ.pop(key)
        os.environ.update(previous_environment)
        if workspace:
            workspace.cleanup()


if __name__ == "__main__":
    if len(sys.argv) == 5 and sys.argv[1] == '--_collect-target':
        Path(sys.argv[4]).write_text(json.dumps(collect(Path(sys.argv[2]), sys.argv[3], {}), indent=2) + '\n')
        sys.exit(0)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list-environments", action="store_true")
    parser.add_argument("--environment")
    parser.add_argument("--output", default=str(ROOT / "diagnostics/esp32-inventory"))
    args = parser.parse_args()
    try:
        if args.list_environments:
            print(json.dumps(environments(ROOT / "esp32")))
        else:
            result = run(args.output, args.environment)
            print("Firmware dependency inventory:", result["status"], len(result["targets"]), "target(s); advisory coverage is not claimed")
    except Exception as error:
        print("Firmware inventory failed:", str(error), file=sys.stderr)
        sys.exit(1)
