"""Shared plumbing for AgentDeck BLE LED-matrix sync clients (iDotMatrix, Timebox Mini).

Both clients poll the same daemon HTTP surface (`/pixoo/frame`, `/display-state`), apply
the same host-display dim resolution, and self-exit when orphaned. Only the genuinely
identical plumbing lives here — the device-specific bits (BLE transport, frame encoding,
offline/farewell handling, and the dim FLOORS) stay in each client.

Imported by sibling scripts via a sys.path insert (they run from bridge/src/<device>/),
so this module must stay dependency-free beyond the stdlib.
"""

import json
import sys
import urllib.request

DEFAULT_URL = "http://127.0.0.1:9120"
POLL_INTERVAL = 1.5  # seconds; balanced for BLE bandwidth
# If the bridge stays unreachable this long, the daemon that spawned us is gone
# (crash / SIGKILL / sleep-kill / launchd) — the client should exit cleanly after
# leaving the panel in a safe state instead of looping forever as an orphan that
# holds the single-central BLE link hostage.
BRIDGE_GONE_EXIT_SEC = 30.0


def http_get_bytes(url: str, timeout: float = 3.0) -> bytes:
    """Blocking GET returning the raw body (frame bytes)."""
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read()


def fetch_display_state(url: str, timeout: float = 1.0):
    """Fetch host display dim state from the AgentDeck daemon (blocking)."""
    endpoint = f"{url.rstrip('/')}/display-state"
    with urllib.request.urlopen(endpoint, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def bridge_reachable(url: str, timeout: float = 1.0) -> bool:
    """True when *some* daemon is answering on the bridge URL right now.

    Used to detect a SUCCESSOR daemon: when our parent daemon died abruptly and a
    new one restarted (launchd KeepAlive) and re-bound the port, the orphaned sync
    client must NOT paint its farewell/OFFLINE frame — doing so would clobber the
    frame the successor just drew and leave the panel stuck until a power-cycle. An
    HTTP error status still counts as reachable (a server answered)."""
    from urllib.error import HTTPError
    try:
        with urllib.request.urlopen(f"{url.rstrip('/')}/display-state", timeout=timeout):
            return True
    except HTTPError:
        return True
    except Exception:
        return False


def resolve_display_brightness(display_state, normal_brightness, *, off_floor, level_floor):
    """Return (effective brightness, dimmed, signature, dim_mode) for the host state.

    `off_floor`   — brightness used when the display is off and dim mode is 'off'.
    `level_floor` — minimum the configured dim 'level' is clamped to.

    iDotMatrix firmware accepts 5-100 (floors = 5); the Timebox bakes brightness into
    the encoded frame and 0 == a fully blank panel (floors = 0). The signature lets the
    caller detect host-state transitions and force a re-encode/re-push at the new level.

    `dim_mode` ('off' | 'min') is returned because a brightness floor alone cannot
    express "dark" on every panel: the Timebox reaches black at 0, but the iDotMatrix
    floor is 5, so that caller has to push an explicitly black frame instead. Callers
    must branch on the mode rather than inferring it from the brightness value —
    level 5 in 'min' mode is indistinguishable from the iDotMatrix 'off' floor.
    """
    if not isinstance(display_state, dict):
        return normal_brightness, False, f"on|true|off|10|{normal_brightness}", "off"

    display_on = bool(display_state.get("displayOn", True))
    dim = display_state.get("dim") if isinstance(display_state.get("dim"), dict) else {}
    dim_enabled = dim.get("enabled", True)
    if not isinstance(dim_enabled, bool):
        dim_enabled = True
    dim_mode = "min" if dim.get("mode") == "min" else "off"
    try:
        dim_level = int(dim.get("level", 10))
    except (TypeError, ValueError):
        dim_level = 10
    dim_level = max(level_floor, min(100, dim_level))
    signature = f"{display_on}|{dim_enabled}|{dim_mode}|{dim_level}|{normal_brightness}"

    if display_on or not dim_enabled:
        return normal_brightness, False, signature, dim_mode
    return (dim_level if dim_mode == "min" else off_floor), True, signature, dim_mode


# ---------------------------------------------------------------------------
# Link status reporting
# ---------------------------------------------------------------------------

# Prefix of the machine-readable status lines the daemon supervisor parses.
# Mirrored in bridge/src/ble-sync-spawn.ts (`BLE_STATUS_LINE_PREFIX`).
STATUS_LINE_PREFIX = "AGENTDECK_STATUS "


class StatusReporter:
    """Report BLE link state to the daemon that spawned us, one line per change.

    The Node daemon has no BLE of its own: it spawns this client and can only
    watch the process. But both clients reconnect *inside* their own loop, so a
    powered-off panel leaves the child running indefinitely and "process alive"
    says nothing about whether the panel is being driven. Without this signal
    the daemon's /health could only report the configured device list, and every
    consumer that renders `connected` — macOS menubar, Dashboard rail, TUI —
    drew both BLE panels as disconnected while they were streaming.

    Emitting only on *change* keeps the frame loop from flooding the daemon log,
    and the supervisor keeps these lines out of its diagnostic output ring so a
    reconnect never looks like a new crash cycle.
    """

    def __init__(self, emit=None):
        self._emit = emit if emit is not None else _write_status_line
        self._last = None
        # Sticky: once we have painted the panel, our frame is on it even while
        # the link is down. Matches `hasFrame` in the daemon's health shape.
        self._has_frame = False

    def _update(self, connected, phase, dimmed=False, error=None):
        payload = {
            "connected": bool(connected),
            "phase": phase,
            "hasFrame": self._has_frame,
            "dimmed": bool(dimmed),
            "error": error,
        }
        if payload == self._last:
            return
        self._last = payload
        self._emit(payload)

    def connecting(self):
        self._update(False, "connecting")

    def connected(self):
        self._update(True, "connected")

    def streaming(self, dimmed=False):
        """Link up and the frame loop is running — does not claim a painted frame.

        Used on the dim/pause path, where a reconnect while the host display is
        already asleep runs the loop without pushing anything.
        """
        self._update(True, "streaming", dimmed=dimmed)

    def frame_sent(self, dimmed=False):
        self._has_frame = True
        self.streaming(dimmed=dimmed)

    def disconnected(self, error=None):
        self._update(False, "disconnected", error=error)

    def failed(self, error):
        self._update(False, "error", error=str(error) if error is not None else None)


def _write_status_line(payload):
    """Write one status line to stdout. Never raises — a closed pipe during
    shutdown must not take the farewell frame down with it."""
    try:
        sys.stdout.write(
            STATUS_LINE_PREFIX + json.dumps(payload, separators=(",", ":")) + "\n"
        )
        sys.stdout.flush()
    except Exception:
        pass
