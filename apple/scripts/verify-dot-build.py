#!/usr/bin/env python3
"""Check an actual macOS/iOS app, including Xcode's Debug dylib, for Dot isolation.

The archive verifier always requests 'excluded'. Preview acceptance also checks
positive evidence, so accidentally disabling both variants cannot pass CI.
"""
import plistlib
import sys
from pathlib import Path

DOT_MARKERS = (
    b"DotSurfaceSnapshot", b"DotHost", b"DotPixelOverlay",
    b"DotConnectionSetupView", b"DotAquariumResident",
    b"Connect Dot", b"dot-setup-entry", b"agentdeck.briefing.requested",
)


def verify(app: Path, expected: str) -> None:
    if expected not in ("excluded", "preview"):
        raise ValueError("expected mode must be excluded or preview")
    root = app / "Contents" if (app / "Contents").is_dir() else app
    with (root / "Info.plist").open("rb") as file:
        info = plistlib.load(file)
    if info.get("AgentDeckDotSupport") != expected:
        raise ValueError(f"Dot build identity is {info.get('AgentDeckDotSupport')!r}, expected {expected}")
    binaries = root / "MacOS" if root.name == "Contents" else root
    executable = binaries / info["CFBundleExecutable"]
    # Debug app code may be in AgentDeck.debug.dylib rather than the launcher.
    payloads = [executable.read_bytes()]
    payloads.extend(path.read_bytes() for path in binaries.glob("*.dylib"))
    found = [marker.decode() for marker in DOT_MARKERS if any(marker in data for data in payloads)]
    contracts = list(root.rglob("dot-mcp-contract.json"))
    if expected == "excluded":
        if contracts or found:
            raise ValueError(f"Dot leaked into Store app: contracts={len(contracts)}, markers={found}")
    elif not contracts or "DotSurfaceSnapshot" not in found:
        raise ValueError("DotPreview lacks its contract or compiled snapshot implementation")


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("usage: verify-dot-build.py AgentDeck.app excluded|preview")
        verify(Path(sys.argv[1]), sys.argv[2])
    except (OSError, ValueError, KeyError, plistlib.InvalidFileException) as error:
        sys.exit(f"FAIL: {error}")
    print(f"Dot build boundary: {sys.argv[2]} verified ({sys.argv[1]})")
