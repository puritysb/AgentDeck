# 2026-09-26 — Round AMOLED lost both transports; link observability

## Incident

The round AMOLED (`round_amoled` 1.4.0, `/dev/cu.usbmodem211201`, 192.168.68.55) showed missing creatures and usage, as if its connection were unstable. It was not rebooting: uptime had been 354,346 s with no `reboot observed` line. Both transports were failing at once:

- **Wi-Fi:** 78–80% ICMP loss with RTT up to 3.3 s, against 0–15% on four other boards at the same moment. Routing and ARP on the Mac were identical for all of them. The daemon held no TCP socket to the board for long stretches, and `esp32Wifi.stale` (over 90 s silent) kept recurring. Over 2026-09-21 → 24 the board came back from staleness 27–33 times a day.
- **USB:** the port opened and host→board writes succeeded, but the board sent nothing back, not even to a direct `device_info_request`. The health view's serial `deviceInfo` was the cache seed (uptime frozen), not a live read. The daemon recycled the port as half-open every 120 s and denylisted it for 10 minutes after three strikes. All of this was logged at debug level only.

Replugging USB power-cycled the board (`reset=poweron`), and serial answered at once. So the USB silence was a board-side HWCDC transmit wedge that a host-side reopen cannot clear on a native-USB board. Ping loss fell to 37% after the reboot, still the worst on the network (the peer read 17% then), so the radio link itself is weak where the board sits.

## Changes

- `device_info` carries `rssiDbm` (WiFi.RSSI(), only while associated) from both firmware ladders. The daemon keeps it on serial and Wi-Fi records, exposes it in `/health` `esp32Wifi` and `/devices`, and prints it in `agentdeck devices`. A weak radio can now be told apart from a daemon fault without ping sweeps.
- The serial half-open recycle and the denylist of a port that was previously identified as an AgentDeck board now log at info level. A foreign device's denylist stays at debug.

## Validation and delivery scope

`pnpm build`, `pnpm typecheck` and `pnpm test` pass; `generate-protocol` leaves no drift. Firmware compiled for amoled, ttgo, led8x32, ips10 and esp32_c6_147. No board was flashed, and the Swift daemon does not yet surface `rssiDbm`.
