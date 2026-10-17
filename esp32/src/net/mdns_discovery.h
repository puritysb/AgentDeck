#pragma once

#include <cstdint>

namespace Net {

struct BridgeInfo {
    char ip[16];
    uint16_t port;
    char token[40];
    char project[40];
    char agent[16];
    bool found;
};

/**
 * Start the mDNS responder. Idempotent, and only meaningful while the STA has
 * an address: mdnsPoll() calls it on demand, so nothing else needs to.
 */
void mdnsInit();

/**
 * Stop the mDNS responder. Must run BEFORE anything that destroys the WiFi
 * netifs (WIFI_OFF), never after — see mdns_discovery.cpp.
 */
void mdnsStop();

/**
 * Poll for discovered bridges, starting the responder on first use. Call only
 * while the STA is connected and the radio is not parked.
 * Returns true if a new bridge was found since last call.
 */
bool mdnsPoll(BridgeInfo& out);

/**
 * Force a fresh mDNS query.
 */
void mdnsRefresh();

}  // namespace Net
