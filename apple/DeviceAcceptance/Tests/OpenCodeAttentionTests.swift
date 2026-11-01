import XCTest

/// Explicit lab test: the orchestrator creates a fresh real OpenCode question
/// and permission wait before this runner touches the installed LAN dashboard.
final class OpenCodeAttention: XCTestCase {
    private func capture(_ app: XCUIApplication, _ name: String) {
        let tree = XCTAttachment(string: app.debugDescription); tree.name = name + "-tree"; tree.lifetime = .keepAlways; add(tree)
        let shot = XCTAttachment(screenshot: app.screenshot()); shot.name = name; shot.lifetime = .keepAlways; add(shot)
    }
    private func waitForAction(_ element: XCUIElement, app: XCUIApplication) {
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate { value, _ in
            guard let element = value as? XCUIElement else { return false }
            return element.isEnabled && element.isHittable
        }, object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 45), .completed, app.debugDescription)
    }
    func testQuestionThenOneTimePermission() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "bound.serendipity.agent.deck")
        app.terminate(); app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 15))
        let local = app.buttons["Local network dashboard"]
        if local.waitForExistence(timeout: 5) { local.tap() }
        #if targetEnvironment(simulator)
        // A dedicated simulator uses the normal manual-connect UI; no saved
        // token, app preference injection or synthetic hook is required.
        let manual = app.buttons["Enter URL Manually"]
        if manual.waitForExistence(timeout: 5) {
            manual.tap()
            let url = app.textFields["ws://192.168.1.x:9120"]
            XCTAssertTrue(url.waitForExistence(timeout: 5), app.debugDescription)
            url.tap(); url.typeText("ws://127.0.0.1:9120")
            app.buttons["Connect"].tap()
        }
        #endif
        capture(app, "local-dashboard-before-choice")
        let choice = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Phone acceptance")).firstMatch
        XCTAssertTrue(choice.waitForExistence(timeout: 40), app.debugDescription)
        waitForAction(choice, app: app)
        capture(app, "real-opencode-choice-visible")
        choice.tap()
        XCTAssertTrue(choice.waitForNonExistence(timeout: 20), app.debugDescription)
        let allow = app.buttons.matching(NSPredicate(format: "label == %@ OR label BEGINSWITH %@", "Allow", "Allow ")).firstMatch
        XCTAssertTrue(allow.waitForExistence(timeout: 30), app.debugDescription)
        waitForAction(allow, app: app)
        capture(app, "real-opencode-permission-visible")
        allow.tap()
        XCTAssertTrue(allow.waitForNonExistence(timeout: 20), app.debugDescription)
        capture(app, "real-opencode-turn-resumed")
    }
    func testLocalCacheStorageRoundTrip() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "bound.serendipity.agent.deck")
        app.terminate(); app.launch()
        let check = app.buttons["Check local cache storage"]
        XCTAssertTrue(check.waitForExistence(timeout: 15), app.debugDescription)
        check.tap()
        XCTAssertTrue(app.staticTexts["Local cache storage round trip passed."].waitForExistence(timeout: 10), app.debugDescription)
        capture(app, "local-cache-storage-round-trip")
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
        XCTAssertTrue(counts.waitForExistence(timeout: 20), app.debugDescription)
        XCTAssertEqual(stamp.label, originalTime)
        XCTAssertEqual(counts.label, originalCounts)
        capture(app, "cloud-summary-restored-after-relaunch")
    }
}
