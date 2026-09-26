// terrarium-rules.ts — Cross-platform terrarium behavior rules (SSOT).
//
// This file is the single source of truth for terrarium *rules*: numeric
// invariants every surface must agree on regardless of its own world model
// (creature homes that are unified across dashboards, exclusion zones,
// rest strips). Surface-specific *tuning* (per-board Y offsets, swim lanes,
// sprite sizes) stays local to each platform.
//
// Consumers:
//   TypeScript  — import { TERRARIUM_RULES } from '@agentdeck/shared'
//                 (TUI terrarium, Pixoo renderer, future web surfaces)
//   Swift       — apple/AgentDeck/Terrarium/TerrariumRules.generated.swift
//   Kotlin      — android/.../terrarium/TerrariumRules.generated.kt
//   C++ (ESP32) — esp32/src/ui/terrarium/terrarium_rules_generated.h
//
// The Swift/Kotlin/C++ files are GENERATED — run `pnpm generate-terrarium-rules`
// after editing this file and commit the regenerated outputs. A vitest sync
// test (shared/src/__tests__/terrarium-rules.test.ts) fails CI when the
// generated files drift from this source, so hand-editing them cannot stick.
//
// When adding a new cross-platform rule (a coordinate, clamp, or zone that
// more than one surface must respect), add it HERE first, regenerate, and
// wire each surface to the generated constant — never introduce the literal
// in platform code. That is what keeps new features from re-fragmenting.

/**
 * Terrarium cross-platform rules.
 *
 * crayfish — the OpenClaw crayfish's unified dashboard home and territory.
 *   `clearMaxX` is the load-bearing invariant: idle/sleeping floor-resting
 *   drifters (OpenCode, sleeping Antigravity, idle Cloud) must clamp their
 *   rest anchor X to ≤ clearMaxX so the crayfish's floor territory (claws
 *   reach ~homeX − widthFrac) stays clear. Fix origin: 610fe15c — idle
 *   OpenCode landed exactly on the crayfish when two sessions were idle.
 *
 * floorRestStrip — the sand strip idle drifters converge to on the full
 *   dashboard surfaces (macOS/Android). Y is surface-tunable elsewhere
 *   (TUI floor ≈ 0.88, ESP32 SleepY per board); the strip here documents
 *   the canonical dashboard band.
 *
 * antigravityHoverStrip — Antigravity idles as a HOVER, not a floor rest:
 *   its band extends to x 0.82 (inside crayfish territory), so landing it
 *   would collide. Hover Y band for the full dashboard surfaces.
 *
 * resterMaxWidthFrac — widest floor-resting creature body (Antigravity,
 *   0.096; see creature-layout.ts band specs). Input to the clearance
 *   invariant: clearMaxX + resterMaxWidthFrac/2 < crayfish claw left edge.
 */
export const TERRARIUM_RULES = {
  /** Pixoo HUD rows reserve space for every live provider in both daemons. */
  pixooUsageRowHeight: 7,
  pixooUsageCreatureMargin: 11,
  /** Native 3D foreground budget; the full roster remains independently accessible. */
  nativeResidentLimit: 8,
  /** Shared native activity rhythm and cue geometry; screen-space label sizing remains surface-specific. */
  nativeActivity: {
    idleRate: 0.65,
    workRate: 2.5,
    groundTravel: 0.32,
    waterTravel: 0.28,
    groundYaw: 0.38,
    workYaw: 0.24,
    workRoll: 0.22,
    workBreath: 0.095,
    footLift: 0.065,
    barMinimum: 0.45,
    barRange: 0.55,
    barRate: 2,
    barPhase: 1.2,
    barCount: 3,
    barX: 0.82,
    barSpacing: 0.085,
    barY: 0.10,
    barWidth: 0.055,
    barHeight: 0.28,
    barRadius: 0.02,
    selectionX: 0.70,
    selectionWidth: 0.025,
    selectionHeight: 0.72,
  },
  /** Vertical field of view for the same authored habitat across native engines. */
  nativeCameraFov: 38,
  nativeCameraWideFov: 32,
  nativeCameraWideAspect: 2,
  // Full-canvas underwater wash; shared by native tablet and desktop scenes.
  nativeViewingDistance: 0.82,
  nativeViewingResponseSeconds: 0.18,
  nativeWaterTint: 0.12,
  nativeDepthFadeStart: 0.4,
  nativeDepthFadeShoulder: 0.72,
  nativeDepthFadeShoulderOpacity: 0.85,
  nativeDepthFadeEndOpacity: 0.95,
  crayfish: {
    /** Unified dashboard home center X (Swift/Android agreed on 0.78). */
    homeX: 0.78,
    /** Unified dashboard sitting/home center Y. */
    sittingY: 0.64,
    /** Crayfish body width as fraction of world width. */
    widthFrac: 0.11,
    /** Idle floor-resters clamp rest-anchor X to ≤ this. */
    clearMaxX: 0.62,
  },
  floorRestStrip: { yMin: 0.56, yMax: 0.64 },
  antigravityHoverStrip: { yMin: 0.48, yMax: 0.54 },
  resterMaxWidthFrac: 0.096,
} as const;

export type TerrariumRules = typeof TERRARIUM_RULES;
