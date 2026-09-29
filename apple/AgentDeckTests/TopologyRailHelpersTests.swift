// TopologyRailHelpersTests.swift — guards against the dashboard surfacing
// stale Codex subscription dates. The bug: when the user renews ChatGPT
// Plus but does not re-run `codex login`, ~/.codex/auth.json keeps the
// previous JWT and `chatgpt_subscription_active_until` lags behind the
// real billing state. Once that timestamp is in the past, the renderer
// must drop it instead of showing "ChatGPT Plus · Mar 4" forever.

#if os(macOS)
import XCTest
@testable import AgentDeck

@MainActor
final class TopologyRailHelpersTests: XCTestCase {
    func testInlineSubscriptionPreservesPlanAndCreditsWithoutDate() {
        XCTAssertEqual(TopologyRail.withSubscriptionDate("ChatGPT Pro · Premium · 20 credits", until: nil, now: Date()), "ChatGPT Pro · Premium · 20 credits")
        XCTAssertEqual(TopologyRail.withSubscriptionDate("Google AI Pro", until: nil, now: Date()), "Google AI Pro")
    }

    func testInlineSubscriptionDistinguishesDateFromQuotaReset() {
        let result = TopologyRail.withSubscriptionDate("ChatGPT Pro", until: "2099-12-31", now: Date())!
        XCTAssertTrue(result.hasPrefix("ChatGPT Pro · subscription "))
        XCTAssertFalse(result.contains("reset"))
    }

    func testInlinePastDateDoesNotClaimCancellationOrRenewalRequired() {
        XCTAssertEqual(TopologyRail.withSubscriptionDate("ChatGPT Pro", until: "2020-01-01", now: Date()), "ChatGPT Pro · subscription date unconfirmed")
    }

    func testParseFutureISO8601WithFractionalSeconds() {
        let parsed = TopologyRail.parseUntilDate("2099-12-31T23:59:59.999Z")
        XCTAssertNotNil(parsed)
        XCTAssertGreaterThan(parsed!, Date())
    }

    func testParsePlainISO8601() {
        let parsed = TopologyRail.parseUntilDate("2099-01-15T00:00:00Z")
        XCTAssertNotNil(parsed)
        XCTAssertGreaterThan(parsed!, Date())
    }

    func testParsePastDateReturnsDateInPast() {
        let parsed = TopologyRail.parseUntilDate("2020-06-01T00:00:00Z")
        XCTAssertNotNil(parsed)
        XCTAssertLessThan(parsed!, Date())
    }

    func testParseDateOnly() {
        let parsed = TopologyRail.parseUntilDate("2099-05-15")
        XCTAssertNotNil(parsed)
        XCTAssertGreaterThan(parsed!, Date())
    }

    func testParseEmptyReturnsNil() {
        XCTAssertNil(TopologyRail.parseUntilDate(""))
        XCTAssertNil(TopologyRail.parseUntilDate("   "))
    }

    func testParseMalformedReturnsNil() {
        XCTAssertNil(TopologyRail.parseUntilDate("not-a-date"))
        XCTAssertNil(TopologyRail.parseUntilDate("2026/05/06"))
        XCTAssertNil(TopologyRail.parseUntilDate("forever"))
    }

    func testSubscriptionTrailingFutureRendersShortDate() {
        let now = ISO8601DateFormatter().date(from: "2026-05-06T00:00:00Z")!
        let trailing = TopologyRail.subscriptionTrailing(for: "2099-12-31T00:00:00Z", now: now)
        XCTAssertNotNil(trailing)
        XCTAssertFalse(trailing!.expired)
        XCTAssertFalse(trailing!.text.isEmpty)
    }

    func testSubscriptionTrailingPastRendersRenewalNeeded() {
        let now = ISO8601DateFormatter().date(from: "2026-05-06T00:00:00Z")!
        let trailing = TopologyRail.subscriptionTrailing(for: "2025-03-04T00:00:00Z", now: now)
        XCTAssertEqual(trailing?.text, "renewal needed")
        XCTAssertEqual(trailing?.expired, true)
    }

    func testSubscriptionTrailingMalformedRendersRenewalNeeded() {
        let now = Date()
        let trailing = TopologyRail.subscriptionTrailing(for: "not-a-date", now: now)
        XCTAssertEqual(trailing?.text, "renewal needed")
        XCTAssertEqual(trailing?.expired, true)
    }

    func testSubscriptionTrailingNilOrBlankReturnsNil() {
        let now = Date()
        XCTAssertNil(TopologyRail.subscriptionTrailing(for: nil, now: now))
        XCTAssertNil(TopologyRail.subscriptionTrailing(for: "   ", now: now))
    }
}
#endif
