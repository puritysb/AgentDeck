#pragma once
#include <stddef.h>
#include <string.h>
#include "wifi_cred_id.generated.h"

// The board's record of which `wifi_provision` its stored WiFi credentials came
// from (`credId`, reported back as `device_info.wifiCredId`). Header-only over a
// two-call storage backend so the ordering below runs in the host tests
// (esp32/sim/tests/wifi_cred_id_test.cpp); wifi_manager.cpp backs it with NVS.
// Stateless: every call reads storage, so the record costs no static DRAM
// (ttgo's dram0_0_seg had no room for even a 17-byte mirror), and nothing is
// allocated. C++11 (led8x32 builds at gnu++11).
//
// The rule every write keeps: the record may be missing while the board does
// hold the daemon's credentials — that costs one redundant provision — but it
// must never name credentials the board does not hold, or the daemon would
// never send it the ones it needs. Hence:
//  - a provision forgets the old id BEFORE its credentials are written (unless
//    it carries that same id) and records its own only once they were, so a
//    reset between the two writes leaves "none", never a stale id;
//  - when the old id cannot be forgotten, the credentials are not written;
//  - forgetting does not trust a failed read: it clears whatever is stored;
//  - anything that is not a valid id is recorded as none;
//  - a re-join of credentials already stored (credId == nullptr) leaves it alone;
//  - storage is written only when the record changes.
// Firmware that predates the id does not keep this rule, so a downgrade that
// changes the credentials and an upgrade back can leave a stale id (the
// 2026-10-18 credential-id devlog says why that is left open).
//
// Backend, held by value (a handle, not the storage itself):
// bool load(char* out, size_t outLen) — false when nothing is stored or it
// cannot be read; bool save(const char* id) — "" removes the record (true when
// none was stored), false when the storage could not be written.
namespace WifiCredId {

template <typename Backend>
class Store {
public:
    explicit Store(Backend backend = Backend()) : backend_(backend) {}

    // The recorded id ("" = none), NUL-terminated into out.
    void load(char* out, size_t outLen) {
        if (out == nullptr || outLen == 0) return;
        char stored[HEX_LENGTH + 2];
        strncpy(out, read(stored) ? stored : "", outLen - 1);
        out[outLen - 1] = '\0';
    }

    // A provision carrying `credId` ("" when it carried none) is about to write
    // credentials. False when the old id could not be forgotten: the caller
    // must not write them then.
    bool beforeWrite(const char* credId) {
        if (credId == nullptr) return true;
        char stored[HEX_LENGTH + 2];
        if (valid(credId) && read(stored) && strcmp(stored, credId) == 0) return true;
        return forget();
    }

    // ...and wrote them, or failed to (`written`).
    void afterWrite(const char* credId, bool written) {
        if (credId == nullptr) return;
        if (!written || !valid(credId)) {
            forget();
            return;
        }
        char stored[HEX_LENGTH + 2];
        if (read(stored) && strcmp(stored, credId) == 0) return;
        backend_.save(credId);
    }

    // The stored credentials may change without a provision (captive portal,
    // reset): the record can no longer vouch for them. A load that fails may
    // be an unreadable record rather than an absent one, so this does not ask
    // first. False when the record could not be cleared.
    bool forget() { return backend_.save(""); }

private:
    // One spare byte, so an over-long stored value reads as invalid rather
    // than as its first HEX_LENGTH characters.
    bool read(char (&stored)[HEX_LENGTH + 2]) {
        stored[0] = '\0';
        if (!backend_.load(stored, sizeof(stored))) return false;
        stored[sizeof(stored) - 1] = '\0';
        return valid(stored);
    }

    Backend backend_;
};

}  // namespace WifiCredId
