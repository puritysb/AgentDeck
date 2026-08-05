#!/usr/bin/env python3
"""Sync AgentDeck frames to a Divoom Timebox Mini (BLE variant) over BLE GATT.

Some Timebox Mini revisions expose the 11x11 LED screen via BLE GATT using an
ISSC transparent-UART service (49535343-...), NOT Bluetooth Classic SPP. The
device appears in macOS as "TimeBox-mini-light" (a BLE peripheral) and shares
its BD_ADDR with the Classic audio endpoint under "TimeBox-mini-audio".

This writer builds the Divoom static-image protocol packet and tunnels it
through BLE GATT writes to the transparent-UART TX characteristic. Requires the
`bleak` package in the venv.
"""

import argparse
import asyncio
import hashlib
import io
import os
import signal
import sys
import time
import urllib.request
from typing import Iterable

from PIL import Image as PilImage, ImageEnhance

# Shared HTTP/dim plumbing with the iDotMatrix client. We run from bridge/src/timebox/,
# so add the sibling pysync/ dir before importing the common module.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pysync"))
from matrix_sync_common import (  # noqa: E402
    DEFAULT_URL,
    POLL_INTERVAL,
    BRIDGE_GONE_EXIT_SEC,
    StatusReporter,
    fetch_display_state,
    bridge_reachable,
    resolve_display_brightness as _resolve_display_brightness_common,
)

RECONNECT_DELAY = 3.0
# Force a re-push of the current frame at least this often even when the content
# is unchanged. A stateful write-without-response panel gives no delivery ACK, so
# a frame lost to an RF glitch or a brief dual-writer overlap (daemon restart)
# would otherwise stick until the content changes or the device is power-cycled.
# The heartbeat makes any such loss self-heal within a few seconds.
HEARTBEAT_SEC = 8.0

TIMEBOX_W = 11
TIMEBOX_H = 11
STATIC_IMAGE_CMD_LEN = 0x00BD

# ISSC transparent-UART service characteristics (discovered on Timebox Mini BLE)
WRITE_CHAR = "49535343-8841-43f4-a8d4-ecbe34729bb3"  # write + write-without-response
CHUNK_SIZE = 20  # safe ATT payload for write-without-response


def clamp_nibble(value: int) -> int:
    return max(0, min(15, value))


def escape_message(data: Iterable[int]) -> bytes:
    out = bytearray()
    out.append(0x01)
    for b in data:
        if b in (0x01, 0x02, 0x03):
            out.append(0x03)
            out.append(b + 0x03)
        else:
            out.append(b)
    out.append(0x02)
    return bytes(out)


def build_static_image_packet(image_bytes: bytes) -> bytes:
    cmd = bytes([
        STATIC_IMAGE_CMD_LEN & 0xFF,
        (STATIC_IMAGE_CMD_LEN >> 8) & 0xFF,
        0x44,
        0x00,
        0x0A,
        0x0A,
        0x04,
    ]) + image_bytes
    if len(cmd) != STATIC_IMAGE_CMD_LEN:
        raise ValueError(f"command length {len(cmd)} != {STATIC_IMAGE_CMD_LEN}")
    checksum = sum(cmd) & 0xFFFF
    return escape_message(cmd + bytes([checksum & 0xFF, (checksum >> 8) & 0xFF]))


def encode_image_bright(img: PilImage.Image, brightness: int, gamma: float, sat: float, contrast: float) -> bytes:
    """Encode the native 11x11 micro frame to a 182-byte Timebox payload.

    The source is `size=11&layout=micro` — a bold hand-authored creature glyph
    already drawn at the device resolution with final, device-tuned colors. So the
    pipeline is WYSIWYG by default (gamma/sat/contrast = 1.0): only the 0-100
    software `brightness` dim is applied, then 4-bit quantization. The gamma/sat/
    contrast args remain for manual tuning, but default to identity.
    """
    img = img.convert("RGB").resize((TIMEBOX_W, TIMEBOX_H), PilImage.Resampling.BOX)
    if brightness <= 0:
        return bytes(182)

    if gamma != 1.0:
        lut: list[int] = []
        for _c in range(3):
            lut.extend(min(255, int(255 * ((i / 255.0) ** gamma))) for i in range(256))
        img = img.point(lut)
    if sat != 1.0:
        img = ImageEnhance.Color(img).enhance(sat)
    if brightness != 100:
        img = ImageEnhance.Brightness(img).enhance(brightness / 100.0)
    if contrast != 1.0:
        img = ImageEnhance.Contrast(img).enhance(contrast)

    nibbles: list[int] = []
    px = img.load()
    for y in range(TIMEBOX_H):
        for x in range(TIMEBOX_W):
            r, g, b = px[x, y]
            nibbles.extend([
                clamp_nibble(round(r / 17)),
                clamp_nibble(round(g / 17)),
                clamp_nibble(round(b / 17)),
            ])

    out = bytearray()
    it = iter(nibbles)
    for low in it:
        high = next(it, 0)
        out.append(low | (high << 4))
    if len(out) != 182:
        raise ValueError(f"encoded Timebox image has {len(out)} bytes, expected 182")
    return bytes(out)


