// PixooTideTests.swift — the Swift twin of the Pixoo64 "Tide" scene
// (PixooTide.swift) must draw what bridge/src/pixoo/pixoo-tide.ts draws, byte for
// byte, and must decide to upload for the same reasons. The frame digests below are
// pinned in BOTH test suites (bridge/src/__tests__/pixoo-tide.test.ts holds the same
// table): changing either renderer fails the other side until it is ported.

#if os(macOS)
import CryptoKit
import XCTest
@testable import AgentDeck

final class PixooTideTests: XCTestCase {
    private let nowMs = 1_900_000_000_000.0
    private let renderer = PixooRenderer()

    private func payload(_ id: String, _ agentType: String, _ state: String) -> [String: Any] {
        ["id": id, "agentType": agentType, "state": state, "alive": true, "projectName": id, "port": 9121]
    }

    private func scene(
        _ sessions: [[String: Any]], fiveHour: Double? = nil, sevenDay: Double? = nil, gatewayHasError: Bool = false
    ) -> (state: DashboardState, marks: PixooTide.Marks) {
        var state = DashboardState()
        state.fiveHourPercent = fiveHour
        state.sevenDayPercent = sevenDay
        state.gatewayHasError = gatewayHasError
        state.siblingSessions = sessions.compactMap { raw in
            guard let id = raw["id"] as? String else { return nil }
            return SessionInfo(id: id, port: 9121, projectName: raw["projectName"] as? String,
                               agentType: raw["agentType"] as? String, alive: (raw["alive"] as? Bool) ?? true,
                               state: raw["state"] as? String)
        }
        let marks = PixooTide.resolveMarks(
            sessions: sessions, primary: nil, gatewayHasError: gatewayHasError,
            glyphFor: { self.renderer.officialGlyph(forAgentType: $0) }
        )
        return (state, marks)
    }

    private func frames(_ built: (state: DashboardState, marks: PixooTide.Marks)) -> [Data] {
        renderer.renderTideLoop(dashboardState: built.state, marks: built.marks, nowMs: nowMs)
    }

    private func digest(_ frame: Data) -> String {
        SHA256.hash(data: frame).map { String(format: "%02x", $0) }.joined().prefix(16).description
    }

    private func diff(_ a: Data, _ b: Data) -> Int {
        zip(a, b).reduce(0) { $0 + ($1.0 == $1.1 ? 0 : 1) }
    }

    // MARK: - Node parity

    /// Same scenarios, same table as `tide frame digests` in pixoo-tide.test.ts.
    func testFramesMatchTheNodeRendererByteForByte() {
        let scenes: [(String, (state: DashboardState, marks: PixooTide.Marks), [String])] = [
            ("empty", scene([]), [
                "8e96cc0790f21a1c", "da28e790ad7d69e9", "a453a44fd386fe72", "530f2353682c7241", "28c12d7dc8082fc6", "df20752288cb3b5a",
            ]),
            ("pair", scene([payload("a", "claude-code", "processing"), payload("b", "codex-cli", "idle")], fiveHour: 40, sevenDay: 10), [
                "ef10d2eec5397d22", "bffb22733ae0dbc9", "f5bb5a64dfc0e3f6", "cd9bc59de2d38266", "3759377e4b50bc2c", "c1e53456a471ad46",
            ]),
            ("crowd", scene([
                payload("a", "claude-code", "awaiting_option"), payload("b", "codex-cli", "processing"), payload("c", "opencode", "idle"),
                payload("d", "kiro-cli", "idle"), payload("e", "antigravity", "idle"),
            ], fiveHour: 80, sevenDay: 55), [
                "ce012f11674a2f5a", "8c946089abbad979", "40fc2cafa7507dec", "751c59863b57e79b", "df6317eb87be52f7", "712f340a76381e38",
            ]),
            ("trio", scene([
                payload("a", "hermes", "processing"), payload("b", "antigravity", "awaiting_permission"), payload("c", "kiro-cli", "idle"),
            ]), [
                "9085f818d08955c5", "147d2c6650d316b0", "7fda6973b235b9ed", "7a2b1e39d3467039", "9db620dc5b0bd4ca", "81e4477f85c99b54",
            ]),
            ("claw", scene([payload("o", "openclaw", "idle"), payload("a", "claude-code", "idle")],
                           fiveHour: 5, sevenDay: 5, gatewayHasError: true), [
                "0478aa3b8c7bdded", "37b8c3c88423629e", "2ba6bc92ed86f12b", "2bd550cc0f04d291", "0e717bd9b73473a5", "aecfeab96cf57020",
            ]),
        ]
        for (name, built, expected) in scenes {
            let got = frames(built).map(digest)
            XCTAssertEqual(got, expected, "\(name): Swift Tide frames drifted from bridge/src/pixoo/pixoo-tide.ts")
        }
    }

