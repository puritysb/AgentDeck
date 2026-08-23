// GatewayParityTests.swift — Swift-side counterpart of
// `bridge/src/__tests__/gateway-parity-fixtures.test.ts`.
//
// Decodes every JSON fixture under `tests/parity/gateway-frames/` and asserts
// the same discriminator/shape invariants the Node adapter relies on. Both
// test suites walk the same directory, so adding/removing a fixture on either
// side surfaces immediately across languages.
//
// The fixtures are now CAPTURES off a live Gateway (`openclaw@2026.7.1-2`),
// content-scrubbed, with every parsed field verbatim. They used to be composed
// from the TypeScript type — and the type, the fixture and the assertion in
// both suites had all been authored together from one guess, so three
// mutually-consistent copies agreed with each other forever while matching no
// frame OpenClaw sends. See that directory's README.

import XCTest

final class GatewayParityTests: XCTestCase {

    // MARK: - Fixture loading

    /// Repo-root-relative path to the shared parity fixtures. Computed from
    /// `#filePath` so the test works regardless of the xctest bundle layout.
    private static func fixtureDirectory() -> URL {
        // #filePath → .../apple/AgentDeckTests/GatewayParityTests.swift
        let thisFile = URL(fileURLWithPath: #filePath)
        return thisFile
            .deletingLastPathComponent()   // AgentDeckTests
            .deletingLastPathComponent()   // apple
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("tests/parity/gateway-frames", isDirectory: true)
    }

    private struct Fixture {
        let name: String
        let url: URL
        let data: Data
        let json: [String: Any]
    }

    private func loadFixtures() throws -> [Fixture] {
        let dir = Self.fixtureDirectory()
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: dir.path),
            "Gateway parity fixture dir missing: \(dir.path)"
        )
        let names = try FileManager.default
            .contentsOfDirectory(atPath: dir.path)
            .filter { $0.hasSuffix(".json") }
            .sorted()

