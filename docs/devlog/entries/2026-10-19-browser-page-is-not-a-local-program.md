# 2026-10-19 — Daemons: a browser page on this machine was trusted as a local program

**What was seen.** Both daemons admit a same-machine connection without the
pairing token (`isLocalConnection`, an IP test). A web page the user has open
connects from `127.0.0.1` as well, so it held everything a local program holds,
by three routes that need nothing unusual from the page:

- A WebSocket has no CORS. A page could open the daemon's socket, receive the
  session roster and timeline, and send device commands.
- A cross-origin POST with a `text/plain` body needs no preflight, and both
  daemons parse any body as JSON. A page could post hooks or `/shutdown`.
- With a host name that re-resolves to `127.0.0.1` (DNS rebinding), the page
  becomes same-origin with the daemon and can read `/health`, pairing token
  included.

The macOS app needed no rebinding at all. `HTTPServer.formatHTTPHeaders` wrote
`Access-Control-Allow-Origin: *` on every response, `/health` included, so any
page could read the token with one ordinary `fetch`. The Node APME API sent the
same header on every answer (prompts, task titles, verdicts), and so did a
session bridge's `/sse` stream.

**Why the docs did not catch it.** `docs/daemon.md` said `/setup-status` was
"the only route that answers with `Access-Control-Allow-Origin: *`", and the
Ulanzi Property Inspector's own comment said "the macOS app has always sent
ACAO". The intent was written down and the exception was known, but no test
pinned either. Now `HTTPCrossOriginTests` (Swift: no header unless a route opts
in) and the APME and `/sse` cases in `apme-http.test.ts`,
`apme-history-reader.test.ts` and `local-trust-servers.test.ts` pin them.

**The rule.** `shared/src/local-trust.ts`, generated into
`LocalTrustRules.generated.swift`. It reads two headers a page cannot set:

- `Host` must name this machine without asking the network: an IP literal,
  `localhost` or a `.localhost` name, or the machine's own mDNS name exactly as
  `gethostname` reports it. This defeats rebinding, because a rebinding page's
  `Host` is its own domain.
- On a WebSocket upgrade or a state-changing method, `Origin` must be one of
  three things. It may be absent, since local programs send none. It may be the
  daemon's own origin, port included, for the APME dashboard it serves. Or it
  may be `file://`, which the ESP32 WebSocket library (links2004) sends; a
  browser serialises an opaque origin as `null`, never as that. "Own origin"
  is this machine at the port the request was addressed to (its `Host`) or at
  the listening port, so the dashboard still posts through `ssh -L`.

A request that fails either check needs the token. Operator approval never
admits it, and it is never recorded as a pairing knock, because an approval for
a loopback address would hand trust to every page. A GET keeps trust whatever
its `Origin`, so the line between a page and an answer is
`Access-Control-Allow-Origin`. That header now goes only on routes with no
secret: `/setup-status`, Node `/display-state` and the Pixoo frame and stream.
No GET takes a privileged action. The GET side effects left are device
bookkeeping, such as feed-pull telemetry and a staged voice reply marked
fetched.

**Rejected.**

| Alternative | Why not |
|---|---|
| Require the token from every local client | Breaks the CLI, the hooks, both deck plugins and the one-token handover between daemons, and gains nothing against a local process, which can read `/health` anyway |
| Fix CORS only | A WebSocket upgrade and a simple POST never consult CORS |
| Check `Origin` only | A rebinding page's same-origin GET carries no `Origin` |
| `Sec-Fetch-Site` | Older WebViews omit it, so its absence proves nothing, and as an extra signal it would cut off the Ulanzi Property Inspector's cross-origin `/setup-status` read |
| Bind loopback only | LAN devices are the product; `--loopback` already exists for sites that want it |

**Compatibility, checked by code.** No first-party local client sends `Origin`:
the Stream Deck and Ulanzi plugins use Node's `ws`, which sends none by default,
and the Swift app uses `URLSession`. The Ulanzi Property Inspector reads with
GETs. The APME dashboard is same-origin, including its POSTs. ESP32 boards send
`Origin: file://`.

