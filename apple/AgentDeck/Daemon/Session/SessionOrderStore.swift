// SessionOrderStore.swift — Swift mirror of the daemon-persisted
// observed-session order pins (#273 session-ordering gate).
//
// Node owns the mechanism (bridge/src/session-order-store.ts); this port
// exists so the pins keep working while the in-process Swift daemon holds
// port 9120. Both daemons read and write the SAME session-order.json —
// unsandboxed dev builds resolve AgentDeckPaths.baseDirectory to
// ~/.agentdeck, the very file the Node daemon uses — so the JSON shape,
// the TTL and the pin cap are a cross-daemon file contract, not an
// implementation detail (constants live in SessionWeightRules, generated
// from the shared SSOT). Only the sandboxed App Store build writes a
// container-local copy the Node daemon cannot see, the same asymmetry its
// daemon.json/timeline.json already carry.
//
// Semantics (must match the Node store exactly — the CLI talks to either):
//   - key = bare session id (ObservedAgentRules.rawSessionId), so
//     `observed:claude:<uuid>` and the bare `<uuid>` address one pin;
//   - overlay applies to observed rows WITHOUT a weight of their own —
//     a managed session's launch-time `--weight` and a remote session's
//     pushed weight always win; weight 0 is a clear, not a pin;
//   - pins survive daemon restarts; `lastSeenAt` advances whenever the
//     daemon rosters the id; unseen-for-TTL pins are GC'd; the store is
//     capped with least-recently-seen eviction.

#if os(macOS)
import Foundation

/// One persisted pin. Milliseconds since epoch, matching the Node writer.
struct SessionOrderPin: Codable, Sendable, Equatable {
    var weight: Int
    var updatedAt: Int64
    var lastSeenAt: Int64
}

/// On-disk document. `version` gates forward-compatible migrations; a file
/// that fails to decode loads as an empty store, never throws.
struct SessionOrderDocument: Codable {
    var version: Int
    var pins: [String: SessionOrderPin]
}

enum SessionOrderTarget: Equatable {
    case resolved(id: String)
    case ambiguous(candidates: [String])
}

/// Pure helpers shared with the HTTP route and the tests (nonisolated by
/// being free of daemon state, mirroring `mergedPushRegisterEntry`).
enum SessionOrderRules {
    /// A `lastSeenAt` update below this age is not worth a file write.
    /// Implementation detail (not in the cross-daemon contract): rosters are
    /// built every few seconds, and a persist per roster would churn the file.
    static let seenPersistThresholdMs: Int64 = 60_000

    /// Validate a pin weight from an untrusted body. Nil for anything the
    /// wire must never see (fractional, out-of-range, wrong type). Mirrors
    /// `parseSessionOrderWeight` on the Node side, including the string
    /// tolerance for hand-rolled `curl` users.
    static func parseWeight(_ value: Any?) -> Int? {
        let n: Int
        switch value {
        case let i as Int: n = i
        case let d as Double where d == d.rounded() && d.magnitude < 1_000_000_000: n = Int(d)
        case let s as String: guard let parsed = Int(s.trimmingCharacters(in: .whitespaces)) else { return nil }; n = parsed
        default: return nil
        }
        guard n >= SessionWeightRules.min, n <= SessionWeightRules.max else { return nil }
        return n
    }

    /// Resolve a user-supplied session reference against the live observed
    /// roster: exact id wins, a prefix must match exactly ONE live id (the
    /// 31-char device echo case), anything else passes through in bare form
    /// (pinning a not-currently-live id is legal — the pin waits). Both the
    /// input and every known id are tried in raw AND bare form: the Node
    /// daemon addresses observed sessions as `observed:claude:<uuid>` while
    /// Swift's rows carry the bare `<uuid>`, so a reference copied from one
    /// daemon's world must resolve against the other's roster (found live
    /// 2026-09-19: an `observed:claude:` prefix keyed a pin on the truncated
    /// uuid here and never applied). Mirrors `resolveSessionOrderTarget`.
    static func resolveTarget(_ raw: String, knownIds: [String]) -> SessionOrderTarget {
        let input = raw.trimmingCharacters(in: .whitespaces)
        let rawInput = ObservedAgentRules.rawSessionId(input)
        let ids = knownIds.filter { !$0.isEmpty }

        func forms(_ id: String) -> [String] {
            let stripped = ObservedAgentRules.rawSessionId(id)
            return stripped != id ? [id, stripped] : [id]
        }

        // Exact match in either form on either side.
        for id in ids {
            for form in forms(id) where form == input || (!rawInput.isEmpty && form == rawInput) {
                return .resolved(id: id)
            }
        }

        // Prefix match: the input (or its bare form) as a prefix of a known
        // id (or its bare form) — the truncated echo in both rosters' shapes.
        var candidates: Set<String> = []
        var match: String?
        let prefixes = !rawInput.isEmpty && rawInput != input ? [input, rawInput] : [input]
        for id in ids {
            for form in forms(id) {
                for p in prefixes where !p.isEmpty && form.hasPrefix(p) {
                    candidates.insert(id)
                    match = id
                }
            }
        }
        if candidates.count == 1, let match { return .resolved(id: match) }
        if candidates.count > 1 { return .ambiguous(candidates: candidates.sorted()) }
        return .resolved(id: rawInput)
    }
}

/// Daemon-actor-confined (like SessionRegistry — no internal locking; every
/// call site lives on `@DaemonActor`). File IO is bounded and best-effort:
/// a disk failure logs and never takes the daemon down.
final class SessionOrderStore {
    private var pins: [String: SessionOrderPin] = [:]
    private let fileURL: URL
    private var nowMs: () -> Int64