        return try names.map { name in
            let url = dir.appendingPathComponent(name)
            let data = try Data(contentsOf: url)
            guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw NSError(
                    domain: "GatewayParityTests",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "Fixture \(name) is not a JSON object"]
                )
            }
            return Fixture(name: name, url: url, data: data, json: obj)
        }
    }

    // MARK: - Mirror of bridge/src/__tests__/gateway-parity-fixtures.test.ts

    func testFixtureSetIsNonEmpty() throws {
        let fixtures = try loadFixtures()
        XCTAssertFalse(fixtures.isEmpty, "Expected at least one .json fixture under tests/parity/gateway-frames/")
    }

    func testEveryFixtureCarriesValidFrameDiscriminator() throws {
        let valid: Set<String> = ["req", "res", "event"]
        for f in try loadFixtures() {
            let type = f.json["type"] as? String
            XCTAssertNotNil(type, "[\(f.name)] missing `type` discriminator")
            if let type {
                XCTAssertTrue(valid.contains(type), "[\(f.name)] unknown frame type: \(type)")
            }
        }
    }

    func testEveryFixtureConformsToItsFrameShape() throws {
        for f in try loadFixtures() {
            let type = f.json["type"] as? String ?? ""

            switch type {
            case "req":
                XCTAssertTrue(f.json["id"] is String, "[\(f.name)] req.id must be String")
                XCTAssertTrue(f.json["method"] is String, "[\(f.name)] req.method must be String")
                XCTAssertTrue(f.json["params"] is [String: Any], "[\(f.name)] req.params must be object")

            case "res":
                XCTAssertTrue(f.json["id"] is String, "[\(f.name)] res.id must be String")
                let ok = f.json["ok"] as? Bool
                XCTAssertNotNil(ok, "[\(f.name)] res.ok must be Bool")
                if ok == true {
                    XCTAssertNotNil(f.json["payload"], "[\(f.name)] ok=true res must carry payload")
                } else {
                    guard let error = f.json["error"] as? [String: Any] else {
                        XCTFail("[\(f.name)] ok=false res must carry error object")
                        continue
                    }
                    XCTAssertTrue(error["code"] is String, "[\(f.name)] error.code must be String")
                    XCTAssertTrue(error["message"] is String, "[\(f.name)] error.message must be String")
                }

            case "event":
                XCTAssertTrue(f.json["event"] is String, "[\(f.name)] event name must be String")
                XCTAssertTrue(f.json["payload"] is [String: Any], "[\(f.name)] event.payload must be object")

            default:
                XCTFail("[\(f.name)] unexpected type: \(type)")
            }
        }
    }

    // MARK: - Adapter-contract fixtures

    /// The `chat` frame is ASSISTANT-ONLY. Asserting the absence of the
    /// assumed fields is the load-bearing part: `prompt` is what the Node
    /// adapter believed it had, so no APME turn was ever opened for a
    /// conversation started in the OpenClaw app.
    func testChatFramesCarryNoPromptAndNoTools() throws {
        let fixtures = try loadFixtures()
        for name in ["chat-delta.json", "chat-final.json"] {
            guard let f = fixtures.first(where: { $0.name == name }) else {
                XCTFail("\(name) fixture not found")
                continue
            }
            XCTAssertEqual(f.json["event"] as? String, "chat", "[\(name)]")
            let payload = f.json["payload"] as? [String: Any] ?? [:]
            XCTAssertNil(payload["prompt"], "[\(name)] the chat frame carries no user prompt")
            XCTAssertNil(payload["tools"], "[\(name)] the chat frame carries no tools array")
            XCTAssertNil(payload["modelId"], "[\(name)] the chat frame names no model")
            let message = payload["message"] as? [String: Any] ?? [:]
            XCTAssertEqual(message["role"] as? String, "assistant", "[\(name)]")
        }
    }

    /// `session.message` is the only channel carrying the user's prompt, and
    /// `content` is a plain string for user messages.
    func testSessionMessageUserCarriesThePrompt() throws {
        let fixtures = try loadFixtures()
        guard let f = fixtures.first(where: { $0.name == "session-message-user.json" }) else {
            XCTFail("session-message-user.json fixture not found")
            return
        }
        let payload = f.json["payload"] as? [String: Any] ?? [:]
        let message = payload["message"] as? [String: Any] ?? [:]
        XCTAssertEqual(message["role"] as? String, "user")
        XCTAssertTrue(message["content"] is String, "a user message's content is a plain string")
        // No top-level `ts`: the frame's top level is the session snapshot, so
        // an event stamped from it would carry delivery time, not event time.
        XCTAssertNil(payload["ts"])
        XCTAssertTrue(message["timestamp"] is NSNumber, "the message itself is stamped")
    }

    /// `session.tool` nests its tool facts under `data`. This is exactly what
    /// `OpenClawAdapter.sessionToolBody` had been missing, which made
    /// `isPlaceholderOnlySessionTool` drop every real tool row as noise.
    func testSessionToolFactsLiveUnderData() throws {
        let fixtures = try loadFixtures()
        for name in ["session-tool-start.json", "session-tool-result.json"] {
            guard let f = fixtures.first(where: { $0.name == name }) else {
                XCTFail("\(name) fixture not found")
                continue
            }
            let payload = f.json["payload"] as? [String: Any] ?? [:]
            guard let data = payload["data"] as? [String: Any] else {
                XCTFail("[\(name)] tool facts must be under `data`")
                continue
            }
            XCTAssertTrue(data["name"] is String, "[\(name)] data.name")
            XCTAssertTrue(data["phase"] is String, "[\(name)] data.phase")
            // The assumed flat shape, asserted absent so nobody reads it back.
            XCTAssertNil(payload["name"], "[\(name)] no top-level tool name")
            XCTAssertNil(payload["input"], "[\(name)] no top-level input")
            XCTAssertNil(payload["output"], "[\(name)] no top-level output")
        }
    }

    /// The approval event nests everything renderable under `request`. This
    /// fixture kept the flat `{tool, command, reason, options:[{key:"allow"}]}`
    /// shape long after `openclaw-approval.ts` was rewritten to document it as
    /// disproven — including the `"allow"` decision the Gateway rejects.
    func testExecApprovalRequestedNestsUnderRequest() throws {
        let fixtures = try loadFixtures()
        guard let f = fixtures.first(where: { $0.name == "exec-approval-requested.json" }) else {
            XCTFail("exec-approval-requested.json fixture not found")
            return
        }
        XCTAssertEqual(f.json["event"] as? String, "exec.approval.requested")

        let payload = f.json["payload"] as? [String: Any] ?? [:]
        XCTAssertTrue(payload["id"] is String, "approval.requested must carry `id` string")
        XCTAssertNil(payload["command"], "the command is nested, never flat")
        XCTAssertNil(payload["options"], "the Gateway sends allowedDecisions, not options")

        guard let request = payload["request"] as? [String: Any] else {
            XCTFail("approval.requested must nest everything under `request`")
            return
        }
        XCTAssertTrue(request["command"] is String, "request.command is what the user must read")
        guard let decisions = request["allowedDecisions"] as? [String] else {
            XCTFail("request must carry `allowedDecisions`")
            return
        }
        XCTAssertGreaterThanOrEqual(decisions.count, 2)
        for d in decisions {
            // `"allow"` is not in the Gateway's vocabulary — sending it comes
            // back INVALID_REQUEST and the approval stays pending forever.
            XCTAssertTrue(["allow-once", "allow-always", "deny"].contains(d),
                          "unexpected decision: \(d)")
        }
    }

    // MARK: - Typed Codable round-trip

    /// Narrow Codable mirror of the three frame envelopes. The generated
    /// `ADGatewayFrame` (quicktype) currently lives only in the main app
    /// target, so the tests keep a local decode-only shim. The goal is to
    /// prove JSONDecoder succeeds on every fixture — the field-level shape
    /// assertions above still use JSONSerialization (matches the TS test).
    private struct FrameEnvelope: Decodable {
        let type: String
        let id: String?
        let method: String?
        let event: String?
        let ok: Bool?
    }

    func testEveryFixtureDecodesWithJSONDecoder() throws {
        let decoder = JSONDecoder()
        for f in try loadFixtures() {
            XCTAssertNoThrow(
                try decoder.decode(FrameEnvelope.self, from: f.data),
                "[\(f.name)] JSONDecoder failed on envelope"
            )
            let envelope = try decoder.decode(FrameEnvelope.self, from: f.data)
            switch envelope.type {
            case "req":
                XCTAssertNotNil(envelope.id, "[\(f.name)] req.id missing after decode")
                XCTAssertNotNil(envelope.method, "[\(f.name)] req.method missing after decode")
            case "res":
                XCTAssertNotNil(envelope.id, "[\(f.name)] res.id missing after decode")
                XCTAssertNotNil(envelope.ok, "[\(f.name)] res.ok missing after decode")
            case "event":
                XCTAssertNotNil(envelope.event, "[\(f.name)] event name missing after decode")
            default:
                XCTFail("[\(f.name)] unexpected envelope type: \(envelope.type)")
            }
        }
    }
}
