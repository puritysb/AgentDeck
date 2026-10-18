# 2026-10-18 — ESP32: the mDNS responder outlived a radio park and crashed the next join

**What was seen.** During the 1.9.2 fleet refresh, the 86 Box (on USB serial,
radio parked) panicked at 19:19:17.9Z, `LoadProhibited` at `EXCVADDR
0x8000018f`, 2.1 s after the daemon sent it a `wifi_provision`. Decoded
against a local build of `c0f0c5e4`, whose code bytes match the release at
every backtrace PC, the crash is in the IDF mDNS service task:
`esp_netif_is_netif_up` ← `join_group` ← `pcb_if_init_lwip` ←
`mdns_priv_if_init` ← `mdns_priv_pcb_enable` ← `service_task`. The daemon log
shows two provisions:
- 19:16:26: the board had just been USB-flashed (fresh NVS). It joined at
  19:16:28 and parked again.
- 19:19:15.8: the daemon reopened every serial port and provisioned it again.
  Two seconds of association and DHCP later, the board panicked.

**Why the second provision happened.** On boards without the `adwifi` store
(everything except IPS10, the T-Display-S3-Pro and the two e-ink panels),
`wifiConfigured()` is `WiFi.SSID().length() > 0`. arduino-esp32 3.3.11's
`STAClass::SSID()` returns the SSID of the AP the board is associated with, so
a parked board reports itself unconfigured. The daemon auto-provisions an
unconfigured serial board once per connection
([bridge/src/esp32-serial.ts](bridge/src/esp32-serial.ts)
`shouldSendWifiProvision`). So every daemon restart, serial reopen or lease
resume turns each parked board's radio on, joins, and parks again.

**Why the join crashed.**
- **Netifs are destroyed.** arduino-esp32 3.3.11 `WiFi.mode(WIFI_OFF)` runs
  `espWiFiStop()` → `wifiLowLevelDeinit()`, which destroys both default
  netifs. The next `WIFI_STA` creates new ones.
- **mDNS keeps the old pointers.** The mDNS component (1.11.3) caches each
  netif pointer when it looks one up (`mdns_priv_get_esp_netif`), and
  `mdns_init()` looks up every interface that exists. The cache is dropped
  only by `mdns_priv_pcb_disable()`, which runs on `STA_DISCONNECTED` or
  `AP_STOP`.
- **A park can leave the cache stale in two ways:**
  - An STA that never associated (a fresh-NVS boot) sends no disconnect.
  - When one does, the disable runs on the mDNS task (priority 1, CPU0,
    internal RAM). Its deinit path (`pcb_if_deinit` → `join_group`) looks the
    netif up again while `esp_wifi_stop()` is still running, so it can
    re-cache the netif that the destroy then frees.
- **The crash.** The next join's `IP_EVENT_STA_GOT_IP` enables the STA socket
  through the dead pointer. Whether that crashes depends on whether the new
  netif landed at the old address: the first provision survived, the second
  did not.
- **Which variant hit 86 Box** is not visible in the log; the fix removes both.
- **`mdns_free()`** walks the same cache, so stopping mDNS after `WIFI_OFF`
  crashes the same way.

**Fix.** The responder lives only while the STA has an address:
- `mdnsPoll()` starts it on demand, and the boot-time `mdnsInit()` call is
  gone.
- Every `WIFI_OFF` in
  [esp32/src/net/wifi_manager.cpp](esp32/src/net/wifi_manager.cpp) goes
  through `radioOff()`, which calls `Net::mdnsStop()` first. `wifiReset()`
  does the same before `resetSettings()` turns WiFi off on its way to the
  restart.
- A `MDNS.begin()` that fails after `mdns_init()` succeeded is ended rather
  than left running untracked.

Because the responder's task stack and allocations come from internal RAM
(`CONFIG_MDNS_TASK_CREATE_FROM_INTERNAL`, `CONFIG_MDNS_MEMORY_ALLOC_INTERNAL`),
a board parked behind USB no longer holds them.

**Rejected alternatives.**
- **Deferring the join of a serial-time provision on every board**, as the
  T-Display-S3-Pro and the e-ink panels do. That removes the provision
  trigger but not the restore path, where serial drops, the radio rejoins,
  and `GOT_IP` meets a cache that survived the park. It would also turn every
  board's provision ack into a save receipt.
- **Parking with `WiFi.disconnect()` instead of `WIFI_OFF`**, as IPS10 does
  for its hosted radio. The netifs survive, but the radio stays powered,
  which is what parking exists to stop.
- **Telling mDNS about each interface around the park**
  (`mdns_netif_action`, re-registering). That depends on cache semantics
  internal to the component, and it still races the asynchronous action queue
  against a synchronous destroy.

**Measured after.** All twelve production envs compile. The 86 Box ran this
branch's build (`de8800ee-dirty`, delivered by WiFi OTA) through the
transitions that had crashed it. I drove them over its own USB port while a
serial-suspend lease kept the daemon off the port, 19:54–19:59Z:
- **Transitions.** Six `wifi_provision`s while parked, plus a restore when
  serial went silent at the start and another at the end: 7 parks and 8 joins.
- **Order.** Every park logged `[mDNS] Stopped` about 0.1 s before `radio
  parked`. Every join logged `[mDNS] Started` as the association landed, and
  the daemon was found 3.1 s later each time.
- **No reboot.** The board's `heartbeat_ack` uptime advanced 199 s across the
  199 s between the first and last ack.
- **Heap.** Parked afterwards, its free internal heap read 73 KB, against
  68 KB parked on `c0f0c5e4` before the update. That is not a controlled
  comparison, but the difference matches the responder's 4 KB task stack plus
  its allocations.

The run does not discriminate. The release build had survived the first of
its two provisions, and none of the boards still on `c0f0c5e4` panicked when
the end of the same lease made the daemon re-provision seven of them at
20:00:21. The outcome of a use-after-free depends on heap reuse, so the
evidence that the crash is gone is the ordering above, not the absence of a
crash.

[scripts/__tests__/esp32-radio-off.test.ts](scripts/__tests__/esp32-radio-off.test.ts)
fails if any firmware source turns the radio off outside `radioOff()`, or if
`radioOff()` stops being the place where mDNS is stopped first. Master's
`wifi_manager.cpp` has six such calls.

That re-provision also took t_embed's lowest-ever free internal heap to 1 KB;
ips_35's already read 0. Those two boards bring WiFi up at the edge of
internal RAM, which is the next item.

**Left open.**
- **Re-provisioning on every reconnect.** It is also how a changed WiFi
  network reaches a parked board today: `agentdeck wifi-setup` only saves the
  config and relies on auto-provision. Reporting saved credentials as
  configured needs a daemon-side "credentials changed" signal first.
- **The rest of the desk fleet** still runs `c0f0c5e4` until the next ESP32
  release round.
