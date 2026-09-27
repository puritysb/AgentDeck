#include "../src/net/sdio_dma_stage.h"
#include <cassert>
#include <cstdint>
#include <cstring>
#include <initializer_list>

int main() {
    uint8_t input[1537];
    for (size_t i=0; i<sizeof(input); ++i) input[i]=uint8_t(i);
    alignas(64) uint8_t scratch[1537];
    for (size_t size : {size_t(512), size_t(1024), size_t(1536)}) {
        assert(Net::needsSdioStaging(input+1, size, 1536, false));
        assert(!Net::needsSdioStaging(input+1, size, 1536, true));
        memset(scratch, 0xa5, sizeof(scratch));
        int calls=0;
        const int result=Net::writeStagedSdio(scratch,input+1,size,[&](const void* p,size_t n) {
            ++calls;
            assert(p==scratch && n==size);
            assert(memcmp(p,input+1,size)==0);
            assert(scratch[size]==0xa5); // no padded overwrite
            return 258; // propagate driver failure, never claim success
        });
        assert(result==258 && calls==1);
    }
    assert(!Net::needsSdioStaging(nullptr,512,1536,false));
    for (size_t size : {size_t(0), size_t(511), size_t(1502), size_t(2048)})
        assert(!Net::needsSdioStaging(input,size,1536,false));
}
