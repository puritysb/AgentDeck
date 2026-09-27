import XCTest
@testable import AgentDeck

final class UsageSeverityTests: XCTestCase {
    func testBoundaryAndRemainingSemantics() {
        XCTAssertEqual(UsageSeverity.level(-1), .unknown)
        XCTAssertEqual(UsageSeverity.level(.nan), .unknown)
        XCTAssertEqual(UsageSeverity.level(69.9), .normal)
        XCTAssertEqual(UsageSeverity.level(70), .warning)
        XCTAssertEqual(UsageSeverity.level(82), .warning)
        XCTAssertEqual(UsageSeverity.level(89.9), .warning)
        XCTAssertEqual(UsageSeverity.level(90), .critical)
        XCTAssertEqual(UsageSeverity.level(100), .critical)
        XCTAssertEqual(UsageSeverity.colorHex(100 - 18), 0xFFA93D)
        XCTAssertEqual(UsageSeverity.colorHex(90), 0xFF6B6B)
        XCTAssertEqual(UsageSeverity.colorHex(82, onPaper: true), 0x7f541e)
    }
}
