"""Fail-closed checks additional to firmware's CA and hostname verification."""
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("tls_peer", Path(__file__).parent / "AgentDeck/tls_peer.py")
tls_peer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tls_peer)


class Socket:
    def __init__(self, certificate=b"trusted DER certificate"):
        self.certificate = certificate

    def getpeercert(self, binary):
        assert binary is True
        return self.certificate


class TLSPeerTests(unittest.TestCase):
    def setUp(self):
        self.trust = {
            "version": 1,
            "sha256": hashlib.sha256(Socket().certificate).hexdigest(),
            "not_before": [2026, 11, 1, 0, 0, 0],
            "not_after": [2026, 12, 1, 0, 0, 0],
            "provisioned_at": [2026, 11, 13, 0, 0, 0],
        }
        self.now = [2026, 11, 14, 0, 0, 0]

    def test_exact_provisioned_peer(self):
        tls_peer.verify_peer(Socket(), self.trust, self.now)

    def test_rejects_different_leaf_even_if_same_ca(self):
        with self.assertRaisesRegex(ValueError, "Unrecognized"):
            tls_peer.verify_peer(Socket(b"other valid certificate"), self.trust, self.now)

    def test_rejects_expiry_and_clock_rollback(self):
        for now in ([2026, 12, 1, 0, 0, 1], [2026, 11, 12, 23, 59, 59], [2000, 1, 1, 0, 0, 0]):
            with self.subTest(now=now), self.assertRaises(ValueError):
                tls_peer.verify_peer(Socket(), self.trust, now)

    def test_missing_peer_fails_closed(self):
        for certificate in (None, {}, b"", b"a" * 8193):
            with self.subTest(certificate=type(certificate)), self.assertRaises(ValueError):
                tls_peer.verify_peer(Socket(certificate), self.trust, self.now)

    def test_invalid_dates_and_metadata_fail_closed(self):
        for field, value in (("not_before", [2026, 2, 30, 0, 0, 0]),
                             ("not_after", [2026, 11, 12, 0, 0, 0]),
                             ("provisioned_at", [True, 11, 13, 0, 0, 0]),
                             ("sha256", "a" * 63), ("version", 2)):
            with self.subTest(field=field), self.assertRaises(ValueError):
                tls_peer.verify_peer(Socket(), dict(self.trust, **{field: value}), self.now)


if __name__ == "__main__":
    unittest.main()
