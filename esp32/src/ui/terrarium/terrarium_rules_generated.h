// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/terrarium-rules.ts
// Regenerate: pnpm generate-terrarium-rules (drift gated by shared/src/__tests__/terrarium-rules.test.ts)
#pragma once

// Cross-platform terrarium rules. See shared/src/terrarium-rules.ts for
// what each value means and the clearance invariant they encode.
// C++11-safe (util/-grade): plain constexpr floats, no dependencies.
namespace TerrariumRules {
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
