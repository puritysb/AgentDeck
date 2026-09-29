#if os(macOS)
import XCTest
import RealityKit
@testable import AgentDeck

final class HermesAquariumTests: XCTestCase {
    func testProjectionDeduplicatesPrimaryAndRejectsProviderGuessing() {
        var dashboard = DashboardState()
        dashboard.agentType = "hermes"; dashboard.sessionId = "h"; dashboard.state = .processing
        dashboard.siblingSessions = [
            SessionInfo(id: "h", port: 1, projectName: "Work", agentType: "hermes", state: "processing"),
            SessionInfo(id: "h2", port: 2, projectName: "Work", agentType: "hermes", state: "awaiting_option"),
            SessionInfo(id: "dead", port: 3, projectName: "Work", agentType: "hermes", alive: false),
            SessionInfo(id: "c", port: 4, projectName: "Hermes", agentType: "claude-code", state: "idle")]
        let state = dashboard.toTerrariumState()
        XCTAssertEqual(state.hermesCreatures.map(\.id), ["h", "h2"])
        XCTAssertEqual(state.hermesCreatures.map(\.activity), [.working, .waiting])
        XCTAssertEqual(state.creatures.map(\.id), ["c"])
        XCTAssertEqual(AquariumResident.project(state).filter { $0.kind == "hermes" }.count, 2)
    }

    func testCanvasFallbackKeepsHermesSelectableAndReducedMotionStable() {
        let renderer = TerrariumRenderer()
        renderer.animateHermes = false
        var state = TerrariumState()
        state.hermesCreatures = [.init(id: "h", projectName: "Hermes", activity: .working)]
        renderer.update(dt: 0.05, state: state)
        XCTAssertEqual(renderer.creatureAtPoint(nx: 0.5, ny: 0.82 - 2.5/7), "h")
        XCTAssertTrue(SessionBrand.hasBrandMark(for: "hermes"))
        state.hermesCreatures = []
        renderer.update(dt: 0.05, state: state)
        XCTAssertNil(renderer.creatureAtPoint(nx: 0.5, ny: 0.82 - 2.5/7))
    }

    func testSwimIsBoundedSmoothAndDoesNotJumpOnStateChangesOrSleep() {
        let home: SIMD3<Float> = [0, 3, 0]
        var swim = HermesSwim(id: "h", position: home)
        var last = home
        var seen: [SIMD3<Float>] = []
        for i in 0..<7200 {
            let activity: HermesSwim.Activity = i < 1800 ? .idle : i < 3600 ? .working : i < 5400 ? .waiting : .idle
            swim.step(i == 3600 ? 600 : 1/60, home: home, size: 0.8,
                      activity: activity, neighbours: [[0.8,3,0]], aspect: 0.6)
            XCTAssertLessThan(simd_distance(last, swim.position), 0.033)
            XCTAssertLessThan(abs(swim.position.x), 1.8)
            XCTAssertTrue(swim.position.y.isFinite)
            XCTAssertGreaterThan(swim.position.y, 1.5)
            last = swim.position
            if i % 300 == 0 { seen.append(last) }
        }
        XCTAssertGreaterThan((seen.map(\.z).max() ?? 0) - (seen.map(\.z).min() ?? 0), 0.15)
        XCTAssertGreaterThan((seen.map(\.y).max() ?? 0) - (seen.map(\.y).min() ?? 0), 0.1)
        let frozen = swim.position
        swim.step(0, home: home, size: 1, activity: .working, neighbours: [], aspect: 1)
        XCTAssertEqual(swim.position, frozen)
    }

