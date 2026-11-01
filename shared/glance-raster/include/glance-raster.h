#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
// Buffers are borrowed; returns false on malformed input or geometry mismatch.
bool agentdeck_glance_rgba(const uint8_t *svg, size_t svg_len,
    const uint8_t *fonts, size_t fonts_len, uint32_t width, uint32_t height,
    uint8_t *output, size_t output_len);
