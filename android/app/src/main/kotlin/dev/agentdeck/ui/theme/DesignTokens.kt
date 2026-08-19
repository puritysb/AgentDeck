package dev.agentdeck.ui.theme

// AgentDeck — Design tokens (Compose mirror of design/tokens.css).
// See DESIGN.md for the spec. The CSS file remains the source of truth;
// keep this file in sync when tokens change.
//
// Existing AgentDeckColors object stays as-is for backwards compatibility.
// New code should reach for DesignTokens; migration is incremental.

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

object DesignTokens {

    // === Tide (sand / paper) ===
    object Tide {
        val s50 = Color(0xFFF5F3EC)
        val s100 = Color(0xFFEBE6D6)
        val s200 = Color(0xFFD8CFB6)
        val s300 = Color(0xFFA8B09A)
    }

    // === Ink (deep aquarium) ===
    object Ink {
        val s900 = Color(0xFF0E1F1F)
        val s800 = Color(0xFF15302F)
        val s700 = Color(0xFF1F4544)
        val s500 = Color(0xFF426664)
        val s300 = Color(0xFF7C9694)
    }

    // === Kelp (App Store / running / OK) ===
    object Kelp {
        val s700 = Color(0xFF1F6157)
        val s500 = Color(0xFF2F8A7C)
        val s300 = Color(0xFF6FB6A8)
    }

    // === Coral (Developer / build) ===
    object Coral {
        val s500 = Color(0xFFC0573A)
        val s700 = Color(0xFF8C3A23)
    }

    // === Amber (attention — only color allowed to pulse) ===
    object Amber {
        val s500 = Color(0xFFC8923A)
    }

    // === Marketing status semantics (DESIGN.md §2.7) ===
    object Status {
        val idle = Ink.s300
        val processing = Kelp.s500
        val awaiting = Amber.s500
        val error = Coral.s500
    }

    // === Product UI palette (menubar / e-ink / hardware / TTY) ===
    // Brighter signal colors. DESIGN.md §2.6: marketing surfaces must NEVER use these.
    object UI {
        val ok = Color(0xFF52D988)
        val attn = Color(0xFFFFA93D)
        val error = Color(0xFFFF6B6B)
        val cyan = Color(0xFF3ED6E8)
        val idle = Color(0xFF9A9AA2)
        val idleDark = Color(0xFF7A8A9C)
        val popupBgDark = Color(0xFF0A1A2A)
        val popupBgDeep = Color(0xFF061018)
        val popupBgMid = Color(0xFF0A1520)
        val popupBgLight = Color(0xFFF6F3EE)
        val ttyBg = Color(0xFF0C0D10)
        val ttyBgMid = Color(0xFF141820)
        val ttyText = Color(0xFFC8D0D8)
        val ttyDim = Color(0xFF7A8493)
        val ttyFaint = Color(0xFF4A5060)
    }

    // === Agent brand marks ===
    // Only saturated reds/blues allowed in the system. Sourced from upstream
    // brand SVGs in design/brand/ — do not redraw or restyle.
    object Brand {
        val claudeCode = Color(0xFFC07058)
        val codex = Color(0xFF6166E0)
        val openclaw = Color(0xFFFF4D4D)
        val opencode = Color(0xFF3A3A3A)
        val antigravity = Color(0xFF5F6368)
        val kiro = Color(0xFF7C3AED)
    }

    // === Type stack ===
    object FontFamilyName {
        const val sans = "IBM Plex Sans"
        const val sansKR = "IBM Plex Sans KR"
        const val sansJP = "IBM Plex Sans JP"
        const val mono = "JetBrains Mono"
        const val monoFallback = "IBM Plex Mono"
    }

    // === Type scale (sp values; use with .sp in Compose) ===
    object FontSize {
        const val h2 = 44f
        const val h3 = 26f
        const val h3Lg = 32f
        const val cardTitle = 19f
        const val bodyLg = 19f
        const val body = 17f
        const val lede = 18f
        const val small = 14.5f
        const val caption = 13f
        const val kicker = 12f
        const val monoBadge = 11.5f
    }

    // === Layout ===
    object Layout {
        val containerMax: Dp = 1240.dp
        val containerPad: Dp = 32.dp
        val sectionY: Dp = 96.dp
    }

    object Tracking {
        const val hero = -0.035f
        const val editorial = -0.04f
        const val h2 = -0.02f
        const val h3 = -0.015f
        const val card = -0.01f
        const val kicker = 0.18f
        const val badge = 0.16f
        const val chip = 0.08f
    }

    // === Spacing scale (4dp base) ===
    object Spacing {
        val s1: Dp = 4.dp
        val s2: Dp = 8.dp
        val s3: Dp = 12.dp
        val s4: Dp = 16.dp
        val s5: Dp = 20.dp
        val s6: Dp = 24.dp
        val s8: Dp = 32.dp
        val s10: Dp = 40.dp
        val s12: Dp = 48.dp
        val s14: Dp = 56.dp
        val s16: Dp = 64.dp
        val s20: Dp = 80.dp
        val s24: Dp = 96.dp
        val s30: Dp = 120.dp
    }

    // === Radii ===
    object Radius {
        val sm: Dp = 4.dp
        val md: Dp = 8.dp
        val lg: Dp = 10.dp
        val xl: Dp = 12.dp
        val xxl: Dp = 14.dp
        val xxxl: Dp = 16.dp
        val xxxxl: Dp = 18.dp
        val pill: Dp = 999.dp
    }

    // === Motion (durations in ms) ===
    object Motion {
        const val fast = 120
        const val base = 200
        const val slow = 320
        const val pulse = 1100
        const val wiggle = 700
    }
}
