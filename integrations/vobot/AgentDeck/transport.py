"""Bounded WebSocket client for the AgentDeck daemon on a trusted LAN."""

import asyncio
import binascii
import hashlib
import json
import os

PROFILE = "display-only/v1"
IDENTITY = "dev.agentdeck.vobot"
REGISTER = {
    "type": "client_register",
    "clientType": "companion",
    "clientLabel": "AgentDeck for Vobot",
    "surface": {
        "protocol": 1,
        "clientId": IDENTITY,
        "productId": IDENTITY,
        "clientVersion": "0.3.0",
        "profiles": [{"id": PROFILE, "capabilities": ["sessions.read", "usage.read"]}],
    },
}

MAX_FRAME = 32768
GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class Connection:
    def __init__(self):
        self.reader = None
        self.writer = None

    async def connect(self, host, port, token):
        self.reader, self.writer = await asyncio.open_connection(host, port)
        key = binascii.b2a_base64(os.urandom(16)).strip()
        request = (
            "GET /?token=%s HTTP/1.1\r\n"
            "Host: %s:%d\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: %s\r\n\r\n"
        ) % (token, host, port, key.decode())
        self.writer.write(request.encode())
        await self.writer.drain()
        status = await self.reader.readline()
        if status.split()[1:2] != [b"101"]:
            raise ValueError("WebSocket upgrade refused")
        expected = binascii.b2a_base64(hashlib.sha1(key + GUID).digest()).strip()
        accepted = False
        for _ in range(24):
            line = await self.reader.readline()
            if line == b"\r\n":
                if not accepted:
                    raise ValueError("Invalid WebSocket handshake")
                break
            if not line or len(line) > 1024:
                raise ValueError("Invalid WebSocket headers")
            parts = line.split(b":", 1)
            if len(parts) == 2 and parts[0].lower() == b"sec-websocket-accept":
                accepted = parts[1].strip() == expected
        else:
            raise ValueError("Too many WebSocket headers")
        await self.send(1, json.dumps(REGISTER).encode())

    async def send(self, opcode, payload):
        size = len(payload)
        header = bytes((128 | opcode, 128 | size)) if size < 126 else bytes(
            (128 | opcode, 254, size >> 8, size & 255)
        )
        mask = os.urandom(4)
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        self.writer.write(header + mask + masked)
        await self.writer.drain()

    async def read_exactly(self, size):
        # Older Vobot builds expose read() but may lack Stream.readexactly().
        result = bytearray()
        while len(result) < size:
            chunk = await self.reader.read(size - len(result))
            if not chunk:
                raise EOFError("Daemon closed the stream")
            result.extend(chunk)
        return result

    async def receive(self):
        first, second = await self.read_exactly(2)
        opcode = first & 15
        size = second & 127
        # Both AgentDeck daemons send complete, uncompressed server frames.
        if first & 240 != 128 or second & 128:
            raise ValueError("Unsupported WebSocket frame")
        if size == 126:
            high, low = await self.read_exactly(2)
            size = high * 256 + low
        elif size == 127:
            size = int.from_bytes(await self.read_exactly(8), "big")
        if opcode >= 8 and size > 125:
            raise ValueError("Invalid WebSocket control frame")
        # The daemon may send legacy startup history before registration takes
        # effect. Consume large frames without allocating their full payload.
        if size > MAX_FRAME:
            while size:
                chunk = min(size, 1024)
                await self.read_exactly(chunk)
                size -= chunk
            return None
        payload = await self.read_exactly(size) if size else b""
        if opcode == 8:
            raise OSError("Daemon closed the connection")
        if opcode == 9:
            await self.send(10, payload)
        if opcode == 1:
            return json.loads(payload.decode())
        return None

    async def close(self):
        writer = self.writer
        self.reader = None
        self.writer = None
        if writer is not None:
            writer.close()
            try:
                await writer.wait_closed()
            except OSError:
                pass
