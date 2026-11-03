#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace WifiBridgeBinding {
enum class Read { Missing, Ready, Unavailable };

// One NVS blob, explicit byte layout: version, big-endian port, endpoint, token.
// Capacities come from DashboardState, not another copy of its buffer limits.
template <size_t IpBytes, size_t TokenBytes> struct Record {
    static constexpr size_t size = 3 + IpBytes + TokenBytes;
    uint8_t bytes[size] = {};
    uint16_t port() const { return (uint16_t(bytes[1]) << 8) | bytes[2]; }
    const char* ip() const { return reinterpret_cast<const char*>(bytes + 3); }
    const char* token() const { return reinterpret_cast<const char*>(bytes + 3 + IpBytes); }
    static size_t length(const char* text, size_t cap) {
        if (!text) return cap;
        size_t n = 0; while (n < cap && text[n]) ++n; return n;
    }
    bool valid() const {
        const size_t host = length(ip(), IpBytes);
        return bytes[0] == 1 && port() != 0 && host > 0 && host < IpBytes && length(token(), TokenBytes) < TokenBytes;
    }
    bool assign(const char* host, uint16_t endpointPort, const char* credential) {
        const size_t h = length(host,IpBytes), t = length(credential,TokenBytes);
        if (!h || h >= IpBytes || t >= TokenBytes || !endpointPort) return false;
        std::memset(bytes,0,sizeof(bytes)); bytes[0]=1;
        bytes[1]=uint8_t(endpointPort >> 8); bytes[2]=uint8_t(endpointPort);
        std::memcpy(bytes+3,host,h); std::memcpy(bytes+3+IpBytes,credential,t);
        return true;
    }
};
template <class Binding> Read decode(Read marker, uint8_t version, Read blob, const Binding& binding, size_t bytesRead) {
    if (marker == Read::Missing && blob == Read::Missing) return Read::Missing;
    if (marker != Read::Ready || version != 1 || blob != Read::Ready) return Read::Unavailable;
    return bytesRead == Binding::size && binding.valid() ? Read::Ready : Read::Unavailable;
}
} // namespace WifiBridgeBinding
