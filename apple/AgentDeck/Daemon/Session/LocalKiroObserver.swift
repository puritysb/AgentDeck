#if os(macOS)
// LocalKiroObserver.swift — passive Kiro observation for the in-process daemon.
//
// Kiro reports NOTHING to AgentDeck on its own. That is not a gap in the
// integration, it is a measured property of the CLI: with AgentDeck's five
// standalone lifecycle hooks installed in `~/.kiro/hooks/` and confirmed
// loaded by Kiro itself, a real `kiro-cli chat` turn fires none of them
// (2026-08-17, kiro-cli 2.18.1 — instrumented each hook with a marker file and
// ran a live turn; zero markers, while a hand-POSTed hook produced a row
// normally, so the receiving side was never the problem). The standalone hook
// surface belongs to the Kiro IDE agent, not to CLI chat.
//
// So the only source is Kiro's own store, which is why the Node daemon watches
// it and why this exists: without it, a Kiro session is invisible to anyone
// running the App Store app alone.
//
// Two things distinguish this from a process-table observer (the shape the
// retired `LocalCodexAppObserver` had):
//
//  - **The sandbox cannot read `~/.kiro` on a home-relative path.** The app
//    holds no such entitlement and will not get one. Access comes from a
//    user-granted security-scoped bookmark (`AppPreferences.withKiroDirectoryAccess`),
//    the same shape already used for `~/.codex`. With no bookmark this observer
//    returns nothing at all — never a partial or guessed session.
//  - **The transcript is the session list.** Kiro's v3 sessions are JSONL files
//    under `<kiro>/sessions/**`, and a file's mtime is what says "this one is
//    live". Process enumeration cannot supply the session id, and the id is
//    what every other surface keys on.
//
// Mirrors `collectKiroSessions` + `KiroTimelineFeed` in the Node bridge.

import Foundation

enum LocalKiroObserver {
    /// A transcript untouched for longer than this is history, not a session.
    /// Deliberately generous: a user reading a long reply can leave a live
    /// session idle for minutes, and showing a stale row costs less than
    /// dropping a live one. Turn state comes from explicit records below.
    static let liveWindow: TimeInterval = 30 * 60

    /// Transcript bytes read for the tail scan. Kiro records are large (a
    /// `thinking` block per turn), so this is a few dozen turns.
    private static let maxTranscriptBytes = 512 * 1024

    /// Directories scanned under `<kiro>/sessions`, newest first.
    private static let maxSessionDirs = 64

    struct Observed: Sendable {
        let sessionId: String
        let transcript: URL
        let modifiedAt: Date
        let projectName: String
        let lastPrompt: String?
        let lastResponse: String?
        let turns: [Turn]
        let state: String
    }

    // MARK: - Session rows

    /// Observed Kiro sessions, or `[]` when no `~/.kiro` bookmark is granted.
    static func collect(now: Date = Date()) -> [DaemonSessionEntry] {
        collect(observed: observe(now: now))
    }

    static func collect(observed: [Observed]) -> [DaemonSessionEntry] {
        observed.map { observed in
            var entry = DaemonSessionEntry(
                id: "observed:kiro:\(observed.sessionId)",
                port: 0,
                pid: 0,
                projectName: observed.projectName,
                agentType: "kiro-cli",
                tmuxSession: nil,
                tty: nil,
                parentTty: nil,
                startedAt: ISO8601DateFormatter().string(from: observed.modifiedAt)
            )
            entry.state = observed.state
            entry.controlMode = "observed"
            return entry
        }
    }

    /// The raw observation, exposed for the timeline feed and for tests.
    static func observe(now: Date = Date()) -> [Observed] {
        guard AppPreferences.shared.hasKiroBookmark else { return [] }
        return AppPreferences.shared.withKiroDirectoryAccess { root in
            scanSessions(root: root, now: now)
        } ?? []
    }

    // MARK: - Scanning