    // MARK: - Loop shape

    func testLoopHasSixFramesAndFitsOneUpload() {
        XCTAssertEqual(PixooTide.frames, 6)
        XCTAssertEqual(PixooTide.frames * PixooTide.picSpeedMs, 3000)
        let out = frames(scene([payload("a", "claude-code", "processing")]))
        XCTAssertEqual(out.count, PixooTide.frames)
        XCTAssertTrue(out.allSatisfy { $0.count == 64 * 64 * 3 })
    }

    func testLoopClosesAndMoves() {
        let scenes = [
            scene([payload("a", "claude-code", "processing")]),
            scene([payload("a", "codex-cli", "awaiting_option"), payload("b", "claude-code", "processing")]),
            scene([payload("a", "opencode", "idle"), payload("b", "kiro-cli", "idle"), payload("c", "claude-code", "idle")]),
            scene([]),
        ]
        for built in scenes {
            let out = frames(built)
            let steps = out.indices.map { diff(out[$0], out[($0 + 1) % out.count]) }
            let wrap = steps[steps.count - 1]
            let others = steps.dropLast().max() ?? 0
            XCTAssertLessThanOrEqual(Double(wrap), Double(others) * 1.25, "wrap step \(wrap) vs largest \(others)")
            XCTAssertGreaterThan(steps.min() ?? 0, 0, "a frozen step")
        }
    }

    func testTickWrapsModuloTheLoopAndIsDeterministic() {
        let built = scene([payload("a", "claude-code", "processing")])
        let a = renderer.renderTideFrame(dashboardState: built.state, marks: built.marks, nowMs: nowMs, tick: 0)
        let b = renderer.renderTideFrame(dashboardState: built.state, marks: built.marks, nowMs: nowMs + 99_999, tick: PixooTide.frames)
        XCTAssertEqual(diff(a, b), 0)
    }

    func testJsRoundIsHalfTowardPositiveInfinity() {
        XCTAssertEqual(PixooTide.jsRound(0.5), 1)
        XCTAssertEqual(PixooTide.jsRound(-0.5), 0)   // Swift's round() says -1
        XCTAssertEqual(PixooTide.jsRound(-1.5), -1)  // Swift's round() says -2
        XCTAssertEqual(PixooTide.jsRound(2.4), 2)
    }

    // MARK: - Marks

    func testLoudestMarksFirstAndOverflowCounted() {
        let built = scene([
            payload("i1", "claude-code", "idle"), payload("i2", "opencode", "idle"), payload("i3", "kiro-cli", "idle"),
            payload("p1", "claude-code", "processing"), payload("w1", "claude-code", "awaiting_option"),
        ])
        XCTAssertEqual(built.marks.marks.map(\.id), ["w1", "p1", "i1", "i2"])
        XCTAssertEqual(built.marks.overflow, 1)
    }

    func testUnknownAgentTypeDrawsAsNothing() {
        XCTAssertEqual(scene([payload("x", "future-agent", "processing")]).marks.marks, [])
    }

    func testDeadSessionsAreSkippedAndCodexRowsFoldByProject() {
        var dead = payload("dead", "claude-code", "processing")
        dead["alive"] = false
        let built = scene([dead, payload("c1", "codex-cli", "idle"), payload("c2", "codex-cli", "idle")]
            .map { var row = $0; if row["agentType"] as? String == "codex-cli" { row["projectName"] = "p" }; return row })
        XCTAssertEqual(built.marks.marks.map(\.glyph), [.codex])
    }

    func testPrimaryStandsInOnlyWhileSessionsWereNeverReceived() {
        let primary = (agentType: "claude-code", state: "processing")
        let glyphFor: (String) -> OfficialDotGlyph? = { self.renderer.officialGlyph(forAgentType: $0) }
        XCTAssertEqual(PixooTide.resolveMarks(sessions: nil, primary: primary, gatewayHasError: false, glyphFor: glyphFor).marks.count, 1)
        XCTAssertEqual(PixooTide.resolveMarks(sessions: [], primary: primary, gatewayHasError: false, glyphFor: glyphFor).marks.count, 0)
    }

