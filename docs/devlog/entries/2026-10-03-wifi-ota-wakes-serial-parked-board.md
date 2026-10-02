# 2026-10-03 — WiFi OTA wakes a board parked on USB serial

### Measured

The fleet OTA after #436 failed for `trmnl_75` with `No online WiFi ESP32 target matches "trmnl_75"`, and `t_display_pro` failed the same way. Both were open on USB serial. Every board except IPS10 and TC001 parks its WiFi radio once serial has been stable for 4 s (`esp32/src/main.cpp`), so the daemon had no WiFi socket to push to. The fallback was a USB flash, which left the TRMNL in its download node until it was reset by hand. Suspending serial with the flash lease (`POST /esp32/serial/suspend`, 180 s) brought the TRMNL onto WiFi (`rssi -22dBm @ 192.168.68.62`, ping 2.7 ms), but that lease releases all 11 serial boards.

### Change

`performWifiEsp32Ota` (Node) and `ESP32WifiOtaManager.performOta` (Swift) first check for a live WiFi target. If there is none, they close only the matching board's serial port (`holdESP32SerialBoard` / `ESP32Serial.holdBoard`; the poll loop skips a held port), wait up to 120 s for the board to register over WiFi (30 s serial timeout + association + mDNS + WS), transfer, and release the hold in a `finally`. The hold lasts 30 minutes, so it outlasts any transfer: a port reopened mid-OTA would re-park the radio under the transfer. It lives in memory, so a daemon restart reopens everything. Regression tests: `bridge/src/__tests__/esp32-wifi-ota-serial-wake.test.ts` and `ESP32WifiOtaSerialWakeTests` in `apple/AgentDeckTests/ESP32WifiForwardTests.swift`.
