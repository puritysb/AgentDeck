import XCTest
@testable import AgentDeck

/// Replays shared/zai-quota-vectors.json against the generated Swift mirror
/// of the z.ai quota-rules SSOT — the same file the vitest suite
/// (shared/src/__tests__/zai-quota.test.ts) replays against the TS canonical
/// implementation, so a vector is a behavioral contract BOTH producers keep
/// (#348). The Swift mirror is byte-gated by the vitest drift test; this file
/// is the behavioral gate.
final class ZaiQuotaRulesVectorsTests: XCTestCase {
    private struct Window: Decodable, Equatable {
        let usedPercent: Int
        let windowMinutes: Int
        let resetsAt: String?
        let quantity: String?
    }
    private struct QuotaVector: Decodable {
        let note: String
        let limits: JSONAny?
        let level: JSONAny?
        let expected: Expected
    }
    private struct Expected: Decodable, Equatable {
        let planType: String?
        let limitId: String?
        let primary: Window?
        let secondary: Window?
    }
    private struct PaygVector: Decodable {
        let note: String
        let key: String?
        let payg: Bool
    }
    /// A minimal lenient JSON value holder (numbers may arrive as Int/Double).
    private enum JSONAny: Decodable {
        case object([String: Any])
        case array([Any])
        case string(String)
        case number(Double)
        case bool(Bool)
        case null

        init(from decoder: Decoder) throws {
            let container = try decoder.singleValueContainer()
            if let o = try? container.decode([String: JSONAny].self) {
                self = .object(o.mapValues { $0.anyValue })
            } else if let a = try? container.decode([JSONAny].self) {
                self = .array(a.map { $0.anyValue })
            } else if let s = try? container.decode(String.self) {
                self = .string(s)
            } else if let b = try? container.decode(Bool.self) {
                self = .bool(b)
            } else if container.decodeNil() {
                self = .null
            } else {
                self = .number(try container.decode(Double.self))
            }
        }

        var anyValue: Any {
            switch self {
            case .object(let o): return o
            case .array(let a): return a
            case .string(let s): return s
            case .number(let n): return n
            case .bool(let b): return b
            case .null: return NSNull()
            }
        }
    }

    private func loadVectors() throws -> (quota: [QuotaVector], paygKeys: [PaygVector]) {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // AgentDeckTests/
            .deletingLastPathComponent()   // apple/
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("shared/zai-quota-vectors.json")
        struct File: Decodable { let quota: [QuotaVector]; let paygKeys: [PaygVector] }
        return try { let f = try JSONDecoder().decode(File.self, from: Data(contentsOf: url)); return (f.quota, f.paygKeys) }()
    }

    func testQuotaVectorsMatch() throws {
        let (vectors, _) = try loadVectors()
        XCTAssertGreaterThanOrEqual(vectors.count, 8, "vector file too small to be a gate")
        for v in vectors {
            let limits = (v.limits?.anyValue) as? [Any]
            let level = (v.level?.anyValue) as? String
            let out = ZaiQuotaRules.quotaFromLimits(limits, level: level)
            XCTAssertEqual(out.planType, v.expected.planType, v.note)
            XCTAssertEqual(out.limitId, v.expected.limitId, v.note)
            XCTAssertEqual(out.primary.map { wire($0) }, v.expected.primary, v.note)
            XCTAssertEqual(out.secondary.map { wire($0) }, v.expected.secondary, v.note)
        }
    }

    private func wire(_ w: ZaiQuotaRules.Window) -> Window {
        Window(usedPercent: w.usedPercent, windowMinutes: w.windowMinutes, resetsAt: w.resetsAtIso, quantity: w.quantity)
    }

    func testPaygKeyVectorsMatch() throws {
        let (_, vectors) = try loadVectors()
        XCTAssertGreaterThanOrEqual(vectors.count, 5, "payg vector file too small to be a gate")
        for v in vectors {
            XCTAssertEqual(ZaiQuotaRules.keyLooksPayAsYouGo(v.key), v.payg, v.note)
        }
    }

