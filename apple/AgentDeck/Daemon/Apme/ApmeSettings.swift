#if os(macOS)
// ApmeSettings.swift — APME configuration loader (Swift mirror of settings.ts).
//
// App Store-safe judge backends: Foundation Models (on-device), MLX local
// server, and Anthropic API are wired without subprocesses. OpenClaw remains
// in the enum for schema forward-compatibility with bridge/src/apme/settings.ts.
//
// Config source of truth: ~/.agentdeck/settings.json  { "apme": { ... } }
// The file is shared with the Node.js bridge, so both stacks read/write the same
// schema. Callers must not mutate the file from multiple processes concurrently.

import Foundation

// MARK: - Judge backend

/// Supported judge backends. `openclaw` currently round-trips settings written
/// by the Node bridge; the Swift runner degrades it to Foundation Models until
/// that adapter is wired locally.
enum ApmeJudgeBackend: String, Codable {
    case foundationModels = "foundationModels"
    case mlx
    case api
    case openclaw
    /// Generic OpenAI-compatible chat-completions (Ollama / OpenRouter /
    /// LM Studio / vLLM / any OpenAI-shaped endpoint). Distinguished from
    /// `mlx` only by config UX; both speak /v1/chat/completions.
    case openai

    /// Tolerate unknown/future backend strings by falling back to the
    /// default chain's first leg instead of throwing during Codable decode.
    /// Mirrors settings.ts, which resets an unknown backend to `mlx`.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ApmeJudgeBackend(rawValue: raw) ?? .mlx
    }
}

struct ApmeJudgeConfig: Codable {
    /// Default = local MLX, with on-device Foundation Models as the fallback
    /// leg (`fallbackToFoundationModels`). Both are free and local; the order
    /// is the measured judge-quality order — see settings.ts's header for the
    /// 2026-08-22 model-eval numbers (FM 0.580 on judge-fidelity, and a hard
    /// 4,096-token window that refuses 4.2% of this machine's real rollup
    /// judge prompts) — and FM stays the floor so a Mac with no MLX server
    /// still produces evals.
    var backend: ApmeJudgeBackend = .mlx
    /// Model id — unused for `foundationModels` (system picks on-device model),
    /// retained for forward-compat with other backends.
    var model: String = "default"
    /// Fraction of closed runs that trigger a layer-2 judge call (0..1).
    var sampleRate: Double = 1.0
    /// Only judge runs where layer-1 signal is ambiguous. Phase 1 has no layer-1,
    /// so this has no effect for code runs; for turn-level evals it's also bypassed.
    var onlyWhenDisagreement: Bool = false
    /// Optional custom endpoint — unused for `foundationModels`.
    var endpoint: String?
    /// Bearer key for the `openai` backend (OpenRouter etc.). Optional for
    /// local servers (Ollama/LM Studio). Also read by `api` (Anthropic).
    var apiKey: String?
    /// `reasoning_effort` for the OpenAI-compatible leg — `none` is how a user
    /// stops a local reasoning model spending the output cap on thinking
    /// tokens. Node has read this since the field existed; this daemon did not,
    /// so identical settings produced a thinking-enabled request here that came
    /// back `finish_reason: "length"` (#286 item 2). Values mirror settings.ts:
    /// none | low | medium | high | max; anything else is not a choice and is
    /// dropped rather than forwarded.
    var reasoningEffort: String?
    /// When the MLX server does not answer, retry on-device Foundation Models
    /// instead of skipping the eval. True for the DEFAULT only: a user who
    /// names `mlx` and whose server is offline still gets a visible skip
    /// rather than a silent downgrade (the rule `callJudge` already stated).
    var fallbackToFoundationModels: Bool = true
}

struct ApmeDeterministicConfig: Codable {
    /// Phase 1: deterministic layer is never run from the Swift daemon (sandbox
    /// can't spawn processes into user project paths). The flag is preserved for
    /// config round-trip but `runner.runOne` always reports layer1Ran=false.
    var enabled: Bool = false
    var timeoutSec: Int = 180
}

