#if os(macOS)
import XCTest
@testable import AgentDeck

final class AttentionSessionAccessTests: XCTestCase {
    func testFreshEmptyRosterIsDistinctFromStaleOrFutureDatedEvidence() throws {
        let now = Date(timeIntervalSince1970: 1_000)
        let fresh = attentionSnapshot([], receivedAt: now)
        XCTAssertTrue(try fresh.items(waitingOnly: true, at: now).isEmpty)

        for receivedAt in [now.addingTimeInterval(-AttentionSessionSnapshot.maximumAge), now.addingTimeInterval(1)] {
            let unavailable = attentionSnapshot([], receivedAt: receivedAt)
            XCTAssertThrowsError(try unavailable.items(waitingOnly: true, at: now)) {
                XCTAssertEqual($0 as? AttentionSessionError, .unavailable)
            }
        }
    }

    @MainActor
    func testQueryTimesOutForMissingAndStaleRosterInsteadOfReturningZero() async {
        let stale = attentionSnapshot([], receivedAt: Date().addingTimeInterval(-60))
        for snapshot in [nil, stale] as [AttentionSessionSnapshot?] {
            let fixture = AttentionAccessFixture(snapshot: snapshot, readinessTimeout: .milliseconds(10))
            do {
                _ = try await fixture.access.waitingSessions()
                XCTFail("Unavailable evidence must not become a successful empty result")
            } catch {
                XCTAssertEqual(error as? AttentionSessionError, .unavailable)
            }
            XCTAssertEqual(fixture.openCount, 0, "A query does not request a Dashboard route")
        }
    }

    @MainActor
    func testWaitingQueryIncludesOnlyLiveAwaitingRowsAndPreservesTheirEvidence() async throws {
        let observedAt = Date()
        let rows = [
            attentionRow("z-option", state: "awaiting_option", question: "Choose a branch"),
            attentionRow("dead", state: "awaiting_permission", alive: false),
            attentionRow("idle", state: "idle"),
            attentionRow("working", state: "processing"),
            attentionRow("unknown", state: "future_state"),
            attentionRow("a-permission", state: "awaiting_permission", question: "Allow this tool?"),
            attentionRow("m-diff", state: "awaiting_diff")
        ]
        let fixture = AttentionAccessFixture(snapshot: attentionSnapshot(rows, receivedAt: observedAt))

        let waiting = try await fixture.access.waitingSessions()
        XCTAssertEqual(waiting.map(\.reference.sessionID), ["a-permission", "m-diff", "z-option"])
        XCTAssertEqual(waiting.first?.question, "Allow this tool?")
        XCTAssertTrue(waiting.allSatisfy { $0.observedAt == observedAt })
        let available = try await fixture.access.availableSessions()
        XCTAssertEqual(Set(available.map(\.reference.sessionID)), Set(rows.filter(\.alive).map(\.id)))
    }

    @MainActor
    func testNotificationReferenceSeparatesHostsWithoutCarryingPairingCredentials() throws {
        let firstEndpoint = try XCTUnwrap(PairingCredential.endpoint(of: "ws://first.local:9120?token=private-pairing-token"))
        let first = AttentionSessionReference(endpoint: firstEndpoint, sessionID: "same-session")
        let second = AttentionSessionReference(endpoint: "second.local:9120", sessionID: "same-session")
        XCTAssertNotEqual(first.id, second.id)
        XCTAssertEqual(AttentionSessionReference(id: first.id), first)

        let content = AttentionNotifier.content(reference: first, projectName: "AgentDeck", question: "Continue?")
        let encoded = try XCTUnwrap(content.userInfo[AttentionNotifier.referenceKey] as? String)
        let decoded = try XCTUnwrap(AttentionSessionReference(id: encoded))
        XCTAssertEqual(decoded.endpoint, "first.local:9120")
        XCTAssertEqual(decoded.sessionID, "same-session")
        XCTAssertEqual(content.threadIdentifier, encoded)
        XCTAssertEqual(content.userInfo.count, 1)
        // Inspect the decoded payload as well: base64 is not credential removal.
        let serialized = try JSONEncoder().encode(decoded)
        XCTAssertFalse(String(decoding: serialized, as: UTF8.self).contains("private-pairing-token"))
        XCTAssertFalse(decoded.endpoint.contains("token="))
    }