**What the adversarial review found before merge.** Two holes, both
reproduced, and three smaller defects.

- **A reflected XSS turned the rule's own exemption into a bypass.** A session
  bridge's `/status` wrote `?token=` unescaped into an inline script, and a
  same-machine navigation GET passes the rule (IP-literal `Host`, no `Origin`).
  Any site could navigate the browser to
  `http://127.0.0.1:912x/status?token=");…//` and run its script on the
  bridge's origin, which the rule treats as the bridge's own: POST `/hooks/*`
  and the bridge WebSocket (`send_prompt`, `select_option`) opened without a
  token, and a foreign-origin POST still got 401. The reviewer reproduced it
  against the built `HookServer` + `WsServer`. The bug was old; before this
  change no page needed it. `/status` now writes only the token the bridge
  issued, as a JSON string. The general rule: a script on a daemon's own
  origin holds its trust, so nothing it serves may reflect request input. The
  APME dashboard also had unescaped fields (model, agent, project, category,
  a test command, error messages); they go through `esc()` now.
- **A bare host name re-opened DNS rebinding.** `gethostname` returns
  `<name>.local`, and the rule also trusted `<name>`. macOS resolves a single
  label through the DNS search domains, not mDNS: on this machine the bare name
  resolved to a Tailscale address while `<name>.local` resolved to its own,
  `127.0.0.1` included. Whoever runs the network (a rogue Wi-Fi's DHCP and DNS;
  the name leaks through DHCP option 12 and the daemon's mDNS name) can serve
  `http://<name>:9120/` and rebind the name to `127.0.0.1`. Only the exact
  `.local` name is trusted now; nothing is derived from a bare or fully
  qualified one, since another machine can claim a `.local` name this one does
  not answer. `*.localhost` stays: Chrome and Firefox never ask DNS for it, and
  macOS's resolver answers `agentdeck-probe.localhost` with `127.0.0.1` and
  `::1` (checked with `dscacheutil`, 2026-10-19).
- **Nothing tested the Swift wiring.** Reverting the HTTP policy to plain
  same-machine trust, or deleting the handshake's `Origin` check, left the
  Swift suite green. The policy body moved into
  `DaemonServer.accessPolicyResponse`, which the installed closure calls, and
  `LocalTrustWiringTests` drives it and a real WebSocket handshake over a
  loopback socket.
- **The two evaluators disagreed off ASCII.** Swift's digit test used
  `Character`, so `localhost:8` plus a combining mark passed there and failed
  in TS (138 of 10,514 fuzzed cases, all that one shape). The Swift template
  now reads Unicode scalars, and both sides trim and fold case as ASCII only:
  JS `trim` takes a byte-order mark where Swift's set takes NEL, and either
  difference let one daemon read an `Origin` as empty. The TS lookup of a
  scheme's default port also found `Object.prototype.constructor` for
  `constructor://`; it checks own keys now. Vectors pin all three.
- **A port forward broke the dashboard's POSTs**, because "own origin" meant
  the listening port. It now also means the port the request was addressed to.

The Swift daemon's upgrade detection searched the whole request, body
included, so a hook POST whose JSON quoted `Upgrade: websocket` went down the
upgrade path and was dropped. It reads the headers only now.

**Known limits.**

- A `.local` name that differs from `gethostname()` (a Bonjour name the user
  renamed) is not recognised, so a browser using it needs the token, and a
  machine whose `gethostname()` is a DNS name has no trusted `.local` name.
- Docker's `host.docker.internal` likewise needs the token.
- Browsers serialise an IPv4-mapped origin in hex (`[::ffff:7f00:1]`), which
  is not matched as a local address.

**Not done here.** A token a page already read stays valid until it is rotated.
`agentdeck token rotate` does that for the CLI daemon, but the macOS app has no
rotation action of its own.
