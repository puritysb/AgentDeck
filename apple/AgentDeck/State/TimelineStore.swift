// TimelineStore.swift — Event buffer with grouping
// Ported from plugin/src/timeline-store.ts + android TimelineStore.kt

import Foundation
import Combine

struct SubagentVisualActivity: Equatable {
    var activeCount: Int = 0
    var lastCompletedAt: Double?

    static let none = SubagentVisualActivity()

    func merged(with other: SubagentVisualActivity) -> SubagentVisualActivity {
        SubagentVisualActivity(
            activeCount: activeCount + other.activeCount,
            lastCompletedAt: max(lastCompletedAt ?? 0, other.lastCompletedAt ?? 0) > 0
                ? max(lastCompletedAt ?? 0, other.lastCompletedAt ?? 0)
                : nil
        )
    }
}

final class TimelineStore: ObservableObject, @unchecked Sendable {
    @Published private(set) var entries: [TimelineEntry] = []
    // NOTE: no stored `grouped` here. The store used to keep a @Published
    // grouped array recomputed via groupConsecutive() on every addEntry, but
    // no view ever read it — TimelineStripView runs its own
    // groupConsecutive(filteredEntries) per render (it must, because the
    // session filter changes the grouping input). The stored copy was pure
    // duplicate work plus an extra objectWillChange fire per event.

    // Parity with Android `TimelineStore.MAX_ENTRIES` (500). The old 200-cap
    // aged real turn/task rows out faster than Android on the same stream — and
    // when macOS attaches to an external Node daemon whose store isn't OTel-
    // filtered, tool_exec noise ate the buffer even quicker (timeline data
    // audit 2026-07-13).
    private let maxEntries = 500
    /// Task hierarchy rows are exempt from the generic FIFO so a long task's
    /// `task_start` doesn't scroll away while its turns stream in (which would
    /// render an unpaired `task_end`). Mirrors `DaemonTimelineStore.maxTaskEntries`
    /// / Node `BridgeTimelineStore.MAX_TASK_ENTRIES` — the eviction half of the
    /// daemon store design that never made it into the client store.
    private let maxTaskEntries = 60

    private static func isTaskRow(_ e: TimelineEntry) -> Bool {
        e.type == .taskStart || e.type == .taskEnd || e.type == .taskMilestone
    }

    /// Whether we're receiving timeline from bridge (suppress local generation)
    @Published var receivingBridgeTimeline = false

    /// `Subagent ×8 dispatched · researcher` → 8; anything else → 1.
    static func subagentBurstCount(_ raw: String) -> Int {
        guard raw.hasPrefix("Subagent ×") else { return 1 }
        let digits = raw.dropFirst("Subagent ×".count).prefix { $0.isNumber }
        return Int(digits).flatMap { $0 > 0 ? $0 : nil } ?? 1
    }

    /// Parent/child decoration derived from timeline rows.
    ///
    /// **This is the fallback path.** `SessionInfo.subagents` carries the
    /// daemon's own census and is authoritative wherever present; prefer it
    /// (see `MonitorScreen.subagentActivityForTerrarium`). This exists for what
    /// the wire field cannot cover — a rehydrated timeline from an older daemon
    /// — and is inherently approximate, because the rows it reads are bounded
    /// and lossy by design: a dispatch burst folds into one upserted row, and
    /// the buffer evicts. Mirrors shared/src/subagent-activity.ts.
    func subagentActivityBySession(
        now: Double = Date().timeIntervalSince1970 * 1000,
        activeTtlMs: Double = 6 * 60 * 60 * 1000
    ) -> [String: SubagentVisualActivity] {
        struct Burst {
            let ts: Double
            let count: Int
        }

        var bursts: [String: [Burst]] = [:]
        var completed: [String: Double] = [:]
        var drained: [String: Int] = [:]
        // Latest turn close per session. A dispatch older than the parent's
        // own chat_end/chat_response is finished work: this is a FALLBACK read
        // of a lossy buffer that keeps dispatch rows but sheds the children's
        // stop rows, so without the bound a fan-out read "+8 running" for the
        // whole TTL after every daemon restart. Mirrors
        // shared/src/subagent-activity.ts.
        var turnClosed: [String: Double] = [:]
        let ordered = entries.enumerated().sorted {
            $0.element.ts == $1.element.ts
                ? $0.offset < $1.offset
                : $0.element.ts < $1.element.ts
        }

        for (_, entry) in ordered {
            guard let sessionId = entry.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !sessionId.isEmpty else { continue }
            let isSubagent = entry.raw.hasPrefix("Subagent ")
            let isTeamCompletion = entry.raw.hasPrefix("Team ")

            if entry.type == .chatEnd || entry.type == .chatResponse {
                let closedAt = entry.endedAt ?? entry.ts
                turnClosed[sessionId] = max(turnClosed[sessionId] ?? 0, closedAt)
                continue
            }

            if entry.type == .toolExec && isSubagent {
                let anchor = entry.startedAt ?? entry.ts
                let burst = Burst(ts: anchor, count: Self.subagentBurstCount(entry.raw))
                var list = bursts[sessionId, default: []]
                // A dispatch row is upserted as its burst grows, so the same
                // anchor must replace rather than accumulate.
                if let existing = list.firstIndex(where: { $0.ts == anchor }) {
                    list[existing] = burst
                } else {
                    list.append(burst)
                }
                bursts[sessionId] = list
                continue
            }
            guard entry.type == .toolResolved, isSubagent || isTeamCompletion else { continue }

            completed[sessionId] = max(completed[sessionId] ?? 0, entry.endedAt ?? entry.ts)
            guard isSubagent else { continue }
            drained[sessionId] = (drained[sessionId] ?? 0) + 1
        }

        var result: [String: SubagentVisualActivity] = [:]
        let sessionIds = Set(bursts.keys).union(completed.keys)
        for sessionId in sessionIds {
            let turnClosedAt = turnClosed[sessionId] ?? 0
            let dispatched = bursts[sessionId, default: []]
                .filter { now - $0.ts <= activeTtlMs && $0.ts >= turnClosedAt }
                .reduce(0) { $0 + $1.count }
            let activeCount = max(0, dispatched - (drained[sessionId] ?? 0))
            let lastCompletedAt = completed[sessionId]
            guard activeCount > 0 || lastCompletedAt != nil else { continue }
            result[sessionId] = SubagentVisualActivity(
                activeCount: activeCount,
                lastCompletedAt: lastCompletedAt
            )
        }
        return result
    }

