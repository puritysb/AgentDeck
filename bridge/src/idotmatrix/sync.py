import asyncio
import os
import sys
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

# Default settings
DEFAULT_URL = "http://127.0.0.1:9120"
POLL_INTERVAL = 1.5  # 1.5 seconds interval (balanced for BLE bandwidth)

async def fetch_frame(url: str) -> bytes:
    """Fetch the current 32x32 BMP frame from the AgentDeck bridge."""
    endpoint = f"{url.rstrip('/')}/pixoo/frame?size=32"
    
    # We use urllib run_in_executor to avoid blocking the asyncio event loop
    loop = asyncio.get_running_loop()
    def _fetch():
        with urllib.request.urlopen(endpoint, timeout=3.0) as response:
            return response.read()
            
    return await loop.run_in_executor(None, _fetch)

async def run_sync(address: str, url: str, brightness: int = 100, boost: float = 1.5):
    print(f"Initializing iDotMatrix Synchronization...")
    print(f"Target Device BLE Address: {address}")
    print(f"AgentDeck Bridge API URL: {url}")
    print(f"Initial Hardware Brightness: {brightness}%")
    print(f"Software Brightness Boost: {boost}x")
    
    manager = ConnectionManager()
    
    idm_image = IdmImage()
    idm_image.conn = manager
    
    idm_common = IdmCommon()
    idm_common.conn = manager
    
    last_hash = ""
    connected = False
    
    while True:
        try:
            # 1. Ensure bluetooth connection
            if not connected:
                print(f"Connecting to iDotMatrix ({address})...")
                await manager.connectByAddress(address)
                print("Connected to Bluetooth device!")
                
                # Set initial hardware brightness
                if brightness:
                    print(f"Setting hardware brightness to {brightness}%...")
                    await idm_common.setBrightness(brightness)
                
                # Enter DIY drawing mode (mode 1)
                print("Entering DIY drawing mode...")
                await idm_image.setMode(1)
                connected = True
                last_hash = "" # Force immediate push of first frame after reconnect
            
            # 2. Fetch frame from AgentDeck Bridge
            try:
                frame_data = await fetch_frame(url)
            except urllib.error.URLError as ue:
                print(f"Bridge API offline or unreachable (GET /pixoo/frame): {ue.reason}")
                await asyncio.sleep(5.0)
                continue
            except Exception as fe:
                print(f"Failed to fetch frame from bridge: {fe}")
                await asyncio.sleep(3.0)
                continue
                
            # 3. Check if frame has changed
            current_hash = hashlib.sha256(frame_data).hexdigest()
            if current_hash == last_hash:
                # Frame didn't change, skip BLE transmission to save battery and bandwidth
                await asyncio.sleep(POLL_INTERVAL)
                continue
                
            print(f"New frame detected (hash: {current_hash[:8]}). Enhancing and sending to display...")
            
            # 4. Pillow Image Enhancement (Brightness & Contrast Boost)
            # Load 32x32 BMP data
            img = PilImage.open(io.BytesIO(frame_data))
            
            # Apply Software Brightness Boost if set
            if boost != 1.0:
                bright_enhancer = ImageEnhance.Brightness(img)
                img = bright_enhancer.enhance(boost)
                
                # Boost contrast slightly to prevent color washing out
                contrast_enhancer = ImageEnhance.Contrast(img)
                img = contrast_enhancer.enhance(1.2)
            
            # Save processed image to a temporary file (PNG format)
            with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tmp:
                img.save(tmp, format="PNG")
                tmp_path = tmp.name
                
            try:
                # Use uploadUnprocessed because we already resized and enhanced the image
                res = await idm_image.uploadUnprocessed(tmp_path)
                if res:
                    last_hash = current_hash
                    print("Frame uploaded successfully.")
                else:
                    print("Failed to upload frame (uploadUnprocessed returned False).")
            finally:
                # Always clean up the temp file
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            
            await asyncio.sleep(POLL_INTERVAL)
            
        except asyncio.CancelledError:
            print("Sync task cancelled.")
            break
        except Exception as e:
            print(f"Error during loop: {e}")
            print("Resetting bluetooth connection...")
            connected = False
            try:
                await manager.disconnect()
            except Exception:
                pass
            await asyncio.sleep(3.0)

def main():
    parser = argparse.ArgumentParser(description="AgentDeck iDotMatrix Sync Client")
    parser.add_argument("-a", "--address", required=True, help="BLE MAC/UUID Address of the iDotMatrix device")
    parser.add_argument("-u", "--url", default=DEFAULT_URL, help=f"AgentDeck Bridge URL (default: {DEFAULT_URL})")
    parser.add_argument("-b", "--brightness", type=int, default=100, help="Initial hardware brightness percent (5-100, default: 100)")
    parser.add_argument("--boost", type=float, default=1.6, help="Software brightness boost factor (default: 1.6)")
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