def resolve_display_brightness(display_state, normal_brightness: int):
    """Return (effective software brightness, dimmed, signature) for the host state.

    The Timebox Mini has no hardware brightness command — brightness is baked into the
    encoded frame by `encode_image_bright` (0 yields a blank frame). So the off floor is
    0 (a truly blank sleep frame) and the dim 'level' clamps down to 0 as well.
    """
    return _resolve_display_brightness_common(
        display_state, normal_brightness, off_floor=0, level_floor=0
    )


async def write_packet(client, packet: bytes) -> None:
    """Chunked write-without-response to the transparent-UART TX characteristic."""
    for i in range(0, len(packet), CHUNK_SIZE):
        await client.write_gatt_char(WRITE_CHAR, packet[i:i + CHUNK_SIZE], response=False)


async def blank_panel(client) -> None:
    """Push an all-black 11x11 farewell frame so the stateful LED panel doesn't
    freeze on the last dashboard scene after we go away. The Timebox Mini has no
    text resolution for an "OFFLINE" label (mirrors the Swift TimeboxModule, which
    also blanks to 11x11 black; iDotMatrix/Pixoo can fit an OFFLINE glyph)."""
    await write_packet(client, build_static_image_packet(bytes(182)))


async def push_micro_frame(client, url, brightness, gamma, sat, contrast, last_key, force=False) -> tuple[str, bool]:
    """Fetch the native 11x11 micro frame and push it over BLE when its
    content+brightness changed (or `force`). Returns (new dedup key, sent?).

    `size=11&layout=micro` is a NATIVE 11x11 frame — a bold hand-authored creature
    glyph on a status field, drawn pixel-for-pixel at the device resolution (no
    downscale). The key mixes the source hash with `brightness` so a host display
    sleep/wake (brightness change, same source frame) still forces a re-push.
    """
    frame_data = urllib.request.urlopen(
        f"{url.rstrip('/')}/pixoo/frame?size=11&layout=micro", timeout=3.0
    ).read()
    key = f"{hashlib.sha256(frame_data).hexdigest()}|{brightness}"
    if force or key != last_key:
        img = PilImage.open(io.BytesIO(frame_data))
        payload = encode_image_bright(img, brightness, gamma, sat, contrast)
        await write_packet(client, build_static_image_packet(payload))
        print(f"Frame sent ({key[:8]} @ {brightness}%)")
        return key, True
    return key, False


