#if os(macOS)
import XCTest
@testable import AgentDeck

/// Regression guard for the #327 serial ownership model.
///
/// The 2026-09-13 incident: the Node daemon went latency-silent at host load
/// 600–800, the macOS app promoted a fallback daemon on 9121 and opened the
/// same USB boards — two readers on one TTY steal each other's bytes instead
/// of failing cleanly, and two flashes corrupted. The guard this pins is a
/// truth table decided on every 10 s poll cycle:
///
///   1. a live suspension (the Swift twin of the Node flash lease — the
///      sandbox cannot read ~/.agentdeck, so it arrives over HTTP) keeps every
///      port closed, and expiry is enforced on read, never by a timer;
///   2. the LOWEST live daemon port in the window owns serial, so a fallback
///      hub defers to the incumbent and releases ports it grabbed earlier;
///   3. everything else owns the ports as before.
final class SerialOwnershipGuardTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_789_000_000)

    // MARK: sibling deferral

    func testFallbackPortDefersToCanonicalSibling() {
        // The incident topology: this app fell back to 9121 while the Node
        // daemon still answered on 9120.
        let d = ESP32Serial.ownershipDecision(ownPort: 9121, siblingPort: 9120, suspendedUntil: nil, now: now)
        XCTAssertEqual(d, .deferToSibling)
    }

    func testCanonicalDaemonKeepsSerialAgainstHigherPortSibling() {
        // Symmetric rule: the incumbent on 9120 is the owner; a sibling that
        // somehow lives on a HIGHER port defers to it, not the other way.
        let d = ESP32Serial.ownershipDecision(ownPort: 9120, siblingPort: 9121, suspendedUntil: nil, now: now)
        XCTAssertEqual(d, .own)
    }

    func testNoSiblingOrUnknownPortOwns() {
        XCTAssertEqual(ESP32Serial.ownershipDecision(ownPort: 9120, siblingPort: nil, suspendedUntil: nil, now: now), .own)
        // Own port unknown (0) → the sibling gate is skipped, never inverted
        // into a deferral for a daemon that cannot know better.
        XCTAssertEqual(ESP32Serial.ownershipDecision(ownPort: 0, siblingPort: 9120, suspendedUntil: nil, now: now), .own)
    }

    // MARK: suspension (the in-memory flash lease)

    func testSuspensionBeatsSiblingAndOwnership() {
        // A flash lease outranks topology: the flasher owns the ports, no
        // matter which daemon is canonical.
        let until = now.addingTimeInterval(60)
        XCTAssertEqual(
            ESP32Serial.ownershipDecision(ownPort: 9121, siblingPort: 9120, suspendedUntil: until, now: now),
            .suspended
        )
        XCTAssertEqual(
            ESP32Serial.ownershipDecision(ownPort: 9120, siblingPort: nil, suspendedUntil: until, now: now),
            .suspended
        )
    }

    func testExpiredSuspensionReadsAsExpiredOnReadNotByTimer() {
        // Expiry is enforced where the lease is read: a stale lease must stop
        // being true with nothing running to end it (CLI killed mid-flash).
        let expired = now.addingTimeInterval(-1)
        XCTAssertEqual(
            ESP32Serial.ownershipDecision(ownPort: 9121, siblingPort: nil, suspendedUntil: expired, now: now),
            .own
        )
    }

    // MARK: suspend/resume semantics on the actor

    func testSuspendClampsAndNeverShortensALiveLease() async {
        let serial = ESP32Serial()
        let (until, _) = await serial.suspendSerial(seconds: 10_000, reason: "test")
        // Clamped to the Node lease ceiling (900s = 15 min).
        XCTAssertLessThanOrEqual(until.timeIntervalSinceNow, 900 + 5, "seconds must clamp to 900")
        XCTAssertGreaterThan(until.timeIntervalSinceNow, 0)

        let (until2, _) = await serial.suspendSerial(seconds: 1, reason: "test")
        XCTAssertGreaterThanOrEqual(until2, until.addingTimeInterval(-1),
                                    "a second suspension must never shorten a live lease")

        // Resume is idempotent and reports the prior state both times.
        let was = await serial.resumeSerial()
        XCTAssertTrue(was)
        let wasAgain = await serial.resumeSerial()
        XCTAssertFalse(wasAgain)
    }
}
#endif
