#if os(macOS)
import XCTest
@testable import AgentDeck

final class SwiftSurfaceProtocolTests: XCTestCase {
    private func headers(_ overrides: [String: String] = [:]) -> [String: String] {
        var value = [
            "agentdeck-surface-protocol": "1",
            "agentdeck-surface-profile": "portable-reader/v1",
            "agentdeck-client-id": "io.pocketdaily.reader",
            "agentdeck-client-version": "1.4.1-pocket",
            "agentdeck-product-id": "io.pocketdaily.reader",
            "agentdeck-capabilities": "feed.pull,feed.conditional,outbox.push,glance.read,learning.pack.read,learning.pack.update,font.pack.read,font.pack.update,ota.feed,device.telemetry,future.unknown",
            "agentdeck-board": "xteink_x3",
            "agentdeck-update-channel": "stable",
        ]
        value.merge(overrides) { _, new in new }
        return value
    }

    func testHeaderlessFeedRemainsLegacy() throws {
        let identity = try DaemonServer.parseSurfaceHTTPIdentity(
            headers: [:], requiredCapability: "feed.pull"
        ).get()
        XCTAssertNil(identity)
    }

    func testPocketFeedIdentityIntersectsToFullSwiftRuntimeCapabilities() throws {
        let identity = try XCTUnwrap(DaemonServer.parseSurfaceHTTPIdentity(
            headers: headers(), query: ["board": "xteink_x3"], requiredCapability: "feed.pull"
        ).get())
        XCTAssertEqual(identity.productId, "io.pocketdaily.reader")
        XCTAssertEqual(identity.board, "xteink_x3")
        XCTAssertEqual(identity.capabilities, [
            "feed.pull", "feed.conditional", "outbox.push", "glance.read",
            "learning.pack.read", "learning.pack.update",
            "font.pack.read", "font.pack.update",
            "ota.feed", "device.telemetry",
        ])
    }

    func testPartialWrongMajorAndTupleMismatchFailClosed() {
        switch DaemonServer.parseSurfaceHTTPIdentity(
            headers: ["agentdeck-surface-protocol": "1"], requiredCapability: "feed.pull"
        ) {
        case .failure(let error): XCTAssertEqual(error.status, 400)
        case .success: XCTFail("partial Surface identity must fail")
        }
        switch DaemonServer.parseSurfaceHTTPIdentity(
            headers: headers(["agentdeck-surface-protocol": "2"]), requiredCapability: "feed.pull"
        ) {
        case .failure(let error): XCTAssertEqual(error.status, 426)
        case .success: XCTFail("wrong major must fail")
        }
        switch DaemonServer.parseSurfaceHTTPIdentity(
            headers: headers(), query: ["board": "xteink_x4"], requiredCapability: "feed.pull"
        ) {
        case .failure(let error): XCTAssertEqual(error.code, "surface_query_identity_mismatch")
        case .success: XCTFail("query tuple must not override headers")
        }
    }

    func testSwiftWelcomeGrantsImplementedRuntimeAndNeverGrantsInbox() throws {
        let negotiation = try DaemonServer.negotiateSurface([
            "protocol": 1,
            "clientId": "io.pocketdaily.reader",
            "clientVersion": "1.4.1-pocket",
            "productId": "io.pocketdaily.reader",
            "profiles": [[
                "id": "portable-reader/v1",
                "capabilities": [
                    "feed.pull", "glance.read", "outbox.push",
                    "learning.pack.read", "learning.pack.update", "ota.feed", "inbox.ws",
                    "font.pack.read", "font.pack.update",
                ],
            ]],
        ]).get()
        XCTAssertEqual(negotiation.profile, "portable-reader/v1")
        XCTAssertEqual(negotiation.capabilities, [
            "feed.pull", "glance.read", "outbox.push",
            "learning.pack.read", "learning.pack.update", "ota.feed",
            "font.pack.read", "font.pack.update",
        ])
        XCTAssertFalse(negotiation.capabilities.contains("inbox.ws"))
    }

