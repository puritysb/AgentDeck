import XCTest
import Foundation
import Darwin
@testable import NativeClientCore

final class IOTests: XCTestCase {
    func testPrivateLockExcludesAnotherOwnerAndReleasesWithoutDeletingFile() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var first: PrivateLock? = try PrivateLock(directory: directory, name: "test")
        XCTAssertNotNil(first)
        XCTAssertThrowsError(try PrivateLock(directory: directory, name: "test"))
        first = nil
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("test.lock").path))
        XCTAssertNoThrow(try PrivateLock(directory: directory, name: "test"))
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: directory.path)
        XCTAssertThrowsError(try PrivateLock(directory: directory, name: "test"))
    }
    func testPrivateLockRejectsSymlinkDirectoryAndLock() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: base) }
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let target = base.appendingPathComponent("target"), link = base.appendingPathComponent("link")
        try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        XCTAssertThrowsError(try PrivateLock(directory: link, name: "test"))
        try Data().write(to: target.appendingPathComponent("actual"))
        try FileManager.default.createSymbolicLink(at: target.appendingPathComponent("test.lock"), withDestinationURL: target.appendingPathComponent("actual"))
        XCTAssertThrowsError(try PrivateLock(directory: target, name: "test"))
    }
    func testFramingBoundsIncompleteAndOversizedInput() throws {
        func consume(_ data: Data) throws -> [Data] {
            let file = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            try data.write(to: file); defer { try? FileManager.default.removeItem(at: file) }
            let fd = open(file.path, O_RDONLY); defer { close(fd) }
            var frames: [Data] = []
            try Framing.readFrames(fd: fd) { frames.append($0) }
            return frames
        }
        XCTAssertEqual(try consume(Data("{}\n{\"id\":1}\n".utf8)).count, 2)
        XCTAssertThrowsError(try consume(Data("{}".utf8)))
        XCTAssertThrowsError(try consume(Data(repeating: 97, count: Contract.bodyLimit + 1)))
    }
    func testSingleFrameStillTimesOutIfWriterNeverCloses() throws {
        var descriptors: [Int32] = [0, 0]
        XCTAssertEqual(pipe(&descriptors), 0)
        defer { close(descriptors[0]); close(descriptors[1]) }
        let data = Data("{}\n".utf8)
        _ = data.withUnsafeBytes { Darwin.write(descriptors[1], $0.baseAddress!, $0.count) }
        let began = Date()
        XCTAssertThrowsError(try Framing.readSingle(fd: descriptors[0], timeout: 0.01))
        XCTAssertLessThan(Date().timeIntervalSince(began), 1)
    }
}
