// ClaudePermissionRequestTests.swift — Claude Code's `PermissionRequest` hook
// as an observation-only event, and releasing a held hook gate when the
// hook's socket closes. Mirror of the Node daemon's
// `setPermissionRequestOverlay` / `setPermissionNotificationOverlay` and
// `releaseHoldOnHookClose` (bridge/src/__tests__/awaiting-overlay.test.ts,
// tests/e2e/daemon-hub.e2e.test.ts).

#if os(macOS)
import Network
import XCTest
@testable import AgentDeck

final class ClaudePermissionRequestTests: XCTestCase {
    private typealias Signal = DaemonServer.ClaudePermissionPromptSignal

    private func question(
        _ signal: Signal, _ text: String,
        state: String? = "processing", current: String? = nil,
        askPending: Bool = false, gateHeld: Bool = false
    ) -> String? {
        DaemonServer.claudePermissionPromptQuestion(
            signal: signal, question: text, state: state, currentQuestion: current,
            askPending: askPending, gateHeld: gateHeld)
    }

    // MARK: - Event name and question

    func testMapsThePermissionRequestHook() {
        XCTAssertEqual(DaemonServer.mapHookEventName("PermissionRequest"), "permission_request")
    }

    func testGateQuestionNamesTheTool() {
        XCTAssertEqual(
            DaemonServer.claudeGateQuestion(tool: "Bash", toolInput: ["command": "rm -rf build"]),
            "Allow Bash: rm -rf build")
        XCTAssertEqual(
            DaemonServer.claudeGateQuestion(tool: "Edit", toolInput: ["file_path": "/tmp/a.txt"]),
            "Allow Edit: /tmp/a.txt")
        XCTAssertEqual(DaemonServer.claudeGateQuestion(tool: "WebSearch", toolInput: nil), "Allow WebSearch?")
        let long = String(repeating: "x", count: 300)
        XCTAssertEqual(DaemonServer.claudeGateQuestion(tool: "Bash", toolInput: ["command": long]).count, 120)
    }

    // MARK: - Overlay decision

    func testPermissionRequestAloneDoesNotProveAHumanWait() {
        XCTAssertNil(question(.permissionRequest, "Allow Bash: rm -rf build"))
        XCTAssertNil(question(.permissionRequest, "Allow Bash: ls", state: "idle"))
        XCTAssertNil(question(.permissionRequest, "Allow Bash: rm -rf build",
                              state: "awaiting_permission", current: "A real prompt"))
    }

    func testOnlyTheWaitingNotificationShowsPermissionAttention() {
        XCTAssertEqual(question(.notification, "  Claude needs your permission to use Bash  "),
                       "Claude needs your permission to use Bash")
        XCTAssertNil(question(.notification, "Claude needs your permission to use Bash",
                              state: "awaiting_permission", current: "A real prompt"))
    }

    func testUnstructuredStatusTextIsNotAPermissionPrompt() {
        for message in ["No longer needs your permission", "Not requesting permission",
                        "Output: Claude needs your permission to use Bash", "permission to use was granted"] {
            XCTAssertFalse(DaemonServer.isPermissionNotification(notificationType: nil, message: message))
        }
    }

    func testNeitherSignalReplacesAHeldGateOrAQuestion() {
        // A held gate owns the row and its requestId — the device's only way
        // to answer. Neither signal may touch it.
        XCTAssertNil(question(.permissionRequest, "Allow Bash: ls",
                              state: "awaiting_permission", current: "Allow Bash: rm -rf dist", gateHeld: true))
        XCTAssertNil(question(.notification, "Claude needs your permission",
                              state: "awaiting_permission", current: "Allow Bash: rm -rf dist", gateHeld: true))
        // An AskUserQuestion prompt carries the real choices.
        XCTAssertNil(question(.permissionRequest, "Allow AskUserQuestion?", state: "awaiting_option", current: "Pick one"))
        XCTAssertNil(question(.notification, "Claude needs your permission", askPending: true))
    }

    // MARK: - Peer-close signal

    func testPeerCloseSignalFiresOnceAndNeverAfterFinish() {
        let fired = Counter()
        let signal = HTTPPeerCloseSignal()
        signal.onClose { fired.add() }
        signal.fire()
        signal.fire()
        XCTAssertEqual(fired.value, 1)
        // A handler registered after the close runs at once.
        signal.onClose { fired.add() }
        XCTAssertEqual(fired.value, 2)

        let answered = HTTPPeerCloseSignal()
        answered.onClose { fired.add() }
        answered.finish()
        answered.fire() // our own close after the response
        answered.onClose { fired.add() }
        XCTAssertEqual(fired.value, 2)
    }

    func testPeerCloseReleasesAHeldGateUndecided() async throws {
        let steering = ObservedSteering()
        guard ObservedSteering.askGateEnabled else { throw XCTSkip("AGENTDECK_ASK_GATE=0") }
        let begun = await steering.beginAskGate(sessionId: "sid-peer-close", clientCount: 1)
        let requestId = try XCTUnwrap(begun)
        let signal = HTTPPeerCloseSignal()
        HTTPRequestContext.$peerClose.withValue(signal) {
            DaemonServer.releaseHoldOnPeerClose(requestId: requestId, steering: steering)
        }
        let held = Task { await steering.awaitGate(requestId: requestId) }
        try? await Task.sleep(nanoseconds: 50_000_000)
        let started = Date()
        signal.fire()
        let decision = await held.value
        XCTAssertEqual(decision, "pass")
        XCTAssertLessThan(Date().timeIntervalSince(started), 2, "released by the close, not the hold timer")
        // Released: the session can hold again.
        let again = await steering.beginAskGate(sessionId: "sid-peer-close", clientCount: 1)
        XCTAssertNotNil(again)
    }

    /// The real listener: a client that sends a request and goes away fires
    /// the handler's signal; a request answered normally does not.
    func testHTTPServerSignalsAPeerThatClosesBeforeTheAnswer() async throws {
        let port: UInt16 = 19143
        let server = HTTPServer()
        let closed = Counter()
        let answeredClosed = Counter()
        await server.post("/hold") { _ in
            HTTPRequestContext.peerClose?.onClose { closed.add() }
            for _ in 0..<100 where closed.value == 0 {
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
            return .text("")
        }
        await server.post("/quick") { _ in
            HTTPRequestContext.peerClose?.onClose { answeredClosed.add() }
            return .text("ok")
        }
        do {
            try await server.start(port: port)
        } catch {
            throw XCTSkip("port \(port) unavailable on this machine: \(error)")
        }
        defer { Task { await server.stop() } }
        try? await Task.sleep(nanoseconds: 200_000_000)

        // 1. Request, then close without reading the answer.
        let conn = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        conn.start(queue: .global())
        let request = "POST /hold HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 2\r\n\r\n{}"
        conn.send(content: Data(request.utf8), completion: .contentProcessed { _ in })
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(closed.value, 0, "an open peer is not a closed one")
        conn.cancel()
        for _ in 0..<40 where closed.value == 0 {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(closed.value, 1, "the hold learned its peer went away")

        // 2. A normally answered request never fires.
        var quick = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/quick")!)
        quick.httpMethod = "POST"
        quick.httpBody = Data("{}".utf8)
        quick.timeoutInterval = 5
        let (body, _) = try await URLSession.shared.data(for: quick)
        XCTAssertEqual(String(decoding: body, as: UTF8.self), "ok")
        try? await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(answeredClosed.value, 0)
    }
}

private final class Counter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
    func add() { lock.lock(); count += 1; lock.unlock() }
}
#endif
