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


    func testExpressivePoseHasDelayedTailIndependentLimbsAndBoundedGaze() throws {
        var swim = HermesSwim(id: "portrait", position: [0,3,0])
        var blinkCount = 0
        var lastOpen: Float = 1
        for i in 0..<1800 {
            let activity: HermesSwim.Activity = i < 600 ? .working : i < 1200 ? .waiting : .error
            swim.step(1/60, home: [0,3,0], size: 0.8, activity: activity,
                      neighbours: [[0.9,3.2,0]], aspect: 1.6)
            let pose = swim.pose
            if lastOpen > 0.12 && pose.eyeLeft <= 0.12 { blinkCount += 1 }
            lastOpen = pose.eyeLeft
            XCTAssertTrue(pose.pupil.x.isFinite)
            XCTAssertLessThanOrEqual(abs(pose.pupil.x), 0.0061)
            XCTAssertGreaterThanOrEqual(pose.eyeLeft, 0)
            XCTAssertLessThanOrEqual(pose.eyeRight, 1)
            // Every pose must remain serializable: the review uses this exact contract.
            if i % 300 == 0 { XCTAssertNoThrow(try JSONEncoder().encode(pose)) }
        }
        XCTAssertGreaterThan(blinkCount, 3)
        XCTAssertGreaterThan(swim.pose.browRight, 0.1)
        XCTAssertLessThan(swim.pose.mouthCurve, 0)
        for _ in 0..<120 { swim.step(1/60, home: [0,3,0], size: 0.8, activity: .working, neighbours: [], aspect: 1.6) }
        let pose = swim.pose
        XCTAssertNotEqual(pose.tailBase.x, pose.tailMid.x)
        XCTAssertNotEqual(pose.tailMid.x, pose.tailTip.x)
        XCTAssertNotEqual(pose.wristLeft.x, pose.wristRight.x)
        for _ in 0..<180 { swim.step(1/60, home: [0,3,0], size: 0.8, activity: .waiting, neighbours: [], aspect: 1.6) }
        XCTAssertGreaterThan(abs(swim.pose.armLeft.z), abs(swim.pose.armRight.z) + 0.5)
    }

    @MainActor
    func testSkinAndFaceControlsAreIndependentAndPoseApplicationDoesNotAccumulate() async throws {
        let root = try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "hermes-mermaid", withExtension: "usdz")))
        let copy = root.clone(recursive: true)
        let rig = HermesMermaid.Rig(root), other = HermesMermaid.Rig(copy)
        XCTAssertTrue(rig.isComplete)
        let originalOther = try XCTUnwrap(other.skins.first).entity.jointTransforms
        var swim = HermesSwim(id: "rig", position: [0,3,0])
        for _ in 0..<120 { swim.step(1/60, home: [0,3,0], size: 1, activity: .waiting, neighbours: [], aspect: 1.6) }
        var pose = swim.pose
        pose.eyeLeft = 0; pose.eyeRight = 1
        pose.pupil = [0.004, -0.001]
        rig.apply(pose)
        let first = try XCTUnwrap(rig.skins.first).entity.jointTransforms
        for _ in 0..<20 { rig.apply(pose) }
        XCTAssertEqual(try XCTUnwrap(rig.skins.first).entity.jointTransforms, first)
        XCTAssertEqual(try XCTUnwrap(other.skins.first).entity.jointTransforms, originalOther)
        XCTAssertFalse(try XCTUnwrap(root.findEntity(named: "hermes_eye_left")).isEnabled)
        XCTAssertTrue(try XCTUnwrap(root.findEntity(named: "hermes_lid_left")).isEnabled)
        XCTAssertTrue(try XCTUnwrap(root.findEntity(named: "closed_lid_left")).isEnabled)
        XCTAssertTrue(try XCTUnwrap(root.findEntity(named: "hermes_eye_right")).isEnabled)
        XCTAssertFalse(try XCTUnwrap(root.findEntity(named: "hermes_lid_right")).isEnabled)
        XCTAssertEqual(try XCTUnwrap(root.findEntity(named: "hermes_pupil_right")).position.x, 0.004, accuracy: 0.0001)
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
        let rig = HermesMermaid.Rig(resident)
        XCTAssertTrue(rig.isComplete)
        let skin = try XCTUnwrap(rig.skins.first)
        let tailIndex = try XCTUnwrap(skin.names.firstIndex(of: "tail_mid"))
        let face = try XCTUnwrap(resident.findEntity(named: "face"))
        XCTAssertEqual(AquariumResidents.sessionID(for: face), "h")
        let body = try XCTUnwrap(resident.findEntity(named: "body"))
        let bounds = body.visualBounds(relativeTo: resident)
        XCTAssertGreaterThan(bounds.extents.y, 0.8)
        XCTAssertLessThan(bounds.extents.y, 1.3)
        // The swept-back tail now occupies real depth; still bound its footprint.
        XCTAssertLessThan(bounds.extents.z, bounds.extents.y * 0.75)
        let rest = skin.entity.jointTransforms[tailIndex]
        for _ in 0..<120 { scene.step(1/60) }
        XCTAssertNotEqual(skin.entity.jointTransforms[tailIndex], rest)
        let position = resident.position
        scene.animate = false
        let frozen = skin.entity.jointTransforms[tailIndex]
        scene.step(600)
        XCTAssertEqual(skin.entity.jointTransforms[tailIndex], frozen)
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
