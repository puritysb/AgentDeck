#pragma once

#include <Arduino.h>
#include <FastLED.h>

// 3x5 pixel font — each glyph packed into uint16_t (15 bits, MSB first)
// Bit layout: row0[2:0] row1[2:0] row2[2:0] row3[2:0] row4[2:0] + 1 unused bit
// Row bits: bit2=left, bit1=center, bit0=right

namespace MatrixFont {

// Pack 3x5 glyph: rows top to bottom, each row is 3 bits (L=4, C=2, R=1)
#define G(r0,r1,r2,r3,r4) ((uint16_t)((r0)<<12|(r1)<<9|(r2)<<6|(r3)<<3|(r4)))

static const uint16_t PROGMEM GLYPHS[] = {
    // ' ' (space)
    G(0,0,0,0,0),
    // A
    G(0b010, 0b101, 0b111, 0b101, 0b101),
    // B
    G(0b110, 0b101, 0b110, 0b101, 0b110),
    // C
    G(0b011, 0b100, 0b100, 0b100, 0b011),
    // D
    G(0b110, 0b101, 0b101, 0b101, 0b110),
    // E
    G(0b111, 0b100, 0b110, 0b100, 0b111),
    // F
    G(0b111, 0b100, 0b110, 0b100, 0b100),
    // G
    G(0b011, 0b100, 0b101, 0b101, 0b011),
    // H
    G(0b101, 0b101, 0b111, 0b101, 0b101),
    // I
    G(0b111, 0b010, 0b010, 0b010, 0b111),
    // J
    G(0b001, 0b001, 0b001, 0b101, 0b010),
    // K
    G(0b101, 0b101, 0b110, 0b101, 0b101),
    // L
    G(0b100, 0b100, 0b100, 0b100, 0b111),
    // M
    G(0b101, 0b111, 0b111, 0b101, 0b101),
    // N
    // Deliberately asymmetric diagonal. The old double-join was identical to M
    // at 3×5 and made OFFLINE's N look like a filled/smudged glyph.
    G(0b101, 0b110, 0b101, 0b011, 0b101),
    // O
    G(0b010, 0b101, 0b101, 0b101, 0b010),
    // P
    G(0b110, 0b101, 0b110, 0b100, 0b100),
    // Q
    G(0b010, 0b101, 0b101, 0b111, 0b011),
    // R
    G(0b110, 0b101, 0b110, 0b101, 0b101),
    // S
    G(0b011, 0b100, 0b010, 0b001, 0b110),
    // T
    G(0b111, 0b010, 0b010, 0b010, 0b010),
    // U
    G(0b101, 0b101, 0b101, 0b101, 0b010),
    // V
    G(0b101, 0b101, 0b101, 0b101, 0b010),
    // W
    G(0b101, 0b101, 0b111, 0b111, 0b101),
    // X
    G(0b101, 0b101, 0b010, 0b101, 0b101),
    // Y
    G(0b101, 0b101, 0b010, 0b010, 0b010),
    // Z
    G(0b111, 0b001, 0b010, 0b100, 0b111),
    // 0-9: Pixoo HUD style — filled/blocky for LED matrix readability
    // 0
    G(0b111, 0b101, 0b101, 0b101, 0b111),
    // 1
    G(0b010, 0b110, 0b010, 0b010, 0b111),
    // 2
    G(0b111, 0b001, 0b111, 0b100, 0b111),
    // 3
    G(0b111, 0b001, 0b111, 0b001, 0b111),
    // 4
    G(0b101, 0b101, 0b111, 0b001, 0b001),
    // 5
    G(0b111, 0b100, 0b111, 0b001, 0b111),
    // 6
    G(0b111, 0b100, 0b111, 0b101, 0b111),
    // 7
    G(0b111, 0b001, 0b001, 0b001, 0b001),
    // 8
    G(0b111, 0b101, 0b111, 0b101, 0b111),
    // 9
    G(0b111, 0b101, 0b111, 0b001, 0b111),
    // '-'
    G(0b000, 0b000, 0b111, 0b000, 0b000),
    // '.'
    G(0b000, 0b000, 0b000, 0b000, 0b010),
    // '%'
    G(0b101, 0b001, 0b010, 0b100, 0b101),
    // '?'
    G(0b110, 0b001, 0b010, 0b000, 0b010),
    // '!'
    G(0b010, 0b010, 0b010, 0b000, 0b010),
    // '/'
    G(0b001, 0b001, 0b010, 0b100, 0b100),
    // ':'
    G(0b000, 0b010, 0b000, 0b010, 0b000),
    // '_'
    G(0b000, 0b000, 0b000, 0b000, 0b111),
    // '+' (explicit lower bound for unusually narrow labelled countdowns)
    G(0b000, 0b010, 0b111, 0b010, 0b000),
};

#undef G

// Character to glyph index mapping
inline uint8_t charToIndex(char c) {
    if (c == ' ') return 0;
    if (c >= 'A' && c <= 'Z') return 1 + (c - 'A');
    if (c >= 'a' && c <= 'z') return 1 + (c - 'a');  // lowercase → same as uppercase
    if (c >= '0' && c <= '9') return 27 + (c - '0');
    switch (c) {
        case '-': return 37;
        case '.': return 38;
        case '%': return 39;
        case '?': return 40;
        case '!': return 41;
        case '/': return 42;
        case ':': return 43;
        case '_': return 44;
        case '+': return 45;
        default:  return 0;  // unknown → space
    }
}

// Draw a single character at (x, y) on the LED buffer
// x, y are pixel coordinates; only visible pixels are drawn
inline void drawChar(CRGB* leds, int x, int y, char c, CRGB color,
                     int matW = 32, int matH = 8) {
    uint8_t idx = charToIndex(c);
    uint16_t glyph = pgm_read_word(&GLYPHS[idx]);

    for (int row = 0; row < 5; row++) {
        uint8_t rowBits = (glyph >> (12 - row * 3)) & 0b111;
        for (int col = 0; col < 3; col++) {
            if (rowBits & (4 >> col)) {
                int px = x + col;
                int py = y + row;
                if (px >= 0 && px < matW && py >= 0 && py < matH) {
                    // Serpentine XY mapping
                    int ledIdx = (py % 2 == 0) ? (py * matW + px) : (py * matW + (matW - 1 - px));
                    leds[ledIdx] = color;
                }
            }
        }
    }
}

// Draw scrolling text — offsetX is the pixel scroll position (negative = scrolled left)
inline void drawScrollText(CRGB* leds, const char* text, int offsetX, int y,
                           CRGB color, int matW = 32, int matH = 8) {
    for (int i = 0; text[i]; i++) {
        int cx = offsetX + i * 4;  // 4px per char (3px glyph + 1px gap)
        if (cx > matW) break;      // Off screen right
        if (cx < -3) continue;     // Off screen left
        drawChar(leds, cx, y, text[i], color, matW, matH);
    }
}

// Measure text width in pixels
inline int textWidth(const char* text) {
    int len = 0;
    while (text[len]) len++;
    return len > 0 ? len * 4 - 1 : 0;  // No trailing gap
}

} // namespace MatrixFont
