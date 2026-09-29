import XCTest
@testable import AgentDeck

@MainActor
final class LocalModelPresentationTests: XCTestCase {
    private let legacy = #"{"available":true,"models":[{"name":"gemma","size":42,"sizeVram":0}]}"#
    private func decode(_ json: String) throws -> OllamaStatus { try JSONDecoder().decode(OllamaStatus.self, from: Data(json.utf8)) }

    func testReleasedServerDoesNotClaimUnloadedFromZeroVram() throws {
        let status = try decode(legacy)
        XCTAssertNil(status.residency)
        XCTAssertTrue(LocalModelPresentation.ollama(status).contains("Residency unverified"))
        XCTAssertFalse(LocalModelPresentation.ollama(status).contains("0 resident"))
    }
    func testVerifiedEmptyResidentListKeepsInstalledCatalogSeparate() throws {
        var status = try decode(legacy)
        status.residency = ModelResidency(known: true, models: [])
        status.installedModelsKnown = true
        let text = LocalModelPresentation.ollama(status)
        XCTAssertTrue(text.contains("0 resident")); XCTAssertTrue(text.contains("Installed (1): gemma"))
        XCTAssertEqual(LocalModelPresentation.ollama(status, compact: true), "Available · 0 resident · 1 installed")
    }
    func testCpuOnlyModelAndEmbeddingAreNotMisreportedAsUnloaded() throws {
        var status = try decode(legacy)
        status.residency = ModelResidency(known: true, models: ["gemma", "bge-m3"])
        XCTAssertTrue(LocalModelPresentation.ollama(status).contains("Resident (2): gemma, bge-m3"))
    }
    func testExplicitUnknownOverridesOldPositiveVram() throws {
        var status = try decode(legacy.replacingOccurrences(of: #""sizeVram":0"#, with: #""sizeVram":100"#))
        XCTAssertTrue(LocalModelPresentation.ollama(status).contains("GPU residency reported"))
        status.residency = ModelResidency(known: false, models: [])
        XCTAssertTrue(LocalModelPresentation.ollama(status).contains("Residency unverified"))
        XCTAssertFalse(LocalModelPresentation.ollama(status).contains("GPU residency reported"))
    }
    func testReleasedAppleDecoderIgnoresAdditiveMetadata() throws {
        // Wire fields from apple-v1.2.1. Unknown Codable keys are ignored.
        struct ReleasedStatus: Decodable {
            struct Model: Decodable { let name: String; let size: Int; let sizeVram: Int; var kind: String? }
            let available: Bool; let models: [Model]
        }
        var status = try decode(legacy)
        status.residency = ModelResidency(known: true, models: [])
        status.installedModelsKnown = true
        let old = try JSONDecoder().decode(ReleasedStatus.self, from: JSONEncoder().encode(status))
        XCTAssertTrue(old.available); XCTAssertEqual(old.models.first?.name, "gemma")
    }
    func testNewParserAcceptsLegacyAndNewWholeFrames() {
        for type in ["state_update", "usage_update"] {
            let raw = "{\"type\":\"\(type)\",\"state\":\"idle\",\"mlxModels\":[\"gemma\"],\"ollamaStatus\":\(legacy)}"
            XCTAssertNotNil(BridgeEventParser.parse(raw))
            let enhanced = raw.dropLast() + #","mlxResidency":{"known":true,"models":[]},"futureField":42}"#
            XCTAssertNotNil(BridgeEventParser.parse(String(enhanced)))
        }
    }
    func testNewThenLegacyFramesDoNotRetainFalseVerification() throws {
        let holder = AgentStateHolder()
        defer { holder.prepareForTermination() }
        func deliver(_ raw: String) {
            guard let event = BridgeEventParser.parse(raw) else { XCTFail("decode failed"); return }
            holder.handleEvent(event)
        }
        deliver(#"{"type":"state_update","state":"idle","mlxModels":["gemma"],"mlxResidency":{"known":true,"models":["gemma"]}}"#)
        XCTAssertEqual(holder.state.mlxResidency?.known, true)
        deliver(#"{"type":"usage_update","fiveHourPercent":10}"#)
        XCTAssertEqual(holder.state.mlxResidency?.known, true) // quota-only update retains observation
        deliver(#"{"type":"usage_update","mlxModels":["qwen"]}"#)
        XCTAssertNil(holder.state.mlxResidency) // old model snapshot invalidates it
        deliver(#"{"type":"state_update","state":"idle","mlxModels":[],"mlxResidency":{"known":true,"models":[]}}"#)
        XCTAssertEqual(holder.state.mlxResidency?.models, []) // explicit unload clears
        deliver(#"{"type":"connection","status":"disconnected"}"#)
        XCTAssertNil(holder.state.mlxResidency) // reconnecting to an old host cannot inherit verification
    }

    func testMlxLegacyCatalogIsNotAdvertisedAsResident() {
        XCTAssertEqual(LocalModelPresentation.mlx(models: ["qwen", "gemma"], residency: nil), "Residency unverified\nReported: qwen, gemma")
        XCTAssertEqual(LocalModelPresentation.mlx(models: ["qwen"], residency: ModelResidency(known: true, models: ["gemma"])), "Resident: gemma")
    }
}
