# 2026-10-18 — A parked ESP32 says which WiFi credentials it holds

The mDNS panic fix of the same day ([entry](docs/devlog/entries/2026-10-18-esp32-mdns-stale-netif-panic.md))
found that a board parked on USB serial was re-provisioned on every daemon serial reopen. The
daemons decided from `device_info.wifiConfigured`, and that field cannot answer the question:

- A parked board has its WiFi driver off, so `WiFi.SSID()` is empty and it reported `false`.
  Every serial reopen, lease resume and daemon restart sent it the credentials it already held.
  On most boards a provision joins the AP, which wakes a radio that the firmware's own parking
  policy then has to put back to sleep.
- A board that persists a provision for a later join (the `adwifi` store: IPS10,
  T-Display-S3-Pro, NM-EPD-420, EPD47) reported `true` from that store. The Node daemon therefore
  never sent it changed credentials.

Both failures come from the same missing answer: does this board hold the credentials this
daemon would send? A provision now carries `credId`, the first 16 hex characters of HMAC-SHA256
keyed by the pairing token, over `agentdeck-wifi-cred-v1` NUL SSID NUL password. The board stores
the id beside the credentials it came with and reports it as `device_info.wifiCredId` on serial.
The decision is `shared/src/esp32-wifi-provision.ts`; the rule is described in
[docs/esp32.md](docs/esp32.md#which-boards-get-a-wifi-provision).

## Rejected alternatives

- **An unsalted hash of SSID and password.** Anyone who sees the hash can test password guesses
  offline: a device cache file, `/devices`, a serial log, a sniffed frame. A keyed HMAC needs the
  token as well. The token can be read off loopback `/health` by any local process, so the id is
  also kept off WiFi, `/devices` and `esp32-device-cache.json`; it lives on the serial line and in
  the board's NVS only.
- **An id of the SSID alone.** After a password change the board would still read as a match and
  never receive the new password.
- **A ledger in the daemon** ("I sent board B credentials C"). A daemon cannot see a board being
  wiped, reflashed, reconfigured through the captive portal or swapped onto the same tty. Only
  the board knows what it holds.
- **Reporting `wifiConfigured: true` while parked.** Every daemon already in the field would then
  skip parked boards (its rule leaves a configured board alone), and changed credentials would
  stop reaching every board, not just the four persisted ones.

## Decisions beyond the brief, and why

- **The firmware forgets the old id before writing different credentials, and records the new
  one after.** The failure that matters is asymmetric. A missing id costs one redundant
  provision. A stale id that names credentials the board no longer holds means the daemon never
  sends the ones it needs. So a reset between the two NVS writes must leave no id, and when the
  old id cannot be cleared the credentials it would describe are not written (`beforeWrite`
  returns false). A board that writes before it joins then acks `credentials not saved`. The
  IPS10 joins first and saves after, so there a refused clear keeps the saved credentials and
  their id, and the ack reports the join. A board whose NVS refuses that write cannot keep its
  pairing token across a reboot either, so the refusal costs nothing that worked. Forgetting does not trust a failed read: an unreadable record is cleared, not
  taken for an absent one. The write order lives in a header-only store
  (`esp32/src/net/wifi_cred_id_store.h`) so that it runs in the host tests; `wifi_manager.cpp`
  only supplies the NVS backend.
- **The captive portal clears the id from WiFiManager's own save hook.**
  `setPreSaveConfigCallback` fires in `handleWifiSave` before WiFiManager writes what was typed,
  which covers a wrong password that never joins. The first version cleared the id whenever the
  portal opened and again when it connected. Opening also happens when a board boots out of range
  of its saved AP, with the credentials (and so the id) unchanged; connecting also happens when
  the driver later joins with a provision's own credentials. Both cost a redundant provision. At
  boot the id is now cleared only when nothing is saved (`getWiFiIsSaved()`). The portal's
  erase button reboots the board, which then boots with nothing saved.
- **The store keeps no copy of the id; every call reads NVS.** The first version cached it in a
  17-byte static and `ttgo` stopped linking: `dram0_0_seg` overflowed by 32 bytes, and `nm` found
  the store (24 bytes) and its backend (1 byte) to be the only new static data. Stateless, the
  change adds 0 bytes of static data across all 817 ttgo objects (`nm`, per object, against a build
  of the parent commit). That parent — master plus the #565 and #566 branches — overflowed
  `dram0_0_seg` by 8 bytes on its own. With #579 merged, ttgo links on this branch with 1,016 B of
  static DRAM left, the same as master. The read
  now runs on every `device_info`, so it uses plain `nvs_open`/`nvs_get_str`: `Preferences::begin`
  logs an error for a missing namespace, which is what a board that was never provisioned has.
- **Generic boards record the id after the `WiFi.begin` call, whether or not the join
  succeeds, and only when the driver stores to flash.** `WiFi.begin` writes the driver config
  before connecting, and that config is what these boards rejoin. In Arduino-ESP32 3.3.11,
  though, `WiFi.persistent()` only sets a flag that `wifiLowLevelInit` reads when the driver
  starts, and with it false the driver runs on `WIFI_STORAGE_RAM`. WiFiManager's portal save
  (`wifiConnectNew`) leaves it false until the portal closes. A board that saved a wrong password
  in the portal and was then parked would restart its radio on RAM storage, and the next
  provision would land in RAM only: gone at reboot, while the id named it. The firmware now calls
  `esp_wifi_set_storage(WIFI_STORAGE_FLASH)` on the running driver before `WiFi.begin`, which
  also makes that provision survive a reboot at all, and records the id only when both calls
  succeeded. A `WL_CONNECT_FAILED` return also covers failures after the config was written,
  which errs in the safe direction. Persisted boards record it only once the `adwifi` credentials
  are saved, because that store is what they join first.
- **Each daemon keeps its own rule where the id cannot decide** (old firmware, or a daemon with no
  id to offer). Node keeps "skip a board reporting `wifiConfigured`". Swift keeps "once per port
  per credential set per app lifetime" (`provisionFingerprintsByPort`, now consulted only on that
  path). If Swift adopted Node's rule, changed credentials would stop reaching old persisted
  boards. If Node adopted Swift's, a parked board would be re-provisioned on every reopen. The
  vectors pin the shared decision; `ESP32Serial.shouldSendWifiProvision` pins Swift's fallback.
