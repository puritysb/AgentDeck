"""Opt-in, pinned TLS polling; a configured secure device never downgrades."""
import asyncio
import binascii
import errno
import json
import socket
import ssl

from .tls_peer import verify_peer

CONFIG_PATH = "/apps/AgentDeck/device-tls.json"
MAX_BODY = 32768


def configuration():
    try:
        with open(CONFIG_PATH, "r") as stream:
            text = stream.read(8193)
    except OSError as error:
        if error.args and error.args[0] == errno.ENOENT:
            return None
        raise
    if len(text) > 8192:
        raise ValueError("TLS configuration too large")
    value = json.loads(text)
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        raise ValueError("Invalid TLS configuration")
    host, port, hostname, token = (value.get(key) for key in ("host", "port", "hostname", "token"))
    # A provisioned IP keeps DNS resolution out of the bounded device loop.
    parts = host.split(".") if isinstance(host, str) else []
    if len(parts) != 4 or any(not part.isdigit() or not 0 <= int(part) <= 255 for part in parts):
        raise ValueError("Invalid TLS endpoint")
    if type(port) is not int or not 1024 <= port <= 65535 or 9120 <= port <= 9139:
        raise ValueError("Invalid TLS port")
    if not isinstance(hostname, str) or not 1 <= len(hostname) <= 253 or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789.-" for c in hostname):
        raise ValueError("Invalid TLS server name")
    parts = token.split(".") if isinstance(token, str) else []
    if len(parts) != 3 or parts[0] != "addev1" or len(parts[1]) != 32 or len(parts[2]) != 64 or any(c not in "0123456789abcdef" for c in parts[1] + parts[2]):
        raise ValueError("Invalid device credential")
    ca = value.get("ca_der")
    if not isinstance(ca, str) or not ca or len(ca) > 4096:
        raise ValueError("Invalid TLS anchor")
    value["ca_bytes"] = binascii.a2b_base64(ca)
    if not isinstance(value.get("trust"), dict):
        raise ValueError("Missing TLS peer policy")
    return value


class _TLSStream:
    """Small polling adapter for firmware without asyncio.Stream exports."""
    def __init__(self, sock):
        self.socket = sock
        self.output = b""

    async def read(self, count):
        while True:
            try:
                result = self.socket.read(count)
                if result is not None:
                    return result
            except OSError as error:
                if not error.args or error.args[0] not in (errno.EAGAIN, errno.EINPROGRESS):
                    raise
            await asyncio.sleep(0.01)

    def write(self, data):
        if len(self.output) + len(data) > 2048:
            raise ValueError("TLS request too large")
        self.output += data

    async def drain(self):
        while self.output:
            try:
                count = self.socket.write(self.output)
                if count == 0:
                    raise EOFError("TLS socket closed while writing")
                if count is not None:
                    self.output = self.output[count:]
            except OSError as error:
                if not error.args or error.args[0] not in (errno.EAGAIN, errno.EINPROGRESS):
                    raise
            if self.output:
                await asyncio.sleep(0.01)

    def close(self):
        self.socket.close()
        self.output = b""

    async def wait_closed(self):
        return


class TLSConnection:
    def __init__(self, config):
        self.config = config
        self.stream = None
        self.pending = []
        self.first = True

    async def connect(self):
        await self._poll()

    async def _poll(self):
        cfg = self.config
        sock = socket.socket()
        sock.settimeout(3)
        wrapped = None
        try:
            sock.connect((cfg["host"], cfg["port"]))
            wrapped = ssl.wrap_socket(sock, cert_reqs=ssl.CERT_REQUIRED,
                                      cadata=cfg["ca_bytes"], server_hostname=cfg["hostname"])
            # No HTTP bytes or bearer secret precede peer verification.
            verify_peer(wrapped, cfg["trust"])
            wrapped.setblocking(False)
            self.stream = _TLSStream(wrapped)
            request = ("GET /device/snapshot HTTP/1.1\r\nHost: %s\r\n"
                       "Authorization: Bearer %s\r\nConnection: close\r\n\r\n") % (cfg["hostname"], cfg["token"])
            self.stream.write(request.encode())
            await self.stream.drain()
            status = await self._line()
            if status.split()[1:2] != [b"200"]:
                raise ValueError("Device TLS request refused")
            headers = {}
            for _ in range(24):
                line = await self._line()
                if line == b"\r\n":
                    break
                pieces = line.split(b":", 1)
                if len(pieces) != 2 or pieces[0].lower() in headers:
                    raise ValueError("Invalid TLS response headers")
                headers[pieces[0].lower()] = pieces[1].strip()
            else:
                raise ValueError("Too many TLS response headers")
            length = headers.get(b"content-length", b"")
            if b"transfer-encoding" in headers or not length.isdigit() or not 1 <= int(length) <= MAX_BODY:
                raise ValueError("Invalid TLS response length")
            body = bytearray()
            while len(body) < int(length):
                chunk = await self.stream.read(min(1024, int(length) - len(body)))
                if not chunk:
                    raise EOFError("Truncated TLS snapshot")
                body.extend(chunk)
            snapshot = json.loads(body.decode())
            events = snapshot.get("events") if isinstance(snapshot, dict) else None
            if not isinstance(snapshot, dict) or type(snapshot.get("version")) is not int or snapshot["version"] != 1 or not isinstance(events, list) or not 1 <= len(events) <= 3:
                raise ValueError("Invalid device snapshot")
            if any(not isinstance(event, dict) or event.get("type") not in ("surface_welcome", "sessions_list", "usage_update") for event in events):
                raise ValueError("Invalid device event")
            self.pending = events if self.first else [event for event in events if event["type"] != "surface_welcome"]
            self.first = False
        finally:
            if self.stream is not None:
                self.stream.close()
                await self.stream.wait_closed()
                self.stream = None
            elif wrapped is not None:
                wrapped.close()
            else:
                sock.close()

    async def _line(self):
        # Stream.readline() can allocate an unbounded line before the caller checks.
        line = bytearray()
        for _ in range(1024):
            byte = await self.stream.read(1)
            if not byte:
                raise EOFError("Truncated TLS headers")
            line.extend(byte)
            if byte == b"\n":
                return bytes(line)
        raise ValueError("TLS header line too long")

    async def receive(self):
        if not self.pending:
            await asyncio.sleep(2)
            await asyncio.wait_for(self._poll(), 5)
        return self.pending.pop(0) if self.pending else None

    async def send(self, opcode, payload):
        # Usage is included in each snapshot. No control message is transmitted.
        if opcode != 1 or payload != b'{"type":"query_usage"}':
            raise ValueError("Read-only device connection")

    async def close(self):
        if self.stream is not None:
            self.stream.close()
            await self.stream.wait_closed()
            self.stream = None
        self.pending = []
