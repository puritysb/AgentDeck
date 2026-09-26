// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/terrarium-rules.ts
// Regenerate: pnpm generate-terrarium-rules (drift gated by shared/src/__tests__/terrarium-rules.test.ts)
package dev.agentdeck.terrarium

/**
 * Cross-platform terrarium rules. See shared/src/terrarium-rules.ts for
 * what each value means and the clearance invariant they encode.
 */
object TerrariumRules {
    const val NATIVE_RESIDENT_LIMIT = 8
    const val NATIVE_ACTIVITY_IDLE_RATE = 0.65f
    const val NATIVE_ACTIVITY_WORK_RATE = 2.5f
    const val NATIVE_ACTIVITY_GROUND_TRAVEL = 0.32f
    const val NATIVE_ACTIVITY_WATER_TRAVEL = 0.28f
    const val NATIVE_ACTIVITY_GROUND_YAW = 0.38f
    const val NATIVE_ACTIVITY_WORK_YAW = 0.24f
    const val NATIVE_ACTIVITY_WORK_ROLL = 0.22f
    const val NATIVE_ACTIVITY_WORK_BREATH = 0.095f
    const val NATIVE_ACTIVITY_FOOT_LIFT = 0.065f
    const val NATIVE_ACTIVITY_BAR_MINIMUM = 0.45f
    const val NATIVE_ACTIVITY_BAR_RANGE = 0.55f
    const val NATIVE_ACTIVITY_BAR_RATE = 2.0f
    const val NATIVE_ACTIVITY_BAR_PHASE = 1.2f
    const val NATIVE_ACTIVITY_BAR_COUNT = 3.0f
    const val NATIVE_ACTIVITY_BAR_X = 0.82f
    const val NATIVE_ACTIVITY_BAR_SPACING = 0.085f
    const val NATIVE_ACTIVITY_BAR_Y = 0.1f
    const val NATIVE_ACTIVITY_BAR_WIDTH = 0.055f
    const val NATIVE_ACTIVITY_BAR_HEIGHT = 0.28f
    const val NATIVE_ACTIVITY_BAR_RADIUS = 0.02f
    const val NATIVE_ACTIVITY_SELECTION_X = 0.7f
    const val NATIVE_ACTIVITY_SELECTION_WIDTH = 0.025f
    const val NATIVE_ACTIVITY_SELECTION_HEIGHT = 0.72f
    const val NATIVE_CAMERA_FOV = 38.0f
    const val NATIVE_CAMERA_WIDE_FOV = 32.0f
    const val NATIVE_VIEWING_DISTANCE = 0.82f
    const val NATIVE_VIEWING_RESPONSE_SECONDS = 0.18f
    const val NATIVE_WATER_TINT = 0.12f
    const val NATIVE_DEPTH_FADE_START = 0.4f
    const val NATIVE_DEPTH_FADE_SHOULDER = 0.72f
    const val NATIVE_DEPTH_FADE_SHOULDER_OPACITY = 0.85f
    const val NATIVE_DEPTH_FADE_END_OPACITY = 0.95f
    const val NATIVE_CAMERA_WIDE_ASPECT = 2.0f
    const val CRAYFISH_HOME_X = 0.78f
    const val CRAYFISH_SITTING_Y = 0.64f
    const val CRAYFISH_WIDTH_FRACTION = 0.11f
    const val CRAYFISH_CLEAR_MAX_X = 0.62f
    const val FLOOR_REST_Y_MIN = 0.56f
    const val FLOOR_REST_Y_MAX = 0.64f
    const val ANTIGRAVITY_HOVER_Y_MIN = 0.48f
    const val ANTIGRAVITY_HOVER_Y_MAX = 0.54f
    const val RESTER_MAX_WIDTH_FRACTION = 0.096f
}