- **The Node-only IPS10 endpoint refresh became an input** (`refreshIps10Endpoint`), so the Swift
  daemon still never does it. `auth_provision` already carries the endpoint, and on that board a
  provision is a full WiFi rejoin.
- **Neither daemon writes WiFi credentials before a board identifies on the current connection.**
  The Swift daemon previously provisioned unidentified ports. The Node daemon accepted a
  `device_info` seeded from `esp32-device-cache.json`, which may describe a board since wiped or
  replaced. The board's own `device_info` re-runs the fan-out, since the handler runs after the
  record is set. The pairing-token re-arm (`auth_provision`) waits for the same identify.
- **The full-provision fallback for an unacknowledged token re-arm goes only to firmware that
  reports no credential id.** Both daemons resend a `wifi_provision` when `auth_provision` is not
  acknowledged, for firmware too old to know that message. Firmware that reports `wifiCredId`
  knows it, so its silence is a lost frame, and a full provision would wake a parked radio. For
  firmware that knows neither, the fallback can still be a second provision on one connection,
  after the one its `device_info` triggered. Skipping it when a provision was already sent was
  rejected: that provision may carry the token from before a rotation, and the fallback exists
  to deliver the new one. Skipping it only when that provision carried the current token would
  keep the rotation case; it is left for if firmware that old still matters. The bound also
  differs by daemon: the Node daemon remembers each port until it restarts, while the Swift
  daemon's state belongs to the connection, so such firmware gets the fallback again on each
  serial reopen there. That predates this change.
- **A firmware downgrade can still leave a stale id; it is documented, not fixed.** Firmware that
  predates the id changes credentials without touching `adwifi`/`cred_id`, so a board taken
  down to such a build, given other credentials there and flashed back reports an id for
  credentials it no longer holds, and a daemon whose credentials and token still produce that
  id skips it. Recovery is any change of the daemon's credentials or token, the portal, or a
  WiFi reset. The fix, a fingerprint of the stored credentials kept beside the id and compared
  at boot, needs another NVS key and a boot-time read of the driver config on every board, for
  a path that takes a downgrade, a credential change and an upgrade back. One rarer path has the
  same effect: an NVS write that fails inside the portal's pre-save hook, whose result cannot
  stop WiFiManager's own save.
- **A Swift-provisioned TC001 loses a provision it used to get by accident.** The Swift daemon
  provisioned every port, identified or not, and TC001's CH340 TX is broken in hardware, so its
  `device_info` never arrives. It now stays unprovisioned by the Swift daemon, the same as under
  the Node daemon. Its manual path, `ESP32ProvisionSheet`, sends `type: "wifi.config"`, which no
  firmware handles; that sheet was already broken and is left for a follow-up.
- **The serial `device_info` builder in `serial_client.cpp` gained the measured-buffer growth
  path from `protocol.cpp`.** The id adds 32 bytes, and a fully loaded t_display_pro frame then
  comes within a few bytes of the 896-byte stack buffer. `serializeJson` truncates silently, which
  would make the frame unparseable and the board unidentifiable.

## Not measured

No board was flashed for this change, and the hardware check is still to come. A parked board
reopened on serial should log `credentials-match` at Node debug level instead of sending a
`wifi_provision`, and `adwifi`/`cred_id` should hold the id. The design assumes both daemons on
one machine serve the same pairing token. If they diverged, each would re-provision a board the
other had provisioned, once per connection, and only when serial ownership changed hands.
