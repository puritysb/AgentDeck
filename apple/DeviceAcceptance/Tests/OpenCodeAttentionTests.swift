import XCTest

/// Explicit lab test: the orchestrator creates a fresh real OpenCode question
/// and permission wait before this runner touches the installed LAN dashboard.
final class OpenCodeAttention: XCTestCase {
    private func capture(_ app: XCUIApplication, _ name: String) {
        let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-tree"; tree.lifetime = .keepAlways; add(tree)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    func testQuestionThenOneTimePermission() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "bound.serendipity.agent.deck")
        app.terminate(); app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
        let local = app.buttons["Local network dashboard"]
        if local.waitForExistence(timeout: 5) { local.tap() }
        capture(app, "local-dashboard-before-choice")
        let choice = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Phone acceptance")).firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout: 40), app.debugDescription)
        capture(app, "real-opencode-choice-visible")
        choice.tap()
        XCTAssertTrue(choice.waitForNonExistence(timeout: 20), app.debugDescription)
        let allow = app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "Allow", "Allow ")).firstMatch
        XCTAssertTrue(allow.waitForExistence(timeout: 30), app.debugDescription)
        capture(app, "real-opencode-permission-visible")
        allow.tap()
        XCTAssertTrue(allow.waitForNonExistence(timeout: 20), app.debugDescription)
        capture(app, "real-opencode-turn-resumed")
    }
    func testCacheRestoresAfterProcessRelaunch() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "bound.serendipity.agent.deck")
        app.terminate(); app.launch()
        let fetch = app.buttons["Fetch local work summary"]
        XCTAssertTrue(fetch.waitForExistence(timeout: 15), app.debugDescription)
        fetch.tap()
        let counts = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Last observed:")).firstMatch
        XCTAssertTrue(counts.waitForExistence(timeout: 40), app.debugDescription)
        let stamp = app.staticTexts["remote-observation.source-time"]
        XCTAssertTrue(stamp.exists)
        let originalTime = stamp.label
        let originalCounts = counts.label
        capture(app, "cloud-summary-before-relaunch")
        app.terminate(); app.launch()
        XCTAssertTrue(counts.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(stamp.label, originalTime)
        XCTAssertEqual(counts.label, originalCounts)
        capture(app, "cloud-summary-restored-after-relaunch")
    }
}
