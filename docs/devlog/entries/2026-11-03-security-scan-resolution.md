# 2026-11-03 — Dependency audit needs resolver evidence

The first OSV 2.7.0 scan of `bridge/python/requirements-ble.txt` inferred Pillow
9.5.0 despite the declared >=12,<13 range. Treating that as an installed-version
finding would misstate the affected version. `uv pip compile --python-version
3.12 --no-build` on macOS resolved 12.3.0; pip-audit 2.10.1 found 39 advisory
records. Raising the source requirement to >=13,<14 resolved 13.0.0 and removed
those matches. Imports, BMP→RGB resizing, Timebox brightness/packet encoding and
both offline-image PNG paths passed in a disposable Python environment. No BLE
connection or user runtime update was attempted.

The Mac's uv-managed Python 3.12 `ensurepip` subprocess crashed with SIGABRT when
pip-audit created its resolver venv. Resolve first with uv, then use pip-audit's
`--disable-pip --no-deps` on the complete pinned output. This avoids that local
tool failure; a partial direct-only list would silently miss transitives. Linux
CI resolves independently with pip-audit, so it can expose different platform
packages.

The npm registry audit listed deepmerge >=4.3.2 as a fix, while registry metadata
and install resolution still exposed only 4.3.1. Removed the impossible override
and retained the low warning. Likewise, forcing all Zod 3 consumers onto version 4
would hide a compatibility change inside an audit fix: preserve the warning with
an exact-version, dated exception and track the SDK migration.

[The runbook](docs/security-scanning.md) and
[dated aggregate receipt](security/reports/2026-11-03.json) preserve scope and counts.
Raw reports stay in ignored diagnostics/Actions artifacts. Rust's three
unmaintained-crate advisories are maintenance debt, not three newly confirmed
product vulnerabilities; the pixel-identical renderer migration spans Rust,
JS and WASM, so it has a separate deadline.