    // MARK: - Add Entry

    func addEntry(_ rawEntry: TimelineEntry, upsert: Bool = false) {
        // Storage-layer OTel/tool-placeholder filter — mirrors Android
        // `TimelineStore.addEntry`/`upsertEntry` so noise never occupies a
        // buffer slot (and so `entries` readers that bypass display grouping
        // don't see it), even on the upsert enrichment path.
        guard let entry = normalizeTimelineEntryForStorage(rawEntry) else { return }
        if upsert {
            // Task-judge follow-up emits land 5–30 s after the initial
            // boundary, so matching on (ts, type) misses them. For task_end
            // rows, fall back to matching by (type, taskId) — that pair is
            // stable across both emits and lets the score-bearing update
            // merge in place. Mirrors `DaemonTimelineStore::upsert`.
            if entry.type == .taskEnd, let taskId = entry.taskId,
               let idx = entries.lastIndex(where: { $0.type == .taskEnd && $0.taskId == taskId }) {
                entries[idx] = mergedUpsert(base: entries[idx], incoming: entry)
                return
            }
            // A dispatch burst re-upserts ONE row while it grows, so key it
            // by id. The (ts, type) match below is wide enough to land on an
            // unrelated `tool_exec` from another session that arrived in the
            // same millisecond and overwrite it.
            if let subagentId = entry.subagentId, !subagentId.isEmpty {
                if let idx = entries.lastIndex(where: { $0.subagentId == subagentId }) {
                    entries[idx] = mergedUpsert(base: entries[idx], incoming: entry)
                    return
                }
            }
            // Update existing entry with same ts + type
            if let idx = entries.firstIndex(where: { $0.ts == entry.ts && $0.type == entry.type }) {
                entries[idx] = mergedUpsert(base: entries[idx], incoming: entry)
                return
            }
        }

        // Sorted insert: live events normally arrive ascending (append
        // fast-path), but the daemon's deferred `task_start` is backdated to
        // the task's original startedAt — a plain append renders the TASK
        // header below the turns it groups until the next history re-sort.
        if let last = entries.last, entry.ts < last.ts {
            let idx = entries.lastIndex(where: { $0.ts <= entry.ts }).map { $0 + 1 } ?? 0
            entries.insert(entry, at: idx)
        } else {
            entries.append(entry)
        }

        // Trim oldest if over limit
        while entries.count > maxEntries {
            evictOne()
        }
    }

