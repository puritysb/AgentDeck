// IDotMatrixProtocolTests.swift — byte-level verification of the iDotMatrix BLE
// protocol reimplemented in Swift, checked against the Python `idotmatrix` library's
// packet construction. If these drift, the display silently shows garbage or nothing.

#if os(macOS)
@preconcurrency import CoreBluetooth
import XCTest
@testable import AgentDeck

final class IDotMatrixProtocolTests: XCTestCase {

    func testGattUUIDsMatchIDotMatrixLibrary() {
        XCTAssertEqual(IDotMatrixBLE.serviceUUID, CBUUID(string: "000000fa-0000-1000-8000-00805f9b34fb"))
        XCTAssertEqual(IDotMatrixBLE.writeCharUUID, CBUUID(string: "0000fa02-0000-1000-8000-00805f9b34fb"))
        // The transport reads both from the generated identity mirror; if that
        // mirror ever drifts from the library's UUIDs, writes go nowhere.
        XCTAssertEqual(IDotMatrixIdentity.serviceUUIDString, "000000fa-0000-1000-8000-00805f9b34fb")
        XCTAssertEqual(IDotMatrixIdentity.writeCharacteristicUUIDString, "0000fa02-0000-1000-8000-00805f9b34fb")
    }

    // MARK: - Discovery predicate
    //
    // A panel that connects and renders fine must also be *findable*: issue #115
    // had a working iPixel invisible to Scan because the filter was the `IDM-`
    // vendor prefix. Parity with the Python scanner is guarded on the TS side
    // (shared/src/__tests__/idotmatrix-identity.test.ts); these cases pin the
    // Swift mirror's behaviour at the boundary the CoreBluetooth scan uses.

    func testDiscoveryMatchesKnownNameFamilies() {
        XCTAssertTrue(IDotMatrixIdentity.matchesAdvertisement(name: "IDM-L", serviceUUIDs: []))
        XCTAssertTrue(IDotMatrixIdentity.matchesAdvertisement(name: "idm-32", serviceUUIDs: []))
        XCTAssertTrue(IDotMatrixIdentity.matchesAdvertisement(name: "iPixel-1234", serviceUUIDs: []))
    }

    func testDiscoveryMatchesUnnamedPanelByAdvertisedService() {
        // CoreBluetooth hands back whichever form the peripheral advertised.
        XCTAssertTrue(IDotMatrixIdentity.matchesAdvertisement(
            name: "", serviceUUIDs: ["000000FA-0000-1000-8000-00805F9B34FB"]))
        XCTAssertTrue(IDotMatrixIdentity.matchesAdvertisement(name: "", serviceUUIDs: ["00FA"]))
        XCTAssertTrue(IDotMatrixIdentity.matchesAdvertisement(name: "Anything", serviceUUIDs: ["FA"]))
    }

    func testDiscoveryRejectsUnrelatedPeripherals() {
        XCTAssertFalse(IDotMatrixIdentity.matchesAdvertisement(
            name: "Divoom Timebox", serviceUUIDs: ["0000180f-0000-1000-8000-00805f9b34fb"]))
        XCTAssertFalse(IDotMatrixIdentity.matchesAdvertisement(name: "", serviceUUIDs: []))
    }

    func testDiscoveryAcceptsUserConfiguredPrefix() {
        XCTAssertFalse(IDotMatrixIdentity.matchesAdvertisement(name: "MyPanel-7", serviceUUIDs: []))
        XCTAssertTrue(IDotMatrixIdentity.matchesAdvertisement(
            name: "MyPanel-7", serviceUUIDs: [], extraPrefixes: ["mypanel-"]))
        // A blank settings.json entry must not turn the scan into a match-all.
        XCTAssertFalse(IDotMatrixIdentity.matchesAdvertisement(
            name: "Divoom Timebox", serviceUUIDs: [], extraPrefixes: ["", "  "]))
    }

    // MARK: - Command packets

    func testModeCommand() {
        // Python: bytearray([5, 0, 4, 1, mode]) — setMode(1) = enter DIY mode.
        XCTAssertEqual([UInt8](IDotMatrixBLE.modeCommand(1)), [0x05, 0x00, 0x04, 0x01, 0x01])
        XCTAssertEqual([UInt8](IDotMatrixBLE.modeCommand(0)), [0x05, 0x00, 0x04, 0x01, 0x00])
    }

