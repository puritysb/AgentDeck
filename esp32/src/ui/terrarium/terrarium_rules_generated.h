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
constexpr float HermesHomeSharedX = 0.0f;
constexpr float HermesHomeSharedFloor = 0.12f;
constexpr float HermesHomeSharedZ = 1.35f;
constexpr float HermesHomeSharedSize = 0.72f;
constexpr float HermesHomeMouthClearance = 0.45f;
constexpr float HermesHomeBerthTravelScale = 0.35f;
constexpr float HermesHomeBerthInwardTravel = 0.12f;
constexpr float HermesHomeBerthFront = 0.3f;
constexpr float HermesHomeFrontLimit = 2.4f;
constexpr float HermesHomeBerthLaneMinX = 1.4f;
constexpr float HermesHomeBerthLaneMaxX = 1.8f;
constexpr float HermesHomeBerthLaneWidthFraction = 0.3f;
constexpr float HermesHomeBerthFloor = 0.95f;
constexpr float HermesHomeBerthRise = 0.48f;
constexpr float HermesHomeBerthZ = 1.0f;
constexpr float HermesHomeBerthDepth = 1.1f;
constexpr float HermesHomeNeighbourSceneMinWidth = 1.6f;
constexpr float HermesHomeNeighbourSceneMaxWidth = 6.2f;
constexpr float HermesHomeNeighbourSceneAspect = 5.5f;
constexpr float HermesHomeNeighbourLaneMinX = 1.8f;
constexpr float HermesHomeNeighbourLaneMaxX = 2.35f;
constexpr float HermesHomeNeighbourLaneWidthFraction = 0.38f;
constexpr float HermesHomeNeighbourFloor = 0.32f;
constexpr float HermesHomeNeighbourRise = 0.28f;
constexpr float HermesHomeNeighbourZ = 1.0f;
constexpr float HermesHomeNeighbourDepth = 1.4f;
constexpr float HermesHomeNeighbourSize = 0.75f;
constexpr float HermesHomeNeighbourRockWidth = 0.9f;
constexpr float HermesHomeNeighbourRockMinWidth = 0.5f;
constexpr float HermesHomeNeighbourRockDepth = 0.8f;
constexpr float HermesHomeNeighbourRockMinDepth = 0.45f;
constexpr float HermesHomeCanvasX = 0.5f;
constexpr float HermesHomeCanvasY = 0.74f;
constexpr float HermesHomeCanvasRadius = 0.06f;
constexpr float HermesHomeBlinkPeriod = 5.3f;
constexpr float HermesHomeBlinkClose = 0.075f;
constexpr float HermesHomeBlinkHold = 0.035f;
constexpr float HermesHomeBlinkOpen = 0.145f;
constexpr float HermesHomeCanvasRestY = 0.7f;
constexpr float HermesHomeHeadScale = 0.78f;
constexpr float HermesHomeBodyWidth = 1.18f;
constexpr float HermesHomeBodyLength = 1.15f;
constexpr float HermesHomeBodyDepth = 1.08f;
constexpr float HermesHomeOpenRate = 0.9f;
constexpr float HermesHomeCloseRate = 0.7f;
constexpr float HermesHomeEmergeRate = 0.65f;
constexpr float HermesHomeLidClearance = 0.98f;
constexpr float HermesHomeDepartureStart = 0.6f;
constexpr float HermesHomeLidAngle = 1.22f;
constexpr float HermesHomeTuckDepth = 0.65f;
constexpr float HermesHomeSettleDistance = 0.04f;
constexpr float HermesHomeSettleSpeed = 0.04f;
constexpr float HermesHomeTravelRate = 0.34f;
constexpr float HermesHomeSwimLift = 0.85f;
constexpr float HermesHomeSwimRadius = 0.85f;
constexpr float HermesHomeWorkRadius = 0.35f;
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
