#pragma once

#include <cstddef>

namespace Protocol {

/**
 * Parse an incoming JSON message from the bridge WebSocket.
 * Updates g_state accordingly (thread-safe via mutex).
 */
void parseMessage(const char* json, size_t length);

/**
 * Emit device_info (board / version / buildHash / wifi) on every available
 * transport. Serial-attached boards answer device_info_request with this; a
 * WiFi-only board (e.g. TRMNL 7.5") calls it on WS connect so the daemon can
 * register the device without a USB cable.
 */
void announceDeviceInfo();

}  // namespace Protocol
