package dev.agentdeck.terrarium

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import dev.agentdeck.ui.theme.DesignTokens

/** Color palette and timing constants for the terrarium scene. */
object TerrariumColors {
    // Background layers
    val DeepSea = DesignTokens.UI.waterDeep
    val MidWater = DesignTokens.UI.waterMid
    val ShallowWater = DesignTokens.UI.waterShallow

    // Claude Code mascot (pixel art — matching official terracotta)
    val ClaudeBody = DesignTokens.Brand.claudeCode // muted terracotta/copper
    val ClaudeBodyLight = Color(0xFFD08870)  // THINKING pulse bright
    val ClaudeBodyDark = Color(0xFFA05840)   // shadow
    val ClaudeEye = Color(0xFF2D1F16)        // dark brown

    // Cloud (Codex CLI brand: indigo-violet)
    val CloudBody = DesignTokens.Brand.codex // primary indigo (same as Apple/ESP32)
    val CloudDeep = Color(0xFF3342C7)        // dark shadow
    val CloudHighlight = Color(0xFFB394E5)   // light violet highlight
    val CloudGlow = Color(0xFF8F94F2)        // processing pulse glow

    // OpenCode (nested-square logo: warm gray outer, dark inner)
    val OpenCodeOuter = DesignTokens.Brand.opencodeOnDark // light warm gray outer frame
    val OpenCodeInner = Color(0xFF4B4646)    // dark brown-gray inner square

    // Antigravity (peak/arc mark — rainbow reference, with gray fallback for text chips)
    val AntigravityLime = Color(0xFF5CD64D)
    val AntigravityTeal = Color(0xFF1FC6B3)
    val AntigravityCyan = Color(0xFF3AC7EB)
    val AntigravityYellow = Color(0xFFF5CB24)
    val AntigravityOrange = Color(0xFFFF8410)
    val AntigravityRed = Color(0xFFFF5241)
    val AntigravityPink = Color(0xFFB75CB6)
    val AntigravityViolet = Color(0xFF666FE1)
    val AntigravityBlue = Color(0xFF247EFF)
    val AntigravitySky = Color(0xFF29B8EE)
    val AntigravityBody = Color(0xFF5F6368)
    val AntigravityLight = Color(0xFFE8EEF8)
    val AntigravityDim = Color(0xFF3C4043)

    // Crayfish (OpenClaw brand: #FF4D4D→#991B1B gradient, #00E5CC teal eyes)
    val CrayfishShell = DesignTokens.Brand.openclaw
    val CrayfishDark = Color(0xFF991B1B)
    val CrayfishClaw = Color(0xFFFF4D4D)
    val CrayfishEye = Color(0xFF00E5CC)
    val CrayfishBodyLight = Color(0xFFFF6B6B)  // ROUTING pulse bright

    // Neon Tetra
    val TetraNeon = Color(0xFF00E5FF)
    val TetraBody = Color(0xFF1E40AF)
    val TetraFin = Color(0xFFFF6B6B)
    val TetraStripe = Color(0xFF00E5FF)

    // Environment
    val BubbleWhite = Color(0x40FFFFFF)
    val BubbleHighlight = Color(0x80FFFFFF)
    val CausticsLight = Color(0x14FFFFFF)
    val SandBase = Color(0xFF2A1F14)
    val SandLight = Color(0xFF3D2E1F)
    val RockDark = Color(0xFF1A1A2E)
    val RockMid = Color(0xFF2D2D44)
    val RockLight = Color(0xFF3A3A55)
    val KelpGreen = Color(0xFF22C55E)
    val KelpDark = Color(0xFF166534)

    // LED cables
    val LEDGreen = DesignTokens.UI.ok
    val LEDAmber = DesignTokens.UI.attn
    val LEDRed = DesignTokens.UI.error

    // Holographic UI
    val HoloBlue = Color(0x6000E5FF)
    val HoloText = Color(0xB000E5FF)

    // Error state
    val ErrorTint = Color(0x40EF4444)

    // HUD overlay — design tokens shared with the Apple and ESP32 HUDs
    val HUDBg = DesignTokens.UI.popupBgDeep.copy(alpha = 0.5f)
    val HUDText = DesignTokens.UI.hudText
    val HUDSubtext = DesignTokens.UI.hudSubtext
}

/** Layout and sizing constants. */
object TerrariumLayout {
    // Scene proportions (fraction of canvas)
    const val SAND_HEIGHT_FRACTION = 0.35f
    const val ROCK_HEIGHT_FRACTION = 0.25f

    // Octopus sizing (fraction of canvas width)
    const val OCTOPUS_BODY_RADIUS_FRACTION = 0.050f
    const val OCTOPUS_CENTER_X_FRACTION = 0.4f
    const val OCTOPUS_CENTER_Y_FRACTION = 0.45f
    // (TENTACLE_LENGTH_FRACTION removed — pixel mascot has no tentacles)

    // Crayfish sizing — home + clear-anchor come from the cross-platform
    // rules SSOT (shared/src/terrarium-rules.ts → TerrariumRules.generated.kt).
    const val CRAYFISH_WIDTH_FRACTION = TerrariumRules.CRAYFISH_WIDTH_FRACTION
    const val CRAYFISH_CENTER_X_FRACTION = TerrariumRules.CRAYFISH_HOME_X
    const val CRAYFISH_CENTER_Y_FRACTION = TerrariumRules.CRAYFISH_SITTING_Y

