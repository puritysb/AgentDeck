import asyncio
import sys
import argparse
from idotmatrix import ConnectionManager
from idotmatrix.modules.common import Common as IdmCommon

async def set_brightness(address: str, brightness: int):
    manager = ConnectionManager()
    idm_common = IdmCommon()
    idm_common.conn = manager
    
    try:
        print(f"Connecting to iDotMatrix ({address})...")
        await manager.connectByAddress(address)
        print(f"Setting brightness to {brightness}%...")
        await idm_common.setBrightness(brightness)
        print("Brightness set successfully.")
    except Exception as e:
        print(f"ERROR: Failed to set brightness: {e}")
        sys.exit(1)
    finally:
        try:
            await manager.disconnect()
        except Exception:
            pass

def main():
    parser = argparse.ArgumentParser(description="Set iDotMatrix Brightness")
    parser.add_argument("-a", "--address", required=True, help="BLE MAC/UUID Address")
    parser.add_argument("-b", "--brightness", type=int, required=True, help="Brightness percent (5-100)")
    args = parser.parse_args()
    
    if args.brightness not in range(5, 101):
        print("ERROR: Brightness must be between 5 and 100 percent.")
        sys.exit(1)
        
    asyncio.run(set_brightness(args.address, args.brightness))

if __name__ == "__main__":
    main()
