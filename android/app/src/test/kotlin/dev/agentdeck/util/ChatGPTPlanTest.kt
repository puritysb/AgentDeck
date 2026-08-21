package dev.agentdeck.util

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The Codex row subtitle formats the raw `chatgpt_plan_type` itself rather than
 * reading the pre-formatted `subscriptions[].name`, so Android is NOT a pure
 * consumer of the wire for this field. It carried a hand copy of the tier table
 * until 2026-08-22, when a `prolite` upgrade rendered as "ChatGPT Prolite" here
 * and "ChatGPT Pro Lite" everywhere else.
 *
 * `ChatGPTPlan` is now generated from the TS SSOT
 * (`shared/src/format-utils.ts` CHATGPT_PLAN_DISPLAY_NAMES); these cases mirror
 * `shared/src/__tests__/codex-freshness-rules.test.ts` and the Swift
 * `testChatGPTPlanNamesATierTheBuildPredates`.
 */
class ChatGPTPlanTest {
    @Test
    fun `names the known tiers`() {
        assertEquals("ChatGPT Free", ChatGPTPlan.displayName("free"))
        assertEquals("ChatGPT Plus", ChatGPTPlan.displayName("plus"))
        assertEquals("ChatGPT Pro", ChatGPTPlan.displayName("pro"))
        assertEquals("ChatGPT Team", ChatGPTPlan.displayName("team"))
        assertEquals("ChatGPT Enterprise", ChatGPTPlan.displayName("enterprise"))
    }

    @Test
    fun `spells a multi-word tier the same way every other surface does`() {
        assertEquals("ChatGPT Pro Lite", ChatGPTPlan.displayName("prolite"))
        // Separators are stripped before lookup: one plan, three spellings.
        assertEquals("ChatGPT Pro Lite", ChatGPTPlan.displayName("pro_lite"))
        assertEquals("ChatGPT Pro Lite", ChatGPTPlan.displayName("pro-lite"))
        assertEquals("ChatGPT Pro Lite", ChatGPTPlan.displayName("Pro-Lite"))
        assertEquals("ChatGPT Pro Lite", ChatGPTPlan.displayName(" Pro Lite "))
    }

    @Test
    fun `capitalises a tier this build predates rather than dropping it`() {
        // OpenAI mints plan names on its own schedule. An unrecognised tier must
        // still read as a plan beside Plus/Pro/Team — never the raw lowercase
        // token, and never nothing.
        assertEquals("ChatGPT Nebula", ChatGPTPlan.displayName("nebula"))
    }
}
