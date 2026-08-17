// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/model-provider.ts
// Regenerate: pnpm generate-model-provider (drift gated by shared/src/__tests__/model-provider.test.ts)
package dev.agentdeck.state

/**
 * Which company's endpoint served the model on a session row.
 *
 * Third axis, next to the harness (`agentType`) and the model (`modelName`).
 * A `claude-glm` session is Claude Code pointed at z.ai by an env var: the
 * harness identity is unchanged and only this axis moved.
 */
enum class ModelProvider(val id: String, val label: String) {
    ANTHROPIC("anthropic", "Anthropic"),
    OPENAI("openai", "OpenAI"),
    GOOGLE("google", "Google"),
    ZAI("zai", "z.ai"),
    MOONSHOT("moonshot", "Moonshot"),
    DEEPSEEK("deepseek", "DeepSeek"),
    ALIBABA("alibaba", "Qwen"),
    XAI("xai", "xAI"),
    MISTRAL("mistral", "Mistral"),
    META("meta", "Meta"),
    UNKNOWN("unknown", ""),
}

object ModelProviderRules {
    /** Substrings identifying a provider from a model id, most specific first. */
    val MARKERS: List<Pair<ModelProvider, List<String>>> = listOf(
        ModelProvider.ANTHROPIC to listOf(
            "claude",
            "opus",
            "sonnet",
            "haiku",
            "fable",
        ),
        ModelProvider.OPENAI to listOf(
            "gpt-",
            "gpt.",
            "o1-",
            "o3-",
            "o4-",
            "codex-",
            "davinci",
            "chatgpt",
        ),
        ModelProvider.GOOGLE to listOf(
            "gemini",
            "gemma",
            "palm-",
        ),
        ModelProvider.ZAI to listOf(
            "glm",
            "z-ai",
            "zai",
        ),
        ModelProvider.MOONSHOT to listOf(
            "kimi",
            "moonshot",
        ),
        ModelProvider.DEEPSEEK to listOf(
            "deepseek",
        ),
        ModelProvider.ALIBABA to listOf(
            "qwen",
            "qwq",
        ),
        ModelProvider.XAI to listOf(
            "grok",
        ),
        ModelProvider.MISTRAL to listOf(
            "mistral",
            "magistral",
            "devstral",
            "codestral",
            "mixtral",
        ),
        ModelProvider.META to listOf(
            "llama",
        ),
    )

    /** Vendor halves of `vendor/model` ids. */
    val VENDOR_PREFIXES: Map<String, ModelProvider> = mapOf(
        "anthropic" to ModelProvider.ANTHROPIC,
        "openai" to ModelProvider.OPENAI,
        "google" to ModelProvider.GOOGLE,
        "google-vertex" to ModelProvider.GOOGLE,
        "zai" to ModelProvider.ZAI,
        "z-ai" to ModelProvider.ZAI,
        "zhipu" to ModelProvider.ZAI,
        "moonshot" to ModelProvider.MOONSHOT,
        "moonshotai" to ModelProvider.MOONSHOT,
        "deepseek" to ModelProvider.DEEPSEEK,
        "alibaba" to ModelProvider.ALIBABA,
        "qwen" to ModelProvider.ALIBABA,
        "xai" to ModelProvider.XAI,
        "mistral" to ModelProvider.MISTRAL,
        "meta" to ModelProvider.META,
    )

    /** The provider a harness talks to when nobody redirected it. Absent for
     *  the multi-provider harnesses, which have no native provider. */
    val HARNESS_NATIVE: Map<String, ModelProvider> = mapOf(
        "claude" to ModelProvider.ANTHROPIC,
        "claude-code" to ModelProvider.ANTHROPIC,
        "codex" to ModelProvider.OPENAI,
        "codex-cli" to ModelProvider.OPENAI,
        "codex-app" to ModelProvider.OPENAI,
    )

    /** Name the provider behind a model id, or UNKNOWN. */
    fun provider(model: String?): ModelProvider {
        val raw = (model ?: "").trim().lowercase()
        if (raw.isEmpty()) return ModelProvider.UNKNOWN

        var id = raw
        val slash = raw.indexOf('/')
        if (slash > 0) {
            VENDOR_PREFIXES[raw.substring(0, slash)]?.let { return it }
            id = raw.substring(slash + 1)
        }
        for ((provider, markers) in MARKERS) {
            if (markers.any { id.contains(it) }) return provider
        }
        return ModelProvider.UNKNOWN
    }

    fun harnessNativeProvider(agentType: String?): ModelProvider =
        HARNESS_NATIVE[(agentType ?: "").trim().lowercase()] ?: ModelProvider.UNKNOWN

    /**
     * The provider to badge, or null for "say nothing".
     *
     * Non-null only when BOTH sides are known and disagree. Two unknowns must
     * never combine into a claim.
     */
    fun offHarnessProvider(agentType: String?, model: String?): ModelProvider? {
        val native = harnessNativeProvider(agentType)
        if (native == ModelProvider.UNKNOWN) return null
        val actual = provider(model)
        if (actual == ModelProvider.UNKNOWN || actual == native) return null
        return actual
    }

    /** Badge text for a session row — empty when there is nothing to say. */
    fun offHarnessProviderLabel(agentType: String?, model: String?): String =
        offHarnessProvider(agentType, model)?.label ?: ""
}
