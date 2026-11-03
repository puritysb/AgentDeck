#pragma once
#include <cstddef>
#include <cstdint>
#include "transport_auth_policy.generated.h"

// No allocation or credential erasure. Network silence and non-auth closes are
// unknown, not evidence of an invalid token. Only trusted provisioning retries
// the same rejected credential; discovery never authorizes a pairing change.
struct WsAuthRecovery {
    bool required = false;
    void closeFrame(const uint8_t* payload, size_t length) {
        if (payload && length >= 2 &&
            ((uint16_t(payload[0]) << 8) | payload[1]) == TransportAuthPolicy::websocketUnauthorized) required = true;
    }
    void httpStatus(uint16_t code) {
        if (code == TransportAuthPolicy::httpUnauthorized) required = true;
    }
    void provisioned() { required = false; }
};
