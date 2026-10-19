// The WiFi credential-id record (net/wifi_cred_id_store.h) over a fake NVS:
// what a board may store, and the write order that never lets the record name
// credentials the board does not hold.
#include "net/wifi_cred_id_store.h"
#include <cassert>
#include <cstring>
#include <string>

namespace {
struct FakeNvs {
    bool present = false;
    std::string value;
    bool loadOk = true;  // false: a record may be there, but it cannot be read
    bool saveOk = true;  // false: storage cannot be opened for writing
    int saves = 0;       // writes that reached storage
};

// The store holds its backend by value, so the backend is a handle. Mirrors
// PrefsCredIdBackend (wifi_manager.cpp): removing an absent record writes
// nothing, but still needs the storage open.
struct FakeBackend {
    FakeNvs* nvs;
    bool load(char* out, size_t outLen) {
        if (!nvs->present || !nvs->loadOk) return false;
        strncpy(out, nvs->value.c_str(), outLen - 1);
        out[outLen - 1] = '\0';
        return true;
    }
    bool save(const char* id) {
        if (!nvs->saveOk) return false;
        if (id[0] == '\0' && !nvs->present) return true;
        ++nvs->saves;
        nvs->present = id[0] != '\0';
        nvs->value = id;
        return true;
    }
};

using Store = WifiCredId::Store<FakeBackend>;

Store over(FakeNvs& nvs) { return Store(FakeBackend{&nvs}); }

FakeNvs holding(const char* id) {
    FakeNvs nvs;
    nvs.present = true;
    nvs.value = id;
    return nvs;
}

std::string recorded(FakeNvs& nvs) {
    char out[WifiCredId::HEX_LENGTH + 1];
    over(nvs).load(out, sizeof(out));
    return out;
}

const char* const kId = "4fbb066b2801b4ae";
const char* const kOther = "7de137f03d5a8983";
}  // namespace

int main() {
    using WifiCredId::valid;
    assert(WifiCredId::HEX_LENGTH == 16);
    assert(valid(kId) && valid("0"));
    assert(!valid(nullptr) && !valid(""));
    assert(!valid("4FBB066B2801B4AE"));   // lowercase only: ids compare exactly
    assert(!valid("4fbb066b2801b4ae0"));  // longer than HEX_LENGTH
    assert(!valid("4fbb066b2801b4ag") && !valid("4fbb 66b2801b4ae"));

    {  // A provision records its id once its credentials are written.
        FakeNvs nvs;
        assert(recorded(nvs).empty());
        assert(over(nvs).beforeWrite(kId));
        assert(nvs.saves == 0);  // nothing to forget
        over(nvs).afterWrite(kId, true);
        assert(nvs.present && nvs.value == kId && recorded(nvs) == kId);
        // The same provision again (IPS10 endpoint refresh).
        assert(over(nvs).beforeWrite(kId));
        over(nvs).afterWrite(kId, true);
        assert(nvs.saves == 1);  // storage is written only when the record changes
    }
    {  // A different provision forgets the old id BEFORE its credentials land,
       // so a reset between the two writes leaves none, never a stale id.
        FakeNvs nvs = holding(kOther);
        assert(over(nvs).beforeWrite(kId));
        assert(!nvs.present);
        over(nvs).afterWrite(kId, true);
        assert(nvs.value == kId && recorded(nvs) == kId);
    }
    {  // Credentials that failed to save are not vouched for.
        FakeNvs nvs = holding(kOther);
        over(nvs).beforeWrite(kId);
        over(nvs).afterWrite(kId, false);
        assert(!nvs.present && recorded(nvs).empty());
    }
    for (const char* id : {"", "NOT-HEX", "4FBB066B2801B4AE", "4fbb066b2801b4ae0"}) {
        // A provision without an id (an older daemon) or with an invalid one clears it.
        FakeNvs nvs = holding(kId);
        over(nvs).beforeWrite(id);
        over(nvs).afterWrite(id, true);
        assert(!nvs.present && recorded(nvs).empty());
    }
    {  // A re-join of credentials already stored leaves it alone.
        FakeNvs nvs = holding(kId);
        over(nvs).beforeWrite(nullptr);
        over(nvs).afterWrite(nullptr, true);
        over(nvs).afterWrite(nullptr, false);
        assert(nvs.saves == 0 && recorded(nvs) == kId);
    }
    {  // Portal or reset: forgotten, and forgetting twice writes once.
        FakeNvs nvs = holding(kId);
        assert(over(nvs).forget());
        assert(!nvs.present && recorded(nvs).empty());
        assert(over(nvs).forget());
        assert(nvs.saves == 1);
    }
    {  // A record that cannot be read is still cleared: an unreadable record
       // is not proof that none is stored.
        FakeNvs nvs = holding(kId);
        nvs.loadOk = false;
        assert(recorded(nvs).empty());
        assert(over(nvs).forget());
        nvs.loadOk = true;
        assert(!nvs.present && recorded(nvs).empty());

        FakeNvs same = holding(kId);  // nor can it vouch for a matching id
        same.loadOk = false;
        assert(over(same).beforeWrite(kId));
        same.loadOk = true;
        assert(!same.present);
    }
    {  // Nothing is cached: device_info reports what storage holds now.
        FakeNvs nvs = holding(kId);
        Store store = over(nvs);
        char out[WifiCredId::HEX_LENGTH + 1];
        store.load(out, sizeof(out));
        assert(std::string(out) == kId);
        nvs.present = false;
        store.load(out, sizeof(out));
        assert(out[0] == '\0');
    }
    for (const char* stored : {"4FBB066B2801B4AE", "4fbb066b2801b4ae0", "zz"}) {
        // Storage that holds anything but a valid id reads as none.
        FakeNvs nvs = holding(stored);
        assert(recorded(nvs).empty());
    }
    {  // A small output buffer truncates, it never overruns.
        FakeNvs nvs = holding(kId);
        char small[5];
        over(nvs).load(small, sizeof(small));
        assert(std::string(small) == "4fbb");
    }
    {  // A failed id write is not papered over: the record is what storage holds.
        FakeNvs nvs = holding(kOther);
        nvs.saveOk = false;
        assert(!over(nvs).forget());
        assert(recorded(nvs) == kOther);
        // A provision that cannot clear the old id must not write its
        // credentials, or the old id would name credentials no longer held.
        assert(!over(nvs).beforeWrite(kId));
        assert(recorded(nvs) == kOther);
        // The same id needs no write, so it is not refused.
        assert(over(nvs).beforeWrite(kOther));
        nvs.saveOk = true;
        assert(over(nvs).forget());
        assert(!nvs.present && recorded(nvs).empty());

        // Storage that cannot be opened cannot prove it holds no id either.
        FakeNvs empty;
        empty.saveOk = false;
        assert(!over(empty).beforeWrite(kId));
        over(empty).afterWrite(kId, true);
        assert(recorded(empty).empty());
    }
    return 0;
}
