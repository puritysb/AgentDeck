#include <cassert>
#include "net/ws_auth_recovery.h"
int main() {
    WsAuthRecovery state;
    const uint8_t normal[] = {0x03, 0xe8};
    const uint8_t unauthorized[] = {0x0f, 0xa1};
    const uint8_t other[] = {0x0f, 0xa2};
    state.closeFrame(nullptr, 2); state.closeFrame(unauthorized, 1);
    state.closeFrame(normal, 2); state.httpStatus(0); state.httpStatus(101); state.httpStatus(403);
    assert(!state.required);
    state.closeFrame(unauthorized, 2); assert(state.required);
    state.closeFrame(normal, 2); state.httpStatus(200); assert(state.required);
    state.provisioned(); assert(!state.required);
    state.httpStatus(401); assert(state.required);
    state.provisioned(); state.closeFrame(other, 2); assert(!state.required);
}
