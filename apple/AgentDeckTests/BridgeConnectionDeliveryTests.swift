import XCTest
@testable import AgentDeck

final class BridgeConnectionDeliveryTests: XCTestCase {
    @MainActor
    func testCurrentGenerationDeliversParsedRosterOnMainQueue() async {
        let connection = BridgeConnection()
        var delivered: [String] = []
        connection.onEvent = { event in
            XCTAssertTrue(Thread.isMainThread)
            if case .sessionsList(let roster) = event {
                delivered.append(contentsOf: roster.sessions.map(\.id))
            }
        }

        connection.dispatchInbound(Self.rosterFrame(sessionID: "current"))
        XCTAssertTrue(delivered.isEmpty, "Delivery remains asynchronous")
        let drained = expectation(description: "queued frame delivered")
        DispatchQueue.main.async { drained.fulfill() }
        await fulfillment(of: [drained], timeout: 1)

        XCTAssertEqual(delivered, ["current"])
    }

    @MainActor
    func testDisconnectRejectsQueuedOldRosterButAllowsTheCurrentGeneration() async {
        let connection = BridgeConnection()
        var delivered: [String] = []
        connection.onEvent = { event in
            if case .sessionsList(let roster) = event {
                delivered.append(contentsOf: roster.sessions.map(\.id))
            }
        }

        // Remain on the main actor until both frames are queued. This drives
        // the host-switch race without opening a socket: disconnect is the
        // production generation boundary used before connecting another host.
        connection.dispatchInbound(Self.rosterFrame(sessionID: "previous-host"))
        connection.disconnect()
        connection.dispatchInbound(Self.rosterFrame(sessionID: "current-host"))
        let drained = expectation(description: "old and current deliveries drained")
        DispatchQueue.main.async { drained.fulfill() }
        await fulfillment(of: [drained], timeout: 1)

        XCTAssertEqual(delivered, ["current-host"], "An old queued frame cannot repopulate the invalidated roster")
        XCTAssertEqual(connection.status, .disconnected)
    }

    @MainActor
    func testCurrentDisconnectDeliveryNotifiesOnMainQueue() async {
        let connection = BridgeConnection()
        var disconnectCount = 0
        connection.onDisconnect = {
            XCTAssertTrue(Thread.isMainThread)
            disconnectCount += 1
        }

        connection.dispatchDisconnect()
        XCTAssertEqual(disconnectCount, 0, "Transport callbacks remain asynchronous")
        let drained = expectation(description: "current disconnect delivered")
        DispatchQueue.main.async { drained.fulfill() }
        await fulfillment(of: [drained], timeout: 1)

        XCTAssertEqual(disconnectCount, 1)
    }

    @MainActor
    func testExplicitStopRejectsAlreadyQueuedDisconnectDelivery() async {
        let connection = BridgeConnection()
        var disconnectCount = 0
        connection.onDisconnect = { disconnectCount += 1 }

        // Keep the main actor until the old callback and Stop are both queued.
        // stopConnectionAttempts() uses this disconnect() generation boundary;
        // delivering the old callback would let the holder reconnect afterward.
        connection.dispatchDisconnect()
        connection.disconnect()
        let drained = expectation(description: "stale disconnect discarded")
        DispatchQueue.main.async { drained.fulfill() }
        await fulfillment(of: [drained], timeout: 1)

        XCTAssertEqual(disconnectCount, 0)
        XCTAssertEqual(connection.status, .disconnected)
    }

    private static func rosterFrame(sessionID: String) -> String {
        """
        {"type":"sessions_list","sessions":[{"id":"\(sessionID)","port":9120,"projectName":"Project","alive":true,"state":"awaiting_option"}]}
        """
    }
}