    func testWorkDrivesArticulationAndCompletionOnlyTriggersOnObservedTransition() {
        var swim = HermesSwim(id: "h", position: [0,3,0])
        for _ in 0..<120 { swim.step(1/60, home: [0,3,0], size: 1, activity: .idle, neighbours: [], aspect: 1.6) }
        XCTAssertEqual(swim.celebration, 0)
        for _ in 0..<120 { swim.step(1/60, home: [0,3,0], size: 1, activity: .working, neighbours: [], aspect: 1.6) }
        XCTAssertGreaterThan(swim.effort, 0.98)
        swim.step(1/60, home: [0,3,0], size: 1, activity: .idle, neighbours: [], aspect: 1.6)
        XCTAssertGreaterThan(swim.celebration, 0.9)
        for _ in 0..<240 { swim.step(1/60, home: [0,3,0], size: 1, activity: .idle, neighbours: [], aspect: 1.6) }
        XCTAssertEqual(swim.celebration, 0)
    }

    func testNeighbourGreetingIsCosmeticAndSettlesWhenWorking() {
        var swim = HermesSwim(id: "greeting", position: [0,3,0])
        var sawGreeting = false
        for _ in 0..<3600 {
            swim.step(1/60, home: [0,3,0], size: 0.8, activity: .idle, neighbours: [[0.9,3,0]], aspect: 1.6)
            sawGreeting = sawGreeting || swim.greeting > 0.5
        }
        XCTAssertTrue(sawGreeting)
        for _ in 0..<600 {
            swim.step(1/60, home: [0,3,0], size: 0.8, activity: .working, neighbours: [[0.9,3,0]], aspect: 1.6)
        }
        XCTAssertLessThan(swim.greeting, 0.01)
    }

    func testFrameRateIndependentTravelAndStableIndividualPhase() {
        func run(_ dt: Float) -> HermesSwim {
            var swim = HermesSwim(id: "h", position: [0,3,0])
            for _ in 0..<Int(12/dt) { swim.step(dt, home: [0,3,0], size: 0.8, activity: .working, neighbours: [], aspect: 1.6) }
            return swim
        }
        XCTAssertLessThan(simd_distance(run(1/30).position, run(1/120).position), 0.025)
        XCTAssertNotEqual(HermesSwim(id: "a", position: .zero).phase, HermesSwim(id: "b", position: .zero).phase)
    }

    @MainActor
    func testBundledModelArticulatesInRealScenePausesAndRemovesCleanly() async throws {
        let library = try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "hermes-mermaid", withExtension: "usdz")))
        let scene = AquariumResidents()
        scene.loadHermesTemplate(library)
        var state = TerrariumState()
        state.hermesCreatures = [.init(id: "h", projectName: "Hermes", activity: .working)]
        scene.sync(state, aspect: 1.6)
        let resident = try XCTUnwrap(scene.residents["h"])
        let tail = try XCTUnwrap(resident.findEntity(named: "hermes_tail"))
        let face = try XCTUnwrap(resident.findEntity(named: "face"))
        XCTAssertEqual(AquariumResidents.sessionID(for: face), "h")
        let body = try XCTUnwrap(resident.findEntity(named: "body"))
        let bounds = body.visualBounds(relativeTo: resident)
        XCTAssertGreaterThan(bounds.extents.y, 0.8)
        XCTAssertLessThan(bounds.extents.y, 1.2)
        XCTAssertLessThan(bounds.extents.z, bounds.extents.y * 0.6)
        let rest = tail.transform
        for _ in 0..<120 { scene.step(1/60) }
        XCTAssertNotEqual(tail.transform, rest)
        let position = resident.position
        scene.animate = false
        let frozen = tail.transform
        scene.step(600)
        XCTAssertEqual(tail.transform, frozen)
        XCTAssertEqual(resident.position, position)
        state.hermesCreatures = [.init(id: "h", projectName: "Hermes", activity: .waiting)]
        scene.sync(state, aspect: 1.6)
        XCTAssertEqual(resident.findEntity(named: "activity")?.isEnabled, false)
        let pausedPosition = resident.position
        scene.animate = true
        scene.step(1/60)
        XCTAssertLessThan(simd_distance(resident.position, pausedPosition), 0.02)
        state.hermesCreatures = []
        scene.sync(state, aspect: 1.6)
        XCTAssertTrue(scene.residents.isEmpty)
    }
}
#endif