    func testAllPublicProfilesNegotiateAndCommandsAreCapabilityMapped() throws {
        let dashboard = try DaemonServer.negotiateSurface([
            "protocol": 1,
            "clientId": "dashboard.test",
            "clientVersion": "1.0.0",
            "productId": "dashboard.test",
            "profiles": [[
                "id": "dashboard-live/v1",
                "capabilities": ["sessions.read", "usage.read", "session.prompt"],
            ]],
        ]).get()
        XCTAssertEqual(dashboard.profile, "dashboard-live/v1")
        XCTAssertEqual(dashboard.capabilities, ["sessions.read", "usage.read"])

        let companion = try DaemonServer.negotiateSurface([
            "protocol": 1,
            "clientId": "companion.test",
            "clientVersion": "1.0.0",
            "productId": "companion.test",
            "profiles": [[
                "id": "companion-control/v1",
                "capabilities": ["session.prompt", "review.run"],
            ]],
        ]).get()
        XCTAssertEqual(companion.capabilities, ["session.prompt", "review.run"])
        XCTAssertEqual(DaemonServer.surfaceCapabilityForCommand([
            "type": "session_command", "command": ["type": "send_prompt"],
        ]), "session.prompt")
        XCTAssertEqual(DaemonServer.surfaceCapabilityForCommand(["type": "review_run"]), "review.run")
        XCTAssertNil(DaemonServer.surfaceCapabilityForCommand(["type": "shutdown"]))
    }

    func testNegotiatedOutboundEventsRequireTheirGrantedCapability() throws {
        let portable = try DaemonServer.negotiateSurface([
            "protocol": 1,
            "clientId": "io.pocketdaily.reader",
            "clientVersion": "1.4.1-pocket",
            "productId": "io.pocketdaily.reader",
            "profiles": [["id": "portable-reader/v1", "capabilities": ["feed.pull"]]],
        ]).get()
        XCTAssertTrue(DaemonServer.surfaceAllowsEvent(
            negotiation: portable, eventType: "surface_welcome"))
        XCTAssertTrue(DaemonServer.surfaceAllowsEvent(
            negotiation: portable, eventType: "connection"))
        XCTAssertFalse(DaemonServer.surfaceAllowsEvent(
            negotiation: portable, eventType: "sessions_list"))

        let dashboard = try DaemonServer.negotiateSurface([
            "protocol": 1,
            "clientId": "dashboard.test",
            "clientVersion": "1.0.0",
            "productId": "dashboard.test",
            "profiles": [["id": "dashboard-live/v1", "capabilities": ["sessions.read"]]],
        ]).get()
        XCTAssertTrue(DaemonServer.surfaceAllowsEvent(
            negotiation: dashboard, eventType: "sessions_list"))
        XCTAssertFalse(DaemonServer.surfaceAllowsEvent(
            negotiation: dashboard, eventType: "usage_update"))
        XCTAssertFalse(DaemonServer.surfaceAllowsEvent(
            negotiation: dashboard, eventType: "state_update"))
    }

    func testAgentDeckFirmwareProductTupleUsesShippingBoardSet() throws {
        var values = headers([
            "agentdeck-product-id": "dev.agentdeck.dashboard-firmware",
            "agentdeck-client-id": "agentdeck.trmnl_75",
            "agentdeck-board": "trmnl_75",
        ])
        XCTAssertNotNil(try DaemonServer.parseSurfaceHTTPIdentity(
            headers: values, requiredCapability: "ota.feed").get())
        values["agentdeck-board"] = "xteink_x3"
        switch DaemonServer.parseSurfaceHTTPIdentity(headers: values, requiredCapability: "ota.feed") {
        case .failure(let error): XCTAssertEqual(error.code, "surface_product_board_mismatch")
        case .success: XCTFail("AgentDeck firmware product must not cross into Pocket's board namespace")
        }
    }

