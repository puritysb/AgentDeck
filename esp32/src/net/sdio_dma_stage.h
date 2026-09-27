#pragma once
#include <cstddef>
#include <cstring>

namespace Net {
// The caller serializes scratch ownership. Never pad source reads: SDIO block
// writes already require a whole number of 512-byte blocks.
inline bool needsSdioStaging(const void* src, size_t size, size_t capacity, bool aligned) {
    return src && size && size <= capacity && size % 512 == 0 && !aligned;
}
template <typename Write>
auto writeStagedSdio(void* scratch, const void* src, size_t size, Write write)
    -> decltype(write(scratch, size)) {
    std::memcpy(scratch, src, size);
    return write(scratch, size);
}
}
