#if os(macOS)
// DaemonLogger.swift — Logging utility for daemon components

import Foundation
import os.log

final class DaemonLogger: @unchecked Sendable {
    static let shared = DaemonLogger()

    /// Size cap before the log file is rotated. Measured 2026-09-10: with no
    /// rotation, `swift-daemon.log` reached 518 MB — `debug()` writes to the
    /// file unconditionally regardless of `isDebugEnabled`, and that's most
    /// of the volume. One previous generation is kept (`swift-daemon.log.1`),
    /// so worst case on disk is ~2x this cap.
    static let defaultMaxBytes: UInt64 = 32 * 1024 * 1024

    nonisolated(unsafe) var isDebugEnabled = true
    private let stateLock = NSLock()
    private var throttledKeys: [String: Date] = [:]
    private var sampledCounters: [String: Int] = [:]
    // Serial DispatchQueue — every enqueued write runs in submission order on
    // a background thread. Prior versions of this class also kept an
    // `fileWriteInFlight` flag and dropped subsequent calls while a write was
    // pending. That dropped diagnostics whenever a code path emitted multiple
    // log lines back-to-back (e.g. the OpenClaw fallback decision logs every
    // ERROR/INFO line within a few microseconds — only the first survived).
    // The serial queue alone is sufficient for ordering; backpressure isn't a
    // concern at the volume this daemon emits. Rotation also runs on this
    // queue so it can never race an in-flight append.
    private let fileWriteQueue = DispatchQueue(label: "dev.agentdeck.daemon.file-log", qos: .utility)
    private let fileReadQueue = DispatchQueue(label: "dev.agentdeck.daemon.file-log-read", qos: .utility)

    private let osLog = os.Logger(subsystem: "dev.agentdeck.daemon", category: "daemon")
    private let logFile: URL
    private let rotatedLogFile: URL
    private let maxBytes: UInt64

    // Bytes written to `logFile` since it was opened or last rotated. Seeded
    // once from a `stat()` at init and updated on every write thereafter —
    // deliberately never re-`stat`'d per line, since that was the cost this
    // rotation exists to avoid paying per log call.
    private var currentBytes: UInt64

    init(logFile: URL = AgentDeckPaths.swiftDaemonLog, maxBytes: UInt64 = DaemonLogger.defaultMaxBytes) {
        self.logFile = logFile
        self.rotatedLogFile = logFile.deletingLastPathComponent()
            .appendingPathComponent(logFile.lastPathComponent + ".1")
        self.maxBytes = maxBytes
        let attrs = try? FileManager.default.attributesOfItem(atPath: logFile.path)
        self.currentBytes = (attrs?[.size] as? UInt64) ?? 0
    }

    private func writeToFile(_ line: String) {
        let entry = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
        guard let data = entry.data(using: .utf8) else { return }

        fileWriteQueue.async { [self] in
            rotateIfNeeded(nextWriteSize: data.count)
            appendData(data)
        }
    }

    /// Runs on `fileWriteQueue`. Renames the current file to `.1` (replacing
    /// any existing `.1`) when the next write would push it past `maxBytes`,
    /// so exactly one previous generation is ever kept. Any failure here
    /// (permissions, a missing directory, a concurrent delete) is swallowed —
    /// rotation must never throw or block the line being written; the write
    /// that follows simply keeps appending to the current file.
    private func rotateIfNeeded(nextWriteSize: Int) {
        guard currentBytes + UInt64(nextWriteSize) > maxBytes else { return }
        let fm = FileManager.default
        do {
            if fm.fileExists(atPath: rotatedLogFile.path) {
                try fm.removeItem(at: rotatedLogFile)
            }
            guard fm.fileExists(atPath: logFile.path) else {
                currentBytes = 0
                return
            }
            try fm.moveItem(at: logFile, to: rotatedLogFile)
            currentBytes = 0
        } catch {
            // Keep appending to the current (over-cap) file rather than
            // losing the line being written.
        }
    }

