#if os(macOS)
import XCTest
@testable import AgentDeck

final class DaemonRecoveryTests: XCTestCase {
    @DaemonActor
    func testColdRecoveryRemovalsAndConcurrentCommitFence() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let shared = root.appendingPathComponent("shared"), a = root.appendingPathComponent("a"), b = root.appendingPathComponent("b")
        for p in [shared, a, b] { try FileManager.default.createDirectory(at: p, withIntermediateDirectories: true) }
        defer { try? FileManager.default.removeItem(at: root) }
        func owner(_ dir: URL) throws -> (SessionOrderStore, DaemonConfigurationStore, PocketAutonomy, DaemonCheckpointStore) {
            let order = SessionOrderStore(fileURL: dir.appendingPathComponent("session-order.json")).load()
            let config = DaemonConfigurationStore(directory: dir, order: order)
            let pocket = PocketAutonomy()
            let recovery = try DaemonRecoverySession(shared: shared, directory: dir)
            let store = try DaemonCheckpointStore(directory: dir, pocket: pocket, configuration: config, recovery: recovery)
            return (order, config, pocket, store)
        }
        let first = try owner(a)
        first.0.set("session-a", weight: -7)
        try first.1.save(.init(devices: [.init(ip: "127.0.0.2", brightness: 27, animation: "tide")], autoDiscover: false))
        var state = first.2.state; state.feedbackCount = 9; first.2.adopt(state)
        let oldInbox = try first.3.capture(receipts: [], sealed: true)
        let sql = DaemonRecoveryStore(directory: shared), old = try sql.load()
        let database = shared.appendingPathComponent(DaemonParityRules.recoveryFile)
        let beforeRead = try Data(contentsOf: database)
        _ = try sql.load()
        XCTAssertEqual(try Data(contentsOf: database), beforeRead)
        let second = try owner(b)
        XCTAssertEqual(second.0.weightFor("session-a"), -7); XCTAssertEqual(second.2.state.feedbackCount, 9)
        XCTAssertEqual(try second.1.pixoo().devices.first?.brightness, 27)
        XCTAssertThrowsError(try sql.commit(expected: old, payload: try XCTUnwrap(old).payload))
        second.0.clear("session-a"); try second.1.save(.init(devices: [], autoDiscover: false))
        _ = try second.3.capture(receipts: [], sealed: true)
        let localOrder = a.appendingPathComponent("session-order.json")
        var doc = try JSONSerialization.jsonObject(with: Data(contentsOf: localOrder)) as! [String: Any]
        var pins = doc["pins"] as! [String: [String: Any]]
        pins["session-a"]?["lastSeenAt"] = Int64(Date().timeIntervalSince1970 * 1000) + 60_000
        doc["pins"] = pins
        try JSONSerialization.data(withJSONObject: doc).write(to: localOrder)
        try Data(oldInbox.utf8).write(to: a.appendingPathComponent("daemon-checkpoint-peer.json"))
        let restored = try owner(a)
        XCTAssertTrue(restored.0.list().isEmpty); XCTAssertTrue(try restored.1.pixoo().devices.isEmpty)
        XCTAssertEqual(restored.2.state.feedbackCount, 9)
        let checkpointFile = a.appendingPathComponent("daemon-checkpoint.json")
        var metadata = try JSONSerialization.jsonObject(with: Data(contentsOf: checkpointFile)) as! [String: Any]
        metadata["writer"] = UUID().uuidString.lowercased()
        metadata["generation"] = (metadata["generation"] as! Int) + 1
        try JSONSerialization.data(withJSONObject: metadata).write(to: checkpointFile)
        let cursorFile = a.appendingPathComponent(DaemonParityRules.recoveryCursorFile)
        var cursor = try JSONSerialization.jsonObject(with: Data(contentsOf: cursorFile)) as! [String: Any]
        cursor["revision"] = max(1, (cursor["revision"] as! Int) - 1)
        cursor["digest"] = String(repeating: "0", count: 64)
        try JSONSerialization.data(withJSONObject: cursor).write(to: cursorFile)
        XCTAssertEqual(try owner(a).2.state.feedbackCount, 9)
        let before = try Data(contentsOf: a.appendingPathComponent("daemon-checkpoint.json"))
        try Data("{broken".utf8).write(to: shared.appendingPathComponent(DaemonParityRules.recoveryFile))
        XCTAssertThrowsError(try owner(a))
        XCTAssertEqual(try Data(contentsOf: a.appendingPathComponent("daemon-checkpoint.json")), before)
    }
    @DaemonActor
    func testConflictChoicesRetainBothVersionsAndRefuseStalePreview() async throws {
        for choice in ["local", "recovery"] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            let shared = root.appendingPathComponent("shared"), a = root.appendingPathComponent("a"), b = root.appendingPathComponent("b")
            for dir in [shared,a,b] { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
            defer { try? FileManager.default.removeItem(at: root) }
            func owner(_ dir: URL) throws -> (SessionOrderStore, DaemonCheckpointStore) {
                let pins = SessionOrderStore(fileURL: dir.appendingPathComponent("session-order.json")).load()
                let config = DaemonConfigurationStore(directory: dir, order: pins)
                return (pins, try DaemonCheckpointStore(directory: dir, pocket: PocketAutonomy(), configuration: config,
                    recovery: DaemonRecoverySession(shared: shared, directory: dir)))
            }
            let first = try owner(a); first.0.set("same", weight: 1); _ = try first.1.capture(receipts: [])
            let second = try owner(b); second.0.set("same", weight: 7); _ = try second.1.capture(receipts: [])
            first.0.set("same", weight: -9)
            let original = try Data(contentsOf: a.appendingPathComponent("session-order.json"))
            XCTAssertThrowsError(try owner(a))
            let sql = DaemonRecoveryStore(directory: shared), preview = try XCTUnwrap(sql.conflicts().first)
            second.0.set("same", weight: 8); _ = try second.1.capture(receipts: [])
            XCTAssertThrowsError(try sql.resolve(preview, choice: choice))
            XCTAssertEqual(try Data(contentsOf: a.appendingPathComponent("session-order.json")), original)
            let current = try XCTUnwrap(sql.conflicts().first)
            try sql.resolve(current, choice: choice)
            XCTAssertEqual(try Data(contentsOf: a.appendingPathComponent("session-order.json")), original)
            let restored = try owner(a)
            XCTAssertEqual(restored.0.weightFor("same"), choice == "local" ? -9 : 8)
            XCTAssertTrue(try sql.conflicts().isEmpty)
            let backup = try XCTUnwrap(FileManager.default.contentsOfDirectory(at: a, includingPropertiesForKeys: nil).first { $0.lastPathComponent.hasPrefix("daemon-recovery-resolution-") })
            XCTAssertEqual(try Data(contentsOf: backup.appendingPathComponent("session-order.json")), original)
            let other = try owner(b); other.0.set("same", weight: 12); _ = try other.1.capture(receipts: [])
            restored.0.set("same", weight: -9)
            XCTAssertThrowsError(try owner(a))
        }
    }
}
#endif
