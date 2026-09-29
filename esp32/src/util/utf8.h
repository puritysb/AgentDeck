#pragma once
// UTF-8-safe truncation helpers. Byte-sized firmware buffers (TimelineEntry.raw,
// SessionInfo.question, …) are filled with strncpy from daemon JSON; a cut that
// lands mid-sequence leaves a broken trailing glyph (한글/CJK renders as garbage
// on LVGL and e-ink). Every strncpy of daemon-supplied text should be followed
// by utf8TrimEnd(), and manual compositions should back off with utf8Boundary().
//
// C++11-safe (shared by pioarduino C++20/23 envs, the `led8x32` espressif32
// env, and the host simulator).
#include <stddef.h>
#include <stdint.h>

namespace Utf8 {

// Largest cut point ≤ n that does not split a multi-byte sequence in s.
inline size_t utf8Boundary(const char* s, size_t n) {
    while (n > 0 && ((uint8_t)s[n] & 0xC0) == 0x80) n--;
    // n now points at a lead (or ASCII) byte — verify the sequence that starts
    // there actually ends before the cut; a lead byte whose continuation bytes
    // were themselves truncated must go too.
    if (n > 0) {
        size_t lead = n - 1;
        while (lead > 0 && ((uint8_t)s[lead] & 0xC0) == 0x80) lead--;
        uint8_t b = (uint8_t)s[lead];
        size_t needed = (b & 0xF8) == 0xF0 ? 4 : (b & 0xF0) == 0xE0 ? 3 : (b & 0xE0) == 0xC0 ? 2 : 1;
        if (lead + needed > n) n = lead;
    }
    return n;
}

// In-place: drop a trailing incomplete UTF-8 sequence left by a byte-truncating
// strncpy. No-op on well-formed endings.
inline void utf8TrimEnd(char* s) {
    size_t n = 0;
    while (s[n]) n++;
    s[utf8Boundary(s, n)] = '\0';
}

// A bounded UI row cannot pass embedded line breaks to GFX/LVGL print().
inline void singleLine(char* s) {
    if (!s) return;
    utf8TrimEnd(s);
    for (; *s; ++s) if ((uint8_t)*s < 0x20 || *s == 0x7f) *s = ' ';
}

// Number of UTF-8 code points (lead/ASCII bytes) in s.
inline size_t utf8CharCount(const char* s) {
    size_t n = 0;
    for (; *s; s++) if (((uint8_t)*s & 0xC0) != 0x80) n++;
    return n;
}

// In-place sanitizer for LVGL text surfaces (Montserrat + Noto KR fallback).
// The fallback covers Hangul syllables only, so common daemon-text punctuation
// (· • – — " " ' ' → …) renders as a tofu box; map those to ASCII lookalikes
// and blank everything else outside ASCII / Hangul / LVGL's F000 symbol area.
// Shared by every LVGL board (ips10 cards, T-Embed knob) — never re-implement
// per surface. u8g2 e-ink surfaces don't need it (unifont covers U+00B7).
inline void sanitizeLvglText(char* s) {
    if (!s) return;
    char* d = s;
    while (*s) {
        uint32_t cp = 0;
        size_t len = 0;
        uint8_t b1 = (uint8_t)s[0];
        if (b1 < 0x80) {
            cp = b1; len = 1;
        } else if ((b1 & 0xE0) == 0xC0) {
            if ((uint8_t)s[1] == 0) break;
            cp = ((b1 & 0x1F) << 6) | ((uint8_t)s[1] & 0x3F);
            len = 2;
        } else if ((b1 & 0xF0) == 0xE0) {
            if ((uint8_t)s[1] == 0 || (uint8_t)s[2] == 0) break;
            cp = ((b1 & 0x0F) << 12) | (((uint8_t)s[1] & 0x3F) << 6) | ((uint8_t)s[2] & 0x3F);
            len = 3;
        } else if ((b1 & 0xF8) == 0xF0) {
            if ((uint8_t)s[1] == 0 || (uint8_t)s[2] == 0 || (uint8_t)s[3] == 0) break;
            cp = ((b1 & 0x07) << 18) | (((uint8_t)s[1] & 0x3F) << 12)
               | (((uint8_t)s[2] & 0x3F) << 6) | ((uint8_t)s[3] & 0x3F);
            len = 4;
        } else {
            s++;
            continue;
        }

        if (cp == 0x2022 || cp == 0x00B7) {          // • · → -
            *d++ = '-';
        } else if (cp == 0x2013 || cp == 0x2014) {   // – — → -
            *d++ = '-';
        } else if (cp == 0x201C || cp == 0x201D) {   // " " → "
            *d++ = '"';
        } else if (cp == 0x2018 || cp == 0x2019) {   // ' ' → '
            *d++ = '\'';
        } else if (cp == 0x2192) {                   // → → >
            *d++ = '>';
        } else if (cp == 0x2026) {                   // … → ..
            *d++ = '.';
            *d++ = '.';
        } else {
            bool allowed = (cp >= 0x20 && cp <= 0x7E)
                        || cp == 0x0A || cp == 0x0D || cp == 0x09
                        || (cp >= 0xAC00 && cp <= 0xD7A3)    // Hangul syllables (Noto KR fallback)
                        || (cp >= 0xF000 && cp <= 0xF8FF);   // LVGL symbol private-use area
            if (allowed) {
                for (size_t i = 0; i < len; i++) *d++ = s[i];
            } else {
                *d++ = ' ';
            }
        }
        s += len;
    }
    *d = '\0';
}

}  // namespace Utf8
