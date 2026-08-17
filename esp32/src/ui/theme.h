#pragma once

#include <cstdint>

// ===== RGB565 color macros =====
// Convert 24-bit RGB to 16-bit RGB565
#define RGB565(r, g, b) ((uint16_t)(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)))

// ===== LVGL lv_color_hex equivalents =====

namespace Theme {

// --- Background layers ---
constexpr uint32_t DeepSea       = 0x0A1628;
constexpr uint32_t MidWater      = 0x0F2744;
constexpr uint32_t ShallowWater  = 0x163B5C;

// --- Sand & Rock ---
constexpr uint32_t SandBase      = 0x2A1F14;
constexpr uint32_t SandLight     = 0x3D2E1F;
constexpr uint32_t RockDark      = 0x1A1A2E;
constexpr uint32_t RockMid       = 0x2D2D44;
constexpr uint32_t RockLight     = 0x3A3A55;

// --- Kelp ---
constexpr uint32_t KelpGreen     = 0x22C55E;
constexpr uint32_t KelpDark      = 0x166534;

// --- Octopus (Claude Code) ---
constexpr uint32_t ClaudeBody      = 0xC07058;
constexpr uint32_t ClaudeBodyLight = 0xD08870;
constexpr uint32_t ClaudeBodyDark  = 0xA05840;
constexpr uint32_t ClaudeEye       = 0x2D1F16;

// --- Cloud (Codex CLI) ---
constexpr uint32_t CloudBody       = 0x5561E0;
constexpr uint32_t CloudBodyLight  = 0x7B85F0;
constexpr uint32_t CloudBodyDark   = 0x3A45C0;
constexpr uint32_t CloudPrompt     = 0xE2E8F0;  // ">_" text color

// --- OpenCode (nested square) ---
constexpr uint32_t OpenCodeOuter = 0xF1ECEC;
constexpr uint32_t OpenCodeInner = 0x4B4646;
constexpr uint32_t OpenCodePulse = 0xCFCECD;

// --- Antigravity (peak/arc mark) ---
constexpr uint32_t AntigravityMark = 0xD2D6DC;  // canonical brand gray (agent-logos.ts)
constexpr uint32_t AntigravityCyan = 0x28BDF3;
constexpr uint32_t AntigravityGreen = 0x2FD66D;
constexpr uint32_t AntigravityYellow = 0xF3D233;

// --- Kiro (ghost mark) ---
constexpr uint32_t KiroMark = 0x7C3AED;
constexpr uint32_t AntigravityOrange = 0xFF8A18;
constexpr uint32_t AntigravityRed = 0xFF4F47;
constexpr uint32_t AntigravityPurple = 0xA85CC8;
constexpr uint32_t AntigravityBlue = 0x247CFF;

// --- Crayfish (OpenClaw) ---
constexpr uint32_t CrayfishShell     = 0xFF4D4D;
constexpr uint32_t CrayfishDark      = 0x991B1B;
constexpr uint32_t CrayfishEye       = 0x00E5CC;
constexpr uint32_t CrayfishBodyLight = 0xFF6B6B;

// --- Neon Tetra ---
constexpr uint32_t TetraNeon   = 0x00E5FF;
constexpr uint32_t TetraBody   = 0x1E40AF;
constexpr uint32_t TetraFin    = 0xFF6B6B;

// --- Bubble ---
constexpr uint32_t BubbleWhite = 0xFFFFFF;  // rendered with alpha

// --- HUD ---
constexpr uint32_t HUDBg       = 0x000000;  // rendered at ~50% alpha
constexpr uint32_t HUDText     = 0xE2E8F0;
constexpr uint32_t HUDDim      = 0x94A3B8;
constexpr uint32_t HUDFaint    = 0x64748B;  // fainter than HUDDim — cell footers (model · elapsed)

// --- Status colors ---
constexpr uint32_t StatusGreen  = 0x22C55E;
constexpr uint32_t StatusBlue   = 0x3B82F6;
constexpr uint32_t StatusAmber  = 0xFBBF24;
constexpr uint32_t StatusRed    = 0xEF4444;
constexpr uint32_t StatusCyan   = 0x00E5FF;
constexpr uint32_t StatusPurple = 0xA855F7;

// --- Activity type colors (shared by the TTGO activity widget) ---
constexpr uint32_t TLChatStart   = 0x22C55E;  // green
constexpr uint32_t TLToolReq     = 0x3B82F6;  // blue
constexpr uint32_t TLToolOk      = 0x00E5FF;  // cyan
constexpr uint32_t TLError       = 0xEF4444;  // red
constexpr uint32_t TLChatEnd     = 0xFBBF24;  // amber
constexpr uint32_t TLModelCall   = 0xA855F7;  // purple

// --- LED cable (omitted on ESP32 but kept for reference) ---
constexpr uint32_t LEDGreen  = 0x22C55E;
constexpr uint32_t LEDAmber  = 0xFBBF24;
constexpr uint32_t LEDRed    = 0xEF4444;

}  // namespace Theme

