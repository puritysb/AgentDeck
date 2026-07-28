#pragma once

// Rear-camera "show-and-tell" capture (T-Display-S3-Pro POGO shield).
// The board contributes a sensor and a shutter; everything heavy stays on the
// host: the daemon assembles the JPEG, saves it, and routes a prompt with the
// file path to the target session (docs/esp32-companion-concepts.md).
//
// Boards without BOARD_HAS_DVP_CAMERA compile this header to no-op stubs so
// callers need no guards of their own.

#include <cstddef>
#include <cstdint>

namespace Camera {

/**
 * Probe and initialize the sensor. Call once from the UI task after Wire is
 * up (the SCCB config rides Wire's I2C port — no second driver on the shared
 * bus). Returns false when no shield is attached; the UI then never grows the
 * CAM page, so the no-camera unit runs the same binary.
 */
bool init();

/** True when the shield probed successfully at boot. */
bool present();

/**
 * Power the camera up for a CAM-page session (driver init + XCLK). The sensor
 * only draws power between acquire() and release(): leaving it running around
 * the clock browned out the 3.3 V rail the moment WiFi TX started.
 */
bool acquire();

/** Power the camera back down (also turns the lamp off). */
void release();

/** True while a camera session is active (between acquire and release). */
bool active();

/**
 * Copy a live preview into a little-endian RGB565 buffer laid out dstW x dstH,
 * downscaling the full sensor frame 2:1 so the viewfinder shows exactly what a
 * capture will contain (camera memory is big-endian; the copy swaps).
 * Returns false when no frame is available.
 */
bool grabPreview(uint16_t* dst, int dstW, int dstH);

/**
 * Capture one full-resolution frame and JPEG-encode it on the board.
 * On success *out is a malloc'd buffer the caller owns (free()).
 * Blocking (~encode time for an HVGA frame); call from the UI task on an
 * explicit shutter press only.
 */
bool captureJpeg(uint8_t** out, size_t* outLen, int* width, int* height);

/**
 * Portrait variants for the Pocket UI. How the sensor sits relative to the
 * panel is a physical fact no datasheet states; it was established on
 * hardware (180°) and is now a fixed board constant.
 *
 * The preview centre-crops to the destination aspect; the capture keeps the
 * whole frame at the rotated dimensions.
 */
bool grabPreviewPortrait(uint16_t* dst, int dstW, int dstH);
bool captureJpegPortrait(uint8_t** out, size_t* outLen, int* width, int* height);

/** Sensor→upright rotation used by the portrait paths (0/1/2/3 = 0/90/180/270). */
uint8_t rotationIndex();

/** White illumination LED duty 0-255 (PWM — full-on runs hot). */
void setLamp(uint8_t duty);

/** Current lamp duty (0 = off). */
uint8_t lampDuty();

}  // namespace Camera
