import XCTest
@testable import AgentDeck

/// Codex purchased credits after an exhausted plan window. The rule and the
/// balance format are generated from shared/src/usage-presentation.ts, and
/// shared/credit-balance-vectors.json is replayed by the vitest suite too, so a
/// vector is a cross-platform contract: every surface must print the same
/// "62.5K" for the same balance and gate on the same exhaustion.
final class CodexCreditsPresentationTests: XCTestCase {
    private enum Num: Decodable {
        case value(Double)
        case infinity
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let s = try? c.decode(String.self), s == "inf" { self = .infinity; return }
            self = .value(try c.decode(Double.self))
        }
        var double: Double {
            switch self {
            case .value(let v): return v
            case .infinity: return .infinity
            }
        }
    }

    private struct FormatCase: Decodable {
        let balance: Num
        let text: String
        init(from decoder: Decoder) throws {
            var c = try decoder.unkeyedContainer()
            balance = try c.decode(Num.self)
            text = try c.decode(String.self)
        }
    }

    private struct ActiveCase: Decodable {
        let primary: Double
        let secondary: Double
        let balance: Num
        let active: Bool
        init(from decoder: Decoder) throws {
            var c = try decoder.unkeyedContainer()
            primary = try c.decode(Double.self)
            secondary = try c.decode(Double.self)
            balance = try c.decode(Num.self)
            active = try c.decode(Bool.self)
        }
    }

    private struct File: Decodable {
        let format: [FormatCase]
        let active: [ActiveCase]
    }

    func testMatchesSharedVectors() throws {
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // AgentDeckTests/
            .deletingLastPathComponent()   // apple/
            .deletingLastPathComponent()   // repo root
            .appendingPathComponent("shared/credit-balance-vectors.json")
        let file = try JSONDecoder().decode(File.self, from: Data(contentsOf: url))
        XCTAssertGreaterThanOrEqual(file.format.count, 10, "vector file too small to be a gate")
        for c in file.format {
            XCTAssertEqual(UsagePresentation.formatCreditBalance(c.balance.double), c.text, "balance \(c.balance.double)")
        }
        for c in file.active {
            XCTAssertEqual(UsagePresentation.creditsActive(c.primary, c.secondary, c.balance.double), c.active,
                           "(\(c.primary), \(c.secondary), \(c.balance.double))")
        }
    }

    private let now = ISO8601DateFormatter().date(from: "2026-10-01T00:00:00Z")!
    private let credits = CodexCredits(hasCredits: true, unlimited: false, balance: "62500")

    private func weekly(_ used: Double, resetsAt: String = "2026-10-03T00:00:00Z", stale: Bool? = nil) -> CodexRateLimitWindow {
        CodexRateLimitWindow(usedPercent: used, windowMinutes: 10080, resetsAt: resetsAt, stale: stale)
    }

    func testCreditBalanceReadsTheWire() {
        XCTAssertEqual(CodexRateLimits().creditBalance, -1)
        XCTAssertEqual(CodexRateLimits(credits: credits).creditBalance, 62500)
        XCTAssertEqual(CodexRateLimits(credits: CodexCredits(hasCredits: false, unlimited: false, balance: "0")).creditBalance, 0)
        XCTAssertEqual(CodexRateLimits(credits: CodexCredits(hasCredits: true, unlimited: true)).creditBalance, .infinity)
        XCTAssertEqual(CodexRateLimits(credits: CodexCredits(hasCredits: true, unlimited: false, balance: "n/a")).creditBalance, -1)
    }

    func testCreditsShowOnlyWhileALiveWindowIsExhaustedAndABalanceRemains() {
        // The measured Pro shape: weekly at 94% with 62,500 purchased credits.
        XCTAssertNil(CodexRateLimits(primary: weekly(94), credits: credits).activeCodexCredits(now: now))
        XCTAssertEqual(CodexRateLimits(primary: weekly(100), credits: credits).activeCodexCredits(now: now),
                       ActiveCodexCredits(balance: 62500, regularResetsAt: "2026-10-03T00:00:00Z"))
        XCTAssertEqual(CodexRateLimits(primary: weekly(100), credits: credits).activeCodexCredits(now: now)?.formatted, "62.5K")
        // Exhausted but nothing to spend: hidden, never "0".
        XCTAssertNil(CodexRateLimits(primary: weekly(100),
                                     credits: CodexCredits(hasCredits: false, unlimited: false, balance: "0"))
            .activeCodexCredits(now: now))
        // An ended or stale window is unknown, not exhausted.
        XCTAssertNil(CodexRateLimits(primary: weekly(100, stale: true), credits: credits).activeCodexCredits(now: now))
        XCTAssertNil(CodexRateLimits(primary: weekly(100, resetsAt: "2026-09-30T00:00:00Z"), credits: credits)
            .activeCodexCredits(now: now))
        // Credit-only plans (no windows) keep their own readout, not this one.
        XCTAssertNil(CodexRateLimits(credits: credits).activeCodexCredits(now: now))
    }

    func testLatestExhaustedResetEndsCreditSpending() {
        let limits = CodexRateLimits(
            primary: CodexRateLimitWindow(usedPercent: 100, windowMinutes: 300, resetsAt: "2026-10-01T03:00:00Z"),
            secondary: CodexRateLimitWindow(usedPercent: 100, windowMinutes: 10080, resetsAt: "2026-10-05T00:00:00Z"),
            credits: CodexCredits(hasCredits: true, unlimited: false, balance: "12")
        )
        XCTAssertEqual(limits.activeCodexCredits(now: now)?.regularResetsAt, "2026-10-05T00:00:00Z")
    }

    // MARK: - D200H preview mirror (shared/src/__tests__/session-deck-usage.test.ts)

    private func usageKinds(_ usage: D200HUsage, sessions: Int) -> [D200HSlotKind] {
        let input = D200HDeckInput(
            state: "IDLE",
            sessions: (0..<sessions).map {
                D200HSession(id: "s\($0)", agentType: "claude-code", state: "idle", projectName: "p\($0)")
            },
            usage: usage
        )
        return D200HLayoutModel.buildSessionDeck(input, view: D200HDeckView(mode: .list)).map(\.kind)
    }

    private func isCredits(_ kind: D200HSlotKind) -> Bool {
        if case .codexCredits = kind { return true }
        return false
    }

    private func isLuna(_ kind: D200HSlotKind) -> Bool {
        if case .lunaReserve = kind { return true }
        return false
    }

    private func isCodexWindow(_ kind: D200HSlotKind) -> Bool {
        if case .usageGauge(agent: "codex", _, _, _, _, _, _) = kind { return true }
        if case .usagePair("codex", _) = kind { return true }
        return false
    }

    func testD200HCreditTileReplacesAnExhaustedCodexWindow() {
        let exhausted = usageKinds(D200HUsage(
            fiveHourPercent: 42, sevenDayPercent: 17, known: true,
            codexSecondaryPercent: 100, codexSecondaryWindowMinutes: 10080,
            codexCreditBalance: 62500
        ), sessions: 12)
        guard case .some(.codexCredits(let balance)) = exhausted.first(where: isCredits)
        else { return XCTFail("expected a CREDITS tile, got \(exhausted)") }
        XCTAssertEqual(balance, 62500)
        XCTAssertFalse(exhausted.contains(where: isCodexWindow))

        // Still inside the plan: nothing changes.
        let inside = usageKinds(D200HUsage(
            codexSecondaryPercent: 94, codexSecondaryWindowMinutes: 10080, codexCreditBalance: 62500
        ), sessions: 12)
        XCTAssertFalse(inside.contains(where: isCredits))
        XCTAssertTrue(inside.contains(where: isCodexWindow))

        // Exhausted with nothing to spend: the exhausted window stays.
        let broke = usageKinds(D200HUsage(
            codexSecondaryPercent: 100, codexSecondaryWindowMinutes: 10080, codexCreditBalance: 0
        ), sessions: 12)
        XCTAssertFalse(broke.contains(where: isCredits))
        XCTAssertTrue(broke.contains(where: isCodexWindow))
    }

    func testD200HKeepsCreditsAndLunaSeparateYieldingTheReserveWhenFull() {
        let both = D200HUsage(
            fiveHourPercent: 42, sevenDayPercent: 17, known: true,
            codexSecondaryPercent: 100, codexSecondaryWindowMinutes: 10080,
            lunaReserve: D200HLunaReserve(usedPercent: 40, available: true),
            codexCreditBalance: 1250
        )
        // Few sessions → spare keys join the usage budget, so both fit.
        let roomy = usageKinds(both, sessions: 1)
        XCTAssertTrue(roomy.contains(where: isCredits))
        XCTAssertTrue(roomy.contains(where: isLuna))
        // A full roster leaves the three-key strip: Claude 5H/7D + credits.
        let full = usageKinds(both, sessions: 12)
        XCTAssertTrue(full.contains(where: isCredits))
        XCTAssertFalse(full.contains(where: isLuna))
    }
}