    func testPullFirmwareStorePersistsSegmentsAndAcknowledgesInstall() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdeck-surface-test-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let identity = SwiftSurfaceFirmwareStore.Identity(
            productId: "io.pocketdaily.reader", board: "xteink_x3", updateChannel: "stable")
        var firmware = Data(repeating: 0x5a, count: 80 * 1024)
        firmware.append(Data("CrossPoint version: 1.5.0-pocket\0".utf8))

        let first = SwiftSurfaceFirmwareStore(baseDirectory: root)
        let staged = try await first.stage(firmware: firmware, target: "xteink_x3", identity: identity)
        XCTAssertEqual(staged.bytes, firmware.count)
        XCTAssertEqual(staged.md5, SwiftSurfaceFirmwareStore.md5(firmware))

        // A new actor proves state and bytes survive a daemon restart.
        let reloaded = SwiftSurfaceFirmwareStore(baseDirectory: root)
        let advert = await reloaded.advert(identity: identity, board: identity.board, clientVersion: "1.4.9-pocket")
        XCTAssertEqual(advert?.size, firmware.count)
        let segment = try await reloaded.segment(
            identity: identity, board: identity.board, requestedFrom: 32 * 1024,
            requestedLimit: 32 * 1024)
        XCTAssertEqual(segment.from, 32 * 1024)
        XCTAssertEqual(segment.data, firmware.subdata(in: (32 * 1024)..<(64 * 1024)))

