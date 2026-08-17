// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/model-provider.ts
// Regenerate: pnpm generate-model-provider (drift gated by shared/src/__tests__/model-provider.test.ts)

import Foundation

/// Which company's endpoint served the model on a session row.
///
/// Third axis, next to the harness (`agentType`) and the model (`modelName`).
/// A `claude-glm` session is Claude Code — same binary, same hooks, same
/// transcript — pointed at z.ai by an env var, so the harness identity is
/// unchanged and only this axis moved.
enum ADModelProvider: String, Equatable {
    case anthropic = "anthropic"
    case openai = "openai"
    case google = "google"
    case zai = "zai"
    case moonshot = "moonshot"
    case deepseek = "deepseek"
    case alibaba = "alibaba"
    case xai = "xai"
    case mistral = "mistral"
    case meta = "meta"
    case unknown = "unknown"

    /// Display name; empty for `.unknown`, which must render as nothing.
    var label: String {
        switch self {
        case .anthropic: return "Anthropic"
        case .openai: return "OpenAI"
        case .google: return "Google"
        case .zai: return "z.ai"
        case .moonshot: return "Moonshot"
        case .deepseek: return "DeepSeek"
        case .alibaba: return "Qwen"
        case .xai: return "xAI"
        case .mistral: return "Mistral"
        case .meta: return "Meta"
        case .unknown: return ""
        }
    }
}

enum ModelProviderRules {
    /// Substrings identifying a provider from a model id, most specific first.
    static let markers: [(ADModelProvider, [String])] = [
        (.anthropic, [
            "claude",
            "opus",
            "sonnet",
            "haiku",
            "fable",
        ]),
        (.openai, [
            "gpt-",
            "gpt.",
            "o1-",
            "o3-",
            "o4-",
            "codex-",
            "davinci",
            "chatgpt",
        ]),
        (.google, [
            "gemini",
            "gemma",
            "palm-",
        ]),
        (.zai, [
            "glm",
            "z-ai",
            "zai",
        ]),
        (.moonshot, [
            "kimi",
            "moonshot",
        ]),
        (.deepseek, [
            "deepseek",
        ]),
        (.alibaba, [
            "qwen",
            "qwq",
        ]),
        (.xai, [
            "grok",
        ]),
        (.mistral, [
            "mistral",
            "magistral",
            "devstral",
            "codestral",
            "mixtral",
        ]),
        (.meta, [
            "llama",
        ]),
    ]

    /// Vendor halves of `vendor/model` ids.
    static let vendorPrefixes: [String: ADModelProvider] = [
        "anthropic": .anthropic,
        "openai": .openai,
        "google": .google,
        "google-vertex": .google,
        "zai": .zai,
        "z-ai": .zai,
        "zhipu": .zai,
        "moonshot": .moonshot,
        "moonshotai": .moonshot,
        "deepseek": .deepseek,
        "alibaba": .alibaba,
        "qwen": .alibaba,
        "xai": .xai,
        "mistral": .mistral,
        "meta": .meta,
    ]

    /// The provider a harness talks to when nobody redirected it. Absent for
    /// the multi-provider harnesses (OpenClaw, OpenCode, Antigravity, Kiro) —
    /// they have no native provider, which is what keeps them from wearing a
    /// permanent "off-harness" badge for doing exactly what they are for.
    static let harnessNative: [String: ADModelProvider] = [
        "claude": .anthropic,
        "claude-code": .anthropic,
        "codex": .openai,
        "codex-cli": .openai,
        "codex-app": .openai,
    ]

    /// Name the provider behind a model id, or `.unknown`.
    static func provider(model: String?) -> ADModelProvider {
        let raw = (model ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if raw.isEmpty { return .unknown }

        var id = raw
        if let slash = raw.firstIndex(of: "/"), slash != raw.startIndex {
            if let vendor = vendorPrefixes[String(raw[raw.startIndex..<slash])] { return vendor }
            id = String(raw[raw.index(after: slash)...])
        }
        for (provider, markers) in markers {
            for marker in markers where id.contains(marker) { return provider }
        }
        return .unknown
    }

    static func harnessNativeProvider(agentType: String?) -> ADModelProvider {
        let key = (agentType ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return harnessNative[key] ?? .unknown
    }

    /// The provider to badge, or nil for "say nothing".
    ///
    /// Non-nil only when BOTH sides are known and disagree. Two unknowns must
    /// never combine into a claim: absence of evidence is not evidence of
    /// redirection.
    static func offHarnessProvider(agentType: String?, model: String?) -> ADModelProvider? {
        let native = harnessNativeProvider(agentType: agentType)
        if native == .unknown { return nil }
        let actual = provider(model: model)
        if actual == .unknown || actual == native { return nil }
        return actual
    }

    /// Badge text for a session row — empty when there is nothing to say.
    static func offHarnessProviderLabel(agentType: String?, model: String?) -> String {
        offHarnessProvider(agentType: agentType, model: model)?.label ?? ""
    }
}
