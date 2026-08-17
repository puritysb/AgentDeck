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
// Two things make this different from `LocalCodexAppObserver`:
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
    /// dropping a live one — the row carries its own idle state either way.
    static let liveWindow: TimeInterval = 30 * 60

    /// Transcript bytes read for the tail scan. Kiro records are large (a
    /// `thinking` block per turn), so this is a few dozen turns.
    private static let maxTranscriptBytes = 512 * 1024

    /// Directories scanned under `<kiro>/sessions`, newest first.
    private static let maxSessionDirs = 64

    struct Observed {
        let sessionId: String
        let transcript: URL
        let modifiedAt: Date
        let projectName: String
        let lastPrompt: String?
        let lastResponse: String?
    }

    // MARK: - Session rows

    /// Observed Kiro sessions, or `[]` when no `~/.kiro` bookmark is granted.
    static func collect(now: Date = Date()) -> [DaemonSessionEntry] {
        observe(now: now).map { observed in
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
            // Passive observation cannot see a turn in flight: the transcript
            // gains its assistant record only once the reply lands. Claiming
            // `processing` would be inventing a state, so an observed Kiro
            // session is always reported idle — the same answer the Node
            // observer gives when its store read finds a completed turn.
            entry.state = "idle"
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

    private static func scanSessions(root: URL, now: Date) -> [Observed] {
        let fm = FileManager.default
        let sessionsRoot = root.appendingPathComponent("sessions", isDirectory: true)
        guard let dirs = try? fm.contentsOfDirectory(
            at: sessionsRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        var out: [Observed] = []
        for dir in dirs.prefix(maxSessionDirs) {
            guard (try? dir.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true else { continue }
            guard let files = try? fm.contentsOfDirectory(
                at: dir,
                includingPropertiesForKeys: [.contentModificationDateKey],
                options: [.skipsHiddenFiles]
            ) else { continue }
            for file in files where file.pathExtension == "jsonl" {
                guard let modified = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?
                    .contentModificationDate else { continue }
                guard now.timeIntervalSince(modified) <= liveWindow else { continue }
                let sessionId = file.deletingPathExtension().lastPathComponent
                guard !sessionId.isEmpty else { continue }
                let turns = readTurns(file)
                out.append(Observed(
                    sessionId: sessionId,
                    transcript: file,
                    modifiedAt: modified,
                    projectName: projectName(for: sessionId, in: dir, root: root),
                    lastPrompt: turns.last(where: { $0.isPrompt })?.text,
                    lastResponse: turns.last(where: { !$0.isPrompt })?.text
                ))
            }
        }
        // Newest first, so a device showing one row shows the live one.
        return out.sorted { $0.modifiedAt > $1.modifiedAt }
    }

    /// Session metadata sits beside the transcript as `<uuid>.json`; its `cwd`
    /// is what names the project. Falls back to the agent's name rather than
    /// to a directory hash, which would read as gibberish on a deck key.
    private static func projectName(for sessionId: String, in dir: URL, root: URL) -> String {
        let metaURL = dir.appendingPathComponent("\(sessionId).json")
        if let data = try? Data(contentsOf: metaURL),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            for key in ["cwd", "workspace", "working_directory", "workingDirectory"] {
                if let path = obj[key] as? String, !path.isEmpty {
                    let name = URL(fileURLWithPath: path).lastPathComponent
                    if !name.isEmpty { return name }
                }
            }
        }
        return "Kiro"
    }

    // MARK: - Transcript parsing

    struct Turn {
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
        guard let handle = try? FileHandle(forReadingFrom: url) else { return [] }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let start = size > UInt64(maxTranscriptBytes) ? size - UInt64(maxTranscriptBytes) : 0
        try? handle.seek(toOffset: start)
        guard let data = try? handle.readToEnd(), let raw = String(data: data, encoding: .utf8) else { return [] }

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
                  let obj = try? JSONSerialization.jsonObject(with: lineData) as? [String: Any],
                  let kind = obj["kind"] as? String,
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
        return turns
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
