#include <cassert>
#include <cstring>
#include "net/mdns_policy.h"
int main() {
    char a[32] = {}, b[32] = {}, small[8] = {};
    assert(MdnsPolicy::hostname(a,sizeof(a),0x001122334455));
    assert(std::strcmp(a,"agentdeck-display-001122334455") == 0);
    assert(MdnsPolicy::hostname(b,sizeof(b),0x991122334455));
    assert(std::strcmp(a,b) != 0);
    assert(!MdnsPolicy::hostname(small,sizeof(small),1));
    assert(!MdnsPolicy::hostname(a,sizeof(a),0));
    MdnsPolicy::Choice saved("192.168.1.2",9120);
    saved.consider(0,"192.168.1.1",9120,true); saved.consider(1,"192.168.1.2",9120,true);
    assert(saved.selected() == 1);
    MdnsPolicy::Choice absent("192.168.1.3",9120);
    absent.consider(0,"192.168.1.1",9120,true); assert(absent.selected() == -1);
    MdnsPolicy::Choice unknown(nullptr,0);
    unknown.consider(0,"192.168.1.1",9120,true); unknown.consider(1,"192.168.1.2",9120,true);
    assert(unknown.selected() == -1);
    MdnsPolicy::Choice duplicate("",0);
    duplicate.consider(0,"192.168.1.1",9120,true); duplicate.consider(1,"192.168.1.1",9120,true);
    assert(duplicate.selected() == 0);
    MdnsPolicy::Choice rank("",0);
    rank.consider(0,"192.168.1.2",9121,false); rank.consider(1,"192.168.1.1",9120,true);
    assert(rank.selected() == 1);
    MdnsPolicy::Choice invalid("",0);
    invalid.consider(0,"",9120,true); invalid.consider(1,"192.168.1.1",0,true);
    assert(invalid.selected() == -1);
    static_assert(sizeof(MdnsPolicy::Choice) <= 96,"bounded stack policy");
}
