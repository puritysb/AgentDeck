import XCTest
@testable import AgentDeck

/// #463: Swift mirror of `shared/src/__tests__/session-settings.test.ts`. Row and
/// defaults shapes captured from a live OpenClaw Gateway (2026.9.8).
final class OpenClawSessionSettingsTests: XCTestCase {
    private let levels: [[String: Any]] = ["off", "low", "medium", "high"].map { ["id": $0, "label": $0] }
    private let catalog: [[String: Any]] = [
        ["key": "openai/gpt-6-sol", "name": "GPT-6 Sol", "role": "default", "available": true],
        ["key": "zai/glm-5.3", "name": "zai/glm-5.3", "role": "configured", "available": true],
        ["key": "gone/model", "name": "Gone", "role": "configured", "available": false],
    ]

    func testProjectsRowLevelsCurrentAndDefaultVerbatim() {
        let row: [String: Any] = [
            "thinkingLevel": "medium", "thinkingLevels": levels, "thinkingDefault": "high",
            "modelProvider": "openai", "model": "gpt-6-sol", "modelOverrideSource": NSNull(),
        ]
        let out = OpenClawSessionSettings.settings(row: row, defaults: nil, catalog: catalog)
        XCTAssertEqual(out.map { $0["key"] as? String }, ["model", "effort"])
        let model = out[0], effort = out[1]
        XCTAssertEqual(model["current"] as? String, "openai/gpt-6-sol")
        XCTAssertEqual(model["default"] as? String, "openai/gpt-6-sol")
        XCTAssertNil(model["overridden"])
        XCTAssertEqual((model["options"] as? [[String: Any]])?.map { $0["id"] as? String }, ["openai/gpt-6-sol", "zai/glm-5.3"])
        XCTAssertEqual((model["options"] as? [[String: Any]])?.first?["label"] as? String, "GPT-6 Sol")
        XCTAssertEqual(effort["current"] as? String, "medium")
        XCTAssertEqual(effort["default"] as? String, "high")
        // A label equal to its id is dropped, as in the TS projection.
        XCTAssertNil((effort["options"] as? [[String: Any]])?.first?["label"])
    }

    func testOverrideBinaryLabelAndDefaultsFallback() {
        let row: [String: Any] = [
            "modelOverrideSource": "user", "model": "glm-5.3", "modelProvider": "zai",
            "thinkingLevels": [["id": "off", "label": "off"], ["id": "low", "label": "on"]],
        ]
        let out = OpenClawSessionSettings.settings(row: row, defaults: ["thinkingDefault": "low"], catalog: catalog)
        XCTAssertEqual(out[0]["overridden"] as? Bool, true)
        XCTAssertEqual((out[1]["options"] as? [[String: Any]])?.last?["label"] as? String, "on")
        XCTAssertEqual(out[1]["current"] as? String, "low")
    }

    func testNeverInventsAndNoCatalogMeansNoModelSetting() {
        XCTAssertTrue(OpenClawSessionSettings.settings(row: [:], defaults: nil, catalog: nil).isEmpty)
        let out = OpenClawSessionSettings.settings(row: ["thinkingOptions": ["on", "off"]], defaults: nil, catalog: [])
        XCTAssertEqual(out.count, 1)
        XCTAssertNil(out[0]["current"])
        XCTAssertNil(out[0]["default"])
    }

    func testPatchParamsMapKeysAndClearWithNull() {
        let effort = OpenClawSessionSettings.patchParams(sessionKey: "k", key: "effort", value: "high")
        XCTAssertEqual(effort?["thinkingLevel"] as? String, "high")
        let cleared = OpenClawSessionSettings.patchParams(sessionKey: "k", key: "model", value: nil)
        XCTAssertTrue(cleared?["model"] is NSNull)
        XCTAssertNil(OpenClawSessionSettings.patchParams(sessionKey: "k", key: "fastMode", value: "on"))
    }

    private var setCommand: [String: Any] {
        ["type": "set_session_setting", "requestId": "request-a", "sessionId": "openclaw-gateway",
         "targetSessionKey": "agent:main:a", "key": "effort", "value": "high"]
    }

    func testOnlyExplicitNullClearsAndMalformedValuesAreRejected() throws {
        var input = setCommand
        input["value"] = NSNull()
        let clear = try XCTUnwrap(OpenClawSessionSettings.command(input))
        XCTAssertNil(clear.error)
        XCTAssertNil(clear.value)
        input.removeValue(forKey: "value")
        XCTAssertNotNil(OpenClawSessionSettings.command(input)?.error)
        for invalid: Any in [true, 17, ["value": "high"], ["high"], "", " \t\n"] {
            input["value"] = invalid
            XCTAssertNotNil(OpenClawSessionSettings.command(input)?.error)
        }
        input["value"] = "unknown-agent-native-level"
        XCTAssertEqual(OpenClawSessionSettings.command(input)?.value, "unknown-agent-native-level")
        XCTAssertNil(OpenClawSessionSettings.command(input)?.error)
    }

