// TimeboxProtocolTests.swift — byte-level verification of the Divoom Timebox Mini
// static-image protocol reimplemented in Swift (TimeboxDivoomPacket), checked against
// golden vectors generated from bridge/src/timebox/sync_ble.py. If these drift, the panel
// silently shows garbage or nothing.

#if os(macOS)
import XCTest
@testable import AgentDeck

final class TimeboxProtocolTests: XCTestCase {

    // MARK: - Static-image framing

    /// build_static_image_packet(bytes(182)) — all-zero payload. Golden bytes from
    /// the Python source: 194-byte escaped frame. The command is
    /// [0xBD,0x00,0x44,0x00,0x0A,0x0A,0x04] + 182 zeros; sum = 281 = 0x0119, so the
    /// checksum LE tail is [0x19, 0x01], and the 0x01 byte escapes to [0x03, 0x04].
    func testFramingAllZeroPayload() {
        let out = TimeboxDivoomPacket.buildStaticImagePacket(payload: [UInt8](repeating: 0, count: 182))
        XCTAssertEqual(out.count, 194)
        // Header after the 0x01 start byte: length(0xBD,0x00) + 0x44 + 0x00,0x0A,0x0A,0x04.
        XCTAssertEqual(Array(out.prefix(8)), [0x01, 0xBD, 0x00, 0x44, 0x00, 0x0A, 0x0A, 0x04])
        // Tail: checksum 0x19, then 0x01→escaped 0x03 0x04, then frame end 0x02.
        XCTAssertEqual(Array(out.suffix(4)), [0x19, 0x03, 0x04, 0x02])
    }

    /// The escape rule turns each 0x01/0x02/0x03 into [0x03, b+0x03]; other bytes pass through.
    func testEscape() {
        XCTAssertEqual(TimeboxDivoomPacket.escape([0x44, 0x00]), [0x01, 0x44, 0x00, 0x02])
        XCTAssertEqual(TimeboxDivoomPacket.escape([0x01]), [0x01, 0x03, 0x04, 0x02])
        XCTAssertEqual(TimeboxDivoomPacket.escape([0x02]), [0x01, 0x03, 0x05, 0x02])
        XCTAssertEqual(TimeboxDivoomPacket.escape([0x03]), [0x01, 0x03, 0x06, 0x02])
    }

    // MARK: - Nibble packing

    /// nibblePack of an 11×11 RGB whose first two pixels are (255,0,17) and (34,51,255),
    /// rest black. Golden from Python: round(c/17) → [15,0,1, 2,3,15, …], packed
    /// low|high<<4 → [0x0F, 0x21, 0xF3, 0x00, …]. 182 bytes total.
    func testNibblePack() {
        var rgb = [UInt8](repeating: 0, count: 11 * 11 * 3)
        rgb[0] = 255; rgb[1] = 0; rgb[2] = 17
        rgb[3] = 34;  rgb[4] = 51; rgb[5] = 255
        let out = TimeboxDivoomPacket.nibblePack(rgb: rgb)
        XCTAssertEqual(out.count, 182)
        XCTAssertEqual(Array(out.prefix(4)), [0x0F, 0x21, 0xF3, 0x00])
        XCTAssertEqual(out.dropFirst(4).allSatisfy { $0 == 0 }, true)
    }

    /// Channel values clamp to 0–15 nibbles (round(255/17)=15, never overflows).
    func testNibbleClamp() {
        XCTAssertEqual(TimeboxDivoomPacket.clampNibble(20), 15)
        XCTAssertEqual(TimeboxDivoomPacket.clampNibble(-3), 0)
        XCTAssertEqual(TimeboxDivoomPacket.clampNibble(15), 15)
    }

    /// End-to-end: packet(fromRGB:) over an all-black 11×11 equals the all-zero-payload frame.
    func testPacketFromBlackRGB() {
        let black = [UInt8](repeating: 0, count: 11 * 11 * 3)
        let viaRGB = TimeboxDivoomPacket.packet(fromRGB: black)
        let viaPayload = TimeboxDivoomPacket.buildStaticImagePacket(payload: [UInt8](repeating: 0, count: 182))
        XCTAssertEqual(viaRGB, viaPayload)
    }