async def run(address: str, url: str, brightness: int, gamma: float, sat: float, contrast: float, once: bool = False) -> None:
    print(f"Starting Timebox Mini BLE sync: {address} <- {url} brightness={brightness}% gamma={gamma}")
    # Machine-readable link state for the daemon supervisor — it spawns us but
    # cannot see the BLE link, and we reconnect inside this loop rather than
    # exiting, so process liveness tells it nothing about whether the panel is
    # actually being driven.
    status = StatusReporter()
    stop = asyncio.Event()
    # Why we're stopping — decides the farewell. 'signal' = clean daemon shutdown
    # (no successor → blank the panel). 'orphan' = parent died (a successor daemon
    # may have taken over → don't clobber its frame). 'bridge_gone' = nobody home.
    exit_reason = {"v": None}

    def handle_stop(*_):
        exit_reason["v"] = "signal"
        stop.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, handle_stop)
        except (NotImplementedError, RuntimeError):
            # Fall back to a classic handler that still requests a clean stop.
            # The previous fallback installed a no-op handler that IGNORED
            # SIGTERM — that stranded the process (the daemon's SIGTERM on
            # shutdown did nothing) and left orphaned sync clients running for
            # days, each holding the BLE link. Never ignore the signal.
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(handle_stop))

    # Imported lazily so the module is usable for encoding tests without bleak.
    from bleak import BleakClient

    last_bridge_ok = time.monotonic()

    def should_exit() -> bool:
        """True when we've been orphaned (parent daemon gone) or the bridge has
        been unreachable long enough that nobody will ever stop us. A stateful
        BLE panel can't detect a dropped link, so an orphan would otherwise loop
        forever holding the single-central connection."""
        if os.getppid() == 1:
            print("Parent daemon gone (orphaned) — shutting down Timebox sync.")
            exit_reason["v"] = "orphan"
            return True
        if time.monotonic() - last_bridge_ok > BRIDGE_GONE_EXIT_SEC:
            print(f"Bridge unreachable >{int(BRIDGE_GONE_EXIT_SEC)}s — shutting down Timebox sync.")
            exit_reason["v"] = "bridge_gone"
            return True
        return False

    while not stop.is_set():
        if should_exit():
            stop.set()
            break
        link_lost = asyncio.Event()

        def on_disconnect(_client):
            # Fired by bleak when the GATT link drops (e.g. the Timebox is powered
            # off). A stateful BLE panel driven by write-without-response means our
            # writes can silently "succeed" over a dead link, so this callback — not
            # a write error — is the authoritative "reconnect now" signal. Without it
            # the inner loop would spin forever on a dead link and the outer reconnect
            # path (below) would never run.
            print("BLE peripheral disconnected — will reconnect.", file=sys.stderr)
            status.disconnected("BLE peripheral disconnected")
            loop.call_soon_threadsafe(link_lost.set)

        try:
            print(f"Connecting BLE {address}...")
            status.connecting()
            async with BleakClient(address, timeout=15.0, disconnected_callback=on_disconnect) as client:
                print(f"BLE connected (MTU={client.mtu_size})")
                status.connected()

                last_key = ""
                last_sent_at = time.monotonic()
                current_brightness = brightness
                display_dimmed = False
                last_display_signature = ""
                # Honor the host display dim state already at connect time so a
                # reconnect while the screen is asleep comes up dim/blank, not bright.
                try:
                    current_brightness, display_dimmed, last_display_signature, _mode = \
                        resolve_display_brightness(fetch_display_state(url), brightness)
                    last_bridge_ok = time.monotonic()
                except Exception:
                    current_brightness, display_dimmed, last_display_signature = brightness, False, ""

                while not stop.is_set():
                    if should_exit():
                        stop.set()
                        break
                    # 0. The link dropped (peripheral powered off / out of range):
                    #    leave the `async with` so the outer loop reconnects by
                    #    address (macOS bleak addresses are stable UUIDs). Checked
                    #    every iteration because write-without-response never errors
                    #    on a dead link — only this flag / is_connected reveals it.
                    if link_lost.is_set() or not client.is_connected:
                        print("BLE link lost — reconnecting.", file=sys.stderr)
                        status.disconnected("BLE link lost")
                        break
                    # 1. Apply host display sleep/wake. The daemon exposes the same
                    #    display_state Pixoo/iDotMatrix/ESP32 receive; older session-
                    #    only bridges omit it (keep the configured brightness).
                    transitioned = False
                    try:
                        eff_b, dimmed, sig, _mode = resolve_display_brightness(fetch_display_state(url), brightness)
                        last_bridge_ok = time.monotonic()
                        if sig != last_display_signature or eff_b != current_brightness:
                            current_brightness, display_dimmed, last_display_signature = eff_b, dimmed, sig
                            transitioned = True
                            print(f"Host display {'asleep' if dimmed else 'awake'} — brightness {eff_b}%")
                    except Exception:
                        pass

                    # 2. While the host display is asleep, push one frame at the dim
                    #    brightness on the transition (0 => blank sleep frame), then
                    #    pause polling to save BLE bandwidth (mirrors iDotMatrix).
                    if display_dimmed:
                        status.streaming(dimmed=True)
                        if transitioned or once:
                            try:
                                last_key, sent = await push_micro_frame(
                                    client, url, current_brightness, gamma, sat, contrast, last_key, force=True
                                )
                                if sent:
                                    last_sent_at = time.monotonic()
                                last_bridge_ok = time.monotonic()
                                status.frame_sent(dimmed=True)
                            except Exception as e:
                                print(f"Dim-frame send error: {e}", file=sys.stderr)
                                if link_lost.is_set() or not client.is_connected:
                                    status.disconnected(f"dim-frame send error: {e}")
                                    break
                        if once:
                            return
                        try:
                            await asyncio.wait_for(stop.wait(), timeout=POLL_INTERVAL)
                        except asyncio.TimeoutError:
                            pass
                        continue

                    # 3. Normal streaming — push when content/brightness changed, or
                    #    force a heartbeat re-push so a frame lost to an RF glitch or a
                    #    brief dual-writer overlap (daemon restart) self-heals instead
                    #    of sticking until the content changes or a power-cycle.
                    force_beat = (time.monotonic() - last_sent_at) >= HEARTBEAT_SEC
                    try:
                        last_key, sent = await push_micro_frame(
                            client, url, current_brightness, gamma, sat, contrast, last_key, force=force_beat
                        )
                        if sent:
                            last_sent_at = time.monotonic()
                        last_bridge_ok = time.monotonic()
                        status.frame_sent()
                    except Exception as e:
                        print(f"Frame fetch/send error: {e}", file=sys.stderr)
                        # A write error after the link dropped must escalate to a
                        # reconnect; a transient HTTP fetch error (bridge blip) must
                        # not — keep streaming and let should_exit() handle a truly
                        # gone bridge.
                        if link_lost.is_set() or not client.is_connected:
                            status.disconnected(f"frame send error: {e}")
                            break
                    if once:
                        return
                    try:
                        await asyncio.wait_for(stop.wait(), timeout=POLL_INTERVAL)
                    except asyncio.TimeoutError:
                        pass

                # Inner loop exited. If we're shutting down (SIGTERM, orphaned, or
                # bridge gone) and the link is still up, blank the panel before the
                # `async with` drops BLE — otherwise the stateful LED panel freezes
                # on the last dashboard frame forever (parity with iDotMatrix's
                # OFFLINE farewell and the Swift TimeboxModule's 11x11 black blank).
                #
                # EXCEPT when a successor daemon has already taken over: our parent
                # died abruptly (orphan) but the bridge is answering again, so a new
                # daemon restarted and is repainting the panel. Blanking here would
                # clobber its fresh frame and the panel would sit blank until a
                # power-cycle — the exact failure this guard prevents.
                successor_took_over = exit_reason["v"] == "orphan" and bridge_reachable(url)
                if successor_took_over:
                    print("Successor daemon detected — skipping farewell blank (it will repaint).")
                if stop.is_set() and client.is_connected and not successor_took_over:
                    try:
                        await blank_panel(client)
                        # blank_panel writes WITHOUT response — the await returns once
                        # the packet is queued to the OS, not once it's transmitted.
                        # The `async with` below drops the BLE link immediately on
                        # exit; without this beat the queued blank never goes over the
                        # air and the panel freezes on its last dashboard frame.
                        await asyncio.sleep(0.5)
                        print("Shutting down — blanked Timebox panel.")
                    except Exception as e:
                        print(f"Farewell blank failed: {e}", file=sys.stderr)
        except Exception as e:
            print(f"BLE connection error: {e}", file=sys.stderr)
            status.failed(f"BLE connection error: {e}")
            if once:
                raise
            try:
                await asyncio.wait_for(stop.wait(), timeout=RECONNECT_DELAY)
            except asyncio.TimeoutError:
                pass


def main() -> None:
    parser = argparse.ArgumentParser(description="AgentDeck Timebox Mini BLE sync")
    parser.add_argument("--address", required=True, help="BLE address/UUID of TimeBox-mini-light")
    parser.add_argument("--url", default=DEFAULT_URL, help=f"AgentDeck bridge URL (default: {DEFAULT_URL})")
    parser.add_argument("--brightness", type=int, default=100, help="Software brightness 0-100")
    parser.add_argument("--gamma", type=float, default=1.0, help="Gamma (lower=brighter midtones; 1.0=off)")
    parser.add_argument("--sat", type=float, default=1.0, help="Saturation multiplier (1.0=off)")
    parser.add_argument("--contrast", type=float, default=1.0, help="Contrast multiplier (1.0=off)")
    parser.add_argument("--once", action="store_true", help="Send one frame and exit")
    args = parser.parse_args()

    if not (0 <= args.brightness <= 100):
        print("Brightness must be between 0 and 100.", file=sys.stderr)
        sys.exit(1)

    asyncio.run(run(args.address, args.url, args.brightness, args.gamma, args.sat, args.contrast, args.once))


if __name__ == "__main__":
    main()
