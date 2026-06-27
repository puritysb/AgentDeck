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
}
#endif
