#if os(macOS)
// UnauthorizedCloseCodeTests.swift — the refusal the app could not report (#171).
//
// A user scanned the pairing QR, watched the app say "Connection failed", and
// could load `/health` from the same phone. Both facts were true and neither
// helped: public `/health` is served to unauthenticated peers by design (#145),
// so it proves reachability and nothing about the credential — and the app had
// no way to say "Unauthorized", because it only recognised the refusal in the
// shape the Node daemon never sends.
//
// These are contract tests, not behaviour tests: the close code and the
// producer that emits it live in another language, so what is pinned here is
// that the two agree, and that a refusal is presented as its own terminal
// state rather than as a retryable failure.

import XCTest
@testable import AgentDeck

final class UnauthorizedCloseCodeTests: XCTestCase {

    /// `ws.close(4001, 'Unauthorized')` in bridge/src/ws-server.ts. Not a member
    /// of `URLSessionWebSocketTask.CloseCode` — 4001 is application-defined, so
    /// nothing but this test keeps the two numbers in step.
    func testCloseCodeMatchesTheDaemon() {
        XCTAssertEqual(BridgeConnection.unauthorizedCloseCode, 4001)
    }

    func testCloseCodeIsOutsideTheStandardRangeUrlSessionWouldClaim() {
        // Application close codes start at 4000. A value below that could
        // collide with a protocol-level close and mis-report an ordinary
        // disconnect as a credential problem.
        XCTAssertGreaterThanOrEqual(BridgeConnection.unauthorizedCloseCode, 4000)
        XCTAssertLessThanOrEqual(BridgeConnection.unauthorizedCloseCode, 4999)
    }

    /// The message is the whole remedy the user gets, so it has to name both the
    /// problem and the action. "Connection failed" named neither, which is why
    /// #171 was opened rather than self-served.
    func testMessageNamesTheProblemAndTheFix() {
        let message = PairingCredential.approvalMessage(for: "ws://example.local:9120")
        XCTAssertTrue(message.contains("Approval required"), "must name the problem")
        XCTAssertTrue(
            message.contains("Devices › Pair Device"),
            "must point at pairing — a refusal is not fixed by waiting or retrying"
        )
        XCTAssertFalse(
            message.contains("Connection failed"),
            "the generic text is what hid this for a whole release"
        )
    }
}
#endif
