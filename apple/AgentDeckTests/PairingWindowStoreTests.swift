#if os(macOS)
// PairingWindowStoreTests.swift — the Swift daemon's half of the pairing-code
// path, mirroring bridge/src/__tests__/pairing-window.test.ts.
//
// The verdict rules are generated from the TS SSOT, so what is tested here is
// what a pure function cannot express: that the window actually closes, that a
// refused redemption never touches the credential, and that expiry is decided on
// read rather than by a timer that may fire late.

import XCTest
@testable import AgentDeck

@DaemonActor
final class PairingWindowStoreTests: XCTestCase {

    private let peerIP = "192.0.2.55"
    private let token = "the-pairing-token"

    private func freshStore() -> PairingWindowStore {
        let store = PairingWindowStore.shared
        store.resetForTests()
        return store
    }

    // MARK: - Shape rules (parity with the TS SSOT)

    func testCodeShapeMatchesTheSharedRules() async {
            XCTAssertEqual(PairingCodeRules.normalize("482913"), "482913")
            // The CLI prints `482 913`; refusing what the operator is looking at
            // would spend one of their five attempts on a formatting choice.
            XCTAssertEqual(PairingCodeRules.normalize("482 913"), "482913")
            XCTAssertEqual(PairingCodeRules.normalize("482-913"), "482913")
            XCTAssertNil(PairingCodeRules.normalize("48291"))
            XCTAssertNil(PairingCodeRules.normalize("abcdef"))
            XCTAssertNil(PairingCodeRules.normalize(nil))
            XCTAssertEqual(PairingCodeRules.format("482913"), "482 913")
    }

    func testStatusPerOutcomeMatchesTheSharedContract() async {
            let now = 1_700_000_000_000
            let open = PairingCodeRules.WindowSnapshot(
                code: "482913", expiresAt: now + PairingCodeRules.windowMs)

            XCTAssertEqual(PairingCodeRules.evaluate(window: open, submitted: "482913", now: now).status, 200)
            XCTAssertEqual(PairingCodeRules.evaluate(window: nil, submitted: "482913", now: now).status, 401)
            XCTAssertEqual(PairingCodeRules.evaluate(window: open, submitted: "000000", now: now).status, 401)
            XCTAssertEqual(PairingCodeRules.evaluate(window: open, submitted: "nope", now: now).status, 400)

            var expired = open
            expired.expiresAt = now
            XCTAssertEqual(PairingCodeRules.evaluate(window: expired, submitted: "482913", now: now).status, 410)

            var spent = open
            spent.redemptionsRemaining = 0
            XCTAssertEqual(PairingCodeRules.evaluate(window: spent, submitted: "482913", now: now).status, 429)
    }

    func testExpiryIsDecidedBeforeTheCodeIsRead() async {
            let now = 1_700_000_000_000
            var expired = PairingCodeRules.WindowSnapshot(code: "482913", expiresAt: now)
            expired.failedAttempts = 0
            // The RIGHT code against an expired window is `expired`, not `mismatch`:
            // a stale window must not be probeable for free.
            XCTAssertEqual(PairingCodeRules.evaluate(window: expired, submitted: "482913", now: now).outcome, .expired)
    }

    // MARK: - Window lifecycle

    func testWindowIsClosedUntilTheOperatorOpensOne() async {
        let store = freshStore()
        XCTAssertFalse(store.isOpen())
        XCTAssertEqual(store.status().value["open"] as? Bool, false)
    }

    func testOpenMintsACodeOfTheDocumentedShape() async {
        let store = freshStore()
        let opened = store.open()
        XCTAssertEqual(opened.code.count, PairingCodeRules.digits)
        XCTAssertTrue(PairingCodeRules.isPairingCode(opened.code))
        XCTAssertTrue(store.isOpen())
    }

    func testCodesAreActuallyRandom() async {
        let store = freshStore()
        var codes = Set<String>()
        for _ in 0..<200 { codes.insert(store.open().code) }
        // 200 draws from 10^6; a constant or a low-entropy source collapses this.
        XCTAssertGreaterThan(codes.count, 190)
    }