    func testBrightnessCommand() {
        // Python: bytearray([5, 0, 4, 128, brightness]).
        XCTAssertEqual([UInt8](IDotMatrixBLE.brightnessCommand(50)), [0x05, 0x00, 0x04, 0x80, 0x32])
        XCTAssertEqual([UInt8](IDotMatrixBLE.brightnessCommand(100)), [0x05, 0x00, 0x04, 0x80, 100])
        // Clamp to 5–100.
        XCTAssertEqual([UInt8](IDotMatrixBLE.brightnessCommand(0)), [0x05, 0x00, 0x04, 0x80, 5])
        XCTAssertEqual([UInt8](IDotMatrixBLE.brightnessCommand(200)), [0x05, 0x00, 0x04, 0x80, 100])
    }

    // MARK: - Image payload framing

    /// Single-chunk PNG: header = idkLE(pngLen+1) ++ [0,0,0] ++ pngLenLE ++ data.
    func testImagePayloadSingleChunk() {
        let png = Data((0..<10).map { UInt8($0) })   // 10 bytes, 1 chunk
        let out = [UInt8](IDotMatrixBLE.buildImagePayloads(pngData: png))

        // idk = 10 + 1 = 11 → 0x0B,0x00 ; flag = 0x00 (first) ; pngLen = 10 → 0x0A,0,0,0
        let expectedHeader: [UInt8] = [0x0B, 0x00, 0x00, 0x00, 0x00, 0x0A, 0x00, 0x00, 0x00]
        XCTAssertEqual(Array(out.prefix(9)), expectedHeader)
        XCTAssertEqual(Array(out.suffix(10)), Array(0..<10).map { UInt8($0) })
        XCTAssertEqual(out.count, 9 + 10)
    }

    /// Two-chunk PNG: 5000 bytes → [4096, 904]. Second chunk's flag byte is 0x02.
    func testImagePayloadTwoChunks() {
        let png = Data(repeating: 0xAB, count: 5000)
        let out = [UInt8](IDotMatrixBLE.buildImagePayloads(pngData: png))

        // idk = 5000 + 2 = 5002 = 0x138A → LE [0x8A, 0x13]; pngLen = 5000 = 0x1388 → LE [0x88,0x13,0,0]
        // chunk 0: 9-byte header + 4096
        XCTAssertEqual(Array(out.prefix(9)), [0x8A, 0x13, 0x00, 0x00, 0x00, 0x88, 0x13, 0x00, 0x00])
        // chunk 1 starts at offset 9+4096 = 4105; its flag byte (header[4]) is 0x02.
        let secondHeader = Array(out[4105..<4114])
        XCTAssertEqual(secondHeader, [0x8A, 0x13, 0x00, 0x00, 0x02, 0x88, 0x13, 0x00, 0x00])
        // total = (9+4096) + (9+904)
        XCTAssertEqual(out.count, (9 + 4096) + (9 + 904))
    }

    // MARK: - 64→32 downscale + PNG encode

    func testDownscaleUniformColor() {
        // Uniform red 64×64 → uniform red 32×32.
        var src = [UInt8](repeating: 0, count: 64 * 64 * 3)
        for i in stride(from: 0, to: src.count, by: 3) { src[i] = 255 }  // R=255
        let out = IDotMatrixModule.downscale64to32(src)
        XCTAssertEqual(out.count, 32 * 32 * 3)
        XCTAssertEqual(out[0], 255); XCTAssertEqual(out[1], 0); XCTAssertEqual(out[2], 0)
        XCTAssertEqual(out[(31 * 32 + 31) * 3], 255)
    }

    func testDownscaleKeepsHighestLuminancePixel() {
        // The top-left 2×2 block maps to out pixel 0. Max-luminance downscale
        // keeps the brightest source pixel verbatim so pixel-art features stay
        // crisp on the 32×32 panel.
        var src = [UInt8](repeating: 0, count: 64 * 64 * 3)
        func setG(_ x: Int, _ y: Int, _ v: UInt8) { src[(y * 64 + x) * 3 + 1] = v }
        setG(0, 0, 0); setG(1, 0, 100); setG(0, 1, 200); setG(1, 1, 40)
        let out = IDotMatrixModule.downscale64to32(src)
        XCTAssertEqual(out[1], 200)   // out pixel (0,0) green channel
    }

