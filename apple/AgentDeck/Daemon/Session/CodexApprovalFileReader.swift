#if os(macOS)
import Foundation
import Darwin

/// File I/O runs in a worker, never on DaemonActor. Windows overlap; the
/// complete file is searchable without allocating its full contents.
enum CodexApprovalFileReader {
    private struct Snapshot: Equatable {
        let signature: String
        let size: Int
    }

    private static func snapshot(_ url: URL, descriptor: Int32? = nil) -> Snapshot? {
        var info = stat()
        let result = descriptor.map { fstat($0, &info) }
            ?? url.path.withCString { Darwin.fstatat(AT_FDCWD, $0, &info, 0) }
        guard result == 0, (info.st_mode & mode_t(S_IFMT)) == mode_t(S_IFREG), info.st_size >= 0,
              let size = Int(exactly: info.st_size) else { return nil }
        return Snapshot(signature: "\(info.st_dev):\(info.st_ino):\(size):\(info.st_mtimespec.tv_sec):\(info.st_mtimespec.tv_nsec):\(info.st_ctimespec.tv_sec):\(info.st_ctimespec.tv_nsec)", size: size)
    }

    static func reviewer(file: URL, turnId: String?, deadline: ContinuousClock.Instant) -> String? {
        let clock = ContinuousClock()
        let block = CodexApprovalHoldRules.contextBytes
        while clock.now < deadline {
            guard let pathBefore = snapshot(file), let handle = try? FileHandle(forReadingFrom: file) else { return nil }
            defer { try? handle.close() }
            guard let before = snapshot(file, descriptor: handle.fileDescriptor) else { return nil }
            if before != pathBefore { continue }
            do {
                func readRange(_ start: Int, _ length: Int) throws -> Data {
                    try handle.seek(toOffset: UInt64(start))
                    var data = Data()
                    while data.count < length {
                        guard clock.now < deadline,
                              let piece = try handle.read(upToCount: length - data.count), !piece.isEmpty else {
                            throw CocoaError(.fileReadUnknown)
                        }
                        data.append(piece)
                    }
                    return data
                }
                func settingsLine(_ start: Int) throws -> CodexApprovalHoldRules.ReviewerRecord {
                    var position = start
                    var data = Data()
                    while position < before.size {
                        let piece = try readRange(position, min(block, before.size - position))
                        if let newline = piece.range(of: Data([10]))?.lowerBound {
                            data.append(contentsOf: piece[..<newline])
                            break
                        }
                        data.append(piece)
                        position += piece.count
                    }
                    return CodexApprovalHoldRules.latestReviewerRecord(
                        inRollout: String(decoding: data, as: UTF8.self), turnId: turnId)
                        ?? .init(reviewer: nil)
                }
                var end = before.size
                var result: CodexApprovalHoldRules.ReviewerRecord?
                while end > 0 && clock.now < deadline {
                    let start = max(0, end - CodexApprovalHoldRules.windowBytes)
                    let data = try readRange(start, end - start)
                    var first = 0
                    var last = data.count
                    if start > 0 { first = (data.range(of: Data([10]))?.lowerBound).map { $0 + 1 } ?? last }
                    if end < before.size {
                        let trailingStart = (data.range(of: Data([10]), options: .backwards)?.lowerBound).map { $0 + 1 } ?? 0
                        if trailingStart >= first && trailingStart < data.count,
                           CodexApprovalHoldRules.isSettingsPrefix(String(decoding: data[trailingStart...], as: UTF8.self)) {
                            result = try settingsLine(start + trailingStart)
                            break
                        }
                        last = max(first, trailingStart)
                    }
                    // Find line boundaries as bytes. A large irrelevant tool
                    // result must not be traversed as Swift grapheme clusters.
                    var cursor = last
                    while cursor > first {
                        if data[cursor - 1] == 10 { cursor -= 1 }
                        guard cursor > first else { break }
                        let lineStart = data.range(of: Data([10]), options: .backwards,
                            in: first..<cursor).map { $0.lowerBound + 1 } ?? first
                        let line = data[lineStart..<cursor]
                        if line.range(of: Data(#""turn_context""#.utf8)) != nil
                            || line.range(of: Data(#""thread_settings_applied""#.utf8)) != nil {
                            result = CodexApprovalHoldRules.latestReviewerRecord(
                                inRollout: String(decoding: line, as: UTF8.self), turnId: turnId)
                            if result != nil { break }
                        }
                        cursor = lineStart
                    }
                    if result != nil || start == 0 { break }
                    end -= block
                }
                guard clock.now < deadline else { return nil }
                // Retrying a changed snapshot also covers same-size rewrites
                // and replacement. No cached user survives a settings change.
                if before != snapshot(file, descriptor: handle.fileDescriptor) || before != snapshot(file) { continue }
                return result?.reviewer
            } catch {
                if before != snapshot(file) { continue }
                return nil
            }
        }
        return nil
    }
}

private actor CodexApprovalReadResult {
    private var result: CodexApprovalHoldRules.ReviewerRecord?
    func finish(_ reviewer: String?) { result = .init(reviewer: reviewer) }
    func completed() -> CodexApprovalHoldRules.ReviewerRecord? { result }
}

enum CodexApprovalReadWorker {
    static func read(_ work: @escaping @Sendable (ContinuousClock.Instant) -> String?) async -> String? {
        let box = CodexApprovalReadResult()
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .milliseconds(CodexApprovalHoldRules.readTimeoutMs))
        // The worker owns its file/security scope even if the waiter leaves.
        Task.detached(priority: .utility) { await box.finish(work(deadline)) }
        while clock.now < deadline && !Task.isCancelled {
            if let result = await box.completed() { return result.reviewer }
            do { try await Task.sleep(for: .milliseconds(20)) } catch { return nil }
        }
        return nil
    }
}
#endif
