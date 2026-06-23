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

    // MARK: - Micro glyphs (Swift mirror of micro-glyphs.ts)

    private func pixel(_ buf: [UInt8], _ x: Int, _ y: Int) -> [UInt8] {
        let i = (y * 11 + x) * 3
        return [buf[i], buf[i + 1], buf[i + 2]]
    }

    /// The Claude robot glyph must match the bridge's micro-glyphs.ts colors/positions.
    func testMicroGlyphRobot() {
        var buf = [UInt8](repeating: 0, count: 11 * 11 * 3)
        MicroGlyphs.paint(&buf, creature: .octopus, state: .idle, animFrame: 0)
        XCTAssertEqual(pixel(buf, 5, 3), [235, 130, 90])   // terracotta body
        XCTAssertEqual(pixel(buf, 3, 2), [255, 176, 64])   // amber eye (row 2 cols 3–4 / 6–7)
        XCTAssertEqual(pixel(buf, 1, 5), [150, 84, 64])    // left arm joint (rows 5–6 col 1)
        XCTAssertEqual(pixel(buf, 0, 0), [0, 0, 0])        // transparent → untouched
    }

    /// Codex glyph carries the white `>`/`_` terminal-prompt marking on the cloud.
    func testMicroGlyphCodexPrompt() {
        var buf = [UInt8](repeating: 0, count: 11 * 11 * 3)
        MicroGlyphs.paint(&buf, creature: .codex, state: .idle, animFrame: 0)
        XCTAssertEqual(pixel(buf, 2, 4), [238, 240, 255])  // `>` chevron top (marking)
        XCTAssertEqual(pixel(buf, 6, 7), [238, 240, 255])  // `_` underscore (marking)
        XCTAssertEqual(pixel(buf, 0, 4), [120, 126, 236])  // indigo cloud body
    }

    /// Status-field colors match micro-glyphs.ts microStatusBg.
    func testMicroStatusBg() {
        XCTAssertEqual(tupleBytes(MicroGlyphs.statusBg(.processing, animFrame: 0)), [10, 28, 64])
        XCTAssertEqual(tupleBytes(MicroGlyphs.statusBg(.idle, animFrame: 0)), [16, 56, 28])
        XCTAssertEqual(tupleBytes(MicroGlyphs.statusBg(.error, animFrame: 0)), [64, 18, 18])
    }

    private func tupleBytes(_ t: (UInt8, UInt8, UInt8)) -> [UInt8] { [t.0, t.1, t.2] }
}
#endif
