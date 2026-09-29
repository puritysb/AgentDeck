// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/zai-quota.ts (ZAI_*_WINDOW_MINUTES, ZAI_PLAN_DISPLAY_NAMES,
// classifyZaiLimitItem, zaiQuotaFromLimits, zaiKeyLooksPayAsYouGo)
// Regenerate: pnpm generate-zai-quota-rules (drift gated by shared/src/__tests__/zai-quota.test.ts)

package dev.agentdeck.util

/// z.ai GLM Coding Plan quota rules — the Kotlin mirror of the SSOT.
///
/// Android is a pure consumer of the wire snapshot (it never parses the
/// provider response), but it DOES format the raw plan `level` itself for
/// the provider row subtitle — same situation as ChatGPTPlan, which exists as
/// a Kotlin mirror for exactly that reason: a hand copy renders the fallback
/// capitalisation for any tier it predates while every other surface shows
/// the real name.
object ZaiQuotaRules {
    val planDisplayNames: Map<String, String> = mapOf(
        "lite" to "Lite",
        "pro" to "Pro",
        "max" to "Max",
    )

    /// Display name for a raw plan `level`. An unrecognised tier is
    /// capitalised, never dropped — same polarity as the Codex plan names.
    fun formatPlanName(planType: String?): String? {
        val raw = planType?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        return planDisplayNames[raw.lowercase()] ?: raw.replaceFirstChar { it.uppercase() }
    }

    /// A pay-as-you-go key is not a coding plan: the monitor endpoint answers,
    /// but there are no subscription windows to show. Detected by key shape,
    /// the marker community parsers use.
    fun keyLooksPayAsYouGo(apiKey: String?): Boolean {
        val raw = apiKey?.trim()?.lowercase()?.takeIf { it.isNotEmpty() } ?: return false
        return raw.startsWith("sk-pay") || raw.contains("payg")
    }
}