    func testResolutionUsesExactIdentityAndDeclaredFoldMembershipOnly() throws {
        let now = Date()
        var folded = attentionRow("folded", state: "awaiting_option")
        folded.foldedSessionIds = ["member", "dead-exact"]
        let snapshot = attentionSnapshot([folded, attentionRow("dead-exact", alive: false)], receivedAt: now)
        XCTAssertEqual(try snapshot.resolve(attentionReference("member"), at: now), "folded")
        XCTAssertThrowsError(try snapshot.resolve(attentionReference("dead-exact"), at: now)) {
            XCTAssertEqual($0 as? AttentionSessionError, .sessionEnded)
        }
        XCTAssertThrowsError(try snapshot.resolve(attentionReference("same-project-but-unrelated"), at: now)) {
            XCTAssertEqual($0 as? AttentionSessionError, .sessionEnded)
        }
        let foreign = AttentionSessionReference(endpoint: "other.local:9120", sessionID: "folded")
        XCTAssertThrowsError(try snapshot.resolve(foreign, at: now)) {
            XCTAssertEqual($0 as? AttentionSessionError, .differentHost)
        }
    }

    @MainActor
    func testSavedEntityResolvesFoldMembershipWithCurrentMetadataAndOriginalIdentity() async throws {
        var representative = attentionRow("representative", state: "awaiting_option", question: "Current question")
        representative.foldedSessionIds = ["original", "dead-exact"]
        let fixture = AttentionAccessFixture(snapshot: attentionSnapshot([
            representative, attentionRow("dead-exact", alive: false)
        ]))
        let reference = attentionReference("original")
        let foreign = AttentionSessionReference(endpoint: "other.local:9120", sessionID: "representative")
        let entities = try await fixture.access.resolveSessions(identifiers: [
            reference.id, attentionReference("missing").id, "invalid", foreign.id, attentionReference("dead-exact").id
        ])
        XCTAssertEqual(entities.count, 1)
        let entity = try XCTUnwrap(entities.first)
        XCTAssertEqual(entity.reference, reference)
        XCTAssertEqual(entity.question, "Current question")
        try await fixture.access.openSession(entity.reference)
        let presentation = try XCTUnwrap(fixture.access.presentation)
        XCTAssertEqual(fixture.access.consumePresentation(id: presentation.id), .session("representative"))
    }

    @MainActor
    func testColdOpenSurvivesConfigurationArrivingAfterTheRequest() async throws {
        let access = AttentionSessionAccess(readinessTimeout: .milliseconds(100))
        let opening = Task { try await access.openSession(attentionReference("target")) }
        defer { opening.cancel() }
        try await waitForAttentionRequest { access.hasRequestedDashboard }
        XCTAssertNil(access.presentation)

        var openCount = 0
        let snapshot = attentionSnapshot([attentionRow("target")])
        access.configure(snapshot: { snapshot }, openDashboard: { openCount += 1 })
        try await opening.value

        XCTAssertGreaterThan(openCount, 0)
        let presentation = try XCTUnwrap(access.presentation)
        XCTAssertEqual(access.consumePresentation(id: presentation.id), .session("target"))
        XCTAssertNil(access.consumePresentation(id: presentation.id), "The recreated view consumes a route only once")
    }

    @MainActor
    func testRepeatedOpenSelectsLocallyWithoutTogglingOrChangingHardwareFocus() async throws {
        let target = attentionRow("target")
        let fixture = AttentionAccessFixture(snapshot: attentionSnapshot([target]))
        var state = DashboardState()
        state.siblingSessions = [target]
        state.focusedSessionId = "hardware-target"
        let dashboard = DashboardInspection()
        let otherDashboard = DashboardInspection()

        for _ in 0..<2 {
            try await fixture.access.openSession(attentionReference("target"))
            let presentation = try XCTUnwrap(fixture.access.presentation)
            guard let destination = fixture.access.consumePresentation(id: presentation.id),
                  case .session(let id) = destination else {
                XCTFail("Expected the requested session")
                return
            }
            dashboard.select(id, state: state)
            XCTAssertEqual(dashboard.sessionId, "target")
            XCTAssertEqual(state.focusedSessionId, "hardware-target")
            XCTAssertNil(otherDashboard.sessionId)
        }
    }

    @MainActor
    func testConsumptionRevalidatesHostRosterLivenessAndFreshness() async throws {
        let target = attentionRow("target")
        let changes: [(AttentionSessionSnapshot?, AttentionSessionError)] = [
            (attentionSnapshot([target], endpoint: "other.local:9120"), .differentHost),
            (attentionSnapshot([]), .sessionEnded),
            (attentionSnapshot([attentionRow("target", alive: false)]), .sessionEnded),
            (nil, .unavailable),
            (attentionSnapshot([target], receivedAt: Date().addingTimeInterval(-60)), .unavailable)
        ]

        for (replacement, expectedError) in changes {
            let fixture = AttentionAccessFixture(snapshot: attentionSnapshot([target]))
            try await fixture.access.openSession(attentionReference("target"))
            let presentation = try XCTUnwrap(fixture.access.presentation)
            fixture.snapshot = replacement
            XCTAssertEqual(fixture.access.consumePresentation(id: presentation.id), .failure(expectedError.localizedDescription))
            XCTAssertNil(fixture.access.presentation)
        }
    }

