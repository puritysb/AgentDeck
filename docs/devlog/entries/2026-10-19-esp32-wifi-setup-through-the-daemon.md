# 2026-10-19 — ESP32 Wi-Fi setup: the macOS sheet never reached a board

**What was there.** Three paths set ESP32 Wi-Fi credentials, and none of them
reached a board when the user expected.

- The macOS sheet (Settings → ESP32 & Pixoo → ESP32 boards → Set up…) wrote
  `{"type":"wifi.config",…}` to the first `/dev/cu.*` that matched an ESP32
  USB-UART pattern. No firmware handles that type. `esp32/src/net/protocol.cpp`
  dispatches `wifi_provision`. The port was one the app's own daemon already
  held, since `ESP32Serial` opens every matching port, and two readers on one
  macOS tty steal each other's bytes. The sheet's comment said verification
  "happens via mDNS rediscovery". Nothing could be verified, because the board
  never acted on the frame.
- The app's daemon read `WifiConfigManager.load()` on each board's
  `device_info`, but nothing in the app called `save()`. Its automatic
  provisioning had no credentials unless someone wrote the container file by
  hand.
- `agentdeck wifi-setup` wrote `~/.agentdeck/wifi-config.json`, which only the
  Node daemon reads. The docs said a change applied "on its next serial
  `device_info` after the daemon restarts", and it never reached a Swift
  daemon.

**What changed.** Both daemons serve `GET`/`POST /esp32/wifi`. The gate is
loopback plus the pairing token as a bearer, the `/integrations/zai` rule. A
`POST` checks the credentials with a rule shared through the provision SSOT and
saves them where that daemon reads them. It then sends them to every live serial
board as an operator request. The provision decision gets `manual`, which
lifts the one-provision-per-connection cap and the legacy fallback, and nothing
else. Each connection records the board's `wifi_provision_ack`, and a `GET`
reports it. The sheet and the CLI both call the route on the daemon that holds
the port. Contract: [docs/esp32.md](docs/esp32.md#setting-the-credentials-esp32wifi).

**What an adversarial review of the first version found.**

- The sheet said "Joined Wi-Fi at <ip>" for any successful ack. A
  serial-primary board (T-Display-S3-Pro, the e-ink panels, an IPS10 without
  voice) only saves the credentials while it is on USB, and its ack carried
  whatever address an earlier join had left in the firmware's buffer. The ack
  now says `joined`, and carries an address only for a join. Older firmware
  does not say, and the sheet then claims only that the board accepted them.
- A board answers provisions in order and names none, so an ack for an earlier
  provision could be shown as the answer to a later one. Each connection now
  counts the acks it is owed, and the count expires after 30 s.
- The Swift daemon cached the config it last read, so a file written while it
  stood down was not seen until the app restarted. Both daemons now read the
  file on every `device_info`.
- An operator request re-provisioned an IPS10 whose radio was up (the Node
  endpoint refresh). That is the automatic path's job, so a request no longer
  makes one.
- The CLI sent the password to whatever answered on the registered port. It
  now requires that port's `/health` to report the registered pid.

**Rejected alternatives.**

- *Keep the sheet's serial write and send `wifi_provision` instead.* It would
  still race the daemon on a port the daemon holds, and the daemon would still
  have nothing saved for a board plugged in later. The serial-suspend lease is
  for flashing, and taking every port away from the daemon for one line would
  drop each board's state link to set its Wi-Fi.
- *Let the CLI find the daemon by probing ports.* A blind probe of the default
  port can answer with another account's daemon, and this request carries the
  Wi-Fi password. The CLI uses this user's registry or an explicit `--port`.
  With neither, it writes the file only and says that the macOS app keeps its
  own copy.
- *Same-machine trust alone as the gate.* A local program could then replace
  the network every board joins while holding nothing. The bearer does not shut
  that out either, since a local program can read the token from the daemon's
  loopback `/health`. It does keep out a browser page, which reaches the port
  from 127.0.0.1 and has been judged as a LAN peer since #583. Loopback keeps
  out the token's other holders, the paired LAN devices.
- *Have the board name the provision it answers.* Every board in the field
  answers without an id, and in order. Counting what each connection is owed
  works with all of them.

**Parity traps found while porting the route to Swift.** Each is now a vector in
`shared/esp32-wifi-setup-vectors.json`.

- `as? Bool` on a `JSONSerialization` value accepts the number `1`, through
  NSNumber bridging. Node's `=== true` does not. Both the ack's `success` and
  the request's `autoProvision` now check for a CFBoolean.
- `hasPrefix("Bearer ")` compares graphemes, so a combining mark after the space
  folds into it. The scheme is now compared by Unicode scalar, as Node compares
  UTF-16 units.
- Clipping a board's text to N UTF-16 units with JS `slice` can split a
  surrogate pair. The lone half that results is something a Swift `String`
  cannot hold, so the two daemons could not answer alike. Both now back off one
  unit.
- The request body, measured on macOS 26 by the `bodies` vectors: Foundation's
  `JSONSerialization` accepts a comma before a closing bracket and keeps the
  first of two equal keys, while `JSON.parse` refuses the comma and keeps the
  last. The same request could therefore save different credentials, or none,
  depending on which daemon held the port. Both daemons now refuse either one.
  Both had also decoded bytes that were not UTF-8 by replacing them, and the two
  decoders do not replace alike. Such bytes are now refused too.

**Not covered.** No board has been driven through the new route yet. The owner
deferred device checks, and the tests cover the decision, the route and the
sheet's wording. The firmware's `joined` was compiled for `ttgo` and
`t_display_pro` and not flashed. The session bridge's `wifi_provision` handler
in `bridge/src/index.ts` is unreachable, since session bridges never open
serial. `bridge/src/wifi-config.ts` ignores `AGENTDECK_DATA_DIR`. The Swift
HTTP server decoded a whole request as UTF-8 and read one that failed as
`GET /`, so a non-UTF-8 body never reached that daemon's route. Nothing was
saved either way, but the status differed from Node's 400. Fixed the same day:
[the parser entry](docs/devlog/entries/2026-10-19-swift-http-parser-reads-only-the-head-as-text.md).
