// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/esp32-wifi-provision.ts
// Regenerate: pnpm generate-esp32-wifi-provision-rules (drift gated by shared/src/__tests__/esp32-wifi-provision-sync.test.ts)
#pragma once
#include <stddef.h>

// The credential id a `wifi_provision` carries (`credId`). Opaque here: the
// board never computes one, it only remembers which provision its stored
// credentials came from and reports it back as `device_info.wifiCredId`.
namespace WifiCredId {

// Hex characters in an id the daemon sends; the store is sized for this.
constexpr size_t HEX_LENGTH = 16;

// A storable id: 1..HEX_LENGTH lowercase hex digits. Anything else is
// refused, and the caller treats it like a provision that carried no id.
inline bool valid(const char* id) {
    if (id == nullptr || id[0] == '\0') return false;
    for (size_t i = 0; id[i] != '\0'; i++) {
        if (i >= HEX_LENGTH) return false;
        const char c = id[i];
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    }
    return true;
}

}  // namespace WifiCredId
