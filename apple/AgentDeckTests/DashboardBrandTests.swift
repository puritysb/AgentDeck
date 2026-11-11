import XCTest
@testable import AgentDeck
#if os(macOS)
import SwiftUI

@MainActor
final class DashboardBrandTests: XCTestCase {
    /// The Mac header stacks the wordmark and its rule in the space the session
    /// rail leaves for them. A taller lockup would cover the rail's first row.
    func testLockupFitsTheClearanceAboveTheSessionRail() throws {
        let lockup = VStack(alignment: .leading, spacing: 3) {
            AgentDeckWordmark()
            AgentDeckBrandRule()
        }
        .frame(width: DashboardHUDLayout.sessionPanelWidth(availableWidth: 1_200), alignment: .leading)
        let hosting = NSHostingView(rootView: lockup.padding(12).background(Color.black))
        let size = hosting.fittingSize
        XCTAssertLessThanOrEqual(size.height - 24, DashboardHUDLayout.brandClearance)
        XCTAssertGreaterThan(size.width - 24, 200, "The rule spans the rail, not just the wordmark")
        if let path = ProcessInfo.processInfo.environment["AGENTDECK_BRAND_RENDER"] {
            hosting.frame = NSRect(origin: .zero, size: size)
            hosting.layoutSubtreeIfNeeded()
            let bitmap = try XCTUnwrap(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: path))
        }
    }
}
#endif
