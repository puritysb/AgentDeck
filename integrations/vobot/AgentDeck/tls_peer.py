"""Additional peer checks for firmware that omits X.509 validity checks.

The owner provisions the leaf fingerprint and validity window over an already
trusted channel. They must never be learned from an unauthenticated handshake.
The native TLS layer must still require a valid CA signature and server name.
"""

import binascii
import hashlib
import time


def _date(value):
    if not isinstance(value, (list, tuple)) or len(value) != 6:
        raise ValueError("Invalid certificate date")
    if any(type(part) is not int for part in value):
        raise ValueError("Invalid certificate date")
    year, month, day, hour, minute, second = value
    if not 2020 <= year <= 9999 or not 1 <= month <= 12:
        raise ValueError("Invalid certificate date")
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    days = (31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    if not 1 <= day <= days[month - 1] or not 0 <= hour <= 23 or not 0 <= minute <= 59 or not 0 <= second <= 59:
        raise ValueError("Invalid certificate date")
    return tuple(value)


def verify_peer(sock, trust, now=None):
    """Run before sending HTTP headers, credentials, or application data.

    A pinned leaf also prevents an unchecked intermediate's validity from
    extending trust. Renewal requires a new owner-authorized provision.
    Clocks earlier than provisioning fail closed. This does not authenticate
    NTP or prevent rollback within the provisioned validity window.
    """
    if not isinstance(trust, dict) or type(trust.get("version")) is not int or trust["version"] != 1:
        raise ValueError("Invalid TLS trust record")
    fingerprint = trust.get("sha256")
    if not isinstance(fingerprint, str) or len(fingerprint) != 64 or any(c not in "0123456789abcdef" for c in fingerprint):
        raise ValueError("Invalid certificate fingerprint")
    start = _date(trust.get("not_before"))
    end = _date(trust.get("not_after"))
    floor = _date(trust.get("provisioned_at"))
    current = _date(time.gmtime()[:6] if now is None else now)
    if not start <= floor <= end or not floor <= current <= end:
        raise ValueError("TLS certificate expired or clock not ready")
    certificate = sock.getpeercert(True)
    if not isinstance(certificate, bytes) or not 1 <= len(certificate) <= 8192:
        raise ValueError("Peer certificate unavailable")
    actual = binascii.hexlify(hashlib.sha256(certificate).digest()).decode()
    if actual != fingerprint:
        raise ValueError("Unrecognized server certificate")