    func testOpeningTwiceReplacesRatherThanLeavingTwoValidSecrets() async {
        let store = freshStore()
        let first = store.open()
        let second = store.open()
        XCTAssertNotEqual(first.code, second.code)
        // The code the operator has stopped looking at must not still work.
        let result = store.redeem(submitted: first.code, ip: peerIP, name: nil, kind: nil,
                                  mintToken: { token })
        XCTAssertEqual(result.outcome, .mismatch)
    }

    func testWindowLengthAndDeviceCountAreClamped() async {
        let store = freshStore()
        let long = store.open(ttl: 86_400)
        XCTAssertLessThanOrEqual(long.expiresAt.timeIntervalSinceNow, 601)
        // A `--ttl 0` typo must not open a window that is already over.
        let zero = store.open(ttl: 0)
        XCTAssertGreaterThan(zero.expiresAt.timeIntervalSinceNow, 1)
        XCTAssertEqual(store.open(redemptions: 0).redemptions, 1)
        XCTAssertEqual(store.open(redemptions: 999).redemptions, 16)
    }

    // MARK: - Redemption

    func testRightCodeHandsOverTheTokenAndClosesAOneDeviceWindow() async {
        let store = freshStore()
        let opened = store.open()
        let result = store.redeem(submitted: opened.code, ip: peerIP,
                                  name: "Crema S", kind: "android-eink",
                                  mintToken: { token })
        XCTAssertEqual(result.outcome, .accepted)
        XCTAssertEqual(result.token, token)
        XCTAssertFalse(store.isOpen())
    }

    func testARefusedRedemptionNeverMintsAToken() async {
        let store = freshStore()
        let opened = store.open()
        var minted = 0
        let mint: () -> String = { [token] in minted += 1; return token }

        _ = store.redeem(submitted: "000000", ip: peerIP, name: nil, kind: nil, mintToken: mint)
        _ = store.redeem(submitted: "nope", ip: peerIP, name: nil, kind: nil, mintToken: mint)
        _ = store.redeem(submitted: nil, ip: peerIP, name: nil, kind: nil, mintToken: mint)
        XCTAssertEqual(minted, 0)

        _ = store.redeem(submitted: opened.code, ip: peerIP, name: nil, kind: nil, mintToken: mint)
        XCTAssertEqual(minted, 1)
    }

    func testTokenIsReadLiveSoAHandoverReachesADevicePairingNow() async {
        let store = freshStore()
        var current = "first-token"
        var opened = store.open()
        XCTAssertEqual(
            store.redeem(submitted: opened.code, ip: peerIP, name: nil, kind: nil,
                         mintToken: { current }).token,
            "first-token")

        current = "adopted-token"
        opened = store.open()
        XCTAssertEqual(
            store.redeem(submitted: opened.code, ip: peerIP, name: nil, kind: nil,
                         mintToken: { current }).token,
            "adopted-token")
    }

    func testMultiDeviceWindowPairsSeveralThenCloses() async {
        let store = freshStore()
        let opened = store.open(redemptions: 3)
        for i in 0..<3 {
            let result = store.redeem(submitted: opened.code, ip: "192.0.2.\(i)",
                                      name: nil, kind: nil, mintToken: { token })
            XCTAssertEqual(result.outcome, .accepted)
    }
    XCTAssertFalse(store.isOpen())
    XCTAssertEqual(
        store.redeem(submitted: opened.code, ip: peerIP, name: nil, kind: nil,
                     mintToken: { token }).outcome,
        .noWindow)
    }

    func testAttemptBudgetIsGlobalAcrossPeers() async {
        let store = freshStore()
        let opened = store.open()
        // Global on purpose: an attacker picks their source address, so a
        // per-IP budget would be a budget per attempt.
        for i in 0..<PairingCodeRules.maxFailedAttempts {
            let result = store.redeem(submitted: "000000", ip: "192.0.2.\(i)",
                                      name: nil, kind: nil, mintToken: { token })
            XCTAssertEqual(result.outcome, .mismatch)
    }
    XCTAssertFalse(store.isOpen())
    XCTAssertEqual(
        store.redeem(submitted: opened.code, ip: peerIP, name: nil, kind: nil,
                     mintToken: { token }).outcome,
        .noWindow)
    }