    /// Evict a single entry to enforce `maxEntries`, protecting task rows —
    /// ported from `DaemonTimelineStore.evictOne`. Task rows only leave under
    /// their own cap, an in-flight task's `task_start` (no matching `task_end`
    /// yet) is never evicted, and the oldest `tool_exec` is shed before any
    /// chat/turn row so a turn's `chat_start` doesn't orphan its response.
    private func evictOne() {
        let taskRowCount = entries.lazy.filter { Self.isTaskRow($0) }.count
        if taskRowCount > maxTaskEntries {
            let closed = Set(entries.compactMap { $0.type == .taskEnd ? $0.taskId : nil })
            if let idx = entries.firstIndex(where: { e in
                guard Self.isTaskRow(e) else { return false }
                if e.type == .taskStart, let id = e.taskId, !closed.contains(id) { return false }
                return true
            }) {
                entries.remove(at: idx)
                return
            }
        }
        // Subagent dispatch rows are exempt: they pair with the children's
        // `tool_resolved` rows the way a `task_start` pairs with its
        // `task_end`, and fan-out sessions produce the most tool_exec rows —
        // so shedding them first always split the pair it meant to protect.
        //
        // OpenClaw rows are exempt for a different reason: `tool_exec` is the
        // ONLY row type its producers emit, so on a full buffer an OpenClaw row
        // is typically the only plain `tool_exec` present and evicting it first
        // does not thin those rows, it deletes them. `DaemonTimelineStore`
        // (which this function is a port of) and the Node store both carve it
        // out; this mirror had drifted, so the app's own view would shed
        // exactly the rows its daemon had just decided to keep.
        if let idx = entries.firstIndex(where: {
            $0.type == .toolExec && $0.subagentId == nil && $0.agentType != "openclaw"
        }) {
            entries.remove(at: idx)
            return
        }
        if let idx = entries.firstIndex(where: { !Self.isTaskRow($0) }) {
            entries.remove(at: idx)
            return
        }
        entries.removeFirst()
    }

    /// Field-merge an upsert update over the existing row instead of replacing
    /// it wholesale. The task-judge rollup (taskScore / taskOutcome /
    /// taskCategory / taskSummary) arrives on a **second** `task_end` emit
    /// 5–30 s after the boundary; a later progressive re-emit — or a duplicate
    /// carrying nils — must not clobber score fields an earlier update already
    /// set. Coalesce every optional as `incoming ?? base`, always take the
    /// freshest `raw` summary, and keep the base row's identity (ts / type) so
    /// its sorted position stays put. Mirrors the Node `BridgeTimelineStore`
    /// merge path and Android `TimelineStore.upsertEntry`; the client store used
    /// to full-replace here, dropping the rollup whenever a nil-bearing emit
    /// landed after the scored one (timeline client-divergence audit 2026-07-13).
    private func mergedUpsert(base: TimelineEntry, incoming: TimelineEntry) -> TimelineEntry {
        TimelineEntry(
            ts: base.ts,
            type: base.type,
            raw: incoming.raw,
            detail: incoming.detail ?? base.detail,
            approvalId: incoming.approvalId ?? base.approvalId,
            status: incoming.status ?? base.status,
            agentType: incoming.agentType ?? base.agentType,
            automated: incoming.automated ?? base.automated,
            projectName: incoming.projectName ?? base.projectName,
            sessionId: incoming.sessionId ?? base.sessionId,
            runId: incoming.runId ?? base.runId,
            startedAt: incoming.startedAt ?? base.startedAt,
            endedAt: incoming.endedAt ?? base.endedAt,
            taskId: incoming.taskId ?? base.taskId,
            boundarySignal: incoming.boundarySignal ?? base.boundarySignal,
            summaryKind: incoming.summaryKind ?? base.summaryKind,
            taskScore: incoming.taskScore ?? base.taskScore,
            taskOutcome: incoming.taskOutcome ?? base.taskOutcome,
            taskCategory: incoming.taskCategory ?? base.taskCategory,
            taskSummary: incoming.taskSummary ?? base.taskSummary,
            subagentId: incoming.subagentId ?? base.subagentId
        )
    }

    // MARK: - Replace Snapshot (authoritative history load)

    /// Replace the entire buffer with a daemon `timeline_history` snapshot.
    ///
    /// The daemon's `timeline_history` to a WS client is the FULL authoritative
    /// store snapshot sent in the initial state on a fresh socket. The old
    /// `mergeHistory` (ts-only dedup + append, never clearing) let re-stamped
    /// rows stack across reconnects: the daemon re-stamps `ts` on log-tail
    /// replay, so a ts-only key shifts and the "same" OpenClaw row survives —
    /// the ghost-row accumulation that bit the Android tablet before it moved
    /// to replace-on-connect. Since the snapshot is authoritative and TCP
    /// preserves the `connection` → `timeline_history` → live-event order, no
    /// live row is lost by replacing. Dedup by (ts, type, raw) mirrors Android
    /// `replaceSnapshot`'s `ts-type-summary` key; the storage filter runs here
    /// too so a snapshot can't reintroduce noise. Mirrors android
    /// `TimelineStore.kt::replaceSnapshot`.
    func replaceSnapshot(_ snapshot: [TimelineEntry]) {
        var seen = Set<String>()
        var deduped: [TimelineEntry] = []
        for entry in snapshot.compactMap({ normalizeTimelineEntryForStorage($0) }) {
            let key = "\(entry.ts)-\(entry.type.rawValue)-\(entry.raw)"
            if seen.insert(key).inserted { deduped.append(entry) }
        }
        deduped.sort { $0.ts < $1.ts }
        if deduped.count > maxEntries {
            deduped.removeFirst(deduped.count - maxEntries)
        }
        entries = deduped
    }

    // MARK: - Clear

    func clear() {
        entries.removeAll()
    }
}
