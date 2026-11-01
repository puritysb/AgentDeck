#if os(macOS)
import AppKit
import XCTest
@testable import AgentDeck

final class DisplayMonitorTests: XCTestCase, @unchecked Sendable {
    func testWorkspaceEdgesArriveBeforeFallbackPollAndStopRemovesObservers() async {
        let center = NotificationCenter()
        let monitor = DisplayMonitor(workspaceNotifications: center, readDisplayAsleep: { false })
        let asleep = expectation(description: "immediate display sleep")
        await monitor.setOnStateChanged { on in if !on { asleep.fulfill() } }
        await monitor.start()
        // Repeated starts must not duplicate observers or edge callbacks.
        await monitor.start()
        center.post(name: NSWorkspace.screensDidSleepNotification, object: nil)
        await fulfillment(of: [asleep], timeout: 0.5)
        let sleeping = await monitor.displayOn
        XCTAssertFalse(sleeping)
        let awake = expectation(description: "immediate display wake")
        await monitor.setOnStateChanged { on in if on { awake.fulfill() } }
        center.post(name: NSWorkspace.screensDidWakeNotification, object: nil)
        await fulfillment(of: [awake], timeout: 0.5)
        await monitor.stop()
        center.post(name: NSWorkspace.screensDidSleepNotification, object: nil)
        try? await Task.sleep(for: .milliseconds(50))
        let stopped = await monitor.displayOn
        XCTAssertTrue(stopped)
    }

    func testInitialAsleepStateIsPublishedAndRestartResamplesHardware() async {
        let monitor = DisplayMonitor(workspaceNotifications: NotificationCenter(), readDisplayAsleep: { true })
        let initial = expectation(description: "initial hardware state")
        await monitor.setOnStateChanged { on in if !on { initial.fulfill() } }
        await monitor.start()
        await fulfillment(of: [initial], timeout: 0.5)
        await monitor.stop()
        await monitor.start()
        let on = await monitor.displayOn
        XCTAssertFalse(on)
        await monitor.stop()
    }
}
#endif