    func testMalformedSubmissionsSpendNoBudget() async {
        let store = freshStore()
        let opened = store.open()
        for _ in 0..<50 {
            _ = store.redeem(submitted: "nope", ip: peerIP, name: nil, kind: nil,
                             mintToken: { token })
    }
    XCTAssertEqual(store.status().value["attemptsRemaining"] as? Int,
                   PairingCodeRules.maxFailedAttempts)
    XCTAssertEqual(
        store.redeem(submitted: opened.code, ip: peerIP, name: nil, kind: nil,
                     mintToken: { token }).outcome,
        .accepted)
    }

    // MARK: - Expiry enforced on read

    func testAWindowPastItsDeadlineIsClosedEvenIfNoTimerRan() async {
        let store = freshStore()
        let opened = store.open(ttl: 20)
        // A sleeping laptop or a saturated executor is exactly this: the
        // deadline passes, no callback has run. Reading must already refuse.
        let afterDeadline = Date().addingTimeInterval(21)
        XCTAssertFalse(store.isOpen(now: afterDeadline))
        XCTAssertEqual(
            store.redeem(submitted: opened.code, ip: peerIP, name: nil, kind: nil,
                         now: afterDeadline, mintToken: { token }).outcome,
            .noWindow)
    }

    // MARK: - Operator status

    func testStatusNeverCarriesTheCodeOrTheToken() async {
        let store = freshStore()
        let opened = store.open()
        _ = store.redeem(submitted: opened.code, ip: peerIP, name: "Crema S",
                         kind: "android-eink", mintToken: { token })
        let flat = String(describing: store.status().value)
        XCTAssertFalse(flat.contains(opened.code))
        XCTAssertFalse(flat.contains(token))
    }

    func testStatusStillReportsThePairingAfterTheWindowClosedOnIt() async {
        let store = freshStore()
        let opened = store.open()
        _ = store.redeem(submitted: opened.code, ip: "192.0.2.50", name: "Crema S",
                         kind: "android-eink", mintToken: { token })
        // A one-device window closes the instant it succeeds and the operator
        // learns the outcome by polling — without a receipt, a pairing that
        // worked reads as "closed with nothing paired".
        let status = store.status().value
        XCTAssertEqual(status["open"] as? Bool, false)
        let redemptions = status["redemptions"] as? [[String: Any]] ?? []
        XCTAssertEqual(redemptions.count, 1)
        XCTAssertEqual(redemptions.first?["name"] as? String, "Crema S")
    }

    func testANewWindowDoesNotInheritThePreviousRunsPairings() async {
        let store = freshStore()
        let first = store.open()
        _ = store.redeem(submitted: first.code, ip: "192.0.2.50", name: "Crema S",
                         kind: nil, mintToken: { token })
        XCTAssertEqual((store.status().value["redemptions"] as? [[String: Any]])?.count, 1)

        _ = store.open()
        XCTAssertEqual((store.status().value["redemptions"] as? [[String: Any]])?.count, 0)
    }

    func testDeviceLabelIsSanitizedBecauseItComesFromAnUnpairedPeer() async {
        let store = freshStore()
        let opened = store.open()
        // The name lands in a log line, which is a terminal, and the peer
        // that chose it has not authenticated.
        let hostile = "evil\u{001b}[2Jname\nsecond line"
        _ = store.redeem(submitted: opened.code, ip: peerIP, name: hostile,
                         kind: String(repeating: "x", count: 200), mintToken: { token })

        let redemption = (store.status().value["redemptions"] as? [[String: Any]])?.first
        let name = redemption?["name"] as? String ?? ""
        XCTAssertFalse(name.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f })
        XCTAssertEqual(name, "evil [2Jname second line")
        XCTAssertLessThanOrEqual((redemption?["kind"] as? String ?? "").count, 24)
    }

    func testEmptyOrMissingLabelsFallBackRatherThanRenderBlank() async {
        let store = freshStore()
        let opened = store.open()
        _ = store.redeem(submitted: opened.code, ip: peerIP, name: "   ", kind: nil,
                         mintToken: { token })
        let redemption = (store.status().value["redemptions"] as? [[String: Any]])?.first
        XCTAssertEqual(redemption?["name"] as? String, "unnamed device")
        XCTAssertEqual(redemption?["kind"] as? String, "unknown")
    }
}
#endif
