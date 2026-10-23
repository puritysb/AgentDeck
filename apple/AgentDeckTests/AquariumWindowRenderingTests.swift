#if os(macOS)
import XCTest
@testable import AgentDeck

final class AquariumWindowRenderingTests: XCTestCase {
    func testSettingsYieldsRendererWithoutTreatingOtherWindowsAsSettings() {
        for key in [nil, "dashboard", "apme-dashboard", "device-preview"] as [String?] {
            XCTAssertTrue(AquariumWindowRenderingPolicy.shouldRender(
                attached: true, visible: true, miniaturized: false, occluded: false, keyWindowID: key))
        }
        XCTAssertFalse(AquariumWindowRenderingPolicy.shouldRender(
            attached: true, visible: true, miniaturized: false, occluded: false, keyWindowID: "settings"))
    }

    func testHiddenMinimizedAndDetachedWindowsNeverRender() {
        for snapshot in [(false, true, false, false), (true, false, false, false),
                         (true, true, true, false), (true, true, false, true)] {
            XCTAssertFalse(AquariumWindowRenderingPolicy.shouldRender(
                attached: snapshot.0, visible: snapshot.1, miniaturized: snapshot.2,
                occluded: snapshot.3, keyWindowID: "dashboard"))
        }
    }

    func testSettingsRemainsSuspendedAcrossApplicationFocusChanges() {
        XCTAssertFalse(AquariumWindowRenderingPolicy.shouldRender(
            attached: true, visible: true, miniaturized: false, occluded: false,
            keyWindowID: nil, mainWindowID: "settings"))
        XCTAssertTrue(AquariumWindowRenderingPolicy.shouldRender(
            attached: true, visible: true, miniaturized: false, occluded: false,
            keyWindowID: "dashboard", mainWindowID: "settings"))
        XCTAssertTrue(AquariumWindowRenderingPolicy.shouldRender(
            attached: true, visible: true, miniaturized: false, occluded: false,
            keyWindowID: nil, mainWindowID: "dashboard"))
    }
}
#endif