    func testCorrelatedInputRequiresKnownKeysAndBoundTarget() {
        var input = setCommand
        for key: Any in ["fastMode", "unknown", 2, NSNull()] {
            input["key"] = key
            XCTAssertNotNil(OpenClawSessionSettings.command(input)?.error)
        }
        input = setCommand
        input.removeValue(forKey: "targetSessionKey")
        XCTAssertNotNil(OpenClawSessionSettings.command(input)?.error)
        input["targetSessionKey"] = true
        XCTAssertNotNil(OpenClawSessionSettings.command(input)?.error)
        input = setCommand
        input.removeValue(forKey: "requestId")
        XCTAssertNil(OpenClawSessionSettings.command(input))
        input["requestId"] = " "
        XCTAssertNil(OpenClawSessionSettings.command(input))
        input = setCommand
        input["type"] = "unknown_command"
        XCTAssertNil(OpenClawSessionSettings.command(input))
    }

    func testLengthsUseWireUTF16UnitsWithoutRewritingAgentValues() {
        var input = setCommand
        let request = String(repeating: "🙂", count: SessionSettingsRules.maxRequestIdLength / 2)
        input["requestId"] = request
        XCTAssertEqual(OpenClawSessionSettings.command(input)?.requestId, request)
        input["requestId"] = request + "🙂"
        XCTAssertNil(OpenClawSessionSettings.command(input))
        input = setCommand
        let value = String(repeating: "🙂", count: SessionSettingsRules.maxValueLength / 2)
        input["value"] = value
        XCTAssertNil(OpenClawSessionSettings.command(input)?.error)
        input["value"] = value + "🙂"
        XCTAssertNotNil(OpenClawSessionSettings.command(input)?.error)
        input = setCommand
        input["targetSessionKey"] = String(repeating: "🙂", count: SessionSettingsRules.maxTargetKeyLength / 2 + 1)
        XCTAssertNotNil(OpenClawSessionSettings.command(input)?.error)
        XCTAssertNil(OpenClawSessionSettings.patchParams(sessionKey: "a", key: "model", value: " "))
    }
}

#if os(macOS)
private actor SettingsGatewayProbe {
    var active = "agent:main:a"
    var moveOnList = false
    var moveOnPatch = false
    private(set) var calls: [(String, String?)] = []

    func configure(moveOnList: Bool = false, moveOnPatch: Bool = false) {
        self.moveOnList = moveOnList
        self.moveOnPatch = moveOnPatch
    }
    func rpc(_ request: OpenClawSessionSettings.RPCRequest) -> OpenClawSessionSettings.RPCReply {
        calls.append((request.method, request.params["key"] as? String))
        if request.method == "sessions.patch" {
            if moveOnPatch { active = "agent:main:b" }
            return .init(ok: true, payload: [:], error: nil)
        }
        if request.method == "sessions.list" {
            if moveOnList { active = "agent:main:b" }
            return .init(ok: true, payload: ["sessions": [
                ["key": "agent:main:a", "thinkingLevel": "high", "thinkingOptions": ["off", "high"]],
                ["key": "agent:main:b", "thinkingLevel": "off", "thinkingOptions": ["off", "high"]],
            ]], error: nil)
        }
        return .init(ok: true, payload: ["models": []], error: nil)
    }
}

final class OpenClawSessionSettingsRuntimeTests: XCTestCase {
    func testQueryReturnsCapturedTargetEvenWhenNewestSessionChangesDuringAwait() async {
        let peer = SettingsGatewayProbe()
        await peer.configure(moveOnList: true)
        let captured = await peer.active
        let read = await OpenClawSessionSettings.query(targetSessionKey: captured) { await peer.rpc($0) }
        let active = await peer.active
        XCTAssertEqual(active, "agent:main:b")
        XCTAssertEqual(read.targetSessionKey, "agent:main:a")
        XCTAssertEqual(read.settings.first?["current"] as? String, "high")
    }

    func testStaleSetRefusesWithoutCallingAnyGatewayRPC() async {
        let peer = SettingsGatewayProbe()
        let error = await OpenClawSessionSettings.set(targetSessionKey: "agent:main:b",
            activeSessionKey: await peer.active, key: "effort", value: "high") { await peer.rpc($0) }
        XCTAssertNotNil(error)
        let calls = await peer.calls
        XCTAssertTrue(calls.isEmpty)
    }

    func testPatchAndReadbackRemainOnRequestedKeyAfterActiveTargetChanges() async {
        let peer = SettingsGatewayProbe()
        await peer.configure(moveOnPatch: true)
        let target = await peer.active
        let error = await OpenClawSessionSettings.set(targetSessionKey: target,
            activeSessionKey: target, key: "effort", value: nil) { await peer.rpc($0) }
        XCTAssertNil(error)
        let active = await peer.active
        XCTAssertEqual(active, "agent:main:b")
        let read = await OpenClawSessionSettings.query(targetSessionKey: target) { await peer.rpc($0) }
        let calls = await peer.calls
        XCTAssertEqual(calls.first?.0, "sessions.patch")
        XCTAssertEqual(calls.first?.1, "agent:main:a")
        XCTAssertEqual(read.targetSessionKey, "agent:main:a")
        XCTAssertEqual(read.settings.first?["current"] as? String, "high")
    }

    func testMissingTargetRowFailsInsteadOfUsingAnotherListedSession() async {
        let peer = SettingsGatewayProbe()
        let read = await OpenClawSessionSettings.query(targetSessionKey: "agent:main:missing") { await peer.rpc($0) }
        XCTAssertNotNil(read.error)
        XCTAssertTrue(read.settings.isEmpty)
        XCTAssertEqual(read.targetSessionKey, "agent:main:missing")
        let calls = await peer.calls
        XCTAssertEqual(calls.count, 1)
    }
}
#endif
