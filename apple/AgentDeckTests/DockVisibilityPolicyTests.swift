#if os(macOS)
import AppKit
import XCTest

@testable import AgentDeck

/// Gates the decision layer of "Menu bar only" (issue #221). Deliberately
/// tests the pure policy rather than the live NSApplication — an activation
/// policy assertion inside the test host would fight the test runner.
final class DockVisibilityPolicyTests: XCTestCase {

    private func snap(
        _ id: String?,
        visible: Bool = true,
        miniaturized: Bool = false
    ) -> DockVisibilityPolicy.WindowSnapshot {
        DockVisibilityPolicy.WindowSnapshot(
            identifier: id,
            isVisible: visible,
            isMiniaturized: miniaturized
        )
    }

    // MARK: - The polarity of the feature

    func testDefaultOffAlwaysStaysRegular() {
        // Off is the shipped default; nothing about window state may change it.
        XCTAssertEqual(
            DockVisibilityPolicy.desiredPolicy(menuBarOnly: false, openTrackedWindowIDs: []),
            .regular
        )
        XCTAssertEqual(
            DockVisibilityPolicy.desiredPolicy(menuBarOnly: false, openTrackedWindowIDs: ["dashboard"]),
            .regular
        )
    }

    func testHidesOnlyWhenNoTrackedWindowIsOpen() {
        XCTAssertEqual(
            DockVisibilityPolicy.desiredPolicy(menuBarOnly: true, openTrackedWindowIDs: []),
            .accessory
        )
        XCTAssertEqual(
            DockVisibilityPolicy.desiredPolicy(menuBarOnly: true, openTrackedWindowIDs: ["dashboard"]),
            .regular,
            "An open window must keep the Dock icon — that is what preserves ⌘Tab."
        )
    }

    // MARK: - The trap this feature dies on

    func testUntrackedWindowsDoNotHoldTheDockIcon() {
        // NSApp.windows also contains the MenuBarExtra `.window` panel, status
        // item windows, and AppKit internals. If any of those counted, the
        // demote would never fire and the toggle would silently do nothing.
        let windows = [
            snap(nil),
            snap("menu-bar-extra-panel"),
            snap("NSStatusBarWindow"),
        ]
        XCTAssertTrue(DockVisibilityPolicy.openTrackedWindowIDs(in: windows).isEmpty)
        XCTAssertEqual(
            DockVisibilityPolicy.desiredPolicy(
                menuBarOnly: true,
                openTrackedWindowIDs: DockVisibilityPolicy.openTrackedWindowIDs(in: windows)
            ),
            .accessory
        )
    }

    func testClosedSceneWindowDoesNotCount() {
        // A closed SwiftUI `Window` scene stays in NSApp.windows with
        // isVisible == false, so the identifier alone can't tell open from
        // closed.
        let windows = [snap("dashboard", visible: false)]
        XCTAssertTrue(DockVisibilityPolicy.openTrackedWindowIDs(in: windows).isEmpty)
    }

    func testMiniaturizedWindowStillCounts() {
        // isVisible is false while miniaturized. Demoting here strands the
        // window's Dock tile and the user can never restore it.
        let windows = [snap("dashboard", visible: false, miniaturized: true)]
        XCTAssertEqual(DockVisibilityPolicy.openTrackedWindowIDs(in: windows), ["dashboard"])
        XCTAssertEqual(
            DockVisibilityPolicy.desiredPolicy(
                menuBarOnly: true,
                openTrackedWindowIDs: DockVisibilityPolicy.openTrackedWindowIDs(in: windows)
            ),
            .regular
        )
    }

    func testAnyTrackedWindowHoldsTheIconNotJustTheDashboard() {
        for id in DockVisibilityPolicy.trackedWindowIDs {
            let open = DockVisibilityPolicy.openTrackedWindowIDs(in: [snap(id)])
            XCTAssertEqual(open, [id], "\(id) should count as an open window")
            XCTAssertEqual(
                DockVisibilityPolicy.desiredPolicy(menuBarOnly: true, openTrackedWindowIDs: open),
                .regular,
                "\(id) is a real window — it must keep the app in ⌘Tab"
            )
        }
    }

    func testMixedWindowListCountsOnlyTheTrackedVisibleOnes() {
        let windows = [
            snap(nil),
            snap("dashboard", visible: false),          // closed
            snap("settings"),                            // open
            snap("device-preview", visible: false, miniaturized: true),  // minimized
            snap("some-appkit-panel"),
        ]
        XCTAssertEqual(
            DockVisibilityPolicy.openTrackedWindowIDs(in: windows),
            ["settings", "device-preview"]
        )
    }
}
#endif