    /// Runs on `fileWriteQueue`. Appends `data` to `logFile`, creating it
    /// fresh when it doesn't exist (immediately after a rotation, or on the
    /// very first write).
    private func appendData(_ data: Data) {
        if let fh = try? FileHandle(forWritingTo: logFile) {
            fh.seekToEndOfFile()
            fh.write(data)
            fh.closeFile()
            currentBytes += UInt64(data.count)
        } else if (try? data.write(to: logFile)) != nil {
            currentBytes = UInt64(data.count)
        }
        // If both writes failed (e.g. the containing directory vanished),
        // `currentBytes` is left stale rather than reset — the next
        // successful append corrects it via the FileHandle path above.
    }

    /// Test-only: blocks until every write enqueued so far has completed.
    func waitForPendingWritesForTesting() {
        fileWriteQueue.sync {}
    }

    func debug(_ category: String, _ message: String) {
        let line = "DEBUG [\(category)] \(message)"
        writeToFile(line)
        guard isDebugEnabled else { return }
        osLog.debug("[\(category)] \(message)")
    }

    func throttledDebug(_ category: String, key: String, _ message: String, minInterval: TimeInterval) {
        let now = Date()
        stateLock.lock()
        let last = throttledKeys[key]
        if let last, now.timeIntervalSince(last) < minInterval {
            stateLock.unlock()
            return
        }
        throttledKeys[key] = now
        stateLock.unlock()
        debug(category, message)
    }

    func sampledDebug(_ category: String, key: String, every: Int, _ message: String) {
        guard every > 1 else {
            debug(category, message)
            return
        }

        stateLock.lock()
        let nextCount = (sampledCounters[key] ?? 0) + 1
        sampledCounters[key] = nextCount
        stateLock.unlock()

        guard nextCount == 1 || nextCount % every == 0 else { return }
        let suffix = nextCount == 1 ? "" : " [count=\(nextCount)]"
        debug(category, message + suffix)
    }

    func info(_ message: String) {
        let line = "INFO \(message)"
        writeToFile(line)
        osLog.info("\(message)")
    }

    func error(_ message: String) {
        let line = "ERROR \(message)"
        writeToFile(line)
        osLog.error("\(message)")
    }

    /// Returns up to `limit` most-recent lines. Reads only `logFile` when it
    /// already holds enough lines; when it's short — the common case in the
    /// first minutes after a rotation — falls back to the tail of the
    /// previous generation (`.1`) so the view isn't sparse right after a
    /// rotation. Older lines from `.1` are prepended (they're chronologically
    /// earlier than anything in the current file).
    func recentLines(limit: Int = 200) async -> [String] {
        await withCheckedContinuation { continuation in
            fileReadQueue.async { [logFile, rotatedLogFile] in
                var lines = Self.linesFromFile(logFile)
                if lines.count < limit {
                    let need = limit - lines.count
                    let older = Self.linesFromFile(rotatedLogFile)
                    if !older.isEmpty {
                        lines = Array(older.suffix(need)) + lines
                    }
                }
                guard lines.count > limit else {
                    continuation.resume(returning: lines)
                    return
                }
                continuation.resume(returning: Array(lines.suffix(limit)))
            }
        }
    }

    /// Lines of `url`, reading at most `tailBytes` from its END. `recentLines`
    /// only ever needs a couple of hundred lines, and the previous generation
    /// is up to `maxBytes` — on this desk the first `.1` was the 518 MB
    /// historical file — so loading it whole to answer a diagnostics view
    /// would stall the app for seconds and allocate the whole file as one
    /// String. The read is byte-offset, so the first line of the window is
    /// almost always a partial one and is dropped (a tail read must align to a
    /// line boundary or the first "line" is garbage).
    private static func linesFromFile(_ url: URL, tailBytes: Int = 512 * 1024) -> [String] {
        guard let fh = try? FileHandle(forReadingFrom: url) else { return [] }
        defer { try? fh.close() }
        let size = (try? fh.seekToEnd()) ?? 0
        let start = size > UInt64(tailBytes) ? size - UInt64(tailBytes) : 0
        try? fh.seek(toOffset: start)
        guard let data = try? fh.readToEnd(), let text = String(data: data, encoding: .utf8) else { return [] }
        var lines = text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
        if start > 0, !lines.isEmpty { lines.removeFirst() }
        return lines
    }
}
#endif
