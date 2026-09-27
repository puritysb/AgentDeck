// ResidentLabelLayoutTests.swift — the aquarium name-tag rule (DESIGN.md §6.4),
// kept in step with Android's ResidentLabelLayoutTest.

import XCTest
@testable import AgentDeck

final class ResidentLabelLayoutTests: XCTestCase {
    private typealias L = ResidentLabelLayout

    private func input(_ id: String, _ rank: L.Rank, x: Float, bodyBottom: Float = 400) -> L.Input {
        L.Input(id: id, rank: rank,
                body: .init(left: x - 40, top: bodyBottom - 80, right: x + 40, bottom: bodyBottom),
                fullTag: .init(left: x - 60, top: bodyBottom - 140, right: x + 60, bottom: bodyBottom - 90),
                compactTag: .init(left: x - 45, top: bodyBottom - 110, right: x + 45, bottom: bodyBottom - 90))
    }

    private func decision(_ out: [L.Decision], _ id: String) -> L.Decision { out.first { $0.id == id }! }

    func testSparseTankKeepsEveryTagWholeAndTranslucent() {
        let out = L.resolve([input("a", .idle, x: 100), input("b", .working, x: 400)])
        XCTAssertTrue(out.allSatisfy { $0.mode == .full && $0.backingOpacity < 1 })
        XCTAssertEqual(decision(out, "a").backingOpacity, TerrariumRules.nativeLabelBackingOpacity)
        XCTAssertEqual(decision(out, "a").textOpacity, TerrariumRules.nativeLabelIdleTextOpacity)
        XCTAssertEqual(decision(out, "b").textOpacity, 1)
    }

    func testDenseTankCollapsesOnlyIdleTags() {
        let ranks: [L.Rank] = [.focused, .awaiting, .working, .idle, .idle]
        let out = L.resolve(ranks.enumerated().map { input("r\($0.offset)", $0.element, x: 150 + Float($0.offset) * 300) })
        XCTAssertEqual(["r0", "r1", "r2"].map { decision(out, $0).mode }, [.full, .full, .full])
        XCTAssertEqual(["r3", "r4"].map { decision(out, $0).mode }, [.compact, .compact])
    }

    func testTagOverAnotherBodyYields() {
        let front = input("front", .idle, x: 300, bodyBottom: 500)
        let rearTemplate = input("rear", .working, x: 800)
        let rear = L.Input(id: "rear", rank: .working, body: front.fullTag, fullTag: rearTemplate.fullTag, compactTag: rearTemplate.compactTag)
        let out = L.resolve([front, rear])
        XCTAssertEqual(decision(out, "front").backingOpacity, TerrariumRules.nativeLabelYieldBackingOpacity)
        XCTAssertEqual(decision(out, "front").textOpacity, TerrariumRules.nativeLabelYieldTextOpacity)
        XCTAssertEqual(decision(out, "front").signalOpacity, TerrariumRules.nativeLabelYieldSignalOpacity)
        XCTAssertEqual(decision(out, "rear").signalOpacity, 1, "An unobstructed tag keeps a solid signal")
    }

    func testCollidingIdleTagDropsOutAndPriorityDrawsLast() {
        let out = L.resolve([input("idle", .idle, x: 320, bodyBottom: 390), input("working", .working, x: 300)])
        XCTAssertEqual(decision(out, "idle").mode, .hidden)
        XCTAssertEqual(out.last?.id, "working")
    }

    func testCollidingWorkingTagsBothStayAndTheLowerYields() {
        let out = L.resolve([input("far", .working, x: 320, bodyBottom: 400), input("near", .working, x: 300, bodyBottom: 420)])
        XCTAssertEqual(decision(out, "far").mode, .full)
        XCTAssertEqual(decision(out, "far").backingOpacity, TerrariumRules.nativeLabelYieldBackingOpacity)
        XCTAssertEqual(out.last?.id, "near")
    }
}