    @MainActor
    func testAWindowOpeningAfterRouteExpiryCannotSelectTheSession() async throws {
        let fixture = AttentionAccessFixture(snapshot: attentionSnapshot([attentionRow("target")]))
        try await fixture.access.openSession(attentionReference("target"))
        let presentation = try XCTUnwrap(fixture.access.presentation)
        XCTAssertEqual(fixture.access.consumePresentation(id: presentation.id, at: presentation.expiresAt),
                       .failure(AttentionSessionError.expired.localizedDescription))
    }

    @MainActor
    func testNotificationTimeoutAndLegacyPayloadLeaveVisibleFailures() async throws {
        let fixture = AttentionAccessFixture(snapshot: nil, readinessTimeout: .milliseconds(10))
        await fixture.access.openNotification(referenceID: attentionReference("target").id)
        let timedOut = try XCTUnwrap(fixture.access.presentation)
        XCTAssertEqual(timedOut.error, .unavailable)
        XCTAssertGreaterThan(fixture.openCount, 0)
        XCTAssertEqual(fixture.access.consumePresentation(id: timedOut.id),
                       .failure(AttentionSessionError.unavailable.localizedDescription))

        await fixture.access.openNotification(referenceID: "legacy-unscoped-session-id")
        let invalid = try XCTUnwrap(fixture.access.presentation)
        XCTAssertEqual(invalid.error, .invalidNotification)
        XCTAssertEqual(fixture.access.consumePresentation(id: invalid.id),
                       .failure(AttentionSessionError.invalidNotification.localizedDescription))
    }

    @MainActor
    func testSupersededReadinessWaitCannotOverwriteTheNewerOpen() async throws {
        let fixture = AttentionAccessFixture(snapshot: nil, readinessTimeout: .milliseconds(100))
        let older = Task { try await fixture.access.openSession(attentionReference("older")) }
        defer { older.cancel() }
        try await waitForAttentionRequest { fixture.openCount > 0 }

        fixture.snapshot = attentionSnapshot([attentionRow("newer")])
        try await fixture.access.openSession(attentionReference("newer"))
        let newest = try XCTUnwrap(fixture.access.presentation)
        do {
            try await older.value
            XCTFail("The old readiness wait should be superseded")
        } catch {
            XCTAssertEqual(error as? AttentionSessionError, .superseded)
        }
        XCTAssertEqual(fixture.access.presentation?.id, newest.id)
        XCTAssertEqual(fixture.access.consumePresentation(id: newest.id), .session("newer"))
    }

    @MainActor
    func testAnOlderViewCallbackCannotConsumeTheLatestPresentation() async throws {
        let fixture = AttentionAccessFixture(snapshot: attentionSnapshot([attentionRow("first"), attentionRow("second")]))
        try await fixture.access.openSession(attentionReference("first"))
        let first = try XCTUnwrap(fixture.access.presentation)
        try await fixture.access.openSession(attentionReference("second"))
        let second = try XCTUnwrap(fixture.access.presentation)

        XCTAssertNil(fixture.access.consumePresentation(id: first.id))
        XCTAssertEqual(fixture.access.presentation?.id, second.id)
        XCTAssertEqual(fixture.access.consumePresentation(id: second.id), .session("second"))
    }
}

private func attentionReference(_ id: String) -> AttentionSessionReference {
    AttentionSessionReference(endpoint: "test.local:9120", sessionID: id)
}

private func attentionRow(_ id: String, state: String = "idle", alive: Bool = true, question: String? = nil) -> SessionInfo {
    var row = SessionInfo(id: id, port: 9120, projectName: "Same project")
    row.agentType = "claude-code"
    row.state = state
    row.alive = alive
    row.question = question
    return row
}

private func attentionSnapshot(_ sessions: [SessionInfo], endpoint: String = "test.local:9120",
                               receivedAt: Date = Date()) -> AttentionSessionSnapshot {
    AttentionSessionSnapshot(endpoint: endpoint, sessions: sessions, receivedAt: receivedAt)
}

@MainActor
private final class AttentionAccessFixture {
    var snapshot: AttentionSessionSnapshot?
    private(set) var openCount = 0
    let access: AttentionSessionAccess

    init(snapshot: AttentionSessionSnapshot?, readinessTimeout: Duration = .milliseconds(100)) {
        self.snapshot = snapshot
        access = AttentionSessionAccess(readinessTimeout: readinessTimeout)
        access.configure(snapshot: { [weak self] in self?.snapshot }, openDashboard: { [weak self] in
            self?.openCount += 1
        })
    }
}

@MainActor
private func waitForAttentionRequest(_ condition: () -> Bool) async throws {
    for _ in 0..<50 {
        if condition() { return }
        try await Task.sleep(for: .milliseconds(1))
    }
    throw AttentionSessionError.unavailable
}
#endif
