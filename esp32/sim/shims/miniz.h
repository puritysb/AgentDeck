#pragma once
// Host shim for the ESP32 ROM inflater (<miniz.h>, tinfl_decompress) — backed
// by zlib. It covers the one call shape the firmware makes: a whole zlib
// stream in, into a non-wrapping output buffer that holds all of it
// (ui/widgets/ips10_workspace.cpp, the compressed ocean). Anything else fails,
// so a new caller with a streaming shape cannot pass here and break on device.
#include <cstddef>
#include <cstdint>
#include <zlib.h>

enum {
    TINFL_FLAG_PARSE_ZLIB_HEADER = 1,
    TINFL_FLAG_HAS_MORE_INPUT = 2,
    TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF = 4,
};

typedef enum {
    TINFL_STATUS_FAILED = -1,
    TINFL_STATUS_DONE = 0,
} tinfl_status;

struct tinfl_decompressor { int unused; };

inline void tinfl_init(tinfl_decompressor*) {}

inline tinfl_status tinfl_decompress(tinfl_decompressor*, const uint8_t* in, size_t* inBytes,
                                     uint8_t* outStart, uint8_t* outNext, size_t* outBytes,
                                     uint32_t flags) {
    const uint32_t oneShot = TINFL_FLAG_PARSE_ZLIB_HEADER | TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF;
    if ((flags & oneShot) != oneShot || (flags & TINFL_FLAG_HAS_MORE_INPUT) || outStart != outNext) {
        *inBytes = 0;
        *outBytes = 0;
        return TINFL_STATUS_FAILED;
    }
    uLongf produced = static_cast<uLongf>(*outBytes);
    uLong consumed = static_cast<uLong>(*inBytes);
    const int rc = uncompress2(outNext, &produced, in, &consumed);
    *inBytes = consumed;
    *outBytes = produced;
    return rc == Z_OK ? TINFL_STATUS_DONE : TINFL_STATUS_FAILED;
}
