"""Exercise the Vobot web settings and pairing flow on a loopback HTTP server."""

import asyncio
import errno
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, patch

sys.modules.setdefault("lvgl", types.ModuleType("lvgl"))
sys.modules.setdefault("peripherals", types.ModuleType("peripherals"))

from AgentDeck import pairing


class Settings:
    def __init__(self, config):
        self.config_data = config

    def config(self, new_config=None):
        if new_config is not None:
            self.config_data = new_config.copy()
        return self.config_data.copy()


class PairingTests(unittest.IsolatedAsyncioTestCase):
    async def test_redeems_once_and_preserves_endpoint(self):
        requests = []
        token = "a" * 32

        async def daemon(reader, writer):
            header = await reader.readuntil(b"\r\n\r\n")
            length = next(int(line.split(b":", 1)[1]) for line in header.splitlines()
                          if line.lower().startswith(b"content-length:"))
            requests.append((header.splitlines()[0], json.loads(await reader.readexactly(length))))
            body = json.dumps({"token": token, "port": port}).encode()
            writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        async with await asyncio.start_server(daemon, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            manager = Settings({"daemon_host": "127.0.0.1", "daemon_port": str(port), "pairing_code": "123 456"})
            with tempfile.TemporaryDirectory() as tmp, patch.object(pairing, "PAIRING_PATH", str(Path(tmp) / "pairing.txt")):
                expected = ("127.0.0.1", port, token)
                self.assertEqual(await pairing.connection_settings(manager), expected)
                self.assertEqual(await pairing.connection_settings(manager), expected)
                self.assertEqual(manager.config_data["pairing_code"], "")
                self.assertNotIn(token, str(manager.config_data))
                self.assertEqual(len(requests), 1)
                self.assertEqual(requests[0][0], b"POST /pair HTTP/1.0")
                self.assertEqual(requests[0][1]["code"], "123456")
                manager.config_data["daemon_host"] = "192.0.2.1"
                self.assertIsNone(await pairing.connection_settings(manager))

    async def test_forget_removes_both_files_without_pairing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pairing.txt"
            path.write_text("127.0.0.1\n" + "b" * 32 + "\n9120\n")
            partial = Path(str(path) + ".new")
            partial.write_text("old partial credential")
            secure = Path(tmp) / "device-tls.json"
            secure.write_text("private secure credential")
            secure_partial = Path(str(secure) + ".new")
            secure_partial.write_text("partial secure credential")
            manager = Settings({"forget_pairing": " unpair ", "pairing_code": "123456"})
            with patch.object(pairing, "PAIRING_PATH", str(path)), patch.object(pairing, "_redeem", new_callable=AsyncMock) as redeem:
                self.assertIsNone(await pairing.connection_settings(manager))
                self.assertIsNone(await pairing.connection_settings(manager))
                redeem.assert_not_awaited()
            self.assertFalse(path.exists())
            self.assertFalse(partial.exists())
            self.assertFalse(secure.exists())
            self.assertFalse(secure_partial.exists())
            self.assertEqual(manager.config_data["forget_pairing"], "")
            self.assertEqual(manager.config_data["pairing_code"], "")

    async def test_forget_failure_stays_armed_and_never_connects(self):
        manager = Settings({"forget_pairing": "UNPAIR", "pairing_code": "123456"})
        with patch.object(pairing.os, "remove", side_effect=OSError(errno.EACCES, "denied")), patch.object(pairing, "_stored_pairing") as stored, patch.object(pairing, "_redeem", new_callable=AsyncMock) as redeem:
            with self.assertRaises(OSError):
                await pairing.connection_settings(manager)
            stored.assert_not_called()
            redeem.assert_not_awaited()
        self.assertEqual(manager.config_data["forget_pairing"], "UNPAIR")

    async def test_invalid_forget_request_neither_deletes_nor_connects(self):
        for value in ("yes", True):
            with patch.object(pairing, "_forget_pairing") as forget, patch.object(pairing, "_stored_pairing") as stored:
                with self.assertRaises(ValueError):
                    await pairing.connection_settings(Settings({"forget_pairing": value}))
                forget.assert_not_called()
                stored.assert_not_called()

    async def test_forget_absent_files_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(pairing, "PAIRING_PATH", str(Path(tmp) / "missing")):
            self.assertIsNone(await pairing.connection_settings(Settings({"forget_pairing": "UNPAIR"})))

    async def test_interrupted_write_cleaned_before_saved_connection(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pairing.txt"
            path.write_text("127.0.0.1\n" + "b" * 32 + "\n9120\n")
            partial = Path(str(path) + ".new")
            partial.write_text("partial credential")
            with patch.object(pairing, "PAIRING_PATH", str(path)):
                self.assertEqual(await pairing.connection_settings(Settings({})), ("127.0.0.1", 9120, "b" * 32))
            self.assertFalse(partial.exists())

    def test_failed_replace_keeps_old_credential_without_temporary(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "pairing.txt"
            saved = "127.0.0.1\n" + "b" * 32 + "\n9120\n"
            path.write_text(saved)
            with patch.object(pairing, "PAIRING_PATH", str(path)), patch.object(pairing.os, "rename", side_effect=OSError(errno.EIO, "write failed")):
                with self.assertRaises(OSError):
                    pairing._save_pairing("127.0.0.1", 9120, "a" * 32)
            self.assertEqual(path.read_text(), saved)
            self.assertFalse(Path(str(path) + ".new").exists())

    async def test_rejected_code_does_not_replace_saved_pairing(self):
        async def daemon(reader, writer):
            await reader.read(1024)
            writer.write(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()
            writer.close()
            await writer.wait_closed()

        async with await asyncio.start_server(daemon, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            manager = Settings({"daemon_host": "127.0.0.1", "daemon_port": str(port), "pairing_code": "000000"})
            with tempfile.TemporaryDirectory() as tmp:
                path = Path(tmp) / "pairing.txt"
                saved = "127.0.0.1\n" + "b" * 32 + "\n%d\n" % port
                path.write_text(saved)
                with patch.object(pairing, "PAIRING_PATH", str(path)):
                    with self.assertRaisesRegex(ValueError, "rejected"):
                        await pairing.connection_settings(manager)
                self.assertEqual(path.read_text(), saved)
                self.assertEqual(manager.config_data["pairing_code"], "")


if __name__ == "__main__":
    unittest.main()
