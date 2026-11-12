"""Redeem an AgentDeck pairing code and store its endpoint with the token."""

import asyncio
import json
import os

DEFAULT_PORT = 9120
PAIRING_PATH = "/apps/AgentDeck/pairing.txt"
DIGITS = "0123456789"


def settings_form():
    return {
        "title": "Connect to AgentDeck",
        "form": [
            {"type": "input", "name": "daemon_host", "caption": "Daemon address",
             "default": "", "attributes": {"maxLength": 253, "placeholder": "192.168.1.10"}},
            {"type": "input", "name": "daemon_port", "caption": "Daemon port",
             "default": str(DEFAULT_PORT), "attributes": {"maxLength": 5}},
            {"type": "input", "name": "pairing_code", "caption": "Pairing code",
             "default": "", "attributes": {"maxLength": 7, "placeholder": "000 000"},
             "tip": "Run agentdeck pair on your computer, save the code here, then open AgentDeck on the dock."},
        ],
    }


def _endpoint(host, port):
    host = host.strip()
    if not host or len(host) > 253 or not all(
        char in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-" for char in host
    ):
        raise ValueError("Invalid daemon address")
    port = int(port or DEFAULT_PORT)
    if not 1 <= port <= 65535:
        raise ValueError("Invalid daemon port")
    return host, port


def _valid_token(token):
    return isinstance(token, str) and len(token) == 32 and all(
        char in "0123456789abcdefABCDEF" for char in token
    )


def _stored_pairing():
    try:
        with open(PAIRING_PATH) as file:
            host = file.readline().strip()
            token = file.readline().strip()
            host, port = _endpoint(host, file.readline().strip())
    except (OSError, ValueError):
        return None
    return (host, port, token) if _valid_token(token) else None


async def _redeem(host, port, code):
    reader, writer = await asyncio.open_connection(host, port)
    try:
        payload = json.dumps({"code": code, "name": "Vobot Mini Dock", "kind": "vobot"}).encode()
        header = (
            "POST /pair HTTP/1.0\r\nHost: %s:%d\r\n"
            "Content-Type: application/json\r\nContent-Length: %d\r\nConnection: close\r\n\r\n"
        ) % (host, port, len(payload))
        writer.write(header.encode() + payload)
        await writer.drain()
        status = (await reader.readline()).split()
        if len(status) < 2 or status[1] != b"200":
            raise ValueError("Pairing code rejected")
        length = None
        for _ in range(24):
            line = await reader.readline()
            if line == b"\r\n":
                break
            if not line or len(line) > 1024:
                raise ValueError("Invalid pairing response")
            parts = line.split(b":", 1)
            if len(parts) == 2 and parts[0].lower() == b"content-length":
                length = int(parts[1].strip())
        else:
            raise ValueError("Invalid pairing headers")
        if length is not None and not 0 < length <= 1024:
            raise ValueError("Invalid pairing length")
        body = bytearray()
        limit = length if length is not None else 1025
        while len(body) < limit:
            chunk = await reader.read(limit - len(body))
            if not chunk:
                break
            body.extend(chunk)
        if len(body) > 1024 or (length is not None and len(body) != length):
            raise ValueError("Invalid pairing body")
        reply = json.loads(bytes(body).decode())
        if not isinstance(reply, dict) or not _valid_token(reply.get("token")):
            raise ValueError("Invalid pairing credential")
        host, port = _endpoint(host, reply.get("port", port))
        return host, port, reply["token"]
    finally:
        writer.close()
        await writer.wait_closed()


async def connection_settings(manager):
    config = manager.config() if manager else None
    config = config if isinstance(config, dict) else {}
    host = config.get("daemon_host") or ""
    code = config.get("pairing_code") or ""
    if not code:
        saved = _stored_pairing()
        if not host or (saved and _endpoint(host, config.get("daemon_port")) == saved[:2]):
            return saved
        return None

    host, port = _endpoint(host, config.get("daemon_port"))
    code = code.strip().replace(" ", "")
    if len(code) != 6 or not all(char in DIGITS for char in code):
        raise ValueError("Invalid pairing code")

    # Consume the web setting before the request so a failed code is never
    # replayed on app resume. Keep the long-lived token out of the web settings.
    config["pairing_code"] = ""
    manager.config(config)
    host, port, token = await asyncio.wait_for(_redeem(host, port, code), 5)
    temporary = PAIRING_PATH + ".new"
    with open(temporary, "w") as file:
        file.write("%s\n%s\n%d\n" % (host, token, port))
    os.rename(temporary, PAIRING_PATH)
    return host, port, token