    func testPlanNames() {
        XCTAssertEqual(ZaiQuotaRules.formatPlanName("max"), "Max")
        XCTAssertEqual(ZaiQuotaRules.formatPlanName("Lite"), "Lite")
        XCTAssertEqual(ZaiQuotaRules.formatPlanName("team"), "Team")
        XCTAssertNil(ZaiQuotaRules.formatPlanName(nil))
        XCTAssertNil(ZaiQuotaRules.formatPlanName("  "))
    }
}

#if os(macOS)
final class ZaiUsageLifecycleTests: XCTestCase {
    func testReplacementRejectsLateReplyAndRemovalRetiresWindows() throws {
        let state = ZaiUsageState()
        let a = try XCTUnwrap(state.prepare(key: "account-a", expectedRevision: state.revision()))
        let reading = ZaiRateLimits(primary: ZaiWindow(usedPercent: 91), planType: "max")
        XCTAssertTrue(state.store(reading, at: Date(), revision: a))
        XCTAssertEqual(state.cached()?.data.primary?.usedPercent, 91)
        let b = try XCTUnwrap(state.prepare(key: "account-b", expectedRevision: state.revision()))
        XCTAssertNil(state.cached()?.data.primary)
        XCTAssertFalse(state.store(reading, at: Date(), revision: a))
        XCTAssertTrue(state.store(reading, at: Date(), revision: b))
        _ = state.prepare(key: nil, expectedRevision: state.revision())
        XCTAssertNil(state.cached()?.data.primary)
        XCTAssertNil(state.cached()?.data.planType)
        XCTAssertNotNil(state.cached(), "An explicit empty block clears retain-on-absent consumers")
    }

    func testSettingsInvalidationRejectsPendingKeyReadAndResponse() throws {
        let state = ZaiUsageState()
        let revision = try XCTUnwrap(state.prepare(key: "old", expectedRevision: state.revision()))
        state.invalidate()
        XCTAssertNil(state.prepare(key: "old", expectedRevision: revision))
        XCTAssertFalse(state.store(ZaiRateLimits(planType: "max"), at: Date(), revision: revision))
        XCTAssertNil(state.cached()?.data.planType)
    }

    func testFailureBackoffAndInFlightDedupResetForNewAccount() throws {
        let state = ZaiUsageState()
        let now = Date()
        let a = try XCTUnwrap(state.prepare(key: "a", expectedRevision: state.revision()))
        XCTAssertTrue(state.beginAttempt(now: now, backoffs: [45], revision: a))
        XCTAssertFalse(state.beginAttempt(now: now, backoffs: [45], revision: a))
        _ = state.noteFailure(revision: a)
        state.endAttempt(revision: a)
        XCTAssertFalse(state.beginAttempt(now: now, backoffs: [45], revision: a))
        let b = try XCTUnwrap(state.prepare(key: "b", expectedRevision: state.revision()))
        XCTAssertTrue(state.beginAttempt(now: now, backoffs: [45], revision: b))
        state.endAttempt(revision: a)
        XCTAssertFalse(state.beginAttempt(now: now, backoffs: [45], revision: b))
    }

    func testStoredKeyIsNotProofOfConnectionAndRemoteReadingNeedsNoLocalKey() {
        var state = DashboardState()
        XCTAssertEqual(IntegrationStatusEvaluator.zaiStatus(state: state, hasKey: true).label, "Awaiting data")
        state.zaiRateLimits = ZaiRateLimits(primary: ZaiWindow(usedPercent: 0), planType: "max")
        XCTAssertEqual(IntegrationStatusEvaluator.zaiStatus(state: state, hasKey: false), .connected(detail: "GLM Coding Plan · Max"))
        state.zaiRateLimits = ZaiRateLimits(planType: "max")
        XCTAssertNotEqual(IntegrationStatusEvaluator.zaiStatus(state: state, hasKey: false).label, "Connected")
    }
}
#endif
