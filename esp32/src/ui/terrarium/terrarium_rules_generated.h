// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/terrarium-rules.ts
// Regenerate: pnpm generate-terrarium-rules (drift gated by shared/src/__tests__/terrarium-rules.test.ts)
#pragma once
#include <stdint.h>

// Cross-platform terrarium rules. See shared/src/terrarium-rules.ts for
// what each value means and the clearance invariant they encode.
// C++11-safe (util/-grade): plain constexpr values; standard integer types only.
namespace TerrariumRules {
constexpr float CiCompanionOrbitRadiusX = 0.08f;
constexpr float CiCompanionOrbitRadiusY = 0.07f;
constexpr float CiCompanionSizeFrac = 0.05f;
constexpr float CiCompanionEdgeInset = 0.035f;
constexpr float CiCompanionRadiansPerSecond = 0.9f;
constexpr float CiCompanionQueuedSpeed = 0.55f;
constexpr float CiCompanionUnknownSpeed = 0.35f;
constexpr float CiCompanionNativeRadiusX = 1.0f;
constexpr float CiCompanionNativeRadiusY = 0.36f;
constexpr float CiCompanionNativeDepth = 0.45f;
constexpr float CiCompanionNativeSize = 0.32f;
constexpr float CiCompanionStaticAngle = 0.7853981633974483f;
constexpr float CiCompanionResultSeconds = 4.0f;
constexpr float CiCompanionHopHeight = 0.035f;
constexpr float CiCompanionHopSeconds = 1.2f;
constexpr uint32_t CiCompanionSeedOffset = 2166136261u;
constexpr uint32_t CiCompanionSeedPrime = 16777619u;
constexpr uint32_t CiCompanionSeedModulus = 10000u;
constexpr float CrayfishHomeX = 0.78f;
constexpr float CrayfishSittingY = 0.64f;
constexpr float CrayfishWidthFraction = 0.11f;
constexpr float CrayfishClearMaxX = 0.62f;
constexpr float FloorRestYMin = 0.56f;
constexpr float FloorRestYMax = 0.64f;
constexpr float AntigravityHoverYMin = 0.48f;
constexpr float AntigravityHoverYMax = 0.54f;
constexpr float ResterMaxWidthFraction = 0.096f;
// Name tags (DESIGN.md §6.4): at or above this many residents idle tags collapse.
constexpr int NativeLabelDenseResidentCount = 5;
}  // namespace TerrariumRules
