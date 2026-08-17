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
    /// Child-agent identity — the dispatch burst id on the `tool_exec` row, the
    /// child's own id on its `tool_resolved` row. Mirrors
    /// `TimelineEntry.subagentId`.
    ///
    /// These rows are structural, not content: a fan-out of eight children of
    /// one `agent_type` produces eight byte-identical raw strings in the same
    /// instant, which content dedup reads as one row. Keying off an id is what
    /// lets identical-looking siblings coexist.
    var subagentId: String? = nil
}

actor DaemonTimelineStore {
    private var entries: [DaemonTimelineEntry] = []
    private let maxEntries = 200
    /// Separate retention cap for task hierarchy rows — mirrors
    /// `BridgeTimelineStore.MAX_TASK_ENTRIES`. Task rows are exempt from the
    /// generic FIFO so a long task's `task_start` doesn't scroll away while
    /// its turns stream in (which would leave the `task_end` unpaired).
    private let maxTaskEntries = 60

    static func isTaskRow(_ e: DaemonTimelineEntry) -> Bool {
        e.type == "task_start" || e.type == "task_end" || e.type == "task_milestone"
    }

    /// Compact human duration for an elapsed span of seconds — "42s",
    /// "5m 12s", "1h 2m" (zero remainders dropped). Mirror of the canonical
    /// TS `formatDurationSec` in shared/src/format-utils.ts; keep in sync.
    static func formatDurationSec(_ sec: Int) -> String {
        let s = max(0, sec)
        if s < 60 { return "\(s)s" }
        if s < 3600 {
            let m = s / 60
            let r = s % 60
            return r > 0 ? "\(m)m \(r)s" : "\(m)m"
        }
        let h = s / 3600
        let rm = (s % 3600) / 60
        return rm > 0 ? "\(h)h \(rm)m" : "\(h)h"
    }
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

        // Task hierarchy rows bypass exact dedup — they're keyed by taskId, not
        // content, so two `task_milestone` rows carrying identical raw
        // ("Todos done") from different tasks within the 8s window must not
        // collapse. Mirrors the bypass in shared/src/timeline.ts deduplicateEntry.
        // Subagent rows bypass it for the same reason: siblings of one fan-out
        // share an `agent_type` and therefore a raw string, and they start in
        // the same millisecond — content dedup read a burst of eight as one row
        // and silently discarded the other seven.
        if !Self.isTaskRow(entry), entry.subagentId == nil {
            // Exact dedup: same ts + type + raw within 8s.
            // Window matches shared/src/timeline.ts deduplicateEntry — covers the
            // PTY-fallback / Stop-hook race that can leak two identical chat_response
            // entries when Claude Code's transcript flush lags spinner_stop by a few
            // seconds.
            let recentWindow = entry.ts - 8000
            if entries.last(where: { $0.ts > recentWindow && $0.type == entry.type && $0.raw == entry.raw }) != nil {
                return
            }
        }

        insertSorted(entry)
        while entries.count > maxEntries {
            evictOne()
        }
        dirty = true
        flush()
    }

    /// Insert keeping `entries` ascending by ts. Live emits normally arrive
    /// in order (append fast-path), but the deferred `task_start` row is
    /// backdated to the task's original startedAt when it's promoted on the
    /// second turn — a plain append lands it BELOW the turns it groups and
    /// every consumer renders the TASK header out of position until the
    /// next full reload re-sorts.
    private func insertSorted(_ entry: DaemonTimelineEntry) {
        if let last = entries.last, entry.ts < last.ts {
            let idx = entries.lastIndex(where: { $0.ts <= entry.ts }).map { $0 + 1 } ?? 0
            entries.insert(entry, at: idx)
        } else {
            entries.append(entry)
        }
    }

    /// Evict a single entry to enforce `maxEntries`, protecting task rows —
    /// mirrors `BridgeTimelineStore.evictOne`. Task rows only leave under
    /// their own cap, and an in-flight task's `task_start` (no matching
    /// `task_end` yet) is never evicted.
    private func evictOne() {
        let taskRowCount = entries.lazy.filter { Self.isTaskRow($0) }.count
        if taskRowCount > maxTaskEntries {
            let closed = Set(entries.compactMap { $0.type == "task_end" ? $0.taskId : nil })
            if let idx = entries.firstIndex(where: { e in
                guard Self.isTaskRow(e) else { return false }
                if e.type == "task_start", let id = e.taskId, !closed.contains(id) { return false }
                return true
            }) {
                entries.remove(at: idx)
                return
            }
        }
        // Shed the oldest `tool_exec` before any chat/turn row — mirrors the
        // Node `BridgeTimelineStore.evictOne`. PTY `agentdeck claude` sessions
        // emit a claude-code tool_exec per tool action (index.ts:1552), and
        // only *codex* tool_exec is dropped at storage, so these accumulate.
        // Undifferentiated FIFO would evict a turn's chat_start (the oldest ts
        // in its turn) before its own tool rows, orphaning the response in a
        // reconnecting client's `timeline_history`. tool_exec is standalone (no
        // request/resolved pair to split), so shedding it first is safe and
        // keeps the two daemons' replay buffers converged.
        //
        // Subagent dispatch rows are the exception: they pair with the
        // children's `tool_resolved` rows exactly the way a `task_start` pairs
        // with its `task_end`. Shedding them first inverted the rule's intent —
        // fan-out sessions produce the most tool_exec rows, so the dispatch row
        // was always the first casualty and the completions read as unattached.
        if let idx = entries.firstIndex(where: { $0.type == "tool_exec" && $0.subagentId == nil }) {
            entries.remove(at: idx)
            return
        }
        if let idx = entries.firstIndex(where: { !Self.isTaskRow($0) }) {
            entries.remove(at: idx)
            return
        }
        // Pathological: buffer is 100% in-flight task rows — plain FIFO so the
        // buffer stays bounded.
        entries.removeFirst()
    }

    func upsert(_ entry: DaemonTimelineEntry, bypassSuppression: Bool = false) {
        guard let entry = Self.normalizeForStorage(entry) else { return }
        // A dispatch burst is keyed by id, not by timestamp: a fan-out can keep
        // growing for the whole burst window, and matching on `ts` would fork a
        // second row the moment a sibling arrived a millisecond later.
        if let subagentId = entry.subagentId, !subagentId.isEmpty {
            if let idx = entries.lastIndex(where: { $0.subagentId == subagentId }) {
                entries[idx] = entry
                dirty = true
                flush()
            } else {
                add(entry, bypassSuppression: bypassSuppression)
            }
            return
        }
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

    /// Recent entries attributed to one session (newest-last), for the
    /// `query_session_timeline` poll. `since` is an epoch-ms lower bound.
    func historyForSession(_ sessionId: String, since: Double? = nil, limit: Int = 16) -> [DaemonTimelineEntry] {
        // sessions_list ids for observed sessions are prefixed ("observed:claude:<uuid>")
        // while entries are keyed by the raw uuid — accept either.
        //
        // This is the route a DEVICE takes to pull a session's timeline
        // (`query_session_timeline`), and the inlined list it used to carry had
        // drifted twice over: no Kiro and no codex-app, so both agents' rows
        // were unreachable from every device talking to the Swift daemon.
        let raw = ObservedAgentRules.rawSessionId(sessionId)
        let matched = entries.filter {
            ($0.sessionId == sessionId || $0.sessionId == raw) && (since == nil || $0.ts > since!)
        }
        // `limit` applies to the chat/tool stream; task hierarchy rows ride
        // along in full so a task_start older than the last `limit` rows
        // doesn't vanish and leave the Detail view an unpaired task_end.
        let taskRows = matched.filter { Self.isTaskRow($0) }
        let rest = matched.filter { !Self.isTaskRow($0) }.suffix(limit)
        return (taskRows + rest).sorted { $0.ts < $1.ts }
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
        let normalized = loaded.compactMap { Self.normalizeForStorage($0) }
        // Task-protected trim (mirrors BridgeTimelineStore.loadPersistedEntries):
        // task rows keep their own deeper retention on reload.
        let taskRows = normalized.filter { Self.isTaskRow($0) }.suffix(maxTaskEntries)
        let rest = normalized.filter { !Self.isTaskRow($0) }.suffix(maxEntries - taskRows.count)
        entries = (taskRows + rest).sorted { $0.ts < $1.ts }
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
        if Self.isOpenClawLowSignalResponse(entry) {
            return true
        }

        guard entry.type == "tool_exec" || entry.type == "tool_request" || entry.type == "tool_resolved" else {
            return false
        }
        // Already coalesced lifecycle row, not observed per-tool churn.
        if entry.type == "tool_exec",
           entry.raw.trimmingCharacters(in: .whitespacesAndNewlines).hasPrefix("Subagent ") {
            return false
        }
        // Observed-agent tool hooks fire for every internal Bash/MCP/read/
        // todowrite action and can easily evict the actual turn/task rows from
        // the bounded timeline. APME still ingests the hook trajectory; the
        // device timeline keeps their chat/task lifecycle rows only. OpenCode
        // had no suppression and flooded the strip with one row per tool while
        // Claude/Codex read clean. Antigravity is included forward-compat (the
        // observed-hook classifier already accepts antigravity_* events).
        if (entry.agentType == "codex-cli" || entry.agentType == "codex-app" || entry.agentType == "opencode" || entry.agentType == "antigravity"), entry.type == "tool_exec" {
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

    static func isOpenClawLowSignalResponse(_ entry: DaemonTimelineEntry) -> Bool {
        guard entry.agentType == "openclaw" else { return false }
        let isResponse = entry.type == "chat_response" || entry.type == "model_response"
        let isAutomatedStart = entry.type == "chat_start" && entry.automated == true
        guard isResponse || isAutomatedStart else { return false }

        let text = ([entry.raw, entry.detail].compactMap { $0 }.joined(separator: "\n"))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        if Self.hasOpenClawNotificationFailureSignal(text) { return false }

        let lower = text.lowercased()
        let hasNoReply = lower.contains("no_reply")
        let looksLikePolling =
            Self.matches(lower, #"still translating"#) ||
            Self.matches(lower, #"translation still in progress"#) ||
            Self.matches(lower, #"not all .*?(terminal|published|failed|complete|completed)"#) ||
            Self.matches(lower, #"(in progress|still active|no action needed|nothing to notify yet)"#) ||
            Self.matches(lower, #"cron job (stays|retained|active)"#) ||
            Self.matches(lower, #"pipeline still active"#) ||
            Self.matches(text, #"(아직|여전히|계속).*(번역|진행)\s*중"#) ||
            Self.matches(text, #"알릴 필요 없음|수행할 작업이 없음|대기합니다"#)

        if isAutomatedStart { return looksLikePolling }
        return looksLikePolling &&
            (hasNoReply || lower.contains("no action needed") || lower.contains("nothing to notify yet") || text.contains("알릴 필요 없음"))
    }

    private static func hasOpenClawNotificationFailureSignal(_ text: String) -> Bool {
        let english = Self.matches(text, #"\b(line|notification|userid|target id|target issue)\b"#, caseInsensitive: true) &&
            Self.matches(text, #"\b(fail(ed|ure)?|missing|unconfigured|notified|needed|pending)\b"#, caseInsensitive: true)
        let korean = Self.matches(text, #"(LINE|알림|userId|사용자 ID|대상 ID).*(실패|미등록|미설정|구성되지|필요|대기)"#, caseInsensitive: true)
        return english || korean
    }

    private static func matches(_ text: String, _ pattern: String, caseInsensitive: Bool = false) -> Bool {
        var options: String.CompareOptions = [.regularExpression]
        if caseInsensitive { options.insert(.caseInsensitive) }
        return text.range(of: pattern, options: options) != nil
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
