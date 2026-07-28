#pragma once
#include <stddef.h>
#include <stdint.h>

namespace Net {

/**
 * Initialize WiFi.
 * Tries saved credentials first (8s timeout).
 * If no saved WiFi, starts AP portal "AgentDeck-Setup" (non-blocking).
 * Serial JSON connection works regardless of WiFi state.
 */
void wifiInit();

/**
 * Process WiFiManager portal (call from network loop if portal active).
 */
void wifiLoop();

/**
 * Check WiFi connection status.
 */
bool wifiConnected();

/**
 * Check whether this board has saved WiFi credentials.
 */
bool wifiConfigured();

/**
 * Connect to a specific WiFi network using provided credentials.
 * Saves credentials to WiFiManager for future auto-connect.
 * Blocks up to 10 seconds waiting for connection.
 * Returns true on success.
 */
bool wifiConnectWith(const char* ssid, const char* password);

#if defined(BOARD_T_DISPLAY_PRO)
/**
 * Bring WiFi up after the boot deferral: daemon-provisioned "adwifi"
 * credentials first, then legacy WiFiManager storage. Returns false (and
 * turns the radio back off) when there is nothing to join. Blocking up to the
 * connect timeout — call only from networkTask once serial is known dead.
 */
bool wifiTryDeferredJoin();
#endif

/**
 * Persist daemon-provisioned WiFi credentials without changing radio state.
 * Used by IPS10 when USB serial is primary and the hosted WiFi radio is parked.
 */
void wifiSaveProvisionedCredentials(const char* ssid, const char* password);

/**
 * Store/load a daemon bridge endpoint learned during serial WiFi provisioning.
 * On IPS10 this lets a WiFi-only boot connect directly without waiting for mDNS.
 */
void wifiSaveProvisionedBridge(const char* ip, uint16_t port, const char* token);
bool wifiLoadProvisionedBridge(char* ip, size_t ipLen, uint16_t* port, char* token, size_t tokenLen);

/**
 * True when firmware intentionally powered WiFi down because another transport
 * is primary. Distinguishes "offline by design" from connection loss.
 */
bool wifiRadioParked();

/**
 * Reset saved WiFi credentials and restart AP portal.
 */
void wifiReset();

/**
 * Get local IP address as string.
 */
const char* wifiLocalIP();

/**
 * Park (true) or restore (false) WiFi while USB serial is primary. Most boards
 * power the radio off (WIFI_OFF). ESP32-P4/C6 IPS10 keeps ESP-Hosted initialized
 * and only disassociates STA, because deinitializing the hosted SDIO transport
 * while RX is in flight can assert. Restoring reconnects to the saved AP.
 */
void wifiSetRadioParked(bool parked);

}  // namespace Net
