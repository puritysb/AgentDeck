// DaemonLoggerRotationTests.swift — the daemon log has no rotation.
//
// Measured 2026-09-10: `swift-daemon.log` reached 518 MB with no cap.
// `DaemonLogger.debug()` writes to the file unconditionally (only the os_log
// half is gated by the debug flag), so it's most of the volume. Rotation
// keeps exactly one previous generation (`.1`) so the worst case on disk is
// ~2x the cap, and `recentLines` must keep returning something useful right
// after a rotation even though the live file is momentarily short.
//
// Tests seed the "old" content directly on disk (rather than writing dozens
// of tiny lines through the logger) so each test drives exactly ONE rotation
// boundary deterministically — this also exercises "size read once at
// startup" (`init` stats the file it's handed), which a many-small-writes
// test wouldn't isolate.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class DaemonLoggerRotationTests: XCTestCase {

    private var tempDir: URL!
    private var logFile: URL!
    private var rotatedFile: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("DaemonLoggerRotationTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        logFile = tempDir.appendingPathComponent("swift-daemon.log")
        rotatedFile = tempDir.appendingPathComponent("swift-daemon.log.1")
    }

    override func tearDownWithError() throws {
        if let tempDir { try? FileManager.default.removeItem(at: tempDir) }
        tempDir = nil
        logFile = nil
        rotatedFile = nil
        try super.tearDownWithError()
    }

    /// Seeds `logFile` with old content under a 200-byte cap (so `init`
    /// picks it up via its startup `stat()`), then writes one line through
    /// the logger. That single write crosses the cap and must trigger
    /// exactly one rotation.
    func testRotatesToDotOneWhenCapExceeded() throws {
        let oldContent = "PRE-EXISTING OLD CONTENT MARKER\n"
        try oldContent.data(using: .utf8)!.write(to: logFile)

        // Cap set just above the seed's own size: the seed alone fits, but
        // any single logger write on top of it does not, so the very first
        // write must rotate.
        let logger = DaemonLogger(logFile: logFile, maxBytes: UInt64(oldContent.utf8.count + 5))
        logger.info("NEW LINE AFTER ROTATION")
        logger.waitForPendingWritesForTesting()

        XCTAssertTrue(FileManager.default.fileExists(atPath: rotatedFile.path), ".1 must exist after crossing the cap")
        XCTAssertTrue(FileManager.default.fileExists(atPath: logFile.path), "the live file must exist after rotation")

        let rotatedText = try String(contentsOf: rotatedFile, encoding: .utf8)
        let liveText = try String(contentsOf: logFile, encoding: .utf8)

        XCTAssertEqual(rotatedText, oldContent, ".1 must carry exactly the old content")
        XCTAssertTrue(liveText.contains("NEW LINE AFTER ROTATION"), "the live file must restart fresh and hold the new line")
        XCTAssertFalse(liveText.contains("PRE-EXISTING"), "the live file must not still carry the old content")

        // Nothing lost across the boundary: the line being written when the
        // cap was crossed lands somewhere, never silently dropped.
        let combined = rotatedText + liveText
        XCTAssertTrue(combined.contains("PRE-EXISTING OLD CONTENT MARKER"))
        XCTAssertTrue(combined.contains("NEW LINE AFTER ROTATION"))
    }

    /// A second rotation must replace the existing `.1` (exactly one
    /// generation kept), not accumulate a `.2`.
    func testSecondRotationReplacesExistingDotOne() throws {
        let seed = "FIRST OLD CONTENT\n"
        try seed.data(using: .utf8)!.write(to: logFile)
        // Cap just above the seed's size, same as the single-rotation test:
        // the seed forces the first rotation on the very next write.
        let logger = DaemonLogger(logFile: logFile, maxBytes: UInt64(seed.utf8.count + 5))

        logger.info("SECOND GENERATION CONTENT")
        logger.waitForPendingWritesForTesting()
        var rotatedText = try String(contentsOf: rotatedFile, encoding: .utf8)
        XCTAssertTrue(rotatedText.contains("FIRST OLD CONTENT"))

        // Pad the live file up near the cap again, then cross it — this must
        // rotate a second time, replacing `.1` with what's in the live file
        // now (not accumulating a `.2`).
        for i in 0..<20 { logger.info("padding \(i) xxxxxxxxxxxxxxxxxxxxxxxxxx") }
        logger.waitForPendingWritesForTesting()

        rotatedText = try String(contentsOf: rotatedFile, encoding: .utf8)
        XCTAssertFalse(rotatedText.contains("FIRST OLD CONTENT"), ".1 must have been replaced, not appended to")
        XCTAssertTrue(rotatedText.contains("SECOND GENERATION CONTENT") || rotatedText.contains("padding"))

        let olderFile = tempDir.appendingPathComponent("swift-daemon.log.2")
        XCTAssertFalse(FileManager.default.fileExists(atPath: olderFile.path), "only one previous generation is ever kept")
    }

    /// `recentLines` must keep working across the rotation boundary: right
    /// after a rotation the live file alone is short, so it must fall back
    /// to the tail of `.1` rather than reporting a near-empty view.
    func testRecentLinesSpansTheRotationBoundary() async throws {
        let oldLines = (0..<20).map { "2026-09-10T00:00:0\($0 % 10)Z INFO old-\($0)" }.joined(separator: "\n") + "\n"
        try oldLines.data(using: .utf8)!.write(to: logFile)

        let logger = DaemonLogger(logFile: logFile, maxBytes: UInt64(oldLines.utf8.count + 5))
        logger.info("new-0")
        logger.waitForPendingWritesForTesting()

        // Confirms the rotation actually happened (live file is short).
        let liveOnly = try String(contentsOf: logFile, encoding: .utf8)
        XCTAssertFalse(liveOnly.contains("old-"), "sanity: rotation must have moved the old content out of the live file")

        let lines = await logger.recentLines(limit: 25)
        XCTAssertTrue(lines.contains { $0.contains("new-0") }, "the newest line must be present")
        XCTAssertTrue(lines.contains { $0.contains("old-19") }, "the tail of .1 must fill in a short live file")
        XCTAssertEqual(lines.last.map { $0.contains("new-0") }, true, "the newest line must sort last")
    }

    /// Mutation check: with the rename never happening (equivalent to
    /// rotation being disabled — see the manual mutation run below), the
    /// live file just keeps growing unbounded and no `.1` is ever created.
    /// This is the same assertion shape `testRotatesToDotOneWhenCapExceeded`
    /// makes, so removing the rename call in `Logger.swift.rotateIfNeeded`
    /// turns that test red — verified manually: with `try
    /// fm.moveItem(at:to:)` commented out, `testRotatesToDotOneWhenCapExceeded`
    /// and `testSecondRotationReplacesExistingDotOne` both fail because no
    /// `.1` is ever written, then the mutation was reverted.
    func testNoRotationLeavesFileUnbounded() throws {
        let logger = DaemonLogger(logFile: logFile, maxBytes: .max)
        for i in 0..<50 { logger.info("line \(i)") }
        logger.waitForPendingWritesForTesting()

        XCTAssertFalse(FileManager.default.fileExists(atPath: rotatedFile.path), "no rotation must mean no .1 file")
        let liveSize = try FileManager.default.attributesOfItem(atPath: logFile.path)[.size] as? UInt64 ?? 0
        XCTAssertGreaterThan(liveSize, 200, "with rotation disabled the file grows past what a 200-byte cap would allow")
    }
}
#endif
