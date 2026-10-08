#pragma once

#include <stdint.h>
#include <string.h>

// Pixel-masked differential frames for the EPD47's 4-bit grayscale panel.
//
// The vendor driver has two relevant passes: WHITE_ON_WHITE lightens each pixel
// in proportion to its darkness in the image it is given, and BLACK_ON_WHITE
// darkens in proportion to the target level. A nibble of 0xF (paper) drives
// nothing in either pass. So an erase image that carries the OLD level only
// where a pixel changed, and a draw image that carries the NEW level only where
// it changed, update exactly the changed pixels and leave every unchanged pixel
// — including unchanged ink — undriven.
//
// The previous implementation passed the whole retained frame to the erase and
// the whole new frame to the draw: every inked pixel on the panel was cycled
// out and back in on every content change, and the driver scanned all 540 rows
// twice (1.32 s measured). Restricting both passes to the band of rows that
// actually changed lets the driver skip the rest.
//
// Layout: row-major, two pixels per byte, even x in the low nibble (the order
// LilyEpdCanvas::drawPixel writes). Data-only so host tests run the exact code.
namespace AgentDeckEpd47 {

struct Band {
    int16_t first = -1;   // first changed row, -1 when the frames are identical
    int16_t last = -1;    // last changed row (inclusive)
    bool empty() const { return first < 0; }
    uint16_t rows() const { return empty() ? 0 : (uint16_t)(last - first + 1); }
};

inline Band changedRows(const uint8_t* prev, const uint8_t* cur, uint16_t rowBytes, uint16_t rows) {
    Band band;
    for (uint16_t y = 0; y < rows; y++) {
        if (memcmp(prev + (size_t)y * rowBytes, cur + (size_t)y * rowBytes, rowBytes) != 0) {
            band.first = (int16_t)y;
            break;
        }
    }
    if (band.empty()) return band;
    for (int32_t y = rows - 1; y >= band.first; y--) {
        if (memcmp(prev + (size_t)y * rowBytes, cur + (size_t)y * rowBytes, rowBytes) != 0) {
            band.last = (int16_t)y;
            break;
        }
    }
    return band;
}

// The changed rows as up to `maxBands` separate bands. The driver skips a row
// outside its area almost for free (epd_skip) but drives every row inside it
// for all 15 phases, so a header stamp and one changed row 400 rows below cost
// two short bands, not one 400-row band. Runs closer than `minGap` rows merge
// (each band pays its own frame start/end); once the slots are used up, later
// runs merge into the last band.
inline uint8_t changedBands(const uint8_t* prev, const uint8_t* cur, uint16_t rowBytes,
                            uint16_t rows, Band* out, uint8_t maxBands, uint16_t minGap) {
    if (!out || maxBands == 0) return 0;
    uint8_t n = 0;
    for (uint16_t y = 0; y < rows; y++) {
        if (memcmp(prev + (size_t)y * rowBytes, cur + (size_t)y * rowBytes, rowBytes) == 0) continue;
        if (n > 0 && (uint16_t)(y - out[n - 1].last) <= minGap) {
            out[n - 1].last = (int16_t)y;
        } else if (n < maxBands) {
            out[n].first = (int16_t)y;
            out[n].last = (int16_t)y;
            n++;
        } else {
            out[n - 1].last = (int16_t)y;
        }
    }
    return n;
}

// Keep `source`'s nibble where the two frames differ, paper (0xF) elsewhere.
inline uint8_t maskedByte(uint8_t prev, uint8_t cur, uint8_t source) {
    const uint8_t diff = (uint8_t)(prev ^ cur);
    uint8_t out = 0xFF;
    if (diff & 0x0F) out = (uint8_t)((out & 0xF0) | (source & 0x0F));
    if (diff & 0xF0) out = (uint8_t)((out & 0x0F) | (source & 0xF0));
    return out;
}

// Writes the band's rows of `out` (same layout and offsets as the frames).
// `takeOld` selects the erase image (old levels) or the draw image (new levels).
// Returns the number of changed pixels in the band.
inline uint32_t buildMasked(const uint8_t* prev, const uint8_t* cur, uint8_t* out,
                            uint16_t rowBytes, const Band& band, bool takeOld) {
    if (band.empty()) return 0;
    uint32_t changed = 0;
    const size_t begin = (size_t)band.first * rowBytes;
    const size_t end = (size_t)(band.last + 1) * rowBytes;
    for (size_t i = begin; i < end; i++) {
        const uint8_t p = prev[i], c = cur[i];
        if (p == c) { out[i] = 0xFF; continue; }
        const uint8_t diff = (uint8_t)(p ^ c);
        changed += (uint32_t)((diff & 0x0F) != 0) + (uint32_t)((diff & 0xF0) != 0);
        out[i] = maskedByte(p, c, takeOld ? p : c);
    }
    return changed;
}

}  // namespace AgentDeckEpd47
