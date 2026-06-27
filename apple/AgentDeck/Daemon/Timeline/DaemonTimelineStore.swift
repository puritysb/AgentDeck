#if os(macOS)
// TimelineStore.swift — In-memory timeline event storage with disk persistence
// Ported from bridge/src/timeline-store.ts

import Foundation

struct DaemonTimelineEntry: Codable, Sendable {
    let ts: Double  // milliseconds
    let type: String
    var raw: String
    var detail: String?
    var approvalId: String?
    var status: String?
    var agentType: String?
    var repeatCount: Int?
    var automated: Bool?
    /// Project name + session id of the originating session. Mirrors the
    /// equivalent fields on `TimelineEntry` (UI-facing copy) so entries
    /// round-tripped through the on-disk timeline keep per-session
    /// attribution. Existing persisted entries without these keys decode
    /// to nil via Codable's default optional-missing-key behaviour.
    var projectName: String?
    var sessionId: String?
    var startedAt: Double?
    var endedAt: Double?
    /// OpenClaw Gateway runId — groups entries belonging to the same
    /// generation cycle so clients can cluster them into a single turn row.
    var runId: String?
    /// Which backend produced the row's `raw` summary text — set by
    /// `appendClaudeCodeChatEnd` / `appendCodexChatEnd` once
    /// `TimelineSummarizer.summarize` returns. Values: `"appleIntelligence"`,
    /// `"mlx"`, `"ollama"`, `"heuristic"`. Nil for pre-existing entries on
    /// disk (Codable's optional-missing-key behaviour) and for rows where
    /// summarization isn't applicable (Gateway pass-through, tool events).
    var summaryKind: String?
    /// APME task id. Set on `task_start` / `task_end` rows so the dashboard
    /// `timelineIsInFlightTask` check can pair them. Without this field the
    /// pair lookup fails (UI guard returns false on nil) and the leading
    /// task icon spins forever after `/clear`. Mirrors `TimelineEntry.taskId`
    /// in shared/src/timeline.ts. Default = nil so existing call sites that
    /// only pass core fields (chat/tool/error rows) keep compiling.
    var taskId: String? = nil
    /// Why a `task_end` row closed — `"todo_complete"`, `"clear"`,
    /// `"session_end"`, `"manual"`, `"idle_gap"`, etc. Mirrors
    /// `TimelineEntry.boundarySignal`. Only meaningful on `task_end`.
    var boundarySignal: String? = nil
    /// Task-judge verdict, attached on the SECOND `task_end` emit the runner
    /// fires once the LLM judge resolves (5–30 s after the initial boundary).
    /// `upsert(_:)` merges by (type=="task_end", taskId) and updates the
    /// existing row in place, so dashboard task headers see the score badge
    /// arrive without a duplicate row. Mirrors the four task-* fields on
    /// `shared/src/timeline.ts::TimelineEntry`. Nil on the first emit /
    /// for pre-existing on-disk rows (Codable optional default).
    ///   - `taskScore`   : 0..1 composite (matches `tasks.composite_score`)
    ///   - `taskOutcome` : `"success" | "partial" | "fail" | "pending"`
    ///   - `taskCategory`: task_rollup category
    ///   - `taskSummary` : one-line judge summary
    var taskScore: Double? = nil
    var taskOutcome: String? = nil
    var taskCategory: String? = nil
    var taskSummary: String? = nil
}

