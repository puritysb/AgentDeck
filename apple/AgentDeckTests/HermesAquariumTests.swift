#if os(macOS)
import XCTest
import RealityKit
@testable import AgentDeck

final class HermesAquariumTests: XCTestCase {
    @MainActor
    func testIdleRestsOnFixedShellAndReturnsAfterWork() async throws {
        let library = try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "hermes-mermaid", withExtension: "usdz")))
        let scene = AquariumResidents()
        scene.loadHermesTemplate(library)
        var state = TerrariumState()
        state.hermesCreatures = [.init(id: "rest", projectName: "Hermes", activity: .idle)]
        scene.sync(state, aspect: 1.6)
        let resident = try XCTUnwrap(scene.residents["rest"])
        let shell = try XCTUnwrap(scene.root.findEntity(named: "hermes-shell"))
        XCTAssertNotNil(shell.findEntity(named: "shell-seat") as? ModelEntity)
        XCTAssertNotNil(shell.findEntity(named: "shell-lid") as? ModelEntity)
        let home = resident.position, support = shell.transformMatrix(relativeTo: nil)
        let body = try XCTUnwrap(resident.findEntity(named: "body"))
        XCTAssertGreaterThanOrEqual(body.visualBounds(relativeTo: scene.root).min.y,
                                    shell.position(relativeTo: scene.root).y,
                                    "The imported tail must stay above the substrate, not sink into it")
        for _ in 0..<600 { scene.step(1/60) }
        XCTAssertEqual(resident.position, home, "Idle must not drift away from the shell")
        state.hermesCreatures = [.init(id: "rest", projectName: "Hermes", activity: .working)]
        scene.sync(state, aspect: 1.6)
        for _ in 0..<600 { scene.step(1/60) }
        XCTAssertGreaterThan(resident.position.y, home.y + 0.25)
        XCTAssertEqual(shell.transformMatrix(relativeTo: nil), support)
        state.hermesCreatures = [.init(id: "rest", projectName: "Hermes", activity: .idle)]
        scene.sync(state, aspect: 1.6)
        XCTAssertFalse(try XCTUnwrap(resident.findEntity(named: "activity")).isEnabled)
        for _ in 0..<1200 { scene.step(1/60) }
        XCTAssertEqual(resident.position, home)
        XCTAssertEqual(shell.transformMatrix(relativeTo: nil), support)
        state.hermesCreatures = []
        scene.sync(state, aspect: 1.6)
        XCTAssertNil(scene.root.findEntity(named: "hermes-shell"))
    }

    func testDisconnectedDashboardCannotAnimateCachedWorkingResidents() {
        var dashboard = DashboardState()
        dashboard.state = .processing
        dashboard.agentType = "hermes"; dashboard.sessionId = "h"
        dashboard.siblingSessions = [SessionInfo(id: "h", port: 0, projectName: "Hermes", agentType: "hermes", state: "processing")]
        let working = dashboard.toTerrariumState(activityAvailable: true)
        XCTAssertEqual(working.hermesCreatures.first?.activity, .working)
        let offline = dashboard.toTerrariumState(previous: working, activityAvailable: false)
        XCTAssertTrue(AquariumResident.project(offline).isEmpty)
        XCTAssertEqual(dashboard.siblingSessions.first?.state, "processing", "History is preserved, not relabeled as completion")
        dashboard.state = .idle
        dashboard.siblingSessions[0].state = "idle"
        XCTAssertEqual(dashboard.toTerrariumState(previous: offline, activityAvailable: true).hermesCreatures.first?.activity, .idle)
    }

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
        // Waiting is shown with the laptop she holds: she turns it round to the
        // viewer and its amber screen comes on. (A raised arm went up behind
        // the laptop and her hair and never read on screen.)
        for _ in 0..<180 { swim.step(1/60, home: [0,3,0], size: 0.8, activity: .waiting, neighbours: [], aspect: 1.6) }
        XCTAssertGreaterThan(swim.pose.laptopTurn, 0.9)
        XCTAssertGreaterThan(swim.pose.laptopAlert, 0.5)
        // Error: the lid sags shut; idle: screen toward her, no alert.
        for _ in 0..<180 { swim.step(1/60, home: [0,3,0], size: 0.8, activity: .error, neighbours: [], aspect: 1.6) }
        XCTAssertLessThan(swim.pose.laptopLid, -0.6)
        XCTAssertEqual(swim.pose.laptopAlert, 0)
        for _ in 0..<300 { swim.step(1/60, home: [0,3,0], size: 0.8, activity: .idle, neighbours: [], aspect: 1.6) }
        XCTAssertLessThan(swim.pose.laptopTurn, 0.05)
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

    @MainActor
    func testPausedHermesStopsTypingWhenTheTurnBecomesIdle() async throws {
        let library = try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "hermes-mermaid", withExtension: "usdz")))
        let scene = AquariumResidents()
        scene.loadHermesTemplate(library)
        scene.animate = false
        var state = TerrariumState()
        state.hermesCreatures = [.init(id: "h", projectName: "Hermes", activity: .idle)]
        scene.sync(state, aspect: 1.6)
        let resident = try XCTUnwrap(scene.residents["h"])
        let rig = HermesMermaid.Rig(resident)
        let skin = try XCTUnwrap(rig.skins.first)
        let wrist = try XCTUnwrap(skin.names.firstIndex(of: "wrist_left"))
        let idle = skin.entity.jointTransforms[wrist]
        scene.animate = true
        state.hermesCreatures = [.init(id: "h", projectName: "Hermes", activity: .working)]
        scene.sync(state, aspect: 1.6)
        for _ in 0..<120 { scene.step(1/60) }
        XCTAssertNotEqual(skin.entity.jointTransforms[wrist], idle)
        scene.animate = false
        state.hermesCreatures = [.init(id: "h", projectName: "Hermes", activity: .idle)]
        scene.sync(state, aspect: 1.6)
        XCTAssertEqual(skin.entity.jointTransforms[wrist], idle)
        let frozen = skin.entity.jointTransforms[wrist]
        scene.step(600)
        XCTAssertEqual(skin.entity.jointTransforms[wrist], frozen)
        XCTAssertEqual(resident.findEntity(named: "activity")?.isEnabled, false)
    }
    @MainActor
    func testWaitingTurnsTheLaptopInPlaceAndShowsTheAlert() async throws {
        let library = try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "hermes-mermaid", withExtension: "usdz")))
        let root = try XCTUnwrap(library.findEntity(named: "resident_hermes")).clone(recursive: true)
        let rig = HermesMermaid.Rig(root)
        let laptop = try XCTUnwrap(root.findEntity(named: "laptop"))
        // USD writes a mesh as an Xform and a Mesh prim of the same name; the
        // rig toggles the innermost one, which is what draws
        var alert = try XCTUnwrap(root.findEntity(named: "laptop_screen_alert"))
        while let inner = alert.children.first(where: { $0.name == alert.name }) { alert = inner }
        let parent = try XCTUnwrap(laptop.parent)
        XCTAssertFalse(alert.isEnabled)
        let centre = laptop.visualBounds(relativeTo: parent).center
        var swim = HermesSwim(id: "w", position: [0, 3, 0])
        for _ in 0..<240 { swim.step(1/60, home: [0, 3, 0], size: 0.8, activity: .waiting, neighbours: [], aspect: 1.6) }
        rig.pose(swim)
        XCTAssertTrue(alert.isEnabled)
        // turned about its own centre: it stays in her hands, not swung behind her
        XCTAssertLessThan(simd_distance(laptop.visualBounds(relativeTo: parent).center, centre), 0.02)
        for _ in 0..<300 { swim.step(1/60, home: [0, 3, 0], size: 0.8, activity: .idle, neighbours: [], aspect: 1.6) }
        rig.pose(swim)
        XCTAssertFalse(alert.isEnabled)
    }
    @MainActor
    func testAquariumAssetLifecycleIgnoresCancellationRetriesAndRejectsStaleCompletions() async throws {
        let loader = AquariumAssetLoader()
        await loader.load { _ in throw CancellationError() }
        XCTAssertNil(loader.failure)
        XCTAssertNil(loader.loaded)
        await loader.load { _ in throw CocoaError(.fileReadCorruptFile) }
        XCTAssertNotNil(loader.failure, "Actual import errors remain visible")
        var gate: CheckedContinuation<Entity, Error>?
        let obsolete = Task { await loader.load { _ in try await withCheckedThrowingContinuation { gate = $0 } } }
        while gate == nil { await Task.yield() }
        loader.invalidate()
        await loader.load { _ in Entity() }
        let current = try XCTUnwrap(loader.loaded?.habitat)
        gate?.resume(throwing: CocoaError(.fileReadCorruptFile))
        await obsolete.value
        XCTAssertTrue(loader.loaded?.habitat === current)
        XCTAssertNil(loader.failure, "An obsolete load cannot replace a newer successful scene")
    }

    @MainActor
    func testAquariumAssetLoaderImportsEveryBundledNativeResource() async throws {
        let loader = AquariumAssetLoader()
        await loader.load()
        XCTAssertNil(loader.failure)
        let loaded = try XCTUnwrap(loader.loaded)
        XCTAssertFalse(loaded.habitat.visualBounds(relativeTo: nil).isEmpty)
        XCTAssertFalse(loaded.ciCompanion.visualBounds(relativeTo: nil).isEmpty)
        let artwork = try XCTUnwrap(loaded.ciCompanion.findEntity(named: "Original_Octocat_alpha_silhouette") as? ModelEntity)
        let materials = try XCTUnwrap(artwork.model?.materials)
        XCTAssertTrue(materials.contains {
            ($0 as? PhysicallyBasedMaterial)?.emissiveColor.texture != nil
        }, "Original Octocat pixels must survive USD export and RealityKit import")
        let scene = AquariumResidents()
        scene.loadTemplates(loaded.residents)
        scene.loadHermesTemplate(loaded.hermes)
        XCTAssertEqual(scene.templateCount, 7)
    }

}
#endif
