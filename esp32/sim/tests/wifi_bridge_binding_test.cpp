#include <cassert>
#include <cstring>
#include "net/wifi_bridge_binding.h"
using WifiBridgeBinding::Read;
using Binding = WifiBridgeBinding::Record<16,40>;
int main() {
    Binding binding;
    assert(!binding.valid());
    assert(binding.assign("192.0.2.1",9120,"old-credential"));
    assert(binding.valid() && binding.port()==9120);
    assert(!std::strcmp(binding.ip(),"192.0.2.1"));
    assert(!std::strcmp(binding.token(),"old-credential"));
    assert(WifiBridgeBinding::decode(Read::Ready,1,Read::Ready,binding,Binding::size)==Read::Ready);
    // A missing/unreadable snapshot after a fence may never use legacy keys.
    assert(WifiBridgeBinding::decode(Read::Missing,0,Read::Missing,binding,0)==Read::Missing);
    assert(WifiBridgeBinding::decode(Read::Ready,1,Read::Missing,binding,0)==Read::Unavailable);
    assert(WifiBridgeBinding::decode(Read::Missing,0,Read::Ready,binding,Binding::size)==Read::Unavailable);
    assert(WifiBridgeBinding::decode(Read::Unavailable,0,Read::Ready,binding,Binding::size)==Read::Unavailable);
    assert(WifiBridgeBinding::decode(Read::Ready,2,Read::Ready,binding,Binding::size)==Read::Unavailable);
    assert(WifiBridgeBinding::decode(Read::Ready,1,Read::Ready,binding,Binding::size-1)==Read::Unavailable);
    Binding next; assert(next.assign("192.0.2.2",9121,"new-credential"));
    // Reboot reads one complete tuple, never a new token with an old endpoint.
    Binding restored; std::memcpy(restored.bytes,next.bytes,Binding::size);
    assert(restored.valid() && restored.port()==9121 && !std::strcmp(restored.ip(),"192.0.2.2") && !std::strcmp(restored.token(),"new-credential"));
    restored.bytes[0]=2;assert(!restored.valid());
    assert(!next.assign("",9120,"token"));assert(!next.assign("192.0.2.2",0,"token"));
    const char tooLong[]="1234567890123456";assert(!next.assign(tooLong,9120,"token"));
    assert(next.assign("192.0.2.2",9120,"")); // Fresh unpaired endpoint, no secret.
    std::memset(next.bytes+3,1,16);assert(!next.valid());
}