struct ApmeConfig: Codable {
    var enabled: Bool = true
    var deterministic: ApmeDeterministicConfig = ApmeDeterministicConfig()
    var judge: ApmeJudgeConfig = ApmeJudgeConfig()
    var availableModels: [String] = []
}

// MARK: - LLM MLX pin

/// Single source of truth for which MLX model AgentDeck uses across
/// probe, timeline summarizer, and APME judge. Mirrors
/// shared/src/llm-settings.ts (MlxSettings). See plan mlx-atomic-minsky.
struct LlmMlxConfig: Codable {
    /// Base URL (no /chat/completions suffix). Default: 127.0.0.1:8800.
    var endpoint: String = "http://127.0.0.1:8800"
    /// Pinned model id. `nil` means auto-detect from `/v1/models`.
    var model: String?
}

private let placeholderModelIds: Set<String> = ["", "default", "qwen3-30b"]

private func isPlaceholderModel(_ m: String?) -> Bool {
    guard let m = m?.trimmingCharacters(in: .whitespaces) else { return true }
    return placeholderModelIds.contains(m)
}

private func stripChatSuffix(_ url: String) -> String {
    var s = url
    for suffix in ["/v1/chat/completions", "/chat/completions"] {
        if s.hasSuffix(suffix) {
            s = String(s.dropLast(suffix.count))
        }
    }
    return s
}

private final class ApmeSettingsDataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?

    func set(_ data: Data?) {
        lock.lock()
        self.data = data
        lock.unlock()
    }

    func get() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return data
    }
}

// MARK: - Loader

enum ApmeSettings {
    /// Path to the shared settings file. Env override (used by tests) takes
    /// precedence; otherwise we route through `AgentDeckPaths` so signed
    /// App Store builds land in the sandbox data container.
    static var settingsPath: String {
        if let override = ProcessInfo.processInfo.environment["AGENTDECK_DATA_DIR"] {
            return (override as NSString).appendingPathComponent("settings.json")
        }
        return AgentDeckPaths.settingsJson.path
    }

    // .userInteractive: ApmeRunner.init and DaemonServer.probeMLX call
    // load()/loadMlxConfig() from the main actor and sync-wait via
    // DispatchSemaphore. .userInitiated still leaves a one-step inversion
    // (User-interactive → User-initiated) that TPC flags. Bounded by the
    // 700 ms timeout + single Data(contentsOf:), so promoting to
    // .userInteractive is safe.
    private static let settingsReadQueue = DispatchQueue(label: "dev.agentdeck.apme-settings.read", qos: .userInteractive)
    private static let settingsReadTimeout: DispatchTimeInterval = .milliseconds(700)

    /// Load APME config from ~/.agentdeck/settings.json.
    /// Returns defaults on any failure — the daemon must keep booting.
    static func load() -> ApmeConfig {
        guard let data = readSettingsDataBounded(),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return ApmeConfig()
        }
        guard let apme = json["apme"] as? [String: Any] else {
            return ApmeConfig()
        }

        var cfg = ApmeConfig()
        if let enabled = apme["enabled"] as? Bool { cfg.enabled = enabled }

        if let det = apme["deterministic"] as? [String: Any] {
            if let e = det["enabled"] as? Bool { cfg.deterministic.enabled = e }
            if let t = det["timeoutSec"] as? Int { cfg.deterministic.timeoutSec = max(5, min(1800, t)) }
        }