// ===== Layout constants =====
namespace Layout {

// Sand/terrain
constexpr float SandHeightFrac = 0.35f;

#if IS_ROUND
// Round AMOLED: tighter swim boundaries to stay within circular mask
// Octopus
constexpr float OctBodyRadiusFrac = 0.060f;   // Slightly larger for small display
constexpr float OctHomeX          = 0.32f;
constexpr float OctStandingY      = 0.62f;    // Just above sand (0.65)
constexpr float OctSleepY         = 0.70f;
constexpr float OctWorkingY       = 0.40f;
constexpr float OctSwimMinX       = 0.20f;
constexpr float OctSwimMaxX       = 0.55f;
constexpr float OctSwimMinY       = 0.15f;
constexpr float OctSwimMaxY       = 0.58f;

// Crayfish
constexpr float CfWidthFrac  = 0.12f;
constexpr float CfHomeX      = 0.72f;
constexpr float CfHomeY      = 0.55f;
constexpr float CfSittingY   = 0.68f;
constexpr float CfRoutingY   = 0.52f;

// Cloud (Codex CLI) — slightly smaller body so the ">_" prompt reads more prominently
constexpr float CloudRadiusFrac = 0.046f;
constexpr float CloudHomeX      = 0.50f;
constexpr float CloudStandingY  = 0.62f;
constexpr float CloudSleepY     = 0.70f;
constexpr float CloudWorkingY   = 0.30f;
constexpr float CloudSwimMinX   = 0.28f;
constexpr float CloudSwimMaxX   = 0.65f;
constexpr float CloudSwimMinY   = 0.15f;
constexpr float CloudSwimMaxY   = 0.58f;

// OpenCode (nested square)
constexpr float OpenCodeRadiusFrac = 0.050f;
constexpr float OpenCodeHomeX      = 0.63f;
constexpr float OpenCodeStandingY  = 0.62f;
constexpr float OpenCodeSleepY     = 0.70f;
constexpr float OpenCodeWorkingY   = 0.42f;
constexpr float OpenCodeSwimMinX   = 0.42f;
constexpr float OpenCodeSwimMaxX   = 0.72f;
constexpr float OpenCodeSwimMinY   = 0.15f;
constexpr float OpenCodeSwimMaxY   = 0.58f;

// Antigravity (peak/arc mark)
constexpr float AntigravityRadiusFrac = 0.054f;
constexpr float AntigravityHomeX      = 0.74f;
constexpr float AntigravityStandingY  = 0.50f;
constexpr float AntigravitySleepY     = 0.67f;
constexpr float AntigravityWorkingY   = 0.26f;
constexpr float AntigravitySwimMinX   = 0.52f;
constexpr float AntigravitySwimMaxX   = 0.82f;
constexpr float AntigravitySwimMinY   = 0.12f;
constexpr float AntigravitySwimMaxY   = 0.56f;

// Kiro (ghost mark). Sits between the octopus lane (0.32) and OpenCode (0.63)
// so a tank holding one of each does not stack two marks on one column.
constexpr float KiroRadiusFrac = 0.050f;
constexpr float KiroHomeX      = 0.46f;
constexpr float KiroStandingY  = 0.56f;
constexpr float KiroSleepY     = 0.72f;
constexpr float KiroWorkingY   = 0.32f;
constexpr float KiroSwimMinX   = 0.34f;
constexpr float KiroSwimMaxX   = 0.60f;
constexpr float KiroSwimMinY   = 0.14f;
constexpr float KiroSwimMaxY   = 0.60f;

// Tetra
constexpr float TetraSize     = 0.018f;
constexpr float TetraSwimMinX = 0.10f;
constexpr float TetraSwimMaxX = 0.90f;
constexpr float TetraSwimMinY = 0.12f;
constexpr float TetraSwimMaxY = 0.58f;

// Water surface
constexpr float SurfaceY = 0.06f;

// HUD
constexpr uint8_t HudHeight = 20;

#else
// Rectangular displays (480x480, 480x320)
// Octopus
constexpr float OctBodyRadiusFrac = 0.055f;
constexpr float OctHomeX          = 0.30f;
constexpr float OctStandingY      = 0.63f;    // Just above sand (0.65)
constexpr float OctSleepY         = 0.75f;
constexpr float OctWorkingY       = 0.42f;
constexpr float OctSwimMinX       = 0.15f;
constexpr float OctSwimMaxX       = 0.50f;
constexpr float OctSwimMinY       = 0.10f;
constexpr float OctSwimMaxY       = 0.61f;

// Crayfish
constexpr float CfWidthFrac  = 0.11f;
constexpr float CfHomeX      = 0.78f;
constexpr float CfHomeY      = 0.58f;
constexpr float CfSittingY   = 0.72f;
constexpr float CfRoutingY   = 0.55f;

// Cloud (Codex CLI) — slightly smaller body so the ">_" prompt reads more prominently
constexpr float CloudRadiusFrac = 0.041f;
constexpr float CloudHomeX      = 0.50f;
constexpr float CloudStandingY  = 0.63f;
constexpr float CloudSleepY     = 0.75f;
constexpr float CloudWorkingY   = 0.30f;
constexpr float CloudSwimMinX   = 0.25f;
constexpr float CloudSwimMaxX   = 0.60f;
constexpr float CloudSwimMinY   = 0.10f;
constexpr float CloudSwimMaxY   = 0.61f;

// OpenCode (nested square)
constexpr float OpenCodeRadiusFrac = 0.045f;
constexpr float OpenCodeHomeX      = 0.65f;
constexpr float OpenCodeStandingY  = 0.63f;
constexpr float OpenCodeSleepY     = 0.75f;
constexpr float OpenCodeWorkingY   = 0.42f;
constexpr float OpenCodeSwimMinX   = 0.40f;
constexpr float OpenCodeSwimMaxX   = 0.70f;
constexpr float OpenCodeSwimMinY   = 0.10f;
constexpr float OpenCodeSwimMaxY   = 0.61f;

// Antigravity (peak/arc mark)
constexpr float AntigravityRadiusFrac = 0.048f;
constexpr float AntigravityHomeX      = 0.72f;
constexpr float AntigravityStandingY  = 0.50f;
constexpr float AntigravitySleepY     = 0.74f;
constexpr float AntigravityWorkingY   = 0.28f;
constexpr float AntigravitySwimMinX   = 0.52f;
constexpr float AntigravitySwimMaxX   = 0.84f;
constexpr float AntigravitySwimMinY   = 0.10f;
constexpr float AntigravitySwimMaxY   = 0.61f;

// Kiro (ghost mark) — see the note in the block above.
constexpr float KiroRadiusFrac = 0.045f;
constexpr float KiroHomeX      = 0.45f;
constexpr float KiroStandingY  = 0.56f;
constexpr float KiroSleepY     = 0.76f;
constexpr float KiroWorkingY   = 0.33f;
constexpr float KiroSwimMinX   = 0.33f;
constexpr float KiroSwimMaxX   = 0.60f;
constexpr float KiroSwimMinY   = 0.12f;
constexpr float KiroSwimMaxY   = 0.63f;

// Tetra
constexpr float TetraSize     = 0.015f;
constexpr float TetraSwimMinX = 0.03f;
constexpr float TetraSwimMaxX = 0.92f;
constexpr float TetraSwimMinY = 0.08f;
constexpr float TetraSwimMaxY = 0.61f;

// Water surface
constexpr float SurfaceY = 0.04f;

// HUD
constexpr uint8_t HudHeight = 24;
#endif

}  // namespace Layout
