#if os(macOS)
import XCTest
@testable import AgentDeck

final class DaemonCheckpointTests: XCTestCase {
    @DaemonActor
    func testActualNodeReceiptVectorAndCheckpointDecode() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("shared/daemon-checkpoint-vectors.json"))) as? [String: Any])
        for vector in raw["decisions"] as? [[String: Any]] ?? [] {
            let decision = try XCTUnwrap(vector["decision"] as? [String: Any])
            XCTAssertEqual(DaemonCheckpointStore.receiptKey(decision), vector["key"] as? String)
        }
        let authorityRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: authorityRoot) }
        for authority in raw["authorityCases"] as? [[String: Any]] ?? [] {
            let dir = authorityRoot.appendingPathComponent(UUID().uuidString)
            let own = try DaemonCheckpointStore(directory: dir, pocket: PocketAutonomy())
            var reference = try XCTUnwrap(DaemonCheckpointStore.parse(own.capture(receipts: [])))
            if authority["withPeer"] as? Bool == true {
                let peer = try DaemonCheckpointStore(directory: authorityRoot.appendingPathComponent(UUID().uuidString), pocket: PocketAutonomy())
                let payload = try peer.capture(receipts: [])
                XCTAssertNotNil(try DaemonCheckpointStore.stagePeer(payload, directory: dir))
                reference = try XCTUnwrap(DaemonCheckpointStore.parse(payload))
            }
            let next = try DaemonCheckpointStore(directory: dir, pocket: PocketAutonomy())
            let value = try XCTUnwrap(DaemonCheckpointStore.parse(next.capture(receipts: next.restoredReceipts)))
            XCTAssertEqual(value.lineage != reference.lineage, authority["newLineage"] as? Bool)
        }
        let decision = try XCTUnwrap(raw["decision"] as? [String: Any])
        let bytes = try JSONSerialization.data(withJSONObject: try XCTUnwrap(raw["checkpoint"]))
        let value = try XCTUnwrap(DaemonCheckpointStore.parse(String(decoding: bytes, as: UTF8.self)))
        XCTAssertEqual(DaemonCheckpointStore.receiptKey(decision), value.receipts.first?.key)
        let encoded = try JSONEncoder().encode(value)
        XCTAssertNotNil(DaemonCheckpointStore.parse(String(decoding: encoded, as: UTF8.self)))
    }

    @DaemonActor
    func testAggregateReceiptRoundTripAndOldFrameFence() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appendingPathComponent("source"), target = dir.appendingPathComponent("target")
        let pocket = PocketAutonomy()
        var state = pocket.state; state.feedbackCount = 7; pocket.adopt(state)
        let decision: [String: Any] = ["cardId": "opaque:fixture", "action": "card_choice", "choiceId": "useful", "text": "private text / 한글"]
        let key = try XCTUnwrap(DaemonCheckpointStore.receiptKey(decision))
        let store = try DaemonCheckpointStore(directory: source, pocket: pocket)
        let old = try store.capture(receipts: [])
        let receipt = DaemonReceipt(key: key, status: "applied")
        let payload = try store.capture(receipts: [receipt], sealed: true)
        XCTAssertNotNil(try DaemonCheckpointStore.stagePeer(payload, directory: target))
        XCTAssertNil(try DaemonCheckpointStore.stagePeer(old, directory: target))
        XCTAssertNotNil(try DaemonCheckpointStore.stagePeer(payload, directory: target))
        let restored = PocketAutonomy(), next = try DaemonCheckpointStore(directory: target, pocket: restored)
        XCTAssertEqual(restored.state.feedbackCount, 7)
        XCTAssertEqual(next.restoredReceipts.first?.key, key)
        XCTAssertNil(try DaemonCheckpointStore.stagePeer(payload, directory: target))
        let bytes = try next.capture(receipts: next.restoredReceipts)
        XCTAssertFalse(bytes.contains("private text")); XCTAssertFalse(bytes.contains("opaque:fixture"))
        var retry = decision; retry["ageSec"] = 999
        XCTAssertEqual(DaemonCheckpointStore.receiptKey(retry), key)
        let dead = BridgeDeliveryToken(); dead.invalidate()
        XCTAssertNil(try DaemonCheckpointStore.stagePeer(payload, directory: dir.appendingPathComponent("dead"), isCurrent: { dead.isValid }))
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("dead").path))
    }

    @DaemonActor
    func testAbsentOwnerRestartBranchesWithoutLosingItsLocalReceipts() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: dir) }
        let pocket = PocketAutonomy(), first = try DaemonCheckpointStore(directory: dir, pocket: pocket)
        let receipt = DaemonReceipt(key: String(repeating: "a", count: 64), status: "applied")
        let prior = try XCTUnwrap(DaemonCheckpointStore.parse(first.capture(receipts: [receipt])))
        let next = try DaemonCheckpointStore(directory: dir, pocket: pocket)
        let restarted = try XCTUnwrap(DaemonCheckpointStore.parse(next.capture(receipts: next.restoredReceipts)))
        XCTAssertNotEqual(prior.lineage, restarted.lineage)
        XCTAssertEqual(restarted.receipts.first?.key, receipt.key)
    }

    @DaemonActor
    func testCorruptCheckpointIsPreservedAndCannotResetState() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("daemon-checkpoint.json")
        try Data("{corrupt".utf8).write(to: path)
        XCTAssertThrowsError(try DaemonCheckpointStore(directory: dir, pocket: PocketAutonomy()))
        XCTAssertEqual(try String(contentsOf: path, encoding: .utf8), "{corrupt")
    }

    @MainActor
    func testPowerRegistrationIsExplicitlyReleasedAndStopIsIdempotent() {
        let observation = DaemonPowerObservation(wake: {})
        XCTAssertTrue(observation.isRegistered)
        observation.stop(); XCTAssertFalse(observation.isRegistered)
        observation.stop(); XCTAssertFalse(observation.isRegistered)
    }
}
#endif