    func testRgb32ToPNGRoundTrips() {
        let rgb = [UInt8](repeating: 128, count: 32 * 32 * 3)
        guard let png = IDotMatrixModule.rgb32ToPNG(rgb) else {
            return XCTFail("PNG encode returned nil")
        }
        XCTAssertFalse(png.isEmpty)
        // PNG magic.
        XCTAssertEqual(Array(png.prefix(8)), [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
        // Decodes back to a 32×32 image.
        let rep = NSBitmapImageRep(data: png)
        XCTAssertEqual(rep?.pixelsWide, 32)
        XCTAssertEqual(rep?.pixelsHigh, 32)
    }

    func testRgb32ToPNGRejectsWrongSize() {
        XCTAssertNil(IDotMatrixModule.rgb32ToPNG([UInt8](repeating: 0, count: 100)))
    }

    // MARK: - Native 32×32 compact terrarium

    private func compactPixel(_ data: Data, _ x: Int, _ y: Int) -> [UInt8] {
        let bytes = [UInt8](data)
        let i = (y * 32 + x) * 3
        return [bytes[i], bytes[i + 1], bytes[i + 2]]
    }

    func testCompactRendererIsNative32AndKeepsOpenCodeHollow() {
        var state = DashboardState()
        state.state = .idle
        state.agentType = "opencode"
        state.siblingSessions = [
            SessionInfo(id: "oc", port: 9120, projectName: "AgentDeck", agentType: "opencode", state: "idle")
        ]
        let frame = PixooRenderer().renderCompact32(dashboardState: state)
        XCTAssertEqual(frame.count, 32 * 32 * 3)
        // One mark is centered at (16,14); the official OpenCode center stays
        // water-colored while its top stroke is bright.
        XCTAssertLessThan(compactPixel(frame, 16, 14)[0], 40)
        XCTAssertGreaterThan(compactPixel(frame, 16, 8)[0], 120)
    }

    func testCompactRendererUsesLargerSingleAgentFootprint() {
        var state = DashboardState()
        state.state = .processing
        state.agentType = "claude-code"
        state.siblingSessions = [
            SessionInfo(id: "cc", port: 9120, projectName: "AgentDeck", agentType: "claude-code", state: "processing")
        ]
        let frame = [UInt8](PixooRenderer().renderCompact32(dashboardState: state))
        var brightIdentityPixels = 0
        for y in 6...22 { for x in 8...24 {
            let i = (y * 32 + x) * 3
            if frame[i] > 90 || frame[i + 1] > 110 || frame[i + 2] > 130 { brightIdentityPixels += 1 }
        } }
        XCTAssertGreaterThan(brightIdentityPixels, 24)
    }

    func testCompactRendererShowsClaudeAndCodexTelemetryRails() {
        var state = DashboardState()
        state.state = .idle
        state.agentType = "codex-cli"
        state.siblingSessions = [
            SessionInfo(id: "cx", port: 9120, projectName: "AgentDeck", agentType: "codex-cli", state: "idle")
        ]
        state.fiveHourPercent = 25
        state.sevenDayPercent = 40
        state.codexRateLimits = CodexRateLimits(
            primary: CodexRateLimitWindow(usedPercent: 50, windowMinutes: 300, resetsAt: nil, stale: false),
            secondary: CodexRateLimitWindow(usedPercent: 75, windowMinutes: 10080, resetsAt: nil, stale: false),
            planType: "plus", limitId: nil, credits: nil
        )
        let frame = PixooRenderer().renderCompact32(dashboardState: state)
        XCTAssertEqual(compactPixel(frame, 0, 30), [185, 86, 255])
        XCTAssertEqual(compactPixel(frame, 3, 30), [185, 86, 255])
        XCTAssertEqual(compactPixel(frame, 3, 31), [255, 183, 38])
    }

    func testDotMatrixCodexPayloadDecodePreservesFreshness() {
        let limits = dotMatrixCodexRateLimits(from: [
            "primary": ["usedPercent": 62.0, "windowMinutes": 300, "stale": true],
            "secondary": ["usedPercent": 31.0, "windowMinutes": 10080, "stale": false],
        ])
        XCTAssertEqual(limits?.primary?.usedPercent, 62)
        XCTAssertEqual(limits?.primary?.stale, true)
        XCTAssertEqual(limits?.secondary?.usedPercent, 31)
        XCTAssertEqual(limits?.secondary?.stale, false)
    }

    func testPixoo64RendererShowsMatchingClaudeAndCodexResetBands() {
        var state = DashboardState()
        state.state = .idle
        let primaryReset = ISO8601DateFormatter().string(from: Date().addingTimeInterval(90 * 60))
        let secondaryReset = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3 * 24 * 60 * 60))
        state.fiveHourPercent = 25
        state.fiveHourResetsAt = primaryReset
        state.sevenDayPercent = 40
        state.sevenDayResetsAt = secondaryReset
        state.codexRateLimits = CodexRateLimits(
            primary: CodexRateLimitWindow(usedPercent: 50, windowMinutes: 300, resetsAt: primaryReset, stale: false),
            secondary: CodexRateLimitWindow(usedPercent: 75, windowMinutes: 10080, resetsAt: secondaryReset, stale: false),
            planType: "plus", limitId: nil, credits: nil
        )
        let bytes = [UInt8](PixooRenderer().render(dashboardState: state))
        func pixel64(_ x: Int, _ y: Int) -> [UInt8] {
            let i = (y * 64 + x) * 3
            return [bytes[i], bytes[i + 1], bytes[i + 2]]
        }
        func markerPixels(_ top: Int, _ brand: [UInt8]) -> Int {
            (top..<(top + 7)).flatMap { y in (0..<9).map { pixel64($0, y) } }
                .filter { $0 == brand }.count
        }
        XCTAssertGreaterThan(markerPixels(50, [255, 112, 76]), 3)
        XCTAssertGreaterThan(markerPixels(57, [126, 116, 255]), 3)
        func markerBounds(_ top: Int, _ brand: [UInt8]) -> (minX: Int, maxX: Int, minY: Int, maxY: Int) {
            var points: [(x: Int, y: Int)] = []
            for y in top..<(top + 7) { for x in 0..<9 where pixel64(x, y) == brand {
                points.append((x, y))
            } }
            return (
                points.map(\.x).min()!, points.map(\.x).max()!,
                points.map(\.y).min()!, points.map(\.y).max()!
            )
        }
        let claudeBounds = markerBounds(50, [255, 112, 76])
        XCTAssertEqual(claudeBounds.minX, 1)
        XCTAssertEqual(claudeBounds.maxX, 7)
        XCTAssertLessThan(claudeBounds.maxY - claudeBounds.minY + 1, 7)
        let codexBounds = markerBounds(57, [126, 116, 255])
        XCTAssertEqual(codexBounds.minX, 1)
        XCTAssertEqual(codexBounds.maxX, 7)
        // TC001-style usage fill occupies the full band height, not only y=56.
        XCTAssertNotEqual(pixel64(10, 50), pixel64(35, 50))
        XCTAssertNotEqual(pixel64(10, 56), pixel64(35, 56))
        let resetColor: [UInt8] = [0x60, 0x70, 0x80]
        let claudeResetPixels = (50...56).flatMap { y in (0..<64).map { pixel64($0, y) } }
            .filter { $0 == resetColor }.count
        let codexResetPixels = (57...63).flatMap { y in (0..<64).map { pixel64($0, y) } }
            .filter { $0 == resetColor }.count
        XCTAssertGreaterThan(claudeResetPixels, 0)
        XCTAssertGreaterThan(codexResetPixels, 0)
    }

