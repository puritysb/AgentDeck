#if os(macOS)
import XCTest
import RealityKit
@testable import AgentDeck

/// Verify the render-time Codex creature fold introduced to suppress phantom
/// Cloud creatures when Claude Code's rescue/stop-gate workflow spawns a fresh
/// codex thread per turn. Without folding the same workspace lights up 4-5
/// simultaneous Cloud sprites; the fold collapses them to one creature per
/// `(agentType=codex-cli, projectName)` group.
final class TerrariumCloudFoldTests: XCTestCase {

    func testCrowdedForegroundKeepsFocusAndWaitingSessionsWithoutProjectMerging() {
        let items = (0..<48).map {
            AquariumResident(id: "session-\($0)", kind: "codex", title: "Same project",
                             activity: $0 == 20 ? .waiting : .idle)
        }
        let visible = AquariumResident.foreground(items, focusedID: "session-47")
        XCTAssertEqual(visible.count, TerrariumRules.nativeResidentLimit)
        XCTAssertEqual(visible.first?.id, "session-47")
        XCTAssertEqual(visible[1].id, "session-20")
        XCTAssertEqual(visible, AquariumResident.foreground(items.reversed(), focusedID: "session-47"))
        XCTAssertEqual(items.count, 48)
    }

    @MainActor
    func testEveryNativeKindShowsWorkingCueAndClearsItWhilePaused() async throws {
        let scene = AquariumResidents()
        scene.loadTemplates(try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "3d-residents", withExtension: "usdz"))))
        var state = TerrariumState()
        state.creatures = [.init(id: "claude", projectName: "Claude", modelName: nil, state: .working, homeX: 0, homeY: 0, scale: 1)]
        state.cloudCreatures = [.init(id: "codex", projectName: "Codex", modelName: nil, state: .pulsing, homeX: 0, homeY: 0, scale: 1)]
        state.opencodeCreatures = [.init(id: "opencode", projectName: "OpenCode", modelName: nil, state: .pulsing, homeX: 0, homeY: 0, scale: 1)]
        state.antigravityCreatures = [.init(id: "antigravity", projectName: "Antigravity", modelName: nil, state: .working, homeX: 0, homeY: 0, scale: 1)]
        state.kiroCreatures = [.init(id: "kiro", projectName: "Kiro", modelName: nil, state: .working, homeX: 0, homeY: 0, scale: 1)]
        state.crayfishVisible = true
        state.crayfishState = .routing
        scene.sync(state, aspect: 1.6)
        XCTAssertEqual(scene.residents.count, 6)
        for resident in scene.residents.values {
            XCTAssertEqual(resident.findEntity(named: "activity")?.isEnabled, true)
            XCTAssertNotNil(resident.findEntity(named: "working-badge"))
        }
        let resident = try XCTUnwrap(scene.residents["claude"])
        let indicator = try XCTUnwrap(resident.findEntity(named: "activity"))
        let bar = try XCTUnwrap(indicator.children.first)
        let initial = bar.transform
        scene.step(0.05)
        XCTAssertNotEqual(bar.transform, initial)
        scene.labelsVisible = false
        XCTAssertTrue(indicator.isEnabled, "Viewing mode retains the activity cue")
        scene.animate = false
        let frozen = bar.transform
        scene.step(1)
        XCTAssertEqual(bar.transform, frozen)
        // A live state change must clear work cues without waiting for an animation tick.
        state.creatures = [.init(id: "claude", projectName: "Claude", modelName: nil, state: .asking, homeX: 0, homeY: 0, scale: 1)]
        state.cloudCreatures = []
        state.opencodeCreatures = []
        state.antigravityCreatures = []
        state.kiroCreatures = []
        state.crayfishVisible = false
        scene.sync(state, aspect: 1.6)
        XCTAssertFalse(indicator.isEnabled)
        XCTAssertNil(resident.findEntity(named: "working-badge"))
        XCTAssertEqual(scene.residents.count, 1)
        scene.sync(TerrariumState(), aspect: 1.6)
        XCTAssertTrue(scene.residents.isEmpty)
    }

    @MainActor
    func testNativeResidentAssetsAndLiveReconciliation() async throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "3d-residents", withExtension: "usdz"))
        let library = try await Entity(contentsOf: url)
        for kind in ["claudecode", "codex", "openclaw", "opencode", "antigravity", "kiro"] {
            let template = try XCTUnwrap(library.findEntity(named: "resident_" + kind))
            let extent = template.visualBounds(relativeTo: nil).extents
            XCTAssertGreaterThan(extent.x, 0.3, kind)
            XCTAssertGreaterThan(extent.y, 0.3, kind)
            XCTAssertGreaterThan(extent.z, 0.1, "Real depth, not a textured plane: " + kind)
            XCTAssertLessThan(max(extent.x, extent.y, extent.z), 1.5, "SVG import units/radii: " + kind)
        }
        let scene = AquariumResidents()
        XCTAssertEqual(scene.templateCount, 0)
        var state = DashboardState()
        state.state = .idle
        state.siblingSessions = [session(id: "native", project: "Project", state: "awaiting_permission")]
        var habitat = state.toTerrariumState()
        habitat.focusedSessionId = "native"
        habitat.cloudCreatures[0].subagentActivity.activeCount = 2
        scene.sync(habitat, aspect: 1.6)
        XCTAssertTrue(scene.residents.isEmpty)
        scene.loadTemplates(library)
        XCTAssertEqual(scene.templateCount, 6)
        scene.sync(habitat, aspect: 1.6)
        let resident = try XCTUnwrap(scene.residents["native"])
        XCTAssertNotNil(resident.findEntity(named: "label"), "Loading templates after state must still create labels")
        XCTAssertEqual(AquariumResident.project(habitat).first?.activity, .waiting)
        XCTAssertEqual(AquariumResident.project(habitat).first?.helpers, 2)
        XCTAssertEqual(AquariumResidents.sessionID(for: try XCTUnwrap(resident.findEntity(named: "body"))), "native")
        XCTAssertEqual(resident.findEntity(named: "focus")?.isEnabled, true)
        let body = try XCTUnwrap(resident.findEntity(named: "body"))
        let bodyBounds = body.visualBounds(relativeTo: resident).extents
        let sourceBounds = try XCTUnwrap(library.findEntity(named: "resident_codex")).visualBounds(relativeTo: nil).extents
        XCTAssertEqual(bodyBounds.y, sourceBounds.y, accuracy: 0.001, "Cloned residents must retain USD axis conversion")
        scene.animate = false
        let position = resident.position
        scene.step(1)
        XCTAssertEqual(resident.position, position, "Reduce Motion/scene pause must freeze swimming")
        state.siblingSessions.append(session(id: "aaa-new", project: "New"))
        let expanded = state.toTerrariumState()
        scene.sync(expanded, aspect: 1.6)
        let retainedSlot = resident.position
        scene.sync(expanded, aspect: 1.6)
        XCTAssertEqual(resident.position, retainedSlot, "Repeated state snapshots must not reorder retained residents")
        scene.sync(TerrariumState(), aspect: 1.6)
        XCTAssertTrue(scene.residents.isEmpty, "Departed sessions must remove their 3D entities")
    }

    @MainActor
    func testNativeCrowdHasProjectionClearanceAndDepth() {
        for count in [1, 4, 8, 12, 24, 48] {
            for aspect: Float in [0.6, 1.0, 1.8] {
                let bottom = AquariumResidents.bottomLayout(count: count, aspect: aspect)
                XCTAssertEqual(bottom.positions.count, count)
                for p in bottom.positions {
                    XCTAssertLessThanOrEqual(p.y, 2.46, "Dense substrate must not grow out of the scene")
                    XCTAssertGreaterThanOrEqual(p.z, -3.01)
                }
                let layout = AquariumResidents.layout(count: count, aspect: aspect)
                XCTAssertEqual(layout.positions.count, count)
                let projected = layout.positions.map { p -> SIMD2<Float> in
                    let factor = 13 / (14 - p.z)
                    return [p.x * factor, 4.8 + (p.y - 4.8) * factor]
                }
                for i in projected.indices {
                    for j in projected.indices where j > i {
                        let gap = abs(projected[i] - projected[j])
                        // 1.9-wide labels and bounded sway must fit in each slot.
                        XCTAssertTrue(gap.x > layout.size * 2.05 || gap.y > layout.size * 1.7,
                                      "Projected overlap at count \(count), aspect \(aspect)")
                    }
                }
                if count > 1 { XCTAssertGreaterThan(Set(layout.positions.map(\.z)).count, 1) }
            }
        }
    }

    @MainActor
    func testHabitatFinsHaveVolumeAndHingesAndIncludesBottomFauna() async throws {
        let habitat = try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "living-aquarium", withExtension: "usdz")))
        func nodes(_ node: Entity) -> [Entity] { [node] + node.children.flatMap { nodes($0) } }
        let all = nodes(habitat)
        let tails = all.filter { $0.name.lowercased().contains("caudal") && $0 is ModelEntity }
        XCTAssertGreaterThanOrEqual(tails.count, 7)
        for tail in tails {
            let extent = tail.visualBounds(relativeTo: tail).extents
            XCTAssertGreaterThan(min(extent.x, extent.y, extent.z), 0.02, "A flat membrane disappears edge-on")
            var fish = tail.parent
            while let node = fish, !node.name.lowercased().replacingOccurrences(of: "_", with: " ").hasPrefix("fish yaw") { fish = node.parent }
            let owner = try XCTUnwrap(fish)
            XCTAssertLessThan(tail.position(relativeTo: owner).x, -0.5, "The tail must pivot at the peduncle, not the body center")
        }
        let names = all.map { $0.name.replacingOccurrences(of: "_", with: " ").lowercased() }
        XCTAssertEqual(names.filter { $0 == "fauna snail" }.count, 1)
        XCTAssertEqual(names.filter { $0.hasPrefix("fauna shrimp ") }.count, 0, "Rejected shrimp must not return in generated assets")
        XCTAssertFalse(habitat.availableAnimations.isEmpty, "Foraging and feeler motion must survive USD export")
    }

    @MainActor
    func testSmallSnailTraversesFrontAndHiddenRearGroundWithoutLoopJump() async throws {
        let habitat = try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "living-aquarium", withExtension: "usdz")))
        let shoal = AquariumShoal()
        shoal.load(habitat)
        let snail = try XCTUnwrap(shoal.snail)
        XCTAssertEqual(snail.children.first?.scale.x ?? 0, 0.6, accuracy: 0.01)
        var front = false, rear = false, left = false, right = false
        for second in 0..<3600 {
            let t = Double(second) / 10
            let p = AquariumShoal.snailPosition(at: t)
            let next = AquariumShoal.snailPosition(at: t + 0.1)
            XCTAssertLessThan(simd_distance(p, next), 0.025, "Slow continuous ground motion, including the loop seam")
            XCTAssertGreaterThanOrEqual(p.y, -0.093)
            XCTAssertLessThan(abs(p.x), 6.2)
            front = front || p.z > 2; rear = rear || p.z < -3
            left = left || p.x < -4; right = right || p.x > 4
        }
        XCTAssertTrue(front && rear && left && right)
        XCTAssertLessThan(simd_distance(AquariumShoal.snailPosition(at: 0), AquariumShoal.snailPosition(at: 360)), 0.0001)
        let before = snail.position
        for _ in 0..<120 { shoal.step(1.0 / 60, residents: []) }
        let forward = snail.orientation.act(SIMD3<Float>(1,0,0))
        XCTAssertGreaterThan(simd_dot(snail.position - before, forward), 0)
        XCTAssertEqual(shoal.root.children.filter { $0.name == "wandering-snail" }.count, 1)
    }

    @MainActor
    func testNativeShoalReactsAndStaysBounded() async throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "living-aquarium", withExtension: "usdz"))
        let habitat = try await Entity(contentsOf: url)
        let calm = AquariumShoal(), disturbed = AquariumShoal()
        calm.load(habitat)
        disturbed.load(try await Entity(contentsOf: url))
        XCTAssertEqual(calm.positions.count, 14, "Imported fish must be found, not silently removed")
        let obstacle = calm.positions[0] + SIMD3<Float>(0.20, 0, 0)
        for _ in 0..<180 {
            calm.step(1.0 / 60, residents: [])
            disturbed.step(1.0 / 60, residents: [obstacle])
        }
        XCTAssertGreaterThan(simd_distance(calm.positions[0], disturbed.positions[0]), 0.15)
        for _ in 0..<7200 { disturbed.step(1.0 / 60, residents: [obstacle]) }
        for (position, velocity) in zip(disturbed.positions, disturbed.velocities) {
            XCTAssertLessThan(abs(position.x), 5.5)
            XCTAssertLessThan(abs(position.z), 3.7)
            XCTAssertGreaterThan(position.y, 0.5)
            XCTAssertLessThan(position.y, 4.5)
            XCTAssertGreaterThan(simd_length(velocity), 0.30, "Fish must cruise, not stall at force equilibrium")
            XCTAssertLessThan(simd_length(velocity), 0.81)
        }
    }

    @MainActor
    func testWorkStrokeStartlesSchoolAndSettlesAfterWorkStops() async throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "living-aquarium", withExtension: "usdz"))
        let calm = AquariumShoal(), working = AquariumShoal()
        calm.load(try await Entity(contentsOf: url))
        working.load(try await Entity(contentsOf: url))
        // Same resident position in both scenes: only its work stroke differs.
        let resident = calm.positions[0] + SIMD3<Float>(-0.5, -1.2, 0)
        for _ in 0..<45 {
            calm.step(1.0 / 60, residents: [resident])
            working.step(1.0 / 60, residents: [resident], wakes: [.init(position: resident, strength: 1, radius: 2.4)])
        }
        XCTAssertGreaterThan(working.alertness.max() ?? 0, 0.25)
        XCTAssertGreaterThan(simd_distance(calm.positions[0], working.positions[0]), 0.15)
        XCTAssertGreaterThan(simd_length(working.velocities[0]), simd_length(calm.velocities[0]) + 0.1)
        for _ in 0..<600 { working.step(1.0 / 60, residents: [resident]) }
        XCTAssertLessThan(working.alertness.max() ?? 1, 0.001)
        for velocity in working.velocities { XCTAssertLessThan(simd_length(velocity), 0.81) }
        // Repeated strokes, including from below the school, stay inside the tank.
        for frame in 0..<3600 {
            let strength = pow(max(0, sin(Float(frame) / 60 * 2.35)), 6)
            working.step(1.0 / 60, residents: [resident], wakes: [.init(position: resident, strength: strength, radius: 2.4)])
            for position in working.positions {
                XCTAssertLessThan(abs(position.x), 5.5)
                XCTAssertLessThan(abs(position.z), 3.7)
                XCTAssertGreaterThan(position.y, 0.5)
                XCTAssertLessThan(position.y, 4.5)
            }
        }
    }

    @MainActor
    func testWorkingResidentsDriveSchoolAndPauseTogether() async throws {
        let scene = AquariumResidents()
        scene.loadTemplates(try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "3d-residents", withExtension: "usdz"))))
        scene.shoal.load(try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "living-aquarium", withExtension: "usdz"))))
        var dashboard = DashboardState()
        dashboard.state = .idle
        dashboard.siblingSessions = [session(id: "working", project: "Work", agentType: "codex-cli")]
        scene.sync(dashboard.toTerrariumState(), aspect: 1.6)
        let body = try XCTUnwrap(scene.residents["working"]?.findEntity(named: "body"))
        var peakAlarm: Float = 0
        var minScale: Float = 1, maxScale: Float = 1
        for _ in 0..<600 {
            scene.step(1.0 / 60)
            peakAlarm = max(peakAlarm, scene.shoal.alertness.max() ?? 0)
            minScale = min(minScale, body.scale.x)
            maxScale = max(maxScale, body.scale.x)
        }
        XCTAssertGreaterThan(peakAlarm, 0.15, "Live working state must reach fish, not just a test-only wake")
        XCTAssertGreaterThan(maxScale - minScale, 0.1, "Working silhouette must visibly compress and release")
        scene.animate = false
        let positions = scene.shoal.positions
        let pose = body.transform
        scene.step(1)
        XCTAssertEqual(scene.shoal.positions, positions)
        XCTAssertEqual(body.transform, pose)
    }

    @MainActor
    func testNativeStateTransitionArticulatesWithoutJumping() async throws {
        let library = try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "3d-residents", withExtension: "usdz")))
        let scene = AquariumResidents()
        scene.loadTemplates(library)
        var dashboard = DashboardState()
        dashboard.state = .idle
        dashboard.siblingSessions = [session(id: "motion", project: "Motion", agentType: "claude-code")]
        scene.sync(dashboard.toTerrariumState(), aspect: 1.6)
        let resident = try XCTUnwrap(scene.residents["motion"])
        let arm = try XCTUnwrap(resident.findEntity(named: "joint_arm_0"))
        for _ in 0..<120 { scene.step(1.0 / 60) }
        let workingPose = arm.orientation
        let previousPosition = resident.position
        dashboard.siblingSessions = [session(id: "motion", project: "Motion", state: "awaiting_permission", agentType: "claude-code")]
        scene.sync(dashboard.toTerrariumState(), aspect: 1.6)
        scene.step(1.0 / 60)
        XCTAssertLessThan(simd_distance(resident.position, previousPosition), 0.02)
        XCTAssertLessThan(abs((workingPose.inverse * arm.orientation).angle), 0.10)
        for _ in 0..<180 { scene.step(1.0 / 60) }
        XCTAssertGreaterThan(abs((workingPose.inverse * arm.orientation).angle), 0.15)
        scene.animate = false
        let stopped = arm.orientation
        scene.step(1)
        XCTAssertEqual(arm.orientation, stopped)
    }

    @MainActor
    func testBottomDwellersRemainPlantedInsteadOfBobbing() async throws {
        let library = try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "3d-residents", withExtension: "usdz")))
        let scene = AquariumResidents()
        scene.loadTemplates(library)
        var dashboard = DashboardState()
        dashboard.state = .idle
        dashboard.siblingSessions = [session(id: "walker", project: "Walker", state: "idle", agentType: "claude-code")]
        scene.sync(dashboard.toTerrariumState(), aspect: 1.6)
        let resident = try XCTUnwrap(scene.residents["walker"])
        let support = try XCTUnwrap(scene.root.findEntity(named: "substrate|walker"))
        let body = try XCTUnwrap(resident.findEntity(named: "body"))
        let initialY = resident.position.y
        let supportPosition = support.position
        let surface = support.visualBounds(relativeTo: scene.root).max.y
        for _ in 0..<180 {
            scene.step(1.0 / 60)
            XCTAssertEqual(resident.position.y, initialY, accuracy: 0.0001)
            XCTAssertEqual(body.visualBounds(relativeTo: scene.root).min.y, surface, accuracy: 0.015)
        }
        dashboard.siblingSessions = [session(id: "walker", project: "Walker", state: "processing", agentType: "claude-code")]
        scene.sync(dashboard.toTerrariumState(), aspect: 1.6)
        for _ in 0..<360 {
            scene.step(1.0 / 60)
            XCTAssertEqual(resident.position.y, initialY, accuracy: 0.0001)
            // Original pixel feet alternate contact; no new legs replace them.
            XCTAssertEqual(body.visualBounds(relativeTo: scene.root).min.y, surface, accuracy: 0.025)
            XCTAssertEqual(support.position, supportPosition)
        }
        scene.sync(TerrariumState(), aspect: 1.6)
        XCTAssertNil(scene.root.findEntity(named: "substrate|walker"))
    }

    @MainActor
    func testCanonicalCloudMovesWithoutInventedFinsOrVerticalHoverLoop() async throws {
        let library = try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "3d-residents", withExtension: "usdz")))
        let scene = AquariumResidents()
        scene.loadTemplates(library)
        var dashboard = DashboardState()
        dashboard.state = .idle
        dashboard.siblingSessions = [session(id: "swimmer", project: "Swimmer")]
        scene.sync(dashboard.toTerrariumState(), aspect: 1.6)
        let resident = try XCTUnwrap(scene.residents["swimmer"])
        let fin = try XCTUnwrap(resident.findEntity(named: "body"))
        XCTAssertNil(resident.findEntity(named: "joint_fin_0"))
        XCTAssertNil(resident.findEntity(named: "joint_tentacle_0"))
        let initialY = resident.position.y
        let initialFin = fin.orientation
        for _ in 0..<90 { scene.step(1.0 / 60) }
        XCTAssertEqual(resident.position.y, initialY, accuracy: 0.0001)
        XCTAssertGreaterThan(abs((initialFin.inverse * fin.orientation).angle), 0.03)
        XCTAssertNil(scene.root.findEntity(named: "substrate|swimmer"))
    }

    @MainActor
    func testCanonicalCharactersHaveNoReplacementAnatomy() async throws {
        let library = try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "3d-residents", withExtension: "usdz")))
        func names(_ node: Entity) -> [String] { [node.name] + node.children.flatMap { names($0) } }
        let allNames = names(library)
        for forbidden in ["canonical_badge", "eye_socket", "tentacle", "cloud_lobe", "dorsal", "back_segment", "underside", "joint_fin"] {
            XCTAssertFalse(allNames.contains { $0.contains(forbidden) }, "Do not replace original character anatomy: " + forbidden)
        }
        let claude = try XCTUnwrap(library.findEntity(named: "resident_claudecode"))
        let bounds = claude.visualBounds(relativeTo: nil).extents
        XCTAssertGreaterThan(bounds.x / bounds.y, 1.5, "Retain the original wide pixel silhouette")
        XCTAssertEqual(names(claude).filter { $0.hasPrefix("joint_foot_") }.count, 4)
        for side in 0...1 {
            let arm = try XCTUnwrap(claude.findEntity(named: "joint_arm_\(side)"))
            let span = arm.visualBounds(relativeTo: arm).extents
            XCTAssertLessThan(max(span.x, span.y, span.z), 0.30,
                "An arm hinge must not rotate a full-height side of Claude's torso")
        }
        let flanks = claude.children.filter { $0.name.hasPrefix("claudecode_canonical_flank_") }
        XCTAssertEqual(flanks.count, 4)
        for flank in flanks {
            XCTAssertLessThan(flank.visualBounds(relativeTo: flank).extents.x, 0.015,
                "Fixed torso bevels must not retain thin shelves above or below the moving arms")
        }
        XCTAssertNotNil(library.findEntity(named: "joint_claw_0"))
        XCTAssertNotNil(library.findEntity(named: "joint_claw_1"))
    }

    func testNativeProjectionDoesNotInventAbsentGateway() {
        var state = TerrariumState()
        state.crayfishState = .routing
        XCTAssertTrue(AquariumResident.project(state).isEmpty)
        state.crayfishVisible = true
        state.crayfishState = .sick
        XCTAssertEqual(AquariumResident.project(state).first?.activity, .error)
        XCTAssertEqual(AquariumResident.project(state).first?.id, "crayfish")
    }

    func testThreeProcessingCloudsKeepSeparateSwimmingLanes() {
        var state = DashboardState()
        state.state = .idle
        state.siblingSessions = (0..<3).map { session(id: "cloud-\($0)", project: "Project \($0)") }
        let habitat = state.toTerrariumState()
        let clouds = habitat.cloudCreatures.sorted { $0.homeX < $1.homeX }.map {
            CloudCreature(sessionId: $0.id, homeX: $0.homeX, homeY: $0.homeY, scale: $0.scale)
        }
        XCTAssertEqual(clouds.count, 3)
        for _ in 0..<3600 {
            for cloud in clouds { cloud.update(dt: 1.0 / 60, state: habitat) }
            for i in 1..<clouds.count {
                let gap = clouds[i].currentPosition().x - clouds[i - 1].currentPosition().x
                let radii = 0.060 * 1.28 * 1.03 * (clouds[i].scale + clouds[i - 1].scale) / 2
                XCTAssertGreaterThan(gap, radii, "Independent drift must not overlap adjacent marks")
            }
        }
    }

    private func session(
        id: String,
        project: String?,
        state: String = "processing",
        startedAt: String? = nil,
        agentType: String = "codex-cli"
    ) -> SessionInfo {
        SessionInfo(
            id: id,
            port: 9120,
            projectName: project,
            agentType: agentType,
            alive: true,
            state: state,
            modelName: nil,
            effortLevel: nil,
            startedAt: startedAt
        )
    }

    /// Five back-to-back Codex Companion Tasks in the same workspace must
    /// collapse to a single Cloud sprite, with `groupSize == 5` so the
    /// renderer can optionally surface the count.
    func testFiveCompanionTasksInOneProjectFoldToOneSprite() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.siblingSessions = (1...5).map { i in
            session(
                id: "codex:thread-\(i)",
                project: "AgentDeck",
                state: i == 5 ? "processing" : "idle",
                startedAt: "2026-04-30T00:00:0\(i)Z"
            )
        }

        let terrarium = state.toTerrariumState()

        XCTAssertEqual(terrarium.cloudCreatures.count, 1, "Five threads sharing project=AgentDeck must fold to a single sprite")
        let creature = terrarium.cloudCreatures[0]
        XCTAssertEqual(creature.groupSize, 5, "groupSize should reflect the underlying thread count")
        // The most-recent thread is the focus-relay representative.
        XCTAssertEqual(creature.id, "codex:thread-5")
        XCTAssertEqual(creature.projectName, "AgentDeck")
        // Aggregate state = highest-priority member.
        XCTAssertEqual(creature.state, .pulsing, "Any group member processing → group is processing")
    }

    /// Codex sessions in distinct projects must NOT collapse — fold is
    /// scoped to projectName (mental model: "one Codex working in this
    /// workspace").
    func testDistinctProjectsRenderSeparateSprites() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.siblingSessions = [
            session(id: "codex:a", project: "AgentDeck", state: "processing"),
            session(id: "codex:b", project: "ViewTrans", state: "idle"),
            session(id: "codex:c", project: "OpenClaw", state: "awaiting_permission"),
        ]

        let terrarium = state.toTerrariumState()

        XCTAssertEqual(terrarium.cloudCreatures.count, 3)
        XCTAssertEqual(Set(terrarium.cloudCreatures.compactMap { $0.projectName }), ["AgentDeck", "ViewTrans", "OpenClaw"])
        for c in terrarium.cloudCreatures {
            XCTAssertEqual(c.groupSize, 1, "Singleton groups have groupSize 1")
        }
    }

    /// Codex App OTel and Codex CLI hooks may report the same workspace at
    /// the same time. They must remain two visible Codex creatures instead
    /// of folding solely by projectName.
    func testCodexAppAndCliInSameProjectRenderSeparateSprites() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.siblingSessions = [
            session(id: "codex:cli", project: "AgentDeck", state: "processing", agentType: "codex-cli"),
            session(id: "codex:app-1", project: "AgentDeck", state: "processing", startedAt: "2026-04-30T00:00:01Z", agentType: "codex-app"),
            session(id: "codex:app-2", project: "AgentDeck", state: "idle", startedAt: "2026-04-30T00:00:02Z", agentType: "codex-app"),
        ]

        let terrarium = state.toTerrariumState()

        XCTAssertEqual(terrarium.cloudCreatures.count, 2)
        XCTAssertEqual(Set(terrarium.cloudCreatures.map(\.groupSize)), [1, 2])
        XCTAssertEqual(Set(terrarium.cloudCreatures.compactMap { $0.projectName }), ["AgentDeck"])
    }

    /// Empty / missing projectName MUST fold across distinct ids — when a
    /// Companion Task arrives without a project tag (low-quality hook
    /// payload, OTel span lacking `cwd`) the dashboard would otherwise
    /// stack up multiple anonymous codex sprites, contradicting the
    /// user's "one codex per dashboard" mental model. The fallback key
    /// is shared so every empty-project codex collapses into one creature.
    func testEmptyProjectsFoldIntoSingleSprite() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.siblingSessions = [
            session(id: "codex:1", project: nil, startedAt: "2026-04-30T00:00:01Z"),
            session(id: "codex:2", project: "", startedAt: "2026-04-30T00:00:02Z"),
            session(id: "codex:3", project: "", startedAt: "2026-04-30T00:00:03Z"),
        ]

        let terrarium = state.toTerrariumState()
        XCTAssertEqual(terrarium.cloudCreatures.count, 1, "Empty/nil project rows must collapse into one shared anonymous group")
        XCTAssertEqual(terrarium.cloudCreatures[0].groupSize, 3)
        // Most-recent thread is the representative.
        XCTAssertEqual(terrarium.cloudCreatures[0].id, "codex:3")
    }

    /// Distinct named projects must still render as distinct sprites even
    /// when an anonymous codex is also present — only the empty-project
    /// rows share a fold key.
    func testNamedProjectsStaySeparateFromAnonymousFold() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.siblingSessions = [
            session(id: "codex:a", project: "AgentDeck"),
            session(id: "codex:b", project: nil),
            session(id: "codex:c", project: ""),
            session(id: "codex:d", project: "ViewTrans"),
        ]

        let terrarium = state.toTerrariumState()
        XCTAssertEqual(terrarium.cloudCreatures.count, 3, "AgentDeck + ViewTrans + (anonymous fold of b,c)")
        let groupSizes = terrarium.cloudCreatures.map { $0.groupSize }.sorted()
        XCTAssertEqual(groupSizes, [1, 1, 2])
    }

    /// Aggregate state precedence: processing > awaiting > idle > dormant.
    func testAggregateStatePrecedence() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.siblingSessions = [
            session(id: "codex:a", project: "P", state: "idle"),
            session(id: "codex:b", project: "P", state: "awaiting_permission"),
            session(id: "codex:c", project: "P", state: "processing"),
        ]

        let terrarium = state.toTerrariumState()

        XCTAssertEqual(terrarium.cloudCreatures.count, 1)
        XCTAssertEqual(terrarium.cloudCreatures[0].state, .pulsing)
        XCTAssertEqual(terrarium.cloudCreatures[0].groupSize, 3)
    }

    /// Primary Codex session (focused) folds with siblings sharing its
    /// projectName. The representative's id is the most-recent thread, but
    /// the primary's project tag is the source of truth for the group key.
    func testPrimaryCodexFoldsWithSiblings() {
        var state = DashboardState()
        state.state = .processing
        state.bridgeConnected = true
        state.agentType = "codex-cli"
        state.sessionId = "codex:primary"
        state.projectName = "AgentDeck"
        state.siblingSessions = [
            session(id: "codex:primary", project: "AgentDeck", state: "processing", startedAt: "2026-04-30T00:00:00Z"),
            session(id: "codex:s1", project: "AgentDeck", state: "idle", startedAt: "2026-04-30T00:00:30Z"),
            session(id: "codex:s2", project: "AgentDeck", state: "idle", startedAt: "2026-04-30T00:01:00Z"),
        ]

        let terrarium = state.toTerrariumState()
        XCTAssertEqual(terrarium.cloudCreatures.count, 1)
        XCTAssertEqual(terrarium.cloudCreatures[0].groupSize, 3)
        XCTAssertEqual(terrarium.cloudCreatures[0].state, .pulsing)
    }

    /// `sessionId` is hook/activity attribution, not user selection. The
    /// terrarium halo must stay off until `focusedSessionId` is set by an
    /// explicit focus action.
    func testActivitySessionIdDoesNotCreateFocusHalo() {
        var state = DashboardState()
        state.state = .processing
        state.bridgeConnected = true
        state.agentType = "codex-cli"
        state.sessionId = "codex:active"
        state.projectName = "AgentDeck"
        state.siblingSessions = [
            session(id: "codex:active", project: "AgentDeck", state: "processing")
        ]

        let terrarium = state.toTerrariumState()

        XCTAssertNil(terrarium.focusedSessionId)
    }

    /// When the user focuses one member of a folded Codex group, the halo
    /// should resolve to the visible representative sprite instead of the
    /// hidden thread id.
    func testExplicitFocusedCodexThreadMapsToFoldedRepresentative() {
        var state = DashboardState()
        state.state = .idle
        state.bridgeConnected = true
        state.focusedSessionId = "codex:thread-1"
        state.siblingSessions = [
            session(id: "codex:thread-1", project: "AgentDeck", state: "idle", startedAt: "2026-04-30T00:00:01Z"),
            session(id: "codex:thread-2", project: "AgentDeck", state: "processing", startedAt: "2026-04-30T00:00:02Z"),
        ]

        let terrarium = state.toTerrariumState()

        XCTAssertEqual(terrarium.cloudCreatures.first?.id, "codex:thread-2")
        XCTAssertEqual(terrarium.focusedSessionId, "codex:thread-2")
    }

    /// Resurrection predicate trade-off: `codex_session_start` and
    /// `codex_user_prompt_submit` MUST resurrect (the latter handles
    /// interactive multi-turn sessions whose entry was reaped by the
    /// post-terminal TTL during a "user thinking" pause). `codex_tool_start`
    /// MUST NOT resurrect — by the time it arrives for an unknown sessionId
    /// without a preceding prompt event, it is almost certainly a leftover
    /// hook from a thread that already finished. Other end-of-turn or
    /// progress-only events are also non-resurrecting.
    func testResurrectionPredicateAllowsPromptButNotMidTurn() {
        XCTAssertTrue(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "codex_session_start"))
        XCTAssertTrue(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "codex_user_prompt_submit"))
        XCTAssertFalse(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "codex_tool_start"))
        XCTAssertFalse(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "codex_tool_end"))
        // Permission requests share the tombstone-gated mid-turn resurrection
        // path: after a daemon restart, the first hook may be a live approval.
        XCTAssertFalse(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "codex_permission_request"))
        XCTAssertTrue(DaemonServer.shouldIgnorePostTerminalCodexProgressForTest(event: "codex_permission_request"))
        XCTAssertFalse(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "codex_stop"))
        XCTAssertFalse(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "codex_turn_complete"))
    }

    /// OpenCode resurrection is broader than Codex: the observer plugin
    /// announces `opencode_session_start` once per plugin process, so after a
    /// daemon restart the next signal for a live session is a prompt/tool/
    /// stop hook — all of those must recreate the row (there is no
    /// companion-task noise on the OpenCode side). `session_start` creates
    /// its entry in its own switch case; `session_end` must stay dead.
    func testOpenCodeResurrectionPredicateAllowsMidTurn() {
        XCTAssertFalse(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "opencode_session_start"))
        XCTAssertTrue(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "opencode_user_prompt_submit"))
        XCTAssertTrue(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "opencode_tool_start"))
        XCTAssertTrue(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "opencode_tool_end"))
        XCTAssertTrue(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "opencode_stop"))
        XCTAssertFalse(DaemonServer.shouldSynthesizeUnknownHookSessionForTest(event: "opencode_session_end"))
    }

    /// `CodexHookIdentity.sessionKey` must reject low-quality ids from
    /// EITHER the thread-key path or the `session_id` fallback. Both paths
    /// previously routed through `isDurableSessionId` for `session_id` only,
    /// letting `thread_id: "11"` slip through and synthesize a phantom
    /// `codex:11` row that survived as an unnamed cloud creature.
    func testHookIdentityRejectsShortNumericThreadIds() {
        // Short numeric thread_id — must be rejected.
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["thread_id": "11"]))
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["thread-id": "8"]))
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["codex.thread_id": "12345"]))
        // Pure-digit string of any length is non-durable (real ids are
        // hex/UUID and contain non-decimal characters).
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["thread_id": "12345678901234"]))
        // Same on the session_id fallback.
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["session_id": "11"]))
        XCTAssertNil(CodexHookIdentity.sessionKey(from: ["session_id": ""]))
        XCTAssertNil(CodexHookIdentity.sessionKey(from: [:]))
    }

    func testHookIdentityAcceptsUuidThreadIds() {
        // Real codex thread id (UUIDv7-style) — must be accepted as-is.
        let uuid = "019dee40-c853-74e0-b46d-dae33eb1d02b"
        XCTAssertEqual(CodexHookIdentity.sessionKey(from: ["thread_id": uuid]), "codex:\(uuid)")
        XCTAssertEqual(CodexHookIdentity.sessionKey(from: ["thread-id": uuid]), "codex:\(uuid)")
        // Already-prefixed values are normalized — no double prefix.
        XCTAssertEqual(CodexHookIdentity.sessionKey(from: ["thread_id": "codex:\(uuid)"]), "codex:\(uuid)")
        // session_id fallback path also accepts uuid.
        XCTAssertEqual(CodexHookIdentity.sessionKey(from: ["session_id": uuid]), "codex:\(uuid)")
    }

    /// Regression guard for Codex session classification. The anonymous OTel
    /// placeholder is not real; CLI and App thread-id rows both are.
    func testHasRealCodexSessionIgnoresAnonymousPlaceholder() {
        let anonymous = DaemonSessionEntry(
            id: "codex:otel-active",
            port: 9120,
            pid: 0,
            projectName: "",
            agentType: "codex-cli"
        )
        let realCodex = DaemonSessionEntry(
            id: "codex:019dee40-c853-74e0-b46d-dae33eb1d02b",
            port: 9120,
            pid: 0,
            projectName: "AgentDeck",
            agentType: "codex-cli"
        )
        let realCodexApp = DaemonSessionEntry(
            id: "codex:019dee40-c853-74e0-b46d-dae33eb1d02c",
            port: 9120,
            pid: 0,
            projectName: "Codex App",
            agentType: "codex-app"
        )
        let claude = DaemonSessionEntry(
            id: "claude:1",
            port: 9121,
            pid: 0,
            projectName: "OtherRepo",
            agentType: "claude-code"
        )

        // Empty registry — no real codex session.
        XCTAssertFalse(DaemonServer.hasRealCodexSession(in: [:]))

        // Only the anonymous placeholder — still "no real codex". The OTel
        // placeholder must never count as real, else we'd skip the eviction
        // and the duplicate row would stay.
        XCTAssertFalse(DaemonServer.hasRealCodexSession(in: [anonymous.id: anonymous]))

        // Claude-only — agent type guard rejects non-codex sessions.
        XCTAssertFalse(DaemonServer.hasRealCodexSession(in: [claude.id: claude]))

        // Real codex thread-id sessions.
        XCTAssertTrue(DaemonServer.hasRealCodexSession(in: [realCodex.id: realCodex]))
        XCTAssertTrue(DaemonServer.hasRealCodexSession(in: [realCodexApp.id: realCodexApp]))

        // Real codex + anonymous coexisting (the actual regression
        // scenario): predicate still returns true so anonymous would be
        // suppressed/evicted on the next codex insert.
        XCTAssertTrue(DaemonServer.hasRealCodexSession(in: [
            anonymous.id: anonymous,
            realCodex.id: realCodex,
        ]))

        // Claude + anonymous coexisting: anonymous alone does not count as
        // a real codex session, so the predicate stays false. This guards
        // the invariant that anonymous never gets promoted by the mere
        // presence of an unrelated agent type.
        XCTAssertFalse(DaemonServer.hasRealCodexSession(in: [
            anonymous.id: anonymous,
            claude.id: claude,
        ]))
    }

    /// Octopus (Claude Code) is intentionally NOT folded — multi-instance
    /// in the same workspace is a deliberate user pattern.
    func testClaudeOctopusIsNotFolded() {
        var state = DashboardState()
        state.state = .idle
        state.agentType = "openclaw"
        state.bridgeConnected = true
        state.siblingSessions = [
            SessionInfo(id: "claude:1", port: 9121, projectName: "AgentDeck", agentType: "claude-code", alive: true, state: "processing"),
            SessionInfo(id: "claude:2", port: 9122, projectName: "AgentDeck", agentType: "claude-code", alive: true, state: "idle"),
            SessionInfo(id: "claude:3", port: 9123, projectName: "AgentDeck", agentType: "claude-code", alive: true, state: "idle"),
        ]

        let terrarium = state.toTerrariumState()
        XCTAssertEqual(terrarium.creatures.count, 3, "Claude Code sessions must remain unfolded")
    }
}
#endif