        let installedAdvert = await reloaded.advert(
            identity: identity, board: identity.board, clientVersion: "1.5.0-pocket")
        XCTAssertNil(installedAdvert)
        do {
            _ = try await reloaded.segment(
                identity: identity, board: identity.board, requestedFrom: 0, requestedLimit: nil)
            XCTFail("installed firmware must clear its staged namespace")
        } catch SwiftSurfaceFirmwareStore.StoreError.notStaged {
            // expected
        }
    }

    func testProductAwareFirmwareNeverFallsBackToLegacyBoardStage() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdeck-surface-isolation-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SwiftSurfaceFirmwareStore(baseDirectory: root)
        let firmware = Data(repeating: 0x41, count: 40 * 1024)
        _ = try await store.stage(firmware: firmware, target: "trmnl_75", identity: nil)
        let productIdentity = SwiftSurfaceFirmwareStore.Identity(
            productId: "dev.agentdeck.dashboard-firmware", board: "trmnl_75", updateChannel: "stable")

        let productAdvert = await store.advert(
            identity: productIdentity, board: "trmnl_75", clientVersion: "1.0.0")
        XCTAssertNil(productAdvert)
        do {
            _ = try await store.segment(
                identity: productIdentity, board: "trmnl_75", requestedFrom: 0, requestedLimit: nil)
            XCTFail("product-aware request must not consume a legacy board-only stage")
        } catch SwiftSurfaceFirmwareStore.StoreError.notStaged {
            // expected
        }
        let legacyAdvert = await store.advert(identity: nil, board: "trmnl_75", clientVersion: nil)
        XCTAssertNotNil(legacyAdvert)
    }

    func testBundledLearningPackCarriesVerifiedLicenceAndPayload() throws {
        let pack = try SwiftSurfaceLearningPack.load(bundle: .main)
        XCTAssertEqual(pack.advert, .init(
            id: "jp-n3-ko", version: 3, format: 1, size: 568_324,
            md5: "34681b78b5a1d65bc787dc57e863cba7", licenseSpdx: "CC-BY-SA-4.0"))
        XCTAssertEqual(String(data: pack.bytes.prefix(4), encoding: .ascii), "PDLP")
        XCTAssertTrue(pack.attribution.contains("OpenJLPT"))
        XCTAssertTrue(pack.matchesRequest(id: "jp-n3-ko", version: "3"))
        XCTAssertFalse(pack.matchesRequest(id: "jp-n3-ko", version: "02"))
        XCTAssertFalse(pack.matchesRequest(id: "../jp-n3-ko", version: "3"))
    }

    func testReaderAssetsAreServedAsBoundedContiguousSegments() {
        let bytes = Data((0..<(700 * 1024)).map { UInt8($0 % 251) })
        let first = DaemonServer.boundedSurfaceAssetSegment(
            bytes, requestedFrom: 0, requestedLimit: 64 * 1024)
        let second = DaemonServer.boundedSurfaceAssetSegment(
            bytes, requestedFrom: first.data.count, requestedLimit: 64 * 1024)
        XCTAssertEqual(first.from, 0)
        XCTAssertEqual(first.data.count, 64 * 1024)
        XCTAssertEqual(second.from, 64 * 1024)
        XCTAssertEqual(second.data, bytes.subdata(in: (64 * 1024)..<(128 * 1024)))

        XCTAssertEqual(DaemonServer.boundedSurfaceAssetSegment(
            bytes, requestedFrom: 0, requestedLimit: 1).data.count, 32 * 1024)
        XCTAssertEqual(DaemonServer.boundedSurfaceAssetSegment(
            bytes, requestedFrom: 0, requestedLimit: 2 * 1024 * 1024).data.count, 512 * 1024)
        let tail = DaemonServer.boundedSurfaceAssetSegment(
            bytes, requestedFrom: bytes.count + 1, requestedLimit: nil)
        XCTAssertEqual(tail.from, bytes.count)
        XCTAssertTrue(tail.data.isEmpty)
    }

    func testLearningPackRejectsBytesChangedAfterManifest() throws {
        func resource(_ name: String, extension ext: String) throws -> URL {
            try XCTUnwrap(
                Bundle.main.url(forResource: name, withExtension: ext, subdirectory: "learning")
                    ?? Bundle.main.url(forResource: name, withExtension: ext))
        }
        let manifest = try Data(contentsOf: resource("jp-n3-ko", extension: "manifest.json"))
        var bytes = try Data(contentsOf: resource("jp-n3-ko", extension: "pdl"))
        bytes[bytes.index(before: bytes.endIndex)] ^= 0x01
        XCTAssertThrowsError(try SwiftSurfaceLearningPack.validate(
            manifestBytes: manifest, packBytes: bytes)) { error in
            XCTAssertEqual(error as? SwiftSurfaceLearningPack.ValidationError, .invalidPack)
        }
    }

    func testBundledFontPackCarriesVerifiedLicenceAndPayload() throws {
        let pack = try SwiftSurfaceFontPack.load(bundle: .main)
        XCTAssertEqual(pack.advert, .init(
            id: "pocket-sans-world", version: 1, format: 4, size: 10_903_872,
            md5: "a6844503c142be1a62e4bac8be7c7802", licenseSpdx: "OFL-1.1"))
        XCTAssertEqual(String(data: pack.bytes.prefix(6), encoding: .ascii), "CPFONT")
        XCTAssertTrue(pack.attribution.contains("Noto Sans"))
        XCTAssertTrue(pack.matchesRequest(id: "pocket-sans-world", version: "1"))
        XCTAssertFalse(pack.matchesRequest(id: "pocket-sans-world", version: "01"))
        XCTAssertFalse(pack.matchesRequest(id: "../pocket-sans-world", version: "1"))
    }

    func testFontPackRejectsBytesChangedAfterManifest() throws {
        func resource(_ name: String, extension ext: String) throws -> URL {
            try XCTUnwrap(
                Bundle.main.url(forResource: name, withExtension: ext, subdirectory: "Fonts")
                    ?? Bundle.main.url(forResource: name, withExtension: ext))
        }
        let manifest = try Data(contentsOf: resource("pocket-sans-world", extension: "manifest.json"))
        var bytes = try Data(contentsOf: resource("PocketSansWorld_12", extension: "cpfont"))
        bytes[bytes.index(before: bytes.endIndex)] ^= 0x01
        XCTAssertThrowsError(try SwiftSurfaceFontPack.validate(
            manifestBytes: manifest, fontBytes: bytes)) { error in
            XCTAssertEqual(error as? SwiftSurfaceFontPack.ValidationError, .invalidPack)
        }
    }
}
#endif