    /**
     * Floor-resting drifters (idle/sleeping OpenCode, sleeping Antigravity)
     * keep their rest anchor X at or left of this so the crayfish's floor
     * territory (claws reach ~0.67) stays clear.
     */
    const val CRAYFISH_CLEAR_MAX_X = TerrariumRules.CRAYFISH_CLEAR_MAX_X

    // Tetra sizing
    const val TETRA_SIZE_FRACTION = 0.015f
    const val TETRA_COUNT = 7

    // Octopus swimming boundaries (fraction of canvas)
    const val SWIM_MIN_X = 0.18f   // clear of left HUD panel (~19%)
    const val SWIM_MAX_X = 0.55f   // before crayfish area (0.78)
    const val SWIM_MIN_Y = 0.15f   // below surface (0.05) margin
    const val SWIM_MAX_Y = 0.55f   // above sand (0.65)

    // Cloud/OpenCode/Antigravity swim boundaries -- deliberately distinct from
    // the Octopus box above. Their home bands (CreatureLayout.kt) extend well
    // past SWIM_MAX_X (Cloud to 0.55, OpenCode to 0.68, Antigravity to 0.82);
    // clamping their WORKING-state swim lane into the Octopus box would drag
    // every creature whose home slot is right of ~0.49 back into the
    // Octopus/Cloud region, causing cross-type overlap. Mirrors Apple's
    // per-type homeX +/- offset clamp (apple/.../Creatures/{Cloud,OpenCode,Antigravity}Creature.swift).
    const val CLOUD_SWIM_MIN_X = 0.18f
    const val CLOUD_SWIM_MAX_X = 0.72f
    const val OPENCODE_SWIM_MIN_X = 0.20f
    const val OPENCODE_SWIM_MAX_X = 0.70f
    const val ANTIGRAVITY_SWIM_MIN_X = 0.50f
    const val ANTIGRAVITY_SWIM_MAX_X = 0.88f

    // Cloud creature sizing (Codex CLI)
    const val CLOUD_WIDTH_FRACTION = 0.09f
    const val CLOUD_CENTER_X_FRACTION = 0.55f
    const val CLOUD_CENTER_Y_FRACTION = 0.20f   // upper area — clouds float high

    // OpenCode creature sizing (geometric nested-square)
    const val OPENCODE_CENTER_X_FRACTION = 0.48f
    const val OPENCODE_CENTER_Y_FRACTION = 0.40f

    // Neon Tetra swim boundaries — full aquarium range
    const val TETRA_SWIM_MIN_X = 0.03f   // near left wall
    const val TETRA_SWIM_MAX_X = 0.92f   // near right wall (seaweed at 0.93)
    const val TETRA_SWIM_MIN_Y = 0.08f   // just below surface (0.05)
    const val TETRA_SWIM_MAX_Y = 0.61f   // above sand (0.65)
}

/** Animation timing constants. */
object TerrariumTiming {
    // Octopus
    const val FLOAT_PERIOD_MS = 4000f
    const val FLOAT_AMPLITUDE_FRACTION = 0.015f
    const val TENTACLE_WAVE_SPEED = 2.5f
    const val THINKING_PULSE_SPEED = 3.0f
    const val TYPING_SPEED = 8.0f

    // Crayfish
    const val CLAW_CLAP_PERIOD_MS = 1200f
    const val EYE_FLASH_PERIOD_MS = 800f

    // Tetra
    const val BOID_SPEED = 0.3f
    const val STREAM_SPEED = 1.5f
    const val SEPARATION_RADIUS = 0.04f
    const val ALIGNMENT_RADIUS = 0.08f
    const val COHESION_RADIUS = 0.12f

    // Octopus swimming
    const val SWIM_SPEED = 0.03f           // canvas fraction/sec
    const val SWIM_LERP_RATE = 3.0f         // target convergence speed
    const val WAYPOINT_MIN_INTERVAL = 1.5f // seconds
    const val WAYPOINT_MAX_INTERVAL = 3.0f

    // Neon Tetra tail
    const val TETRA_TAIL_SPEED = 8.0f

    // Bubbles
    const val BUBBLE_RISE_SPEED = 0.08f
    const val BUBBLE_WOBBLE_SPEED = 3.0f
    const val CALM_SPAWN_INTERVAL_MS = 2000f
    const val ACTIVE_SPAWN_INTERVAL_MS = 300f
    const val ERROR_SPAWN_INTERVAL_MS = 100f

    // Environment
    const val CAUSTICS_SPEED = 1.5f
    const val KELP_SWAY_SPEED = 1.0f
    const val LED_PULSE_SPEED = 2.0f

    // Creature bubble exhales
    const val OCTO_BUBBLE_INTERVAL = 2.5f   // seconds between WORKING octopus exhales
    const val CRAYFISH_BUBBLE_INTERVAL = 1.5f // seconds between ROUTING crayfish exhales
    const val CLOUD_BUBBLE_INTERVAL = 3.0f    // seconds between COMPUTING cloud exhales

    // Transitions
    const val STATE_TRANSITION_MS = 500f
    const val EINK_WIPE_MS = 300f
    const val EINK_DEBOUNCE_MS = 500L
}
