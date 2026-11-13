"""Verify credentials never precede peer checks and malformed TLS input fails closed."""
import asyncio
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.modules.setdefault("lvgl", types.ModuleType("lvgl"))
sys.modules.setdefault("peripherals", types.ModuleType("peripherals"))
from AgentDeck import tls_transport as transport


class Socket:
    def __init__(self):
        self.closed = False
    def settimeout(self, seconds): pass
    def connect(self, endpoint): pass
    def setblocking(self, enabled): pass
    def getpeercert(self, binary): return b"certificate"
    def close(self): self.closed = True


class Stream:
    def __init__(self, response):
        self.response = response
        self.writes = []
        self.closed = False
    def write(self, data): self.writes.append(data)
    async def drain(self): pass
    async def read(self, count):
        result, self.response = self.response[:count], self.response[count:]
        return result
    def close(self): self.closed = True
    async def wait_closed(self): pass


class TLSTransportTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.config = {"version":1,"host":"127.0.0.1","port":9443,"hostname":"localhost",
                       "token":"addev1."+"a"*32+"."+"b"*64,"ca_der":"Y2E=","ca_bytes":b"ca",
                       "trust":{"version":1,"sha256":hashlib.sha256(b"certificate").hexdigest(),
                                "not_before":[2020,1,1,0,0,0],"not_after":[2099,1,1,0,0,0],"provisioned_at":[2020,1,1,0,0,0]}}
        self.body = json.dumps({"version":1,"events":[{"type":"surface_welcome","profile":"display-only/v1","protocol":1,"capabilities":["sessions.read"]},{"type":"sessions_list","sessions":[]}]}).encode()
        self.response = b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n" % len(self.body) + self.body

    async def poll(self, response, trust=None):
        sock, stream = Socket(), Stream(response)
        config = dict(self.config)
        if trust is not None: config["trust"] = trust
        connection = transport.TLSConnection(config)
        with patch.object(transport.socket,"socket",return_value=sock), patch.object(transport.ssl,"wrap_socket",return_value=sock,create=True) as wrap, patch.object(transport,"_TLSStream",return_value=stream):
            await connection.connect()
            self.assertEqual(wrap.call_args.kwargs["cert_reqs"],transport.ssl.CERT_REQUIRED)
            self.assertEqual(wrap.call_args.kwargs["server_hostname"],"localhost")
        return connection, stream

    async def test_authenticated_bounded_snapshot(self):
        connection, stream = await self.poll(self.response)
        self.assertEqual((await connection.receive())["type"],"surface_welcome")
        self.assertEqual((await connection.receive())["type"],"sessions_list")
        self.assertIn(b"Authorization: Bearer addev1.",stream.writes[0])
        self.assertNotIn(b"?token",stream.writes[0])
        self.assertTrue(stream.closed)
        await connection.send(1,b'{"type":"query_usage"}')
        with self.assertRaises(ValueError): await connection.send(1,b'{"type":"session_command"}')

    async def test_bad_peer_never_receives_a_credential(self):
        sock, stream = Socket(), Stream(self.response)
        config = dict(self.config,trust=dict(self.config["trust"],sha256="c"*64))
        with patch.object(transport.socket,"socket",return_value=sock), patch.object(transport.ssl,"wrap_socket",return_value=sock,create=True), patch.object(transport,"_TLSStream",return_value=stream):
            with self.assertRaises(ValueError): await transport.TLSConnection(config).connect()
        self.assertEqual(stream.writes,[])
        self.assertTrue(sock.closed)

    async def test_refusal_and_invalid_headers_do_not_produce_events(self):
        for response in (b"HTTP/1.1 401 Unauthorized\r\n\r\n",b"HTTP/1.1 200 OK\r\nContent-Length: 999999\r\n\r\n",
                         b"HTTP/1.1 200 OK\r\nX: "+b"x"*2000+b"\r\n\r\n", self.response[:-3],
                         self.response.replace(b"Content-Length:",b"Transfer-Encoding: chunked\r\nContent-Length:")):
            with self.subTest(response=response[:40]), self.assertRaises((ValueError,EOFError)):
                await self.poll(response)

    async def test_nonblocking_adapter_retries_and_preserves_partial_writes(self):
        class Nonblocking(Socket):
            def __init__(self):
                super().__init__()
                self.reads = [None, b"ok", b""]
                self.sent = b""
                self.blocked = True
            def read(self, count): return self.reads.pop(0)
            def write(self, data):
                if self.blocked:
                    self.blocked = False
                    raise BlockingIOError(transport.errno.EAGAIN, "not ready")
                self.sent += data[:2]
                return min(2,len(data))
        sock=Nonblocking();stream=transport._TLSStream(sock)
        self.assertEqual(await stream.read(2),b"ok")
        self.assertEqual(await stream.read(2),b"")
        stream.write(b"request")
        await stream.drain()
        self.assertEqual(sock.sent,b"request")
        stream.close();self.assertTrue(sock.closed)

    def test_invalid_secure_configuration_never_becomes_legacy(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/"tls.json"
            with patch.object(transport,"CONFIG_PATH",str(path)):
                self.assertIsNone(transport.configuration())
                path.write_text("{broken")
                with self.assertRaises(ValueError): transport.configuration()
                config={key:value for key,value in self.config.items() if key != "ca_bytes"}
                path.write_text(json.dumps(config));self.assertEqual(transport.configuration()["token"],config["token"])
                path.write_text(json.dumps(dict(config,hostname="host\r\nInjected: yes")))
                with self.assertRaises(ValueError): transport.configuration()


if __name__ == "__main__": unittest.main()