    // MARK: - Timebox Mini Agent Beacon

    func testExhaustedQuotaDoesNotOverrideAgentBeacon() {
        var state = DashboardState()
        state.state = .idle
        state.agentType = "claude-code"
        state.fiveHourPercent = 20
        let renderer = PixooRenderer()
        let low = [UInt8](renderer.renderMicro(dashboardState: state))
        state.fiveHourPercent = 100
        let exhausted = [UInt8](renderer.renderMicro(dashboardState: state))
        // Mid-rail pixels are steady in idle/error; corners animate over time.
        XCTAssertEqual(pixel(low, 5, 0), pixel(exhausted, 5, 0))
        state.gatewayHasError = true
        let error = [UInt8](renderer.renderMicro(dashboardState: state))
        XCTAssertNotEqual(pixel(low, 5, 0), pixel(error, 5, 0))
    }


    private func pixel(_ buf: [UInt8], _ x: Int, _ y: Int) -> [UInt8] {
        let i = (y * 11 + x) * 3
        return [buf[i], buf[i + 1], buf[i + 2]]
    }

    func testBeaconUsesOfficialClaudeMaskInsideStatusRail() {
        var buf = [UInt8](repeating: 0, count: 11 * 11 * 3)
        MicroGlyphs.paintBeacon(&buf, creature: .octopus, aggregate: .idle, animFrame: 0)
        XCTAssertNotEqual(pixel(buf, 5, 3), [2, 6, 10])
        XCTAssertEqual(pixel(buf, 5, 5), [203, 112, 78]) // lit 0.92 idle Claude
        XCTAssertNotEqual(pixel(buf, 0, 0), [2, 6, 10]) // idle status corner
    }

    func testBeaconOpenCodeHollowAndOpenClawEyes() {
        var openCode = [UInt8](repeating: 0, count: 11 * 11 * 3)
        var openClaw = [UInt8](repeating: 0, count: 11 * 11 * 3)
        MicroGlyphs.paintBeacon(&openCode, creature: .opencode, aggregate: .idle, animFrame: 0)
        MicroGlyphs.paintBeacon(&openClaw, creature: .crayfish, aggregate: .idle, animFrame: 0)
        XCTAssertEqual(pixel(openCode, 5, 5), [2, 6, 10])
        // Original dark eyes + teal glints are area-sampled at 9 px; each
        // highlight occupies less than a whole LED and blends with its body.
        XCTAssertEqual(pixel(openClaw, 4, 3), [117, 59, 60])
        XCTAssertEqual(pixel(openClaw, 6, 3), [118, 60, 60])
    }

    func testBeaconProcessingMovesOnlyPerimeter() {
        var first = [UInt8](repeating: 0, count: 11 * 11 * 3)
        var later = [UInt8](repeating: 0, count: 11 * 11 * 3)
        MicroGlyphs.paintBeacon(&first, creature: .codex, aggregate: .processing, animFrame: 0)
        MicroGlyphs.paintBeacon(&later, creature: .codex, aggregate: .processing, animFrame: 12)
        for y in 1...9 { for x in 1...9 { XCTAssertEqual(pixel(first, x, y), pixel(later, x, y)) } }
        XCTAssertNotEqual(Array(first.prefix(11 * 3)), Array(later.prefix(11 * 3)))
    }

    func testBeaconStandbyTide() {
        var buf = [UInt8](repeating: 0, count: 11 * 11 * 3)
        MicroGlyphs.paintBeacon(&buf, creature: nil, aggregate: .idle, animFrame: 0)
        XCTAssertNotEqual(pixel(buf, 5, 6), [2, 6, 10])
    }

    func testBeaconUsesContinuousDimStatusFrame() {
        var buf = [UInt8](repeating: 0, count: 11 * 11 * 3)
        MicroGlyphs.paintBeacon(&buf, creature: .octopus, aggregate: .idle, animFrame: 0)
        XCTAssertNotEqual(pixel(buf, 5, 0), [2, 6, 10])
        XCTAssertNotEqual(pixel(buf, 0, 5), [2, 6, 10])
    }
}
#endif