    static func scanSessions(root: URL, now: Date) -> [Observed] {
        let fm = FileManager.default
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .isSymbolicLinkKey, .contentModificationDateKey]
        func children(_ dir: URL) -> [URL] {
            let files = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles])) ?? []
            return files.filter { (try? $0.resourceValues(forKeys: keys))?.isSymbolicLink != true }
                .sorted { lhs, rhs in
                    let a = (try? lhs.resourceValues(forKeys: keys))?.contentModificationDate ?? .distantPast
                    let b = (try? rhs.resourceValues(forKeys: keys))?.contentModificationDate ?? .distantPast
                    return a > b
                }
        }
        var candidates: [(id: String, file: URL, modified: Date, meta: URL)] = []
        for workspace in children(root.appendingPathComponent("sessions")).prefix(maxSessionDirs) {
            for item in children(workspace).prefix(maxSessionDirs) {
                let nested = (try? item.resourceValues(forKeys: keys))?.isDirectory == true
                guard nested || item.pathExtension == "jsonl" else { continue }
                let file = nested ? item.appendingPathComponent("messages.jsonl") : item
                guard let attrs = try? file.resourceValues(forKeys: keys), attrs.isSymbolicLink != true,
                      let modified = attrs.contentModificationDate,
                      now.timeIntervalSince(modified) <= liveWindow else { continue }
                let id = nested ? item.lastPathComponent : item.deletingPathExtension().lastPathComponent
                guard !id.isEmpty else { continue }
                let meta = nested ? item.appendingPathComponent("session.json") : item.deletingPathExtension().appendingPathExtension("json")
                candidates.append((id, file, modified, meta))
            }
        }
        var out: [Observed] = []
        var seen = Set<String>()
        // Parse at most the retained roster, not every candidate on every tick.
        for candidate in candidates.sorted(by: { $0.modified > $1.modified }) {
            guard out.count < maxSessionDirs else { break }
            let (id, file, modified, meta) = candidate
            guard seen.insert(id).inserted else { continue }
            let snapshot = readSnapshot(file)
            var project = "Kiro"
            if let attrs = try? meta.resourceValues(forKeys: [.fileSizeKey, .isSymbolicLinkKey]),
               attrs.isSymbolicLink != true, (attrs.fileSize ?? Int.max) <= maxTranscriptBytes,
               let data = boundedMetadata(meta),
               let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                for key in ["cwd", "workspace", "working_directory", "workingDirectory"] {
                    if let path = obj[key] as? String, !path.isEmpty {
                        project = URL(fileURLWithPath: path).lastPathComponent
                        break
                    }
                }
            }
            out.append(Observed(sessionId: id, transcript: file, modifiedAt: modified,
                projectName: project, lastPrompt: snapshot.turns.last(where: { $0.isPrompt })?.text,
                lastResponse: snapshot.turns.last(where: { !$0.isPrompt })?.text,
                turns: snapshot.turns, state: snapshot.state))
        }
        return out
    }

    private static func boundedMetadata(_ url: URL) -> Data? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: maxTranscriptBytes + 1), data.count <= maxTranscriptBytes else { return nil }
        return data
    }

    // MARK: - Transcript parsing

    struct Turn: Sendable {
        let isPrompt: Bool
        let text: String
        /// Epoch ms. Only `Prompt` records carry a time; an `AssistantMessage`
        /// inherits its prompt's, nudged so it cannot sort before it.
        let ts: Double
    }

    /// Chat turns from a Kiro v3 transcript, oldest-first.
    ///
    /// Record shapes are transcribed from a real file, never invented — this
    /// repo has a documented history of Kiro parsers written against imagined
    /// fixtures that matched nothing on disk. Two properties an invented
    /// fixture gets wrong, both asserted in the tests:
    ///   - `data.meta.timestamp` is in SECONDS
    ///   - a `thinking` block's `data` is an OBJECT, not a string
    static func readTurns(_ url: URL) -> [Turn] {
        readSnapshot(url).turns
    }

    struct Snapshot {
        var turns: [Turn] = []
        var state = "idle"
    }

    static func readSnapshot(_ url: URL) -> Snapshot {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return Snapshot() }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let start = size > UInt64(maxTranscriptBytes) ? size - UInt64(maxTranscriptBytes) : 0
        try? handle.seek(toOffset: start)
        guard var data = try? handle.read(upToCount: maxTranscriptBytes) else { return Snapshot() }
        // A bounded tail may start inside a UTF-8 sequence or JSON record.
        if start > 0 {
            guard let newline = data.firstIndex(of: 10) else { return Snapshot() }
            data = data.suffix(from: data.index(after: newline))
        }
        guard let raw = String(data: data, encoding: .utf8) else { return Snapshot() }
        var state = "idle"
        let iso = ISO8601DateFormatter()
        let fractionalISO = ISO8601DateFormatter()
        fractionalISO.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        var turns: [Turn] = []
        var turnTs: Double = 0
        // Kiro writes SEVERAL AssistantMessage records for one prompt — a reply
        // that resumes after a tool call is a second record. Giving them all
        // `turnTs + 1` made them collide, and a colliding timestamp is not a
        // cosmetic ordering issue here: the timeline dedups on it and the
        // feed's watermark uses it to tell an unseen record from an emitted
        // one, so every reply after a turn's first was silently dropped.
        var replyIndex: Double = 0
        for line in raw.split(separator: "\n", omittingEmptySubsequences: true) {
            guard let lineData = line.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any] else { continue }
            if let envelope = obj["payload"] as? [String: Any], let kind = envelope["type"] as? String {
                if kind == "turn_start" { state = "processing" }
                if kind == "turn_end" { state = "idle" }
                guard kind == "user" || kind == "assistant",
                      envelope["operationType"] as? String != "Reasoning",
                      let stamp = obj["timestamp"] as? String,
                      let date = fractionalISO.date(from: stamp) ?? iso.date(from: stamp) else { continue }
                let text = self.text(from: envelope["content"])
                guard !text.isEmpty else { continue }
                turns.append(Turn(isPrompt: kind == "user", text: text, ts: date.timeIntervalSince1970 * 1000))
                continue
            }
            guard let kind = obj["kind"] as? String,
                  let payload = obj["data"] as? [String: Any] else { continue }
            let text = self.text(from: payload["content"])
            if kind == "Prompt" {
                if let meta = payload["meta"] as? [String: Any],
                   let seconds = (meta["timestamp"] as? NSNumber)?.doubleValue {
                    turnTs = seconds * 1000
                }
                replyIndex = 0
                guard turnTs > 0, !text.isEmpty else { continue }
                turns.append(Turn(isPrompt: true, text: text, ts: turnTs))
            } else if kind == "AssistantMessage" {
                guard turnTs > 0, !text.isEmpty else { continue }
                replyIndex += 1
                turns.append(Turn(isPrompt: false, text: text, ts: turnTs + replyIndex))
            }
        }
        return Snapshot(turns: turns, state: state)
    }

    /// User-facing text from a Kiro content array. `thinking` blocks carry an
    /// object and `toolResult` blocks are not chat, so only `text` counts.
    private static func text(from content: Any?) -> String {
        if let str = content as? String { return str.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard let blocks = content as? [[String: Any]] else { return "" }
        let parts = blocks.compactMap { block -> String? in
            guard block["kind"] as? String == "text", let value = block["data"] as? String else { return nil }
            return value
        }
        return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
#endif
