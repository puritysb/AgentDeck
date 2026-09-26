// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/terrarium-rules.ts
// Regenerate: pnpm generate-terrarium-rules (drift gated by shared/src/__tests__/terrarium-rules.test.ts)

/// Cross-platform terrarium rules. See shared/src/terrarium-rules.ts for
/// what each value means and the clearance invariant they encode.
enum TerrariumRules {
    static let pixooUsageRowHeight: Int = 7
    static let pixooUsageCreatureMargin: Int = 11
    static let nativeResidentLimit: Int = 8
    static let nativeActivityIdleRate: Float = 0.65
    static let nativeActivityWorkRate: Float = 2.5
    static let nativeActivityGroundTravel: Float = 0.32
    static let nativeActivityWaterTravel: Float = 0.28
    static let nativeActivityGroundYaw: Float = 0.38
    static let nativeActivityWorkYaw: Float = 0.24
    static let nativeActivityWorkRoll: Float = 0.22
    static let nativeActivityWorkBreath: Float = 0.095
    static let nativeActivityFootLift: Float = 0.065
    static let nativeActivityBarMinimum: Float = 0.45
    static let nativeActivityBarRange: Float = 0.55
    static let nativeActivityBarRate: Float = 2.0
    static let nativeActivityBarPhase: Float = 1.2
    static let nativeActivityBarCount: Float = 3.0
    static let nativeActivityBarX: Float = 0.82
    static let nativeActivityBarSpacing: Float = 0.085
    static let nativeActivityBarY: Float = 0.1
    static let nativeActivityBarWidth: Float = 0.055
    static let nativeActivityBarHeight: Float = 0.28
    static let nativeActivityBarRadius: Float = 0.02
    static let nativeActivitySelectionX: Float = 0.7
    static let nativeActivitySelectionWidth: Float = 0.025
    static let nativeActivitySelectionHeight: Float = 0.72
    static let nativeCameraFov: Float = 38.0
    static let nativeCameraWideFov: Float = 32.0
    static let nativeViewingDistance: Float = 0.82
    static let nativeViewingResponseSeconds: Float = 0.18
    static let nativeWaterTint: Float = 0.12
    static let nativeDepthFadeStart: Float = 0.4
    static let nativeDepthFadeShoulder: Float = 0.72
    static let nativeDepthFadeShoulderOpacity: Float = 0.85
    static let nativeDepthFadeEndOpacity: Float = 0.95
    static let nativeCameraWideAspect: Float = 2.0
    static let crayfishHomeX: Float = 0.78
    static let crayfishSittingY: Float = 0.64
    static let crayfishWidthFraction: Float = 0.11
    static let crayfishClearMaxX: Float = 0.62
    static let floorRestYMin: Float = 0.56
    static let floorRestYMax: Float = 0.64
    static let antigravityHoverYMin: Float = 0.48
    static let antigravityHoverYMax: Float = 0.54
    static let resterMaxWidthFraction: Float = 0.096
}
