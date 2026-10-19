# 2026-10-19 — Swift HTTP parser: a body that was not UTF-8 turned the request into `GET /`

**What was there.** `HTTPServer.parseHTTPRequest` decoded the whole request,
body included, with `String(data:encoding: .utf8) ?? ""`. When the body was not
UTF-8, the empty fallback became a request line that the parser then read as
method `GET`, path `/`, with no headers. The body bytes were still sliced
correctly, but no route ever saw them. Two routes were affected:

- `/otel/v1/traces` is documented to answer 415 when Codex ignores the
  configured JSON protocol and sends protobuf. A protobuf batch is almost never
  valid UTF-8, so the 415 was unreachable.
- `POST /esp32/wifi` refuses a body that is not UTF-8 with 400 `invalid-body`
  on both daemons ([the route's entry](docs/devlog/entries/2026-10-19-esp32-wifi-setup-through-the-daemon.md)).
  On the Swift daemon such a body never arrived. Nothing was saved, but the
  status differed from Node's.

The listener already found the end of the head as raw bytes
(`completeRequestIfReady`) and sliced the body from raw bytes too. Only this
decode treated the request as one string.

**Measured: Node's parser** (Node 26.5, raw bytes over a socket to
`http.createServer`):

| Request | Node |
|---|---|
| Binary body (`0a ff fe 00 01`) | Routed; all 5 bytes reach the handler |
| `0xff` in a header value | Routed; the value is read as latin1 (`vÿ`) |
| UTF-8 in a header value | Routed; the value is latin1 mojibake, not UTF-8 |
| `0xff` in the request target | 400 `HPE_INVALID_URL` |

**Now.** The parser decodes only the bytes before the first `\r\n\r\n`. A head
that is UTF-8 reads as before. A head that is not is read as Latin-1, byte for
byte, which is how Node reads header values. A request target with such a byte
then matches no route (404), where Node answers 400. Both refuse it, and no
request becomes another request.

**Rejected:**

- Answering 400 for a head that is not UTF-8. Node accepts such a header value,
  so a 400 would only move the difference between the daemons somewhere else.
- Keeping the `GET /` fallback for the head alone. That fallback is what
  dropped every header, including the `Host` and `Origin` that the local-trust
  policy reads.

**Security check.** Any request the fix now routes, a client could already send
with a UTF-8 body or head. The access policy runs on the request's real headers,
as it does for every other request. Before the fix, such a request reached only
`GET /`, with its headers dropped.

Gates: `HTTPServerParseTests` (a binary body routes and keeps its bytes, a
Latin-1 head, a UTF-8 head), and `ESP32WifiSetupTests` (a non-UTF-8 body
reaches the Wi-Fi route and gets 400 `invalid-body`).
