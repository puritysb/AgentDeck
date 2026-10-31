#if os(macOS)
import Darwin
import Foundation

enum AntigravitySourceReader {
    enum Failure: Error { case unsafeSource, changed, invalidData, oversize }

    static func validateFolder(_ root: URL) throws {
        _ = try inside(root, components: ["brain"], directory: true)
    }

    private static func inside(_ root: URL, components: [String], directory: Bool) throws -> URL {
        let keys: Set<URLResourceKey> = [.isDirectoryKey, .isSymbolicLinkKey, .isRegularFileKey]
        var current = root
        let attrs = try current.resourceValues(forKeys: keys)
        guard attrs.isDirectory == true, attrs.isSymbolicLink != true else { throw Failure.unsafeSource }
        for (index, part) in components.enumerated() {
            current = current.appendingPathComponent(part)
            let attrs = try current.resourceValues(forKeys: keys)
            guard attrs.isSymbolicLink != true else { throw Failure.unsafeSource }
            if index < components.count - 1 || directory {
                guard attrs.isDirectory == true else { throw Failure.unsafeSource }
            } else if attrs.isRegularFile != true { throw Failure.unsafeSource }
        }
        return current
    }

    private static func opened<T>(_ url: URL, _ body: (FileHandle, stat) throws -> T) throws -> T {
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
        guard fd >= 0 else { throw Failure.unsafeSource }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        defer { try? handle.close() }
        var before = stat()
        guard fstat(fd, &before) == 0, (before.st_mode & S_IFMT) == S_IFREG else { throw Failure.unsafeSource }
        return try body(handle, before)
    }
    private static func text(_ data: Data) throws -> String {
        guard let raw = String(data: data, encoding: .utf8) else { throw Failure.invalidData }
        return raw
    }
    private static func metadata(_ root: URL, _ components: [String]) throws -> [String: Any] {
        let url = try inside(root, components: components, directory: false)
        return try opened(url) { handle, _ in
            let data = try handle.read(upToCount: AntigravityPolicy.metadataBytes + 1) ?? Data()
            guard data.count <= AntigravityPolicy.metadataBytes else { throw Failure.oversize }
            guard let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw Failure.invalidData }
            return result
        }
    }
    static func projectNames(_ root: URL) -> [String: String] {
        guard let values = try? metadata(root, ["cache", "last_conversations.json"]) else { return [:] }
        var candidates: [String: Set<String>] = [:]
        for (path, value) in values {
            guard let id = value as? String, AntigravityTranscript.validID(id) else { continue }
            let pieces = path.split(whereSeparator: { $0 == "/" || $0 == "\\" })
            guard let leaf = pieces.last.map(String.init), leaf != ".", leaf != "..", !leaf.isEmpty else { continue }
            candidates[id, default: []].insert(leaf)
        }
        return candidates.compactMapValues { names in names.count == 1 ? names.first : nil }
    }

    private static func readTranscript(_ url: URL) throws -> (String, Int64) {
        try opened(url) { handle, before in
            let size = UInt64(before.st_size)
            let maxBytes = AntigravityPolicy.headBytes + AntigravityPolicy.tailBytes
            var data: Data
            if size <= maxBytes { data = try handle.read(upToCount: maxBytes) ?? Data() }
            else {
                let head = try handle.read(upToCount: AntigravityPolicy.headBytes) ?? Data()
                try handle.seek(toOffset: size - UInt64(AntigravityPolicy.tailBytes))
                let tail = try handle.read(upToCount: AntigravityPolicy.tailBytes) ?? Data()
                guard let end = head.lastIndex(of: 10), let start = tail.firstIndex(of: 10) else { throw Failure.oversize }
                data = Data(head.prefix(through: end)); data.append(Data((AntigravityPolicy.gapMarker + "\n").utf8)); data.append(tail.suffix(from: tail.index(after: start)))
            }
            var after = stat()
            guard fstat(handle.fileDescriptor, &after) == 0,
                  before.st_size == after.st_size, before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
                  before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec else { throw Failure.changed }
            return (try text(data), Int64(after.st_mtimespec.tv_sec) * 1000 + Int64(after.st_mtimespec.tv_nsec / 1_000_000))
        }
    }
    static func scan(root: URL, nowMs: Int64, permitted: @Sendable () -> Bool = { true }) -> AntigravityScan {
        var out = AntigravityScan()
        let started = DispatchTime.now().uptimeNanoseconds
        do {
            let brain = try inside(root, components: ["brain"], directory: true)
            let names = try FileManager.default.contentsOfDirectory(atPath: brain.path).sorted()
            guard names.count <= AntigravityPolicy.maxDirectories else { out.reason = "directory_limit"; return out }
            let settings = try? metadata(root, ["settings.json"])
            let fallbackModel = (settings?["model"] as? String).map { String(String.UnicodeScalarView($0.unicodeScalars.prefix(AntigravityPolicy.labelCodePoints))) }
            for id in names where AntigravityTranscript.validID(id) {
                guard permitted(), !Task.isCancelled,
                      (DispatchTime.now().uptimeNanoseconds - started) / 1_000_000 <= AntigravityPolicy.scanBudgetMs else {
                    out.reason = "scan_deadline"; out.observations = []; return out
                }
                do {
                    let file = try inside(root, components: ["brain", id, ".system_generated", "logs", "transcript.jsonl"], directory: false)
                    let modified = try file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
                    if let modified, nowMs - Int64((modified.timeIntervalSince1970 * 1000).rounded(.down)) > AntigravityPolicy.rosterWindowMs,
                       AntigravityActivity.freshness(root: root, id: id, nowMs: nowMs) == "historical" {
                        out.observations.append(AntigravityObservation(conversationId: id, status: "stale", reason: "history"))
                        continue
                    }
                    let (raw, stamp) = try readTranscript(file)
                    var observation = AntigravityTranscript.observe(id: id, raw: raw, modifiedAtMs: stamp, nowMs: nowMs)
                    if observation.status == "known", observation.model == nil, let fallbackModel, !raw.contains(AntigravityPolicy.gapMarker) { observation.model = fallbackModel }
                    observation = AntigravityActivity.observe(root: root, base: observation, nowMs: nowMs, safePath: { parts, directory in
                        try inside(root, components: parts, directory: directory)
                    })
                    out.observations.append(observation)
                } catch { out.observations.append(AntigravityObservation(conversationId: id, reason: "unreadable_source")) }
            }
            out.observations.sort { a, b in
                if (a.updatedAtMs ?? 0) != (b.updatedAtMs ?? 0) { return (a.updatedAtMs ?? 0) > (b.updatedAtMs ?? 0) }
                return a.conversationId < b.conversationId
            }
            out.observations = Array(out.observations.prefix(AntigravityPolicy.maxSessions))
            out.projects = projectNames(root)
            out.status = "known"; out.reason = "scanned"
        } catch { }
        return out
    }
}
#endif
