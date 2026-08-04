# GENERATED FILE — DO NOT EDIT.
# Source of truth: shared/src/idotmatrix-identity.ts
# Regenerate: pnpm generate-idotmatrix-identity (drift gated by shared/src/__tests__/idotmatrix-identity.test.ts)
"""Brand-independent identity of an iDotMatrix-protocol BLE panel.

The same hardware advertises as 'IDM-...' (iDotMatrix) or 'iPixel-...', so a
scan filters on the advertised service first and only falls back to the name
families.
"""

IDOTMATRIX_SERVICE_UUID = "000000fa-0000-1000-8000-00805f9b34fb"
IDOTMATRIX_WRITE_CHARACTERISTIC_UUID = "0000fa02-0000-1000-8000-00805f9b34fb"
IDOTMATRIX_NAME_PREFIXES = ["IDM-", "IPIXEL"]

_HEX = set("0123456789abcdef")


def normalize_uuid(value):
    """Expand a 16-bit ('fa02') or 32-bit ('000000fa') UUID to Bluetooth-base form.

    Short forms are left-padded first: 'fa' and '00fa' are the same service.
    """
    s = (value or "").strip().lower()
    if not s or not set(s) <= _HEX:
        return s
    if len(s) <= 4:
        return "0000" + s.rjust(4, "0") + "-0000-1000-8000-00805f9b34fb"
    if len(s) <= 8:
        return s.rjust(8, "0") + "-0000-1000-8000-00805f9b34fb"
    return s


def matches_name(name, extra_prefixes=()):
    """Whether an advertised local name belongs to a known panel family."""
    n = (name or "").strip().upper()
    if not n:
        return False
    for prefix in list(IDOTMATRIX_NAME_PREFIXES) + list(extra_prefixes or ()):
        p = (prefix or "").strip().upper()
        if p and n.startswith(p):
            return True
    return False


def matches_advertisement(name, service_uuids, extra_prefixes=()):
    """The discovery predicate: service UUID first, name families second."""
    for uuid in service_uuids or ():
        if normalize_uuid(uuid) == IDOTMATRIX_SERVICE_UUID:
            return True
    return matches_name(name, extra_prefixes)
