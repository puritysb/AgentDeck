import asyncio
import json
import sys
from bleak import BleakScanner

async def scan():
    # Scan for 5 seconds
    devices = await BleakScanner.discover(timeout=5.0)
    
    results = []
    for d in devices:
        name = d.name if d.name else "Unknown"
        # Gather all devices, but flag IDM devices
        is_idm = name.startswith("IDM-")
        results.append({
            "name": name,
            "address": d.address,
            "is_idotmatrix": is_idm
        })
        
    # Sort so that iDotMatrix devices are on top
    results.sort(key=lambda x: x["is_idotmatrix"], reverse=True)
    
    # Print as JSON so the calling Node.js CLI can easily parse it
    print(json.dumps(results))

def main():
    try:
        asyncio.run(scan())
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
