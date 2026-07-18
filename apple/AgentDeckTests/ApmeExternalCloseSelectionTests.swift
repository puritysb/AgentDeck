// ApmeExternalCloseSelectionTests.swift — locks the collector-selection
// semantics behind `POST /task/close`.
//
// Two APME collectors track per-session active tasks: one fed by Claude Code
// hooks, one fed by the OpenClaw Gateway. `/task/close` must try the gateway
// first (the macOS app's most common use is OpenClaw chats) and fall through
// to the Claude collector ONLY when the gateway had nothing to close — never
// close both.
//
// The route used to inline this as two property reads inside a
// `MainActor.run` block, so its "same tick" atomicity was an artifact of where
// DaemonServer happened to be isolated. It now lives in one isolated method
// (`DaemonServer.closeApmeTaskExternal`) so that splitting the reads across a
// suspension is not expressible. These tests pin the behaviour that extraction
// had to preserve — first-wins order, and no double close — so the upcoming
// isolation change cannot quietly invert it.

#if os(macOS)
import XCTest
@testable import AgentDeck

// Exercises daemon-actor types (ApmeCollector, DaemonServer statics).
@DaemonActor
final class ApmeExternalCloseSelectionTests: XCTestCase {

    private func makeTempStore() throws -> (store: ApmeStore, dir: URL) {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("apme-close-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        setenv("AGENTDECK_DATA_DIR", dir.path, 1)
        let store = ApmeStore()
        XCTAssertTrue(store.open(), "store should open")
        return (store, dir)
    }

    private func cleanup(_ tmp: (store: ApmeStore, dir: URL)) {
        tmp.store.close()
        try? FileManager.default.removeItem(at: tmp.dir)
        unsetenv("AGENTDECK_DATA_DIR")
    }

    /// Open a run with one live task so `closeTaskExternal` has something to close.
    private func makeCollectorWithOpenTask(_ store: ApmeStore, project: String) -> ApmeCollector {
        let collector = ApmeCollector(store: store)
        collector.handleHook(event: "session_start", data: [
            "agent_type": "claude-code",
            "project_name": project,
        ])
        collector.handleHook(event: "UserPromptSubmit", data: ["prompt": "do the thing"])
        XCTAssertNotNil(collector.activeTaskId, "precondition: collector must hold an open task")
        return collector
    }

    func testGatewayWinsAndClaudeIsLeftUntouched() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let gateway = makeCollectorWithOpenTask(tmp.store, project: "gw")
        let claude = makeCollectorWithOpenTask(tmp.store, project: "cc")

        let result = DaemonServer.closeApmeTaskExternal(
            gateway: gateway, claude: claude,
            sessionId: nil, boundarySignal: "manual", outcome: nil
        )

        XCTAssertTrue(result.closed)
        XCTAssertEqual(result.where, "gateway")
        XCTAssertNil(gateway.activeTaskId, "gateway task should be closed")
        XCTAssertNotNil(claude.activeTaskId, "claude task must NOT be closed when the gateway won")
    }

    func testFallsThroughToClaudeWhenGatewayHasNothing() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let gateway = ApmeCollector(store: tmp.store) // no open task
        let claude = makeCollectorWithOpenTask(tmp.store, project: "cc")

        let result = DaemonServer.closeApmeTaskExternal(
            gateway: gateway, claude: claude,
            sessionId: nil, boundarySignal: "manual", outcome: nil
        )

        XCTAssertTrue(result.closed)
        XCTAssertEqual(result.where, "claude")
        XCTAssertNil(claude.activeTaskId, "claude task should be closed")
    }

    func testFallsThroughWhenGatewayIsAbsentEntirely() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let claude = makeCollectorWithOpenTask(tmp.store, project: "cc")

        let result = DaemonServer.closeApmeTaskExternal(
            gateway: nil, claude: claude,
            sessionId: nil, boundarySignal: "manual", outcome: nil
        )

        XCTAssertTrue(result.closed)
        XCTAssertEqual(result.where, "claude")
    }

    func testReportsNoneWhenNeitherHasAnOpenTask() async throws {
        let tmp = try makeTempStore()
        defer { cleanup(tmp) }
        let gateway = ApmeCollector(store: tmp.store)
        let claude = ApmeCollector(store: tmp.store)

        let result = DaemonServer.closeApmeTaskExternal(
            gateway: gateway, claude: claude,
            sessionId: nil, boundarySignal: "manual", outcome: nil
        )

        XCTAssertFalse(result.closed)
        XCTAssertEqual(result.where, "none", "404 path — neither collector had anything to close")
    }
}
#endif