actor DaemonTimelineStore {
    private var entries: [DaemonTimelineEntry] = []
    private let maxEntries = 200
    private let persistFile: URL
    private var dirty = false
    private var persistenceStarted = false
    // .userInteractive: DaemonServer.startServices calls start() →
    // loadFromDisk() from the main actor and sync-waits via DispatchSemaphore.
    // .userInitiated still leaves a one-step inversion (User-interactive →
    // User-initiated) that TPC flags. Single Data(contentsOf:) capped at
    // 700 ms — bounded enough to justify the elevated QoS on the main-actor
    // startup critical path.
    private static let ioQueue = DispatchQueue(label: "dev.agentdeck.timeline.io", qos: .userInteractive)

    init(persistFile: URL? = nil) {
        self.persistFile = persistFile ?? AuthManager.agentDeckDir.appendingPathComponent("timeline.json")
        // loadFromDisk is called after actor init via start()
    }

    func start() {
        persistenceStarted = true
        loadFromDisk()
    }

    /// Chat/tool entry types that, in projection mode, derive from the
    /// SessionSample projection instead of the adapters' direct emitters.
    static let projectedTypes: Set<String> = [
        "chat_start", "chat_response", "chat_end", "tool_request", "tool_resolved", "tool_exec",
    ]

    /// Phase 6 cutover (default OFF). When true, locally-emitted chat/tool rows
    /// are dropped; the SessionSample projection (added via `bypassSuppression`)
    /// becomes the single source. Mirrors BridgeTimelineStore.
    private var suppressLocalChatTool = false
    func setSuppressLocalChatTool(_ v: Bool) { suppressLocalChatTool = v }

    func add(_ entry: DaemonTimelineEntry, bypassSuppression: Bool = false) {
        if suppressLocalChatTool, !bypassSuppression, Self.projectedTypes.contains(entry.type) {
            return
        }
        guard let entry = Self.normalizeForStorage(entry) else { return }

        // Exact dedup: same ts + type + raw within 8s.
        // Window matches shared/src/timeline.ts deduplicateEntry — covers the
        // PTY-fallback / Stop-hook race that can leak two identical chat_response
        // entries when Claude Code's transcript flush lags spinner_stop by a few
        // seconds.
        let recentWindow = entry.ts - 8000
        if entries.last(where: { $0.ts > recentWindow && $0.type == entry.type && $0.raw == entry.raw }) != nil {
            return
        }

        entries.append(entry)
        if entries.count > maxEntries {
            entries.removeFirst(entries.count - maxEntries)
        }
        dirty = true
        flush()
    }

    func upsert(_ entry: DaemonTimelineEntry) {
        guard let entry = Self.normalizeForStorage(entry) else { return }
        // task_end follow-up emits land 5–30 s later than the initial boundary
        // emit, so the original (ts, type) key won't match. Prefer matching by
        // (type=="task_end", taskId) — the taskId is stable across both emits.
        if entry.type == "task_end", let taskId = entry.taskId, !taskId.isEmpty,
           let idx = entries.lastIndex(where: { $0.type == "task_end" && $0.taskId == taskId }) {
            entries[idx] = entry
            dirty = true
            flush()
            return
        }
        if let idx = entries.lastIndex(where: { $0.ts == entry.ts && $0.type == entry.type }) {
            entries[idx] = entry
            dirty = true
        } else {
            add(entry)
            return
        }
        flush()
    }

    func getAll() -> [DaemonTimelineEntry] { entries }

    func getRecent(_ count: Int = 50) -> [DaemonTimelineEntry] {
        Array(entries.suffix(count))
    }

    /// Returns the last timeline entry matching the given type, or nil if none found.
    func getLastEntry(type: String) -> DaemonTimelineEntry? {
        entries.last(where: { $0.type == type })
    }

    func flush() {
        guard dirty, persistenceStarted else { return }
        if let data = try? JSONEncoder().encode(entries) {
            let persistFile = persistFile
            Self.ioQueue.async {
                try? data.write(to: persistFile)
            }
        }
        dirty = false
    }

    private func loadFromDisk() {
        let box = TimelineDataBox()
        let semaphore = DispatchSemaphore(value: 0)
        let persistFile = persistFile
        Self.ioQueue.async {
            box.set(try? Data(contentsOf: persistFile))
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + .milliseconds(700)) == .success,
              let data = box.get(),
              let loaded = try? JSONDecoder().decode([DaemonTimelineEntry].self, from: data) else { return }
        entries = Array(loaded.compactMap { Self.normalizeForStorage($0) }.suffix(maxEntries))
    }

    // Exposed (default internal) so test targets can drive the predicate
    // directly via `@testable import AgentDeck`. The store's `add()` path
    // already exercises it, but a pure-function test gives sharper
    // failure messages than reading back `getAll()` after an actor hop.
    //
    // **Detail gate**: a placeholder-raw entry is only kept when its
    // `detail` carries content beyond a bare `status: ...` line. The
    // OpenClaw producer's detail format is
    //   `[status: X]\n[input: ...]\n[output: ...]`
    // with each line independently optional — so an entry with detail
    // "status: running" alone is still placeholder noise (just an ack
    // of state, no tool/payload to inspect). Only `input:` / `output:`
    // lines (or any non-status line) qualify as real signal. Codex
    // stop-time review 2026-05-18.
    static func shouldDropLowSignalEntry(_ entry: DaemonTimelineEntry) -> Bool {
        guard entry.type == "tool_exec" || entry.type == "tool_request" || entry.type == "tool_resolved" else {
            return false
        }
        // Codex tool hooks fire for every internal Bash/MCP action and can
        // easily evict the actual turn/task rows from the bounded timeline.
        // APME still ingests the hook trajectory; the device timeline keeps
        // Codex chat/task lifecycle rows only.
        if (entry.agentType == "codex-cli" || entry.agentType == "codex-app"), entry.type == "tool_exec" {
            return true
        }
        // Real signal in detail → keep regardless of placeholder raw.
        if Self.detailHasRealSignal(entry.detail) {
            return false
        }
        let raw = entry.raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if (entry.agentType == "codex-cli" || entry.agentType == "codex-app"), entry.sessionId == "codex:otel-active" {
            return ["tool", "tool completed", "unknown", "unknown completed", "exec", "exec completed"].contains(raw)
        }
        // OpenClaw session.tool placeholder rows. The producer guard added
        // 2026-05-18 drops new placeholders at source, but historical
        // entries persisted to timeline.json before that fix still leak
        // through on load — also catch tool_exec rows whose raw devolves
        // to just the literal "tool" placeholder name (with optional
        // status suffix). Always-empty rows that pre-date the fix.
        //
        // **Structural match, not enumerated**: the OpenClaw producer
        // formats raw as `"{toolName} · {status}"` and Gateway's
        // `SessionToolPayload.status` is a free-form String (not an
        // enum), so listing specific statuses (running/complete/pending/
        // error) misses `failed`, `aborted`, `canceled`, and anything
        // upstream adds tomorrow. Match the placeholder *name* portion
        // ("tool") + any status suffix, instead of enumerating statuses.
        // Codex stop-time review 2026-05-18 (third round) flagged
        // `failed` slipping past the enumerated set.
        if entry.agentType == "openclaw" {
            return Self.isOpenClawPlaceholderRaw(raw)
        }
        return false
    }

    static func normalizeForStorage(_ entry: DaemonTimelineEntry) -> DaemonTimelineEntry? {
        guard !Self.shouldDropLowSignalEntry(entry) else { return nil }
        guard entry.agentType == "openclaw",
              entry.type == "model_call",
              (entry.automated == true || Self.isOpenClawCronPrompt(entry.raw) || Self.isOpenClawCronPrompt(entry.detail)),
              (Self.isOpenClawCronPrompt(entry.raw) || Self.isOpenClawCronPrompt(entry.detail)) else {
            return entry
        }
        var normalized = entry
        let source = Self.isOpenClawCronPrompt(entry.raw) ? entry.raw : entry.detail
        normalized.raw = Self.summarizeOpenClawCronPrompt(source)
        normalized.detail = nil
        normalized.automated = true
        normalized.summaryKind = normalized.summaryKind ?? "heuristic"
        return normalized
    }

    static func isOpenClawCronPrompt(_ text: String?) -> Bool {
        guard let text else { return false }
        return text.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("[cron:")
    }

    static func summarizeOpenClawCronPrompt(_ text: String?) -> String {
        guard let text else { return "자동 작업" }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let end = trimmed.firstIndex(of: "]") else { return "자동 작업" }
        let header = String(trimmed[..<end])
        let parts = header.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
        guard parts.count == 2 else { return "자동 작업" }
        let job = String(parts[1])
            .replacingOccurrences(of: "[-_]+", with: " ", options: .regularExpression)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !job.isEmpty else { return "자동 작업" }
        let capped = job.count > 64 ? String(job.prefix(61)) + "..." : job
        return "자동 작업 · \(capped)"
    }

    /// True when `raw` (already lowercased + trimmed) is an OpenClaw
    /// placeholder — either the bare fallback `"tool"` or
    /// `"tool · <status>"` for any status string. Exposed default-
    /// internal for direct testing of the structural contract.
    static func isOpenClawPlaceholderRaw(_ raw: String) -> Bool {
        return raw == "tool" || raw.hasPrefix("tool · ")
    }

    /// True when `detail` has at least one non-empty line that isn't a
    /// `status: ...` ack — that's the signal threshold worth keeping a
    /// placeholder-raw row visible for. Matches the OpenClaw producer's
    /// detail composition (`status:` / `input:` / `output:` lines), so an
    /// `input: {...}` or `output: {...}` line passes; `status: running`
    /// alone does not. Exposed default-internal for direct testing.
    static func detailHasRealSignal(_ detail: String?) -> Bool {
        guard let detail else { return false }
        for rawLine in detail.split(omittingEmptySubsequences: true, whereSeparator: { $0 == "\n" || $0 == "\r" }) {
            let trimmed = rawLine.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            if !trimmed.lowercased().hasPrefix("status:") {
                return true
            }
        }
        return false
    }
}

private final class TimelineDataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Data?

    func set(_ value: Data?) {
        lock.lock()
        self.value = value
        lock.unlock()
    }

    func get() -> Data? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}
#endif
