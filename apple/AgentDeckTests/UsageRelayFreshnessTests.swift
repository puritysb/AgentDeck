#if os(macOS)
// The Tier 1 usage relay's age gate.
//
// A sibling bridge answers `GET /usage` with `{ usage, fetchedAt }`, and this
// app decides from that stamp whether the reading may be relayed. The gate used
// to be one `if let … , fetchedAt > 0` whose failure skipped the whole block —
// losing the five-minute window AND leaving the payload unstamped, after which
// the caller wrote `Date()` on it. Numbers of unknown age became the one
// reading `usageStaleTTL` can never retire.
//
// The case that made it reachable is in here by name: a Node bridge that has
// numbers but has never completed a live fetch serves `fetchedAt: 0`.

import XCTest
@testable import AgentDeck

final class UsageRelayFreshnessTests: XCTestCase {
    private let now = 1_787_100_000_000   // epoch ms

    func testAFreshStampIsUsableAndComesBackInSeconds() {
        // `ApiUsageData.fetchedAt` is epoch seconds while the wire is ms;
        // getting that conversion wrong would age every reading by 1000×.
        let stamped = now - 30_000
        XCTAssertEqual(UsageRelay.classify(fetchedAtMs: stamped, nowMs: now),
                       .usable(fetchedAtSeconds: Double(stamped) / 1000.0))
    }

    func testAReadingOlderThanTheWindowIsSkipped() {
        XCTAssertEqual(UsageRelay.classify(fetchedAtMs: now - (5 * 60 * 1000) - 1, nowMs: now),
                       .tooOld)
    }

    func testTheWindowBoundaryItselfIsStillUsable() {
        // Exactly five minutes old is inside the window; only strictly older is
        // skipped. Pinning the edge stops a later `>=` from silently halving
        // the relay's usefulness.
        let edge = now - (5 * 60 * 1000)
        XCTAssertEqual(UsageRelay.classify(fetchedAtMs: edge, nowMs: now),
                       .usable(fetchedAtSeconds: Double(edge) / 1000.0))
    }

    // MARK: - The two shapes of "we cannot age this"

    func testAZeroStampIsUnknownAgeNotAncient() {
        // This is the pair the Node fix created: a bridge whose only cached
        // numbers came from a failed fetch's fallback reports `fetchedAt: 0`.
        // Read as a timestamp it is 1970 — ancient, and it would classify as
        // `.tooOld` by accident. It has to be `.unknownAge` on purpose, because
        // the producer is telling us it never fetched, not that it fetched long
        // ago.
        XCTAssertEqual(UsageRelay.classify(fetchedAtMs: 0, nowMs: now), .unknownAge)
    }

    func testAMissingStampIsUnknownAgeNotFresh() {
        // The regression this file exists for. Absence of a timestamp is "no
        // information" — never "fresh", which is what stamping `Date()` on it
        // amounted to, and never "old" either.
        XCTAssertEqual(UsageRelay.classify(fetchedAtMs: nil, nowMs: now), .unknownAge)
    }

    func testUnknownAgeIsNeverUsable() {
        // Stated as the property rather than as two cases, so a third way of
        // losing the stamp cannot quietly become usable.
        for missing in [nil, 0, -1] as [Int?] {
            let verdict = UsageRelay.classify(fetchedAtMs: missing, nowMs: now)
            XCTAssertEqual(verdict, .unknownAge, "fetchedAt \(String(describing: missing))")
            if case .usable = verdict { XCTFail("unstamped reading accepted as a relay source") }
        }
    }

    // MARK: - Clocks

    func testAStampFromTheFutureIsAcceptedRatherThanSkipped() {
        // Both processes are on this machine, so a stamp slightly ahead of us
        // is clock jitter between two local daemons, not a bad reading. It must
        // not compute a negative age that reads as "way inside the window" by
        // luck — it is inside the window on purpose.
        let ahead = now + 2_000
        XCTAssertEqual(UsageRelay.classify(fetchedAtMs: ahead, nowMs: now),
                       .usable(fetchedAtSeconds: Double(ahead) / 1000.0))
    }
}
#endif
