import XCTest
@testable import AgentDeck

final class AppReviewPromptTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!
    private var calendar: Calendar!

    override func setUp() {
        super.setUp()
        suiteName = "AppReviewPromptTests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
        calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        calendar = nil
        super.tearDown()
    }

    func testRequiresMeaningfulUseOnThreeDistinctDays() {
        let policy = AppReviewPromptPolicy(defaults: defaults, calendar: calendar)
        let start = Date(timeIntervalSince1970: 1_800_000_000)

        policy.recordMeaningfulUse(at: start)
        policy.recordMeaningfulUse(at: start.addingTimeInterval(60 * 60))
        XCTAssertFalse(policy.shouldRequestReview(at: start))

        policy.recordMeaningfulUse(at: start.addingTimeInterval(24 * 60 * 60))
        XCTAssertFalse(policy.shouldRequestReview(at: start))

        policy.recordMeaningfulUse(at: start.addingTimeInterval(2 * 24 * 60 * 60))
        XCTAssertTrue(policy.shouldRequestReview(at: start))
    }

    func testAttemptStartsCooldown() {
        let policy = AppReviewPromptPolicy(
            defaults: defaults,
            calendar: calendar,
            minimumDistinctDays: 1,
            cooldown: 180 * 24 * 60 * 60
        )
        let start = Date(timeIntervalSince1970: 1_800_000_000)

        policy.recordMeaningfulUse(at: start)
        XCTAssertTrue(policy.shouldRequestReview(at: start))

        policy.markRequestAttempt(at: start)
        XCTAssertFalse(policy.shouldRequestReview(at: start.addingTimeInterval(179 * 24 * 60 * 60)))
        XCTAssertTrue(policy.shouldRequestReview(at: start.addingTimeInterval(180 * 24 * 60 * 60)))
    }

    func testNaturalPauseRequiresEveryLiveSessionToBeIdle() {
        XCTAssertFalse(AppReviewPromptPolicy.isNaturalPause(sessionStates: []))
        XCTAssertFalse(AppReviewPromptPolicy.isNaturalPause(sessionStates: ["idle", nil]))
        XCTAssertFalse(AppReviewPromptPolicy.isNaturalPause(sessionStates: ["idle", "processing"]))
        XCTAssertFalse(AppReviewPromptPolicy.isNaturalPause(sessionStates: ["awaiting_permission"]))
        XCTAssertTrue(AppReviewPromptPolicy.isNaturalPause(sessionStates: ["idle", "idle"]))
    }
}
