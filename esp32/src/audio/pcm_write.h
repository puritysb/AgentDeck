#pragma once
#include <cstddef>
#include <cstdint>
namespace Audio {
// Never discard a partially accepted PCM prefix or claim unplayed bytes.
// Each successful iteration advances; zero progress terminates the transfer.
template<class Write, class Aborted>
size_t writePcmFully(const uint8_t* data, size_t len, Write write, Aborted aborted) {
    size_t sent = 0;
    while (sent < len && !aborted()) {
        const size_t n = write(data + sent, len - sent);
        if (!n || n > len - sent) break;
        sent += n;
    }
    return sent;
}
}