    func testOpenClawMarkSicknessFollowsTheGateway() {
        let built = scene([payload("o", "openclaw", "idle")], gatewayHasError: true)
        XCTAssertEqual(built.marks.marks.first?.glyph, .openClaw)
        XCTAssertEqual(built.marks.marks.first?.sick, true)
    }

    // MARK: - Upload policy

    func testPolicyMirrorsTheNodeBridge() {
        func sig(_ scene: String, _ hud: String = "h") -> PixooTide.Signature { .init(scene: scene, hud: hud) }
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        func at(_ s: TimeInterval) -> Date { t0.addingTimeInterval(s) }
        let uploaded = PixooTide.UploadRecord(signature: sig("a"), at: t0)

        XCTAssertEqual(PixooTide.decision(signature: sig("a"), uploaded: nil, lastAttemptAt: nil, retryAt: nil, now: t0), .upload)
        XCTAssertEqual(PixooTide.decision(signature: sig("a"), uploaded: uploaded, lastAttemptAt: t0, retryAt: nil, now: at(5)), .wait)
        XCTAssertEqual(PixooTide.decision(signature: sig("a"), uploaded: uploaded, lastAttemptAt: t0, retryAt: nil, now: at(PixooTide.Policy.verify)), .verify)
        // A flapping scene buys at most one upload per floor.
        XCTAssertEqual(PixooTide.decision(signature: sig("b"), uploaded: uploaded, lastAttemptAt: t0, retryAt: nil, now: at(3)), .wait)
        XCTAssertEqual(PixooTide.decision(signature: sig("b"), uploaded: uploaded, lastAttemptAt: t0, retryAt: nil, now: at(PixooTide.Policy.sceneFloor)), .upload)
        // A usage-only change is slow-moving.
        XCTAssertNotEqual(PixooTide.decision(signature: sig("a", "h2"), uploaded: uploaded, lastAttemptAt: t0, retryAt: nil, now: at(PixooTide.Policy.sceneFloor)), .upload)
        XCTAssertEqual(PixooTide.decision(signature: sig("a", "h2"), uploaded: uploaded, lastAttemptAt: t0, retryAt: nil, now: at(PixooTide.Policy.hudFloor)), .upload)
        // Back off after a failed upload instead of retrying every tick.
        XCTAssertEqual(PixooTide.decision(signature: sig("a"), uploaded: nil, lastAttemptAt: t0, retryAt: at(PixooTide.Policy.retry), now: at(1)), .wait)
        XCTAssertEqual(PixooTide.decision(signature: sig("a"), uploaded: nil, lastAttemptAt: t0, retryAt: at(PixooTide.Policy.retry), now: at(PixooTide.Policy.retry)), .upload)
    }

    func testSignatureIgnoresWhatThePanelCannotShowAndSeparatesTheUsageStrip() {
        let sessions = [payload("a", "claude-code", "processing"), payload("b", "codex-cli", "idle")]
        let base = scene(sessions, fiveHour: 40, sevenDay: 10)
        let withHidden = scene(sessions + [payload("z", "future-agent", "processing")], fiveHour: 41, sevenDay: 10)
        let a = PixooTide.signature(marks: base.marks, sessions: sessions, usage: base.state)
        let b = PixooTide.signature(marks: withHidden.marks, sessions: sessions, usage: withHidden.state)
        XCTAssertEqual(a.scene, b.scene)
        XCTAssertNotEqual(a.hud, b.hud)

        let asking = scene([payload("a", "claude-code", "awaiting_option"), payload("b", "codex-cli", "idle")], fiveHour: 40, sevenDay: 10)
        XCTAssertNotEqual(PixooTide.signature(marks: asking.marks, sessions: sessions, usage: asking.state).scene, a.scene)
    }

    func testDeviceSettingParsesTideAndNothingElseWakesIt() {
        XCTAssertTrue(PixooDevice(ip: "1.2.3.4", animation: "tide").isTide)
        XCTAssertFalse(PixooDevice(ip: "1.2.3.4").isTide)
        XCTAssertFalse(PixooDevice(ip: "1.2.3.4", animation: "loop").isTide)
    }
}
#endif
