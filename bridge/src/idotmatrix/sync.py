import asyncio
import os
import signal
import sys
import time
import hashlib
import tempfile
import urllib.request
import urllib.error
import io
import argparse
from PIL import Image as PilImage, ImageEnhance
from idotmatrix import ConnectionManager
from idotmatrix.modules.image import Image as IdmImage
from idotmatrix.modules.common import Common as IdmCommon

# Shared HTTP/dim plumbing with the Timebox client. We run from bridge/src/idotmatrix/,
# so add the sibling pysync/ dir before importing the common module.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pysync"))
from matrix_sync_common import (  # noqa: E402
    DEFAULT_URL,
    POLL_INTERVAL,
    BRIDGE_GONE_EXIT_SEC,
    StatusReporter,
    fetch_display_state as _fetch_display_state_sync,
    bridge_reachable as _bridge_reachable_sync,
    resolve_display_brightness as _resolve_display_brightness_common,
)

OFFLINE_HASH = "offline"

async def fetch_frame(url: str) -> bytes:
    """Fetch the current 32x32 BMP frame from the AgentDeck bridge."""
    endpoint = f"{url.rstrip('/')}/pixoo/frame?size=32"
    
    # We use urllib run_in_executor to avoid blocking the asyncio event loop
    loop = asyncio.get_running_loop()
    def _fetch():
        with urllib.request.urlopen(endpoint, timeout=3.0) as response:
            return response.read()
            
    return await loop.run_in_executor(None, _fetch)

async def fetch_display_state(url: str):
    """Fetch host display dim state from the daemon without blocking the loop."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _fetch_display_state_sync, url)

async def bridge_reachable(url: str) -> bool:
    """True when a daemon is answering the bridge URL (off-loop). Used to detect a
    successor daemon so the orphaned OFFLINE farewell doesn't clobber its frame."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, _bridge_reachable_sync, url)

def resolve_display_brightness(display_state, normal_brightness: int) -> tuple[int, bool, str, str]:
    """Return (hardware brightness, dimmed, signature, dim_mode) for the host state.
    iDotMatrix firmware accepts 5-100 only; 5% is the practical off floor, which is why
    mode 'off' additionally pushes a black frame (see run_sync)."""
    return _resolve_display_brightness_common(
        display_state, normal_brightness, off_floor=5, level_floor=5
    )

def make_offline_image() -> PilImage.Image:
    """Create a small local OFFLINE placeholder for bridge outages."""
    img = PilImage.new("RGB", (32, 32), (8, 10, 14))
    px = img.load()
    for y in range(32):
        for x in range(32):
            if x in (0, 31) or y in (0, 31):
                px[x, y] = (70, 76, 86)
    # Compact block text that fits without font dependencies.
    glyphs = {
        "O": ["111", "101", "101", "101", "111"],
        "F": ["111", "100", "110", "100", "100"],
        "L": ["100", "100", "100", "100", "111"],
        "I": ["111", "010", "010", "010", "111"],
        "N": ["101", "111", "111", "111", "101"],
        "E": ["111", "100", "110", "100", "111"],
    }
    def draw_text(text, x0, y0, color):
        x = x0
        for ch in text:
            for yy, row in enumerate(glyphs[ch]):
                for xx, bit in enumerate(row):
                    if bit == "1":
                        px[x + xx, y0 + yy] = color
            x += 4
    draw_text("OFF", 3, 8, (180, 65, 65))
    draw_text("LINE", 3, 18, (130, 138, 150))
    return img

async def upload_pil_image(idm_image: IdmImage, img: PilImage.Image) -> bool:
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
        img.save(tmp, format="PNG")
        tmp_path = tmp.name
    try:
        return bool(await idm_image.uploadUnprocessed(tmp_path))
    finally:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)

async def upload_offline_frame(idm_image: IdmImage) -> bool:
    return await upload_pil_image(idm_image, make_offline_image())

BLANK_HASH = "blank"

async def upload_blank_frame(idm_image: IdmImage) -> bool:
    """Push an all-black 32x32 frame. Dim mode 'off' cannot be expressed through
    hardware brightness on this panel — the firmware floor is 5% — so blanking the
    pixels is what actually makes it read as asleep. Mirrors IDotMatrixModule.swift."""
    return await upload_pil_image(idm_image, PilImage.new("RGB", (32, 32), (0, 0, 0)))