    func testPixoo64CodexOnlyUsesPrimaryZoneForSubscriptionDate() {
        var state = DashboardState()
        state.state = .idle
        state.codexSubscriptionActiveUntil = "2099-12-31T00:00:00Z"
        state.codexRateLimits = CodexRateLimits(
            primary: nil,
            secondary: CodexRateLimitWindow(
                usedPercent: 50, windowMinutes: 10080, resetsAt: nil, stale: false
            ),
            planType: "plus", limitId: nil, credits: nil
        )
        let bytes = [UInt8](PixooRenderer().render(dashboardState: state))
        func pixel64(_ x: Int, _ y: Int) -> [UInt8] {
            let i = (y * 64 + x) * 3
            return [bytes[i], bytes[i + 1], bytes[i + 2]]
        }
        let timeColor: [UInt8] = [0x60, 0x70, 0x80]
        let datePixels = (57...63).flatMap { y in (9..<36).map { pixel64($0, y) } }
            .filter { $0 == timeColor }.count
        XCTAssertGreaterThan(datePixels, 0)
        XCTAssertNotEqual(pixel64(38, 57), pixel64(63, 57))
    }

    // MARK: - Pixoo adaptive animation transport

    func testPixooAdaptivePolicyUsesSafeMovingSingleFrames() {
        XCTAssertEqual(PixooAdaptivePushPolicy.mode(active: true), .activeSingle)
        XCTAssertEqual(
            PixooAdaptivePushPolicy.interval(stateChanged: false, mode: .activeSingle),
            PixooAdaptivePushPolicy.activeFrameRefreshSec
        )
    }

    func testPixooAdaptivePolicyRefreshesActiveFramesAtTwoPointFiveSeconds() {
        XCTAssertEqual(PixooAdaptivePushPolicy.mode(active: true), .activeSingle)
        XCTAssertEqual(PixooAdaptivePushPolicy.interval(stateChanged: false, mode: .activeSingle), 2.5)
    }

    func testPixooAdaptivePolicyPrioritizesStateChangesAndIdlesCalmly() {
        XCTAssertEqual(PixooAdaptivePushPolicy.mode(active: false), .idle)
        XCTAssertEqual(
            PixooAdaptivePushPolicy.interval(stateChanged: false, mode: .idle),
            PixooAdaptivePushPolicy.idleRefreshSec
        )
        XCTAssertEqual(
            PixooAdaptivePushPolicy.interval(stateChanged: true, mode: .idle),
            PixooAdaptivePushPolicy.stateChangeFloorSec
        )
    }
}
#endif