        if let judge = apme["judge"] as? [String: Any] {
            if let b = judge["backend"] as? String,
               let parsed = ApmeJudgeBackend(rawValue: b) {
                cfg.judge.backend = parsed
                // The user NAMED a backend, so the default chain's FM leg is
                // off unless they asked for it. An unparseable/unknown string
                // is not a choice — it leaves the default (and its fallback)
                // in place, matching settings.ts.
                cfg.judge.fallbackToFoundationModels = judge["fallbackToFoundationModels"] as? Bool ?? false
            } else if let f = judge["fallbackToFoundationModels"] as? Bool {
                cfg.judge.fallbackToFoundationModels = f
            }
            if let m = judge["model"] as? String { cfg.judge.model = m }
            if let s = judge["sampleRate"] as? Double { cfg.judge.sampleRate = max(0, min(1, s)) }
            if let s = judge["sampleRate"] as? Int { cfg.judge.sampleRate = max(0, min(1, Double(s))) }
            if let d = judge["onlyWhenDisagreement"] as? Bool { cfg.judge.onlyWhenDisagreement = d }
            if let ep = judge["endpoint"] as? String { cfg.judge.endpoint = ep }
            if let k = judge["apiKey"] as? String, !k.isEmpty { cfg.judge.apiKey = k }
            if let e = judge["reasoningEffort"] as? String,
               ["none", "low", "medium", "high", "max"].contains(e) {
                cfg.judge.reasoningEffort = e
            }
        }

        if let models = apme["availableModels"] as? [String] { cfg.availableModels = models }

        return cfg
    }

    // MARK: LLM MLX pin

    nonisolated(unsafe) private static var mlxCache: (at: Date, value: LlmMlxConfig)?
    private static let mlxCacheTTL: TimeInterval = 30

    /// Load llm.mlx pin (shared across probe, timeline, judge).
    /// Falls back to legacy apme.judge.{endpoint,model} for backward compat.
    /// Result is cached for 30s to avoid re-parsing settings.json on every call.
    static func loadMlxConfig() -> LlmMlxConfig {
        if let c = mlxCache, Date().timeIntervalSince(c.at) < mlxCacheTTL {
            return c.value
        }
        var cfg = LlmMlxConfig()
        if let data = readSettingsDataBounded(),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {

            if let llmMlx = (json["llm"] as? [String: Any])?["mlx"] as? [String: Any] {
                if let ep = llmMlx["endpoint"] as? String, !ep.isEmpty {
                    cfg.endpoint = stripChatSuffix(ep)
                }
                if let m = llmMlx["model"] as? String, !isPlaceholderModel(m) {
                    cfg.model = m.trimmingCharacters(in: .whitespaces)
                }
            }

            // Legacy fallback: apme.judge.{endpoint,model}
            if cfg.model == nil || cfg.endpoint == "http://127.0.0.1:8800" {
                if let judge = (json["apme"] as? [String: Any])?["judge"] as? [String: Any] {
                    if cfg.model == nil, let m = judge["model"] as? String, !isPlaceholderModel(m) {
                        cfg.model = m.trimmingCharacters(in: .whitespaces)
                    }
                    if cfg.endpoint == "http://127.0.0.1:8800",
                       let ep = judge["endpoint"] as? String, !ep.isEmpty {
                        cfg.endpoint = stripChatSuffix(ep)
                    }
                }
            }
        }
        mlxCache = (Date(), cfg)
        return cfg
    }

    /// Clear the 30s mlx config cache — used by tests or after a settings write.
    static func clearMlxCache() {
        mlxCache = nil
    }

    private static func readSettingsDataBounded() -> Data? {
        let box = ApmeSettingsDataBox()
        let semaphore = DispatchSemaphore(value: 0)
        let url = URL(fileURLWithPath: settingsPath)
        settingsReadQueue.async {
            box.set(try? Data(contentsOf: url))
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + settingsReadTimeout) == .success else {
            return nil
        }
        return box.get()
    }

    /// Decide whether layer-2 (LLM judge) should run for this run.
    /// Mirrors bridge/src/apme/settings.ts shouldJudge() semantics.
    /// Phase 1: turn-level evals ignore this gate (they always run when a response
    /// is captured); this is used for the run-level path only.
    static func shouldJudge(_ cfg: ApmeJudgeConfig, deterministicPassed: Bool?) -> Bool {
        if cfg.sampleRate <= 0 { return false }
        if cfg.onlyWhenDisagreement {
            if deterministicPassed == true { return false }
        }
        return Double.random(in: 0..<1) < cfg.sampleRate
    }
}
#endif