async def _interruptible_sleep(stop_event: asyncio.Event, secs: float) -> None:
    """Sleep up to `secs`, but wake immediately if shutdown was requested."""
    try:
        await asyncio.wait_for(stop_event.wait(), timeout=secs)
    except asyncio.TimeoutError:
        pass

# iDotMatrix software brightness boost canonical = 1.22 — keep in sync:
# idotmatrix-daemon-sync.ts (--boost), sync.py (this default), IDotMatrixModule.swift.
async def run_sync(address: str, url: str, brightness: int = 100, boost: float = 1.22):
    print(f"Initializing iDotMatrix Synchronization...")
    print(f"Target Device BLE Address: {address}")
    print(f"AgentDeck Bridge API URL: {url}")
    print(f"Initial Hardware Brightness: {brightness}%")
    print(f"Software Brightness Boost: {boost}x")

    # Machine-readable link state for the daemon supervisor — it spawns us but
    # cannot see the BLE link, and we reconnect inside this loop rather than
    # exiting, so process liveness tells it nothing about whether the panel is
    # actually being driven.
    status = StatusReporter()

    manager = ConnectionManager()
    
    idm_image = IdmImage()
    idm_image.conn = manager
    
    idm_common = IdmCommon()
    idm_common.conn = manager
    
    last_hash = ""
    connected = False
    last_brightness_assert = 0.0
    last_display_signature = ""
    current_hw_brightness = brightness
    display_dimmed = False
    last_bridge_ok = time.monotonic()

    # Graceful shutdown: when the daemon (or a user) stops us, we must leave the
    # panel in a clean state — a stateful BLE display otherwise freezes on the
    # last dashboard frame forever. Trap SIGTERM/SIGINT, break the loop, and push
    # the OFFLINE frame before disconnecting (mirrors the Pixoo/D200H teardown
    # invariant). add_signal_handler isn't available on all platforms; fall back
    # to a classic handler that still requests a clean stop (never ignore the
    # signal — that would strand the panel on its last frame).
    stop_event = asyncio.Event()
    # Why we're stopping — decides the farewell. 'signal' = clean daemon shutdown
    # (no successor → paint OFFLINE). 'orphan' = parent died (a successor daemon may
    # have taken over → don't clobber its frame). 'bridge_gone' = nobody home.
    exit_reason = {"v": None}
    loop = asyncio.get_running_loop()
    def _request_stop() -> None:
        exit_reason["v"] = "signal"
        stop_event.set()
    for _sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(_sig, _request_stop)
        except (NotImplementedError, RuntimeError):
            signal.signal(_sig, lambda *_: loop.call_soon_threadsafe(_request_stop))

    while not stop_event.is_set():
        # Self-terminate when orphaned. If the daemon that spawned us died
        # (crash / SIGKILL / sleep-kill / launchd), our parent reparents to
        # PID 1 (launchd/init). A stateful BLE panel can't detect a dropped
        # link, so without this we'd loop forever holding the single-central
        # BLE connection — blocking the next daemon's fresh sync and leaving a
        # zombie behind (observed: multiple orphaned sync clients across days).
        # Break the loop so the teardown below paints OFFLINE, then exit.
        if os.getppid() == 1:
            print("Parent daemon gone (orphaned) — shutting down iDotMatrix sync.")
            exit_reason["v"] = "orphan"
            stop_event.set()
            break
        # Belt-and-suspenders: if the bridge has been unreachable for a sustained
        # window (parent alive but wedged, or getppid is unreliable), also exit.
        if time.monotonic() - last_bridge_ok > BRIDGE_GONE_EXIT_SEC:
            print(f"Bridge unreachable >{int(BRIDGE_GONE_EXIT_SEC)}s — shutting down iDotMatrix sync.")
            exit_reason["v"] = "bridge_gone"
            stop_event.set()
            break
        try:
            # 1. Ensure bluetooth connection
            if not connected:
                print(f"Connecting to iDotMatrix ({address})...")
                status.connecting()
                await manager.connectByAddress(address)
                print("Connected to Bluetooth device!")
                status.connected()

                # Settle: the panel drops commands sent too soon after the GATT
                # link comes up. Without this the first setBrightness is lost on a
                # reconnect — the device shows frames (setMode lands later) but
                # stays dark. A short beat before/between control commands fixes it.
                await _interruptible_sleep(stop_event, 0.4)

                try:
                    display_state = await fetch_display_state(url)
                    last_bridge_ok = time.monotonic()
                    current_hw_brightness, display_dimmed, last_display_signature, dim_mode = resolve_display_brightness(display_state, brightness)
                except Exception:
                    current_hw_brightness = brightness
                    display_dimmed = False
                    last_display_signature = ""
                    dim_mode = "off"

                # Set initial hardware brightness
                if current_hw_brightness:
                    print(f"Setting hardware brightness to {current_hw_brightness}%...")
                    await idm_common.setBrightness(current_hw_brightness)
                    await _interruptible_sleep(stop_event, 0.1)

                # Enter DIY drawing mode (mode 1)
                print("Entering DIY drawing mode...")
                await idm_image.setMode(1)
                await _interruptible_sleep(stop_event, 0.1)
                connected = True
                last_hash = "" # Force immediate push of first frame after reconnect
                last_brightness_assert = time.monotonic()

            # 1b. Detect a dropped BLE link. We write WITHOUT response, so a
            # silent disconnect (device sleep, brownout reboot, RF glitch) never
            # raises on write — without this check sync.py "pushes" into the void
            # forever and the panel freezes on the last frame it actually got.
            # bleak's is_connected reflects the real OS-level link state.
            if manager.client is None or not manager.client.is_connected:
                print("BLE link lost — reconnecting...")
                status.disconnected("BLE link lost")
                connected = False
                last_hash = ""
                await _interruptible_sleep(stop_event, 1.0)
                continue

            # 1c. Apply host display sleep/wake dimming. The daemon exposes the
            # same display_state that Pixoo/D200H/ESP32 receive over WS/serial.
            try:
                display_state = await fetch_display_state(url)
                # A successful display-state fetch proves the bridge is alive.
                # Without this the dimmed path below (which skips the frame
                # fetch) starves the bridge-gone watchdog and the sync exits
                # cleanly every BRIDGE_GONE_EXIT_SEC while the host display
                # sleeps — the daemon then respawns it forever at 60s cadence.
                last_bridge_ok = time.monotonic()
                target_brightness, target_dimmed, signature, target_mode = resolve_display_brightness(display_state, brightness)
                if signature != last_display_signature or target_brightness != current_hw_brightness:
                    print(f"Host display {'off' if target_dimmed else 'on'} — setting hardware brightness to {target_brightness}%")
                    await idm_common.setBrightness(target_brightness)
                    current_hw_brightness = target_brightness
                    display_dimmed = target_dimmed
                    dim_mode = target_mode
                    last_display_signature = signature
                    last_brightness_assert = time.monotonic()
                    if display_dimmed and dim_mode == "off":
                        # 5% is the firmware floor, so blank the pixels to make the
                        # panel read as asleep instead of frozen on the last frame.
                        if await upload_blank_frame(idm_image):
                            last_hash = BLANK_HASH
                    elif not display_dimmed:
                        # Force a repaint over the blank/dim frame on wake — the hash
                        # dedup below would otherwise swallow an unchanged dashboard.
                        last_hash = None
            except Exception:
                # Older/session-only bridges do not expose /display-state; keep
                # the configured brightness rather than failing sync.
                pass

            # 1d. Periodically re-assert hardware brightness. The panel can dim
            # itself (idle auto-dim, brownout reboot mid-session) while the BLE
            # link stays up, so a one-shot setBrightness on connect isn't enough —
            # re-send it so the display doesn't silently go dark.
            if current_hw_brightness and time.monotonic() - last_brightness_assert > 60:
                await idm_common.setBrightness(current_hw_brightness)
                last_brightness_assert = time.monotonic()

            if display_dimmed:
                status.streaming(dimmed=True)
                await _interruptible_sleep(stop_event, POLL_INTERVAL)
                continue

            # 2. Fetch frame from AgentDeck Bridge
            try:
                frame_data = await fetch_frame(url)
                last_bridge_ok = time.monotonic()
            except urllib.error.URLError as ue:
                print(f"Bridge API offline or unreachable (GET /pixoo/frame): {ue.reason}")
                if connected and last_hash != OFFLINE_HASH:
                    print("Sending local OFFLINE frame to iDotMatrix...")
                    if await upload_offline_frame(idm_image):
                        last_hash = OFFLINE_HASH
                await _interruptible_sleep(stop_event, 5.0)
                continue
            except Exception as fe:
                print(f"Failed to fetch frame from bridge: {fe}")
                if connected and last_hash != OFFLINE_HASH:
                    print("Sending local OFFLINE frame to iDotMatrix...")
                    if await upload_offline_frame(idm_image):
                        last_hash = OFFLINE_HASH
                await _interruptible_sleep(stop_event, 3.0)
                continue
                
            # 3. Check if frame has changed
            current_hash = hashlib.sha256(frame_data).hexdigest()
            if current_hash == last_hash:
                # Frame didn't change, skip BLE transmission to save battery and bandwidth
                status.streaming()
                await _interruptible_sleep(stop_event, POLL_INTERVAL)
                continue
                
            print(f"New frame detected (hash: {current_hash[:8]}). Enhancing and sending to display...")
            
            # 4. Pillow Image Enhancement (Brightness & Contrast Boost)
            # Load 32x32 BMP data
            img = PilImage.open(io.BytesIO(frame_data))
            if img.size != (32, 32):
                try:
                    resample = PilImage.Resampling.BOX
                except AttributeError:
                    resample = PilImage.BOX
                img = img.resize((32, 32), resample)
            
            # Apply Software Brightness Boost if set
            if boost != 1.0:
                bright_enhancer = ImageEnhance.Brightness(img)
                img = bright_enhancer.enhance(boost)
                
                # Restrained contrast preserves official-mark holes and edge
                # coverage instead of clipping the small glyph into a blob.
                contrast_enhancer = ImageEnhance.Contrast(img)
                img = contrast_enhancer.enhance(1.08)
            
            # Use uploadUnprocessed because we already resized and enhanced the image
            res = await upload_pil_image(idm_image, img)
            if res:
                last_hash = current_hash
                print("Frame uploaded successfully.")
                status.frame_sent()
            else:
                print("Failed to upload frame (uploadUnprocessed returned False).")
                status.disconnected("frame upload failed")

            await _interruptible_sleep(stop_event, POLL_INTERVAL)

        except asyncio.CancelledError:
            print("Sync task cancelled.")
            break
        except Exception as e:
            print(f"Error during loop: {e}")
            print("Resetting bluetooth connection...")
            status.failed(e)
            connected = False
            try:
                await manager.disconnect()
            except Exception:
                pass
            await _interruptible_sleep(stop_event, 3.0)

    # Loop exited (shutdown requested). Leave the panel showing OFFLINE instead
    # of a frozen dashboard frame, then drop the BLE link.
    #
    # EXCEPT when a successor daemon has already taken over: our parent died
    # abruptly (orphan) but the bridge is answering again, so a new daemon
    # restarted and is repainting. Painting OFFLINE here would clobber its fresh
    # frame and the panel would sit on OFFLINE until it next changes / reconnects.
    # We still disconnect cleanly (freeing the single-central link for the
    # successor) — only the OFFLINE paint is suppressed.
    successor_took_over = exit_reason["v"] == "orphan" and await bridge_reachable(url)
    if connected:
        if successor_took_over:
            print("Successor daemon detected — skipping OFFLINE farewell (it will repaint).")
        else:
            print("Shutting down — sending OFFLINE frame to iDotMatrix...")
            try:
                await upload_offline_frame(idm_image)
                # Let the final frame transmit before we drop the BLE link below —
                # otherwise the disconnect races the in-flight write and the panel
                # freezes on its last dashboard frame instead of showing OFFLINE.
                await asyncio.sleep(0.5)
                print("  OFFLINE frame sent.")
            except Exception as e:
                print(f"  offline frame push failed: {e}")
        try:
            await manager.disconnect()
        except Exception:
            pass

def main():
    parser = argparse.ArgumentParser(description="AgentDeck iDotMatrix Sync Client")
    parser.add_argument("-a", "--address", required=True, help="BLE MAC/UUID Address of the iDotMatrix device")
    parser.add_argument("-u", "--url", default=DEFAULT_URL, help=f"AgentDeck Bridge URL (default: {DEFAULT_URL})")
    parser.add_argument("-b", "--brightness", type=int, default=100, help="Initial hardware brightness percent (5-100, default: 100)")
    parser.add_argument("--boost", type=float, default=1.22, help="Software brightness boost factor (default: 1.22)")
    args = parser.parse_args()
    
    if args.brightness not in range(5, 101):
        print("ERROR: Brightness must be between 5 and 100 percent.")
        sys.exit(1)
        
    try:
        asyncio.run(run_sync(args.address, args.url, args.brightness, args.boost))
    except KeyboardInterrupt:
        print("\nExiting iDotMatrix Sync Client. Goodbye!")

if __name__ == "__main__":
    main()
