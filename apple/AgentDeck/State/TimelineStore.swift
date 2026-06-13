// TimelineStore.swift — Event buffer with grouping
// Ported from plugin/src/timeline-store.ts + android TimelineStore.kt

import Foundation
import Combine

final class TimelineStore: ObservableObject, @unchecked Sendable {
    @Published private(set) var entries: [TimelineEntry] = []
    // NOTE: no stored `grouped` here. The store used to keep a @Published
    // grouped array recomputed via groupConsecutive() on every addEntry, but
    // no view ever read it — TimelineStripView runs its own
    // groupConsecutive(filteredEntries) per render (it must, because the
    // session filter changes the grouping input). The stored copy was pure
    // duplicate work plus an extra objectWillChange fire per event.

    private let maxEntries = 200

    /// Whether we're receiving timeline from bridge (suppress local generation)
    @Published var receivingBridgeTimeline = false

    // MARK: - Add Entry

    func addEntry(_ entry: TimelineEntry, upsert: Bool = false) {
        if upsert {
            // Task-judge follow-up emits land 5–30 s after the initial
            // boundary, so matching on (ts, type) misses them. For task_end
            // rows, fall back to matching by (type, taskId) — that pair is
            // stable across both emits and lets the score-bearing update
            // merge in place. Mirrors `DaemonTimelineStore::upsert`.
            if entry.type == .taskEnd, let taskId = entry.taskId,
               let idx = entries.lastIndex(where: { $0.type == .taskEnd && $0.taskId == taskId }) {
                entries[idx] = entry
                return
            }
            // Update existing entry with same ts + type
            if let idx = entries.firstIndex(where: { $0.ts == entry.ts && $0.type == entry.type }) {
                entries[idx] = entry
                return
            }
        }

        entries.append(entry)

        // Trim oldest if over limit
        if entries.count > maxEntries {
            entries.removeFirst(entries.count - maxEntries)
        }
    }

    // MARK: - Merge History (bulk load, dedup)

    func mergeHistory(_ newEntries: [TimelineEntry]) {
        let existingTimestamps = Set(entries.map { $0.ts })
        let unique = newEntries.filter { !existingTimestamps.contains($0.ts) }

        entries.append(contentsOf: unique)
        entries.sort { $0.ts < $1.ts }

        if entries.count > maxEntries {
            entries.removeFirst(entries.count - maxEntries)
        }
    }

    // MARK: - Clear

    func clear() {
        entries.removeAll()
    }
}
