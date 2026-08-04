"""BLE scan for iDotMatrix-protocol panels (terminal-managed daemon + CLI).

Reports every peripheral it sees, flagging the ones that speak the iDotMatrix
protocol. Identification is brand-independent — advertised service UUID first,
known name families second — because the same hardware ships as 'IDM-...'
(iDotMatrix) and 'iPixel-...'. The rule lives in identity_generated.py, mirrored
from shared/src/idotmatrix-identity.ts; the Swift CoreBluetooth scanner in the
App Store daemon applies the identical predicate.

Extra name prefixes may be passed as argv (the daemon forwards
`idotmatrixNamePrefixes` from settings.json) so a further rebrand is a config
change rather than a release.
"""

import asyncio
import json
import sys
from bleak import BleakScanner

from identity_generated import matches_advertisement


async def scan(extra_prefixes):
    # Scan for 5 seconds. return_adv gives the advertisement payload, which is
    # where the service UUIDs live — peripheral.name alone cannot identify a
    # panel that advertises under an unknown brand name.
    discovered = await BleakScanner.discover(timeout=5.0, return_adv=True)

    results = []
    for device, adv in discovered.values():
        name = adv.local_name or device.name or "Unknown"
        service_uuids = list(adv.service_uuids or ())
        results.append({
            "name": name,
            "address": device.address,
            "is_idotmatrix": matches_advertisement(name, service_uuids, extra_prefixes),
        })

    # Sort so that iDotMatrix devices are on top
    results.sort(key=lambda x: x["is_idotmatrix"], reverse=True)

    # Print as JSON so the calling Node.js CLI can easily parse it
    print(json.dumps(results))


def main():
    try:
        asyncio.run(scan(sys.argv[1:]))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