    init(fileURL: URL? = nil, now: (@Sendable () -> Int64)? = nil) {
        self.fileURL = fileURL
            ?? AgentDeckPaths.baseDirectory.appendingPathComponent("session-order.json")
        self.nowMs = now ?? { Int64(Date().timeIntervalSince1970 * 1000) }
    }

    /// Load tolerantly and GC. Corrupt/missing file ⇒ empty store.
    func load() -> Self {
        if let data = try? Data(contentsOf: fileURL),
           let doc = try? JSONDecoder().decode(SessionOrderDocument.self, from: data) {
            for (id, pin) in doc.pins where !id.isEmpty {
                let weight = SessionWeightRules.clamp(pin.weight)
                // 0 pins are meaningless (the default band) — drop, matching
                // the Node loader.
                if weight == 0 { continue }
                pins[ObservedAgentRules.rawSessionId(id)] = SessionOrderPin(
                    weight: weight,
                    updatedAt: pin.updatedAt > 0 ? pin.updatedAt : nowMs(),
                    lastSeenAt: pin.lastSeenAt > 0 ? pin.lastSeenAt : nowMs()
                )
            }
        }
        garbageCollect()
        return self
    }

    /// The stored weight for a session id (either id form), or nil.
    func weightFor(_ id: String) -> Int? {
        pins[ObservedAgentRules.rawSessionId(id)]?.weight
    }

    /// Overlay a stored pin onto one roster row. Observed rows without their
    /// own weight get the pin; managed/remote rows and rows that already
    /// carry a weight pass through unchanged (precedence rule in the header).
    func apply(to entry: DaemonSessionEntry) -> DaemonSessionEntry {
        guard entry.controlMode == "observed", entry.weight == nil else { return entry }
        guard let weight = pins[ObservedAgentRules.rawSessionId(entry.id)]?.weight else { return entry }
        var pinned = entry
        pinned.weight = weight
        return pinned
    }

    /// Set (or, for a clamped 0, clear) a pin. Returns the applied weight,
    /// nil when cleared. Persists synchronously — a CLI-visible action must
    /// survive an immediate daemon crash.
    @discardableResult
    func set(_ id: String, weight: Int) -> Int? {
        let key = ObservedAgentRules.rawSessionId(id)
        let clamped = SessionWeightRules.clamp(weight)
        if clamped == 0 {
            clear(key)
            return nil
        }
        let now = nowMs()
        pins[key] = SessionOrderPin(
            weight: clamped,
            updatedAt: now,
            lastSeenAt: max(pins[key]?.lastSeenAt ?? 0, now)
        )
        garbageCollect()
        persist()
        return clamped
    }

    /// Remove a pin. True when one existed. Persists synchronously.
    @discardableResult
    func clear(_ id: String) -> Bool {
        let key = ObservedAgentRules.rawSessionId(id)
        guard pins.removeValue(forKey: key) != nil else { return false }
        persist()
        return true
    }

    /// All pins sorted for `GET /sessions/order` (weight asc, then id).
    func list() -> [[String: Any]] {
        let sorted = pins
            .map { (id: $0.key, pin: $0.value) }
            .sorted { lhs, rhs in
                if lhs.pin.weight != rhs.pin.weight {
                    return lhs.pin.weight < rhs.pin.weight
                }
                return lhs.id.localizedStandardCompare(rhs.id) == .orderedAscending
            }
        return sorted.map { entry -> [String: Any] in
            [
                "id": entry.id,
                "weight": entry.pin.weight,
                "updatedAt": entry.pin.updatedAt,
                "lastSeenAt": entry.pin.lastSeenAt,
            ]
        }
    }

    var count: Int { pins.count }

    /// Advance `lastSeenAt` for every id the daemon just rostered, throttled
    /// per pin so a roster every few seconds cannot churn the file.
    func noteSeen(ids: [String]) {
        guard !pins.isEmpty else { return }
        let now = nowMs()
        var changed = false
        for id in ids {
            let key = ObservedAgentRules.rawSessionId(id)
            guard var pin = pins[key] else { continue }
            guard now - pin.lastSeenAt >= SessionOrderRules.seenPersistThresholdMs else { continue }
            pin.lastSeenAt = now
            pins[key] = pin
            changed = true
        }
        if changed { persist() }
    }

    /// Drop pins unseen past the TTL and enforce the cap (oldest
    /// `lastSeenAt` first). Returns the number removed.
    @discardableResult
    func garbageCollect() -> Int {
        let now = nowMs()
        let before = pins.count
        pins = pins.filter { now - $0.value.lastSeenAt <= SessionWeightRules.sessionOrderTtlMs }
        if pins.count > SessionWeightRules.maxSessionOrderPins {
            let evict = pins.count - SessionWeightRules.maxSessionOrderPins
            for key in pins.sorted(by: { $0.value.lastSeenAt < $1.value.lastSeenAt }).prefix(evict).map(\.key) {
                pins.removeValue(forKey: key)
            }
        }
        return before - pins.count
    }

    /// Atomic tmp+rename write, best-effort. Node reads this file with a
    /// plain JSON.parse, so a torn write would silently drop every pin.
    private func persist() {
        let doc = SessionOrderDocument(version: 1, pins: pins)
        guard let data = try? JSONEncoder.pretty.encode(doc) else { return }
        let tmp = fileURL.deletingLastPathComponent()
            .appendingPathComponent(".session-order.\(UUID().uuidString).tmp")
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: tmp)
            if FileManager.default.fileExists(atPath: fileURL.path) {
                _ = try FileManager.default.replaceItemAt(fileURL, withItemAt: tmp)
            } else {
                try FileManager.default.moveItem(at: tmp, to: fileURL)
            }
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            DaemonLogger.shared.debug("SessionOrder", "persist failed: \(error.localizedDescription)")
        }
    }
}

#endif
