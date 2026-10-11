#if os(macOS)
import XCTest
import RealityKit
import SwiftUI
@testable import AgentDeck

@MainActor
private final class SnapshotCompletion {
    private var continuation: CheckedContinuation<NSImage?, Never>?
    init(_ continuation: CheckedContinuation<NSImage?, Never>) { self.continuation = continuation }
    func finish(_ image: NSImage?) {
        let pending = continuation
        continuation = nil
        pending?.resume(returning: image)
    }
}

/// Verify the render-time Codex creature fold introduced to suppress phantom
/// Cloud creatures when Claude Code's rescue/stop-gate workflow spawns a fresh
/// codex thread per turn. Without folding the same workspace lights up 4-5
/// simultaneous Cloud sprites; the fold collapses them to one creature per
/// `(agentType=codex-cli, projectName)` group.
final class TerrariumCloudFoldTests: XCTestCase {

    func testBackgroundSnapshotDecodesProjectsAndClearsWithoutInventingAgents() throws {
        let data = Data(#"{"id":"observed:claude:bg","port":0,"projectName":"Render","agentType":"claude-code","alive":true,"state":"processing","backgroundTaskCount":7}"#.utf8)
        var row = try JSONDecoder().decode(SessionInfo.self, from: data)
        var dashboard = DashboardState()
        dashboard.siblingSessions = [row]
        let projected = AquariumResident.project(dashboard.toTerrariumState())
        XCTAssertEqual(projected.count, 1)
        XCTAssertEqual(projected.first?.backgroundTasks, 7)
        XCTAssertEqual(projected.first?.helpers, 0)
        XCTAssertEqual(projected.first?.activity, .working)
        for state in ["awaiting_permission", "awaiting_option", "idle", "disconnected"] {
            row.state = state
            dashboard.siblingSessions = [row]
            let terrarium = dashboard.toTerrariumState()
            // The explicit count is carried (the brood needs it to tell a finish
            // from an unknown), but no pod shows for a session that is not working.
            XCTAssertEqual(terrarium.backgroundTaskCounts[row.id], 7)
            XCTAssertEqual(AquariumResident.project(terrarium).first?.backgroundTasks ?? 0, 0)
        }
        row.state = "idle"
        row.backgroundTaskCount = 0
        dashboard.siblingSessions = [row]
        XCTAssertEqual(dashboard.toTerrariumState().backgroundTaskCounts[row.id], 0, "An explicit zero means the tasks finished")
        for count: Int? in [nil, -1] {
            row.backgroundTaskCount = count
            dashboard.siblingSessions = [row]
            XCTAssertNil(dashboard.toTerrariumState().backgroundTaskCounts[row.id], "Absent or malformed stays unknown")
        }
    }

    @MainActor
    func testBackgroundTilesMoveFreezeAndClearOnRealSceneReconciliation() async throws {
        let scene = AquariumResidents()
        scene.loadTemplates(try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "3d-residents", withExtension: "usdz"))))
        var state = TerrariumState()
        state.creatures = [.init(id: "claude", projectName: "Render", modelName: nil, state: .working, homeX: 0.5, homeY: 0.5, scale: 1)]
        state.cloudCreatures = [.init(id: "codex", projectName: "Codex", modelName: nil, state: .pulsing, homeX: 0.5, homeY: 0.5, scale: 1)]
        state.backgroundTaskCounts = ["claude": 12, "codex": 2]
        scene.sync(state, aspect: 1.6)
        let resident = try XCTUnwrap(scene.residents["claude"])
        XCTAssertEqual(scene.residents["codex"]?.findEntity(named: "background-work")?.isEnabled, true, "Every resident kind gets buddies")
        let group = try XCTUnwrap(resident.findEntity(named: "background-work"))
        XCTAssertTrue(group.isEnabled)
        XCTAssertEqual(resident.findEntity(named: "activity")?.isEnabled, false, "Background tiles replace the foreground bars")
        let jars = (0..<BackgroundWorkPresentation.maxBuddies + 1).compactMap { group.findEntity(named: "background-buddy-\($0)") }
        let finishing = (0..<BackgroundWorkPresentation.maxBuddies).compactMap { group.findEntity(named: "background-finish-\($0)") }
        XCTAssertEqual(jars.count, BackgroundWorkPresentation.maxBuddies, "Large task counts cannot allocate an unbounded effect")
        XCTAssertEqual(jars.filter(\.isEnabled).count, 3)
        XCTAssertEqual(group.findEntity(named: "background-overflow")?.isEnabled, true, "Twelve tasks tag the last jar with +9")
        // Keep a render of the actual production scene for visual review.
        let view = ARView(frame: NSRect(x: 0, y: 0, width: 640, height: 480))
        let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        // Keep the capture window visible to avoid offscreen occlusion throttling.
        window.setFrameOrigin(NSScreen.main?.visibleFrame.origin ?? .zero)
        window.orderFrontRegardless()
        defer { window.orderOut(nil) }
        view.environment.background = .color(NSColor(DesignTokens.Ink.s900))
        let anchor = AnchorEntity(world: .zero)
        anchor.addChild(scene.root)
        let camera = PerspectiveCamera()
        camera.camera.fieldOfViewInDegrees = 38
        // Frame both kinds: buddies are generic, not a Claude-only accent.
        let codex = try XCTUnwrap(scene.residents["codex"])
        let middle = (resident.position + codex.position) / 2
        let spread = max(1.5, simd_distance(resident.position, codex.position))
        camera.look(at: middle + [0, 0.15, 0], from: middle + [0, 0.9, 2.2 + spread * 1.6], relativeTo: nil)
        anchor.addChild(camera)
        let light = DirectionalLight()
        light.light.intensity = 3000
        light.look(at: resident.position, from: resident.position + [-2, 3, 4], relativeTo: nil)
        anchor.addChild(light)
        view.scene.addAnchor(anchor)
        try await Task.sleep(for: .seconds(2))
        let image: NSImage? = await withCheckedContinuation { continuation in
            let completion = SnapshotCompletion(continuation)
            let deadline = Task { @MainActor in
                do { try await Task.sleep(for: .seconds(8)) } catch { return }
                completion.finish(nil)
            }
            view.snapshot(saveToHDR: false) { image in
                Task { @MainActor in
                    deadline.cancel()
                    completion.finish(image)
                }
            }
        }
        // Capture is review evidence, not the motion assertion below. Some macOS
        // test hosts cannot supply a GPU snapshot; record that limitation explicitly.
        let attachment = image.map { XCTAttachment(image: $0) }
            ?? XCTAttachment(string: "RealityKit capture unavailable within 8 seconds. Native scene assertions continue; physical visual acceptance is not attested.")
        attachment.name = image == nil ? "Background work - capture unavailable" : "Background work - native 3D"
        attachment.lifetime = .keepAlways
        add(attachment)
        let preview = TerrariumRenderer()
        preview.animateCompanions = false
        preview.update(dt: 0.016, state: state)
        let canvasImage = ImageRenderer(content: Canvas { context, size in
            preview.draw(context: &context, size: size, includeHabitat: false)
        }.frame(width: 640, height: 480).background(DesignTokens.Ink.s900))
        let canvasAttachment = XCTAttachment(image: try XCTUnwrap(canvasImage.nsImage))
        canvasAttachment.name = "Background work - native Canvas"
        canvasAttachment.lifetime = .keepAlways
        add(canvasAttachment)
        let tile = jars[jars.count - 1]
        let initial = tile.position
        scene.step(0.05)
        XCTAssertNotEqual(tile.position, initial)
        scene.animate = false
        let frozen = tile.position
        scene.step(60)
        XCTAssertEqual(tile.position, frozen)
        state.backgroundTaskCounts["claude"] = 1
        scene.sync(state, aspect: 1.6)
        XCTAssertEqual(jars.filter(\.isEnabled).count, 1)
        XCTAssertEqual(finishing.filter(\.isEnabled).count, 0, "Reduced Motion never starts a finish it could not play out")
        let firstPod = try XCTUnwrap(jars.first)
        let pinned = firstPod.position
        state.backgroundTaskCounts["claude"] = 2
        scene.sync(state, aspect: 1.6)
        XCTAssertEqual(firstPod.position, pinned, "Reduced Motion keeps the phase fixed even when counts change")
        state.creatures = [.init(id: "claude", projectName: "Render", modelName: nil, state: .asking, homeX: 0.5, homeY: 0.5, scale: 1)]
        scene.sync(state, aspect: 1.6)
        XCTAssertFalse(group.isEnabled, "Approval takes priority even with retained task metadata")
        state.creatures = [.init(id: "claude", projectName: "Render", modelName: nil, state: .working, homeX: 0.5, homeY: 0.5, scale: 1)]
        state.backgroundTaskCounts = [:]
        scene.sync(state, aspect: 1.6)
        XCTAssertTrue(group.isEnabled, "An unknown count retains the brood instead of reading as zero")
        XCTAssertEqual(resident.findEntity(named: "activity")?.isEnabled, false, "and the activity bars stay off beside the buddies")
        let retained = try XCTUnwrap(scene.descriptors.first { $0.id == "claude" })
        XCTAssertEqual(retained.backgroundTasks, 2, "The tag is built from the retained count, as in 2D")
        XCTAssertEqual(BackgroundWorkPresentation.label(retained.backgroundTasks), "2 background tasks")
        state.backgroundTaskCounts = ["claude": 0]
        scene.sync(state, aspect: 1.6)
        XCTAssertFalse(group.isEnabled, "Completion clears without requiring an animation frame")
        XCTAssertEqual(resident.findEntity(named: "activity")?.isEnabled, true, "Foreground work keeps its own cue after background tasks end")
        scene.sync(TerrariumState(), aspect: 1.6)
        XCTAssertTrue(scene.residents.isEmpty)

        let canvas = TerrariumRenderer()
        canvas.update(dt: 0.05, state: state)
        XCTAssertGreaterThan(canvas.backgroundOrbitPhase, 0)
        canvas.animateCompanions = false
        let phase = canvas.backgroundOrbitPhase
        canvas.update(dt: 60, state: state)
        XCTAssertEqual(canvas.backgroundOrbitPhase, phase)
    }

    func testJarBuddiesWanderBesideTheBodyClearOfTagAndSand() {
        typealias P = BackgroundWorkPresentation
        XCTAssertEqual(P.visibleCount(0), 0)
        XCTAssertEqual(P.visibleCount(12), P.maxBuddies, "Buddies are capped; +n and the label carry the rest")
        XCTAssertEqual(P.overflow(12), 9)
        XCTAssertEqual(P.overflow(3), 0)
        XCTAssertEqual(P.label(1), "1 background task")
        XCTAssertEqual(P.label(5), "5 background tasks")
        var visited: [Set<Int>] = Array(repeating: [], count: P.maxBuddies + 1)
        var turned = Array(repeating: Set<Float>(), count: P.maxBuddies + 1)
        for phase in stride(from: Float(0), to: 40, by: 0.05) {
            for index in 0...P.maxBuddies {
                let buddy = P.buddy(index: index, phase: phase)
                let c = buddy.center
                // Body: never closer than the creature's own half width plus the jar.
                XCTAssertGreaterThan(abs(c.x) - buddy.radius * 1.3, 1.0, "Buddy \(index) never overlaps the body")
                // Tag above, sand below: the whole jar, lid and fins included.
                XCTAssertLessThan(c.y + buddy.radius * 1.9, 0.6, "Buddy \(index) stays under the name tag")
                XCTAssertGreaterThan(c.y - buddy.radius * 1.1, -0.7, "Buddy \(index) never sinks below the feet")
                XCTAssertLessThan(abs(c.x), 2.4, "Buddy \(index) stays near its creature")
                XCTAssertLessThan(abs(buddy.tilt), 0.31)
                XCTAssertLessThanOrEqual(buddy.lidLift, 0.18 + 1e-4, "The lid hops a little, it does not fly off")
                visited[index].insert(Int((c.x * 10).rounded()))
                turned[index].insert(buddy.facing)
            }
        }
        for index in 0...P.maxBuddies {
            XCTAssertGreaterThan(visited[index].count, 6, "Buddy \(index) wanders, it does not hover in place")
            XCTAssertEqual(turned[index], [-1, 1], "Buddy \(index) turns to face where it swims")
        }
        // Buddies spread over both sides and never move in step.
        XCTAssertGreaterThan(P.buddy(index: 0, phase: 1).center.x, 0)
        XCTAssertLessThan(P.buddy(index: 1, phase: 1).center.x, 0)
        let a = P.buddy(index: 0, phase: 3), b = P.buddy(index: 2, phase: 3)
        XCTAssertNotEqual(a.center, b.center)
        // Lids hop at staggered moments: never all at once.
        var together = 0
        for phase in stride(from: Float(0), to: 20, by: 0.05) {
            if (0..<3).allSatisfy({ P.buddy(index: $0, phase: phase).lidLift > 0.05 }) { together += 1 }
        }
        XCTAssertEqual(together, 0)
        // Simmer bubbles rise from the mouth and fade as they go.
        let buddy = P.buddy(index: 0, phase: 0)
        for bubble in (0..<P.simmerPerBuddy).map({ P.simmer(buddy, slot: 0, k: $0, phase: 1.3) }) {
            XCTAssertGreaterThanOrEqual(bubble.center.y, P.mouth(buddy).y)
            XCTAssertLessThanOrEqual(bubble.opacity, 0.8)
        }
        // A finish pops the lid up and spins it, then the buddy shrinks away.
        let early = P.finish(age: 0.2), late = P.finish(age: 1.2)
        XCTAssertGreaterThan(early?.lidLift ?? 0, 0.5)
        XCTAssertGreaterThan(early?.lidSpin ?? 0, 0)
        XCTAssertEqual(early?.scale ?? 0, 1, accuracy: 1e-5, "The buddy holds its size while the lid pops")
        XCTAssertLessThan(late?.scale ?? 1, 0.5)
        XCTAssertLessThan(late?.opacity ?? 1, early?.opacity ?? 0)
        XCTAssertNil(P.finish(age: P.finishSeconds))
        let first = (0..<P.bubblesPerFinish).compactMap { P.puff(mouth: .zero, age: 0.2, k: $0) }
        let later = (0..<P.bubblesPerFinish).compactMap { P.puff(mouth: .zero, age: 1.0, k: $0) }
        XCTAssertNil(P.puff(mouth: .zero, age: P.finishSeconds, k: 0))
        XCTAssertEqual(first.count, P.bubblesPerFinish)
        for (x, y) in zip(first, later) {
            XCTAssertGreaterThan(y.center.y, x.center.y)
            XCTAssertLessThan(y.opacity, x.opacity)
        }
    }

    /// Close neighbours: every buddy stays nearer its owner than any other
    /// creature, over a long sweep, by keeping to open water or shrinking its loop.
    func testJarBuddiesStayNearerTheirOwnerThanACloseNeighbour() {
        typealias P = BackgroundWorkPresentation
        // Neighbour centres in owner body radii: one close on the right, one on
        // each side (a crowded row), and a diagonal neighbour.
        let layouts: [[SIMD2<Float>]] = [[[3, 0]], [[-3, 0]], [[3, 0], [-3, 0]], [[2.6, 0.4], [-3.2, -0.3]], [[2.4, 1.2]]]
        for neighbours in layouts {
            var room = P.Room()
            for n in neighbours { room.note(n) }
            for phase in stride(from: Float(0), to: 40 * P.radiansPerSecond, by: 0.05) {
                for index in 0..<P.maxBuddies {
                    let c = P.buddy(index: index, phase: phase, room: room).center
                    let own = simd_length(SIMD2(c.x, c.y))
                    for n in neighbours {
                        XCTAssertLessThan(own, simd_distance(SIMD2(c.x, c.y), n),
                                          "Buddy \(index) with neighbours \(neighbours) drifted toward a neighbour")
                    }
                }
            }
        }
        // Very close or overlapping neighbours: buddies never sit over the
        // owner's body. Beside it when a lane fits, above the tag when none does.
        for gap: Float in [0.3, 1.0, 2.0] {
            for layout in [[SIMD2<Float>(gap, 0)], [SIMD2<Float>(gap, 0), SIMD2<Float>(-gap, 0)]] {
                var room = P.Room()
                for n in layout { room.note(n) }
                for phase in stride(from: Float(0), to: 40 * P.radiansPerSecond, by: 0.1) {
                    for index in 0..<P.maxBuddies {
                        let c = P.buddy(index: index, phase: phase, room: room).center
                        let besideBody = abs(c.x) >= P.bodyClearance - 1e-4
                        let aboveTag = c.y - P.buddyRadius >= P.tagTop
                        XCTAssertTrue(besideBody || aboveTag, "gap \(gap) \(layout.count)-sided: buddy \(index) at \(c) covers the body or tag")
                        if aboveTag { XCTAssertEqual(P.clearOfTag(c), c, "A buddy hovering above the tag pops where it is") }
                    }
                }
            }
        }
        // One close neighbour: the whole group keeps to the open side.
        var right = P.Room(); right.note([3, 0])
        for index in 0..<P.maxBuddies { XCTAssertEqual(P.side(index: index, room: right), -1) }
        // A crowded row: both sides cramped, loops shrink instead of drifting.
        var row = P.Room(); row.note([3, 0]); row.note([-3, 0])
        XCTAssertLessThan(try XCTUnwrap(P.lane(side: 1, room: row)).scale, 0.2)
        XCTAssertEqual(try XCTUnwrap(P.lane(side: 1, room: P.Room())).scale, 1, "Open water keeps the full loop")
        var squeezed = P.Room(); squeezed.note([1, 0]); squeezed.note([-1, 0])
        XCTAssertNil(P.lane(side: 1, room: squeezed), "No lane fits beside the body: the group hovers above the tag")
        // A far neighbour or one well above or below changes nothing.
        var far = P.Room(); far.note([6, 0]); far.note([1, 3])
        XCTAssertEqual([P.side(index: 0, room: far), P.side(index: 1, room: far)], [-1, 1], "Open water on both sides still alternates, roomier first")
        // Settling: a brood whose room changes swims to its new lane, it does not jump.
        var brood = BackgroundBrood()
        brood.observe(explicit: 1, working: true, position: .zero, phase: 0, animate: true)
        brood.advance(dt: 1.0 / 60, position: .zero, room: .init(), phase: 0)
        let before = brood.buddy(index: 0, phase: 0).center
        brood.advance(dt: 1.0 / 60, position: .zero, room: right, phase: 0)
        let step = brood.buddy(index: 0, phase: 0).center
        XCTAssertLessThan(simd_distance(before, step), 0.3, "A lane change is a swim, not a jump")
        for _ in 0..<300 { brood.advance(dt: 1.0 / 60, position: .zero, room: right, phase: 0) }
        XCTAssertLessThan(brood.buddy(index: 0, phase: 0).center.x, 0, "and it arrives on the open side")
    }

    /// A finish never pops into the owner's name tag, wherever it started.
    func testJarBuddyFinishPopsClearOfTheNameTag() {
        typealias P = BackgroundWorkPresentation
        for x in stride(from: Float(-2), through: 2, by: 0.1) {
            for y in stride(from: Float(-1), through: 2, by: 0.1) {
                let p = P.clearOfTag([x, y, 0.1])
                let top = p.y + P.buddyRadius * 3
                let overTag = abs(p.x) < P.tagHalfWidth + P.buddyRadius && top > P.tagBottom && p.y - P.buddyRadius < P.tagTop
                XCTAssertFalse(overTag, "A pop at (\(x), \(y)) lands in the name tag")
                if abs(x) >= P.tagHalfWidth + P.buddyRadius || y + P.buddyRadius * 3 <= P.tagBottom || y - P.buddyRadius >= P.tagTop {
                    XCTAssertEqual(p, [x, y, 0.1], "A pop already clear stays where it was")
                }
            }
        }
    }

    func testJarBuddiesFinishOnlyOnExplicitlyLowerCounts() {
        typealias P = BackgroundWorkPresentation
        let here: SIMD2<Float> = [0.3, 0.4]
        var brood = BackgroundBrood()
        brood.observe(explicit: 3, working: true, position: here, phase: 0, animate: true)
        XCTAssertTrue(brood.finishes.isEmpty, "Arriving tasks never finish")
        let last = P.buddy(index: 2, phase: 0)
        brood.observe(explicit: 2, working: true, position: here, phase: 0, animate: true)
        XCTAssertEqual(brood.finishes.map(\.buddy), [last], "A finished task leaves from the end of the group")
        XCTAssertEqual(brood.finishes.first?.base, here, "The finish remembers where it was, to play in the water")
        brood.advance(dt: 1.0 / 60, position: here, room: .init(), phase: 0)
        brood.advance(dt: P.finishSeconds, position: here, room: .init(), phase: 0)
        XCTAssertTrue(brood.finishes.isEmpty, "Finishes expire")

        // Unknown is not zero: a restart or a snapshot without the field retains the buddies.
        brood.observe(explicit: nil, working: true, position: here, phase: 0, animate: true)
        XCTAssertEqual(brood.count, 2)
        XCTAssertTrue(brood.finishes.isEmpty, "An unknown count never finishes a buddy")
        brood.observe(explicit: 2, working: true, position: here, phase: 0, animate: true)
        XCTAssertTrue(brood.finishes.isEmpty, "The same count after an unknown snapshot does not finish one either")

        // The common finish: the last task ends and the same snapshot turns the creature idle.
        brood.observe(explicit: 0, working: false, position: here, phase: 0, animate: true)
        XCTAssertEqual(brood.count, 0)
        XCTAssertEqual(brood.finishes.count, 2, "Every buddy that was showing finishes when the last task ends")

        // A capped group: a drop that stays above the cap changes "+n", not a
        // buddy, and only buddies that were drawn can pop.
        var crowded = BackgroundBrood()
        crowded.observe(explicit: 12, working: true, position: here, phase: 0, animate: true)
        crowded.observe(explicit: 11, working: true, position: here, phase: 0, animate: true)
        XCTAssertTrue(crowded.finishes.isEmpty, "12 → 11 keeps all three buddies; nothing visibly leaves")
        var partly = BackgroundBrood()
        partly.observe(explicit: 4, working: true, position: here, phase: 0, animate: true)
        partly.observe(explicit: 2, working: true, position: here, phase: 0, animate: true)
        XCTAssertEqual(partly.finishes.map(\.buddy), [P.buddy(index: 2, phase: 0)], "4 → 2 with three shown pops only the one that leaves")
        crowded.observe(explicit: 0, working: true, position: here, phase: 0, animate: true)
        XCTAssertEqual(crowded.finishes.count, P.maxBuddies, "11 → 0 pops the three that were drawn")
        crowded.observe(explicit: 0, working: true, position: here, phase: 0, animate: false)
        XCTAssertTrue(crowded.finishes.isEmpty, "Turning on Reduce Motion mid-finish leaves nothing frozen")

        // An approval prompt hides the buddies without finishing their tasks.
        var waiting = BackgroundBrood()
        waiting.observe(explicit: 2, working: true, position: here, phase: 0, animate: true)
        waiting.observe(explicit: 2, working: false, position: here, phase: 0, animate: true)
        XCTAssertEqual(waiting.count, 0)
        waiting.observe(explicit: 1, working: false, position: here, phase: 0, animate: true)
        XCTAssertTrue(waiting.finishes.isEmpty, "Nothing finishes from hidden buddies")
        waiting.observe(explicit: 1, working: true, position: here, phase: 0, animate: true)
        XCTAssertEqual(waiting.count, 1)

        // An unknown count is not carried past the working stretch it belonged to.
        var stale = BackgroundBrood()
        stale.observe(explicit: 3, working: true, position: here, phase: 0, animate: true)
        stale.observe(explicit: nil, working: false, position: here, phase: 0, animate: true)
        stale.observe(explicit: nil, working: true, position: here, phase: 0, animate: true)
        XCTAssertEqual(stale.count, 0)
        XCTAssertTrue(stale.finishes.isEmpty)

        // Followed point: buddies trail a swimming creature, then catch up; no time, no lag.
        var follower = BackgroundBrood()
        follower.advance(dt: 1.0 / 60, position: [0, 0], room: .init(), phase: 0)
        follower.advance(dt: 1.0 / 60, position: [0.2, 0], room: .init(), phase: 0)
        XCTAssertLessThan(follower.lag(from: [0.2, 0]).x, -0.15, "Buddies lag behind a swim")
        for _ in 0..<180 { follower.advance(dt: 1.0 / 60, position: [0.2, 0], room: .init(), phase: 0) }
        XCTAssertEqual(follower.lag(from: [0.2, 0]).x, 0, accuracy: 0.002, "and catch up")
        follower.advance(dt: 0, position: [0.9, 0], room: .init(), phase: 0)
        XCTAssertEqual(follower.lag(from: [0.9, 0]), .zero, "Reduce Motion pins buddies to their creature")

        var still = BackgroundBrood()
        still.observe(explicit: 2, working: true, position: here, phase: 0, animate: false)
        still.observe(explicit: 0, working: true, position: here, phase: 0, animate: false)
        XCTAssertTrue(still.finishes.isEmpty, "Reduce Motion never starts a finish")
    }

    /// Every creature kind gets buddies through the same path; none of them
    /// overlap their own creature.
    @MainActor
    func testCanvasJarBuddiesAreGenericAcrossCreatureKinds() {
        let renderer = TerrariumRenderer()
        renderer.animateHermes = false
        var state = TerrariumState()
        state.creatures = [.init(id: "claude", projectName: "Claude", modelName: nil, state: .working, homeX: 0.2, homeY: 0.4, scale: 1)]
        state.cloudCreatures = [.init(id: "codex", projectName: "Codex", modelName: nil, state: .pulsing, homeX: 0.5, homeY: 0.4, scale: 1)]
        state.opencodeCreatures = [.init(id: "opencode", projectName: "OpenCode", modelName: nil, state: .pulsing, homeX: 0.8, homeY: 0.4, scale: 1)]
        state.kiroCreatures = [.init(id: "kiro", projectName: "Kiro", modelName: nil, state: .working, homeX: 0.35, homeY: 0.6, scale: 1)]
        state.antigravityCreatures = [.init(id: "antigravity", projectName: "Antigravity", modelName: nil, state: .working, homeX: 0.65, homeY: 0.6, scale: 1)]
        let ids = ["claude", "codex", "opencode", "kiro", "antigravity"]
        state.backgroundTaskCounts = Dictionary(uniqueKeysWithValues: ids.map { ($0, 2) })
        renderer.update(dt: 0.016, state: state)
        for id in ids {
            XCTAssertEqual(renderer.broods[id]?.count, 2, "\(id) carries buddies like any other kind")
            XCTAssertNotNil(renderer.residentPose(id))
        }
        state.backgroundTaskCounts = [:]
        renderer.update(dt: 0.016, state: state)
        XCTAssertEqual(renderer.broods["codex"]?.count, 2, "A snapshot without the count retains the buddies")
        XCTAssertEqual(renderer.broods["codex"]?.finishes.count, 0)
        state.backgroundTaskCounts = ["codex": 1]
        renderer.update(dt: 0.016, state: state)
        XCTAssertEqual(renderer.broods["codex"]?.finishes.count, 1)
        state.cloudCreatures = []
        renderer.update(dt: 0.016, state: state)
        XCTAssertNil(renderer.broods["codex"], "A departed creature leaves no buddies behind")
        let quiet = TerrariumRenderer()
        state.creatures = [.init(id: "idle", projectName: "Render", modelName: nil, state: .floating, homeX: 0.5, homeY: 0.5, scale: 1)]
        state.backgroundTaskCounts = ["idle": 0]
        quiet.update(dt: 0.016, state: state)
        XCTAssertNil(quiet.broods["idle"], "A creature with no tasks costs nothing per frame")
    }

    /// Review evidence only: set AGENTDECK_BROOD_VISUAL_OUTPUT to write frames.
    @MainActor
    func testCanvasJarBuddyFramesForVisualReview() throws {
        guard let output = ProcessInfo.processInfo.environment["AGENTDECK_BROOD_VISUAL_OUTPUT"] else {
            throw XCTSkip("Set AGENTDECK_BROOD_VISUAL_OUTPUT to render buddy frames")
        }
        let folder = URL(fileURLWithPath: output, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let renderer = TerrariumRenderer()
        renderer.animateHermes = false
        var state = TerrariumState()
        state.creatures = [.init(id: "claude", projectName: "AgentDeck", modelName: nil, state: .working, homeX: 0.18, homeY: 0.32, scale: 1)]
        state.cloudCreatures = [.init(id: "codex", projectName: "Release", modelName: nil, state: .pulsing, homeX: 0.52, homeY: 0.48, scale: 1)]
        state.opencodeCreatures = [.init(id: "opencode", projectName: "Docs", modelName: nil, state: .pulsing, homeX: 0.84, homeY: 0.3, scale: 1)]
        state.backgroundTaskCounts = ["claude": 1, "codex": 3, "opencode": 5]
        func write(_ name: String) throws {
            let image = ImageRenderer(content: Canvas { context, size in renderer.draw(context: &context, size: size) }.frame(width: 1000, height: 560))
            image.scale = 2
            let data = try XCTUnwrap(image.nsImage?.tiffRepresentation)
            try XCTUnwrap(NSBitmapImageRep(data: data)?.representation(using: .png, properties: [:]))
                .write(to: folder.appendingPathComponent(name + ".png"))
        }
        for frame in 0..<6 {
            for _ in 0..<12 { renderer.update(dt: 1.0 / 30, state: state) }
            try write(String(format: "running-%02d", frame))
        }
        state.backgroundTaskCounts["codex"] = 2
        state.backgroundTaskCounts["claude"] = 0
        state.creatures = [.init(id: "claude", projectName: "AgentDeck", modelName: nil, state: .floating, homeX: 0.18, homeY: 0.32, scale: 1)]
        for frame in 0..<6 {
            for _ in 0..<5 { renderer.update(dt: 1.0 / 30, state: state) }
            try write(String(format: "finish-%02d", frame))
        }
        // A deliberately crowded row: each creature's buddies must stay its own.
        let crowded = TerrariumRenderer()
        crowded.animateHermes = false
        var row = TerrariumState()
        row.creatures = [.init(id: "claude", projectName: "AgentDeck", modelName: nil, state: .working, homeX: 0.40, homeY: 0.42, scale: 1)]
        row.cloudCreatures = [.init(id: "codex", projectName: "Release", modelName: nil, state: .pulsing, homeX: 0.50, homeY: 0.42, scale: 1)]
        row.opencodeCreatures = [.init(id: "opencode", projectName: "Docs", modelName: nil, state: .pulsing, homeX: 0.60, homeY: 0.42, scale: 1)]
        row.backgroundTaskCounts = ["claude": 2, "codex": 3, "opencode": 2]
        func writeRow(_ name: String) throws {
            let image = ImageRenderer(content: Canvas { context, size in crowded.draw(context: &context, size: size) }.frame(width: 1000, height: 560))
            image.scale = 2
            let data = try XCTUnwrap(image.nsImage?.tiffRepresentation)
            try XCTUnwrap(NSBitmapImageRep(data: data)?.representation(using: .png, properties: [:]))
                .write(to: folder.appendingPathComponent(name + ".png"))
        }
        for frame in 0..<6 {
            for _ in 0..<20 { crowded.update(dt: 1.0 / 30, state: row) }
            try writeRow(String(format: "crowded-%02d", frame))
        }
    }


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
    func testSnailKeepsAuthoredRockForagingHierarchyAndTransforms() async throws {
        let habitat = try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "living-aquarium", withExtension: "usdz")))
        func find(_ node: Entity) -> Entity? {
            if node.name.replacingOccurrences(of: "_", with: " ").lowercased() == "fauna snail" { return node }
            return node.children.compactMap { find($0) }.first
        }
        let authored = try XCTUnwrap(find(habitat))
        let parent = try XCTUnwrap(authored.parent)
        let transform = authored.transform
        let shoal = AquariumShoal()
        shoal.load(habitat)
        let snail = try XCTUnwrap(shoal.snail)
        XCTAssertTrue(snail === authored, "Do not replace the animated habitat animal with a detached clone")
        XCTAssertTrue(snail.parent === parent)
        XCTAssertTrue(snail.isEnabled)
        XCTAssertFalse(habitat.availableAnimations.isEmpty, "The shared asset owns rock contact and feeler motion")
        for _ in 0..<120 { shoal.step(1.0 / 60, residents: []) }
        XCTAssertEqual(snail.position, transform.translation, "School steering must not overwrite authored animation")
        XCTAssertEqual(snail.scale, transform.scale)
        XCTAssertEqual(snail.orientation.vector, transform.rotation.vector)
        XCTAssertNil(shoal.root.findEntity(named: "wandering-snail"))
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
    func testSidebarSessionCreatureIconKeepsFilledWhiteCodexPromptOnBothBackgrounds() throws {
        for background in [Color.blue, Color.yellow] {
            let view = SessionCreatureIcon(agentType: "codex-cli", tint: .purple, size: 240)
                .background(background)
            let image = ImageRenderer(content: view)
            image.scale = 1
            let bitmap = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.nsImage?.tiffRepresentation)))
            for (x,y) in [(79,110),(150,153)] {
                let pixel = try XCTUnwrap(bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB))
                XCTAssertEqual(pixel.redComponent, 1, accuracy: 0.01)
                XCTAssertEqual(pixel.greenComponent, 1, accuracy: 0.01)
                XCTAssertEqual(pixel.blueComponent, 1, accuracy: 0.01)
                XCTAssertEqual(pixel.alphaComponent, 1, accuracy: 0.01)
            }
        }
    }

    @MainActor
    func testTinyMonochromeLogoExceptionKeepsInkBodyEyeContrast() throws {
        let size = CreatureBrandFeatures.monochromeMinimumSize / 2
        let view = CanonicalCreatureView(agentType: "claudecode", size: size, color: .black, monochrome: true)
            .background(Color.blue)
        let image = ImageRenderer(content: view)
        image.scale = 240 / size
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.nsImage?.tiffRepresentation)))
        let eye = try XCTUnwrap(bitmap.colorAt(x: 65, y: 94)?.usingColorSpace(.sRGB))
        XCTAssertEqual(eye.redComponent, 1, accuracy: 0.01)
        XCTAssertEqual(eye.greenComponent, 1, accuracy: 0.01)
        XCTAssertEqual(eye.blueComponent, 1, accuracy: 0.01)
    }

    @MainActor
    func testCanvasCreatureFeaturesAreOpaqueOnDifferentBackgroundsAndMonoKeepsBlackEyes() throws {
        let samples: [(agent: String, x: Int, y: Int, rgb: [CGFloat]?, mono: CGFloat)] = [
            ("claudecode", 65, 94, [0, 0, 0], 0), ("claudecode", 173, 94, [0, 0, 0], 0),
            ("codex", 79, 110, [255, 255, 255], 1), ("codex", 150, 153, [255, 255, 255], 1),
            ("openclaw", 80, 81, [5, 8, 16], 0), ("openclaw", 90, 76, [0, 229, 204], 1),
            ("opencode", 120, 120, nil, 0),
        ]
        for monochrome in [false, true] {
            for background in [Color.blue, Color.yellow] {
                for sample in samples {
                    let view = CanonicalCreatureView(agentType: sample.agent, size: 240,
                        color: monochrome ? .black : .red, monochrome: monochrome).background(background)
                    let reference = sample.rgb.map { rgb in
                        monochrome ? Color(white: Double(sample.mono)) :
                            Color(.sRGB, red: Double(rgb[0]/255), green: Double(rgb[1]/255), blue: Double(rgb[2]/255))
                    }
                    let content = view.overlay(alignment: .topLeading) {
                        if let reference { reference.frame(width: 4, height: 4) }
                    }
                    let image = ImageRenderer(content: content)
                    image.scale = 1
                    let bitmap = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.nsImage?.tiffRepresentation)))
                    let pixel = try XCTUnwrap(bitmap.colorAt(x: sample.x, y: sample.y)?.usingColorSpace(.sRGB))
                    // Compare a literal sRGB reference through the same renderer/color profile.
                    // The hole sample uses an untouched background pixel instead.
                    let referencePoint = sample.rgb == nil ? 239 : 1
                    let rgb = try XCTUnwrap(bitmap.colorAt(x: referencePoint, y: referencePoint)?.usingColorSpace(.sRGB))
                    XCTAssertEqual(pixel.redComponent, rgb.redComponent, accuracy: 0.03, sample.agent)
                    XCTAssertEqual(pixel.greenComponent, rgb.greenComponent, accuracy: 0.03, sample.agent)
                    XCTAssertEqual(pixel.blueComponent, rgb.blueComponent, accuracy: 0.03, sample.agent)
                    XCTAssertEqual(pixel.alphaComponent, 1, accuracy: 0.01, sample.agent)
                }
            }
        }
    }

    @MainActor
    func testCanonicalFeatureMaterialsSurviveWorkingIdleAndPermission() async throws {
        let library = try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource: "3d-residents", withExtension: "usdz")))
        XCTAssertNil(library.findEntity(named: "opencode_rear"), "A rear plate must not close OpenCode's real opening")
        let scene = AquariumResidents()
        scene.loadTemplates(library)
        scene.animate = false
        let expected: [(id: String, name: String, agent: String, role: String)] = [
            ("claude", "claudecode_feature_eyes_0", "claudecode", "eyes"),
            ("codex", "codex_feature_prompt_0", "codex", "prompt"),
            ("crayfish", "openclaw_feature_eyes_2", "openclaw", "eyes"),
            ("crayfish", "openclaw_feature_eye_highlight_0", "openclaw", "eye-highlight"),
            ("crayfish", "openclaw_feature_eye_highlight_1", "openclaw", "eye-highlight"),
        ]
        for phase in ["working", "idle", "permission"] {
            var state = TerrariumState()
            state.creatures = [.init(id: "claude", projectName: "Claude", modelName: nil,
                state: phase == "working" ? .working : phase == "permission" ? .asking : .sleeping,
                homeX: 0, homeY: 0, scale: 1)]
            state.cloudCreatures = [.init(id: "codex", projectName: "Codex", modelName: nil,
                state: phase == "working" ? .pulsing : phase == "permission" ? .waiting : .drifting,
                homeX: 0, homeY: 0, scale: 1)]
            state.opencodeCreatures = [.init(id: "opencode", projectName: "OpenCode", modelName: nil,
                state: phase == "working" ? .pulsing : phase == "permission" ? .waiting : .drifting,
                homeX: 0, homeY: 0, scale: 1)]
            state.crayfishVisible = true
            state.crayfishState = phase == "working" ? .routing : phase == "permission" ? .waiting : .sitting
            scene.sync(state, aspect: 1.6)
            for feature in expected {
                let resident = try XCTUnwrap(scene.residents[feature.id])
                let importedFeature = try XCTUnwrap(resident.findEntity(named: feature.name), feature.name)
                func firstMesh(_ node: Entity) -> ModelEntity? {
                    if let model = node as? ModelEntity { return model }
                    return node.children.compactMap { firstMesh($0) }.first
                }
                let model = try XCTUnwrap(firstMesh(importedFeature))
                XCTAssertTrue(importedFeature.isEnabled && model.isEnabled, phase + ": " + feature.name)
                let material = try XCTUnwrap(model.model?.materials.first as? PhysicallyBasedMaterial)
                let rgb = try XCTUnwrap(material.emissiveColor.__color.converted(
                    to: CGColorSpace(name: CGColorSpace.linearSRGB)!, intent: .defaultIntent, options: nil)?.components)
                let sourceColor = try XCTUnwrap(CreatureBrandFeatures.layers[feature.agent]?.first { $0.role == feature.role }?.color)
                let source = try XCTUnwrap(NSColor(sourceColor).cgColor.converted(
                    to: CGColorSpace(name: CGColorSpace.linearSRGB)!, intent: .defaultIntent, options: nil)?.components)
                for (actual, expected) in zip(rgb.prefix(3), source.prefix(3)) {
                    XCTAssertEqual(actual, expected, accuracy: 0.005,
                        phase + ": preserve source RGB with correct linear material conversion " + feature.name)
                }
            }
        }
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
    @MainActor
    func testNativeCiCompanionUsesOriginalAssetAndRealSessionParentWithoutRelocation() async throws {
        let scene = AquariumResidents()
        scene.loadTemplates(try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource:"3d-residents",withExtension:"usdz"))))
        scene.loadCiCompanion(try await Entity(contentsOf: XCTUnwrap(Bundle.main.url(forResource:"ci-companion",withExtension:"usdz"))))
        scene.animate = false
        scene.sync(TerrariumState(),aspect:1.6)
        XCTAssertNil(scene.root.findEntity(named:"ci-companion"),"No permanent resident without CI")
        var state = TerrariumState()
        state.cloudCreatures = [.init(id:"ci",projectName:"Work",modelName:nil,state:.drifting,homeX:0.4,homeY:0.5,scale:1)]
        scene.sync(state,aspect:1.6)
        let resident = try XCTUnwrap(scene.residents["ci"])
        let home = resident.position
        state.ciWaits = ["ci":ciWait("unknown")]
        scene.sync(state,aspect:1.6)
        XCTAssertEqual(resident.position,home)
        let companion = try XCTUnwrap(resident.findEntity(named:"ci-companion"))
        XCTAssertEqual(AquariumResidents.sessionID(for:companion),"ci")
        XCTAssertFalse(companion.visualBounds(relativeTo:resident).isEmpty)
        var clock: TimeInterval = 10
        scene.ciClock = { clock }
        state.ciWaits = ["ci":ciWait("passed",waiting:false)]
        scene.sync(state,aspect:1.6)
        XCTAssertTrue(companion.isEnabled)
        clock = 15
        scene.step(0)
        XCTAssertFalse(companion.isEnabled,"Paused native controller still expires the result cue")
        state.ciWaits = [:]
        scene.sync(state,aspect:1.6)
        XCTAssertNil(resident.findEntity(named:"ci-companion"))
    }

    func testCiOrbitUsesUtf8IdentityAndPassiveBoundedResultsWhenMotionIsPaused() {
        XCTAssertEqual(CiCompanionPresentation.seed("hello"),0.1723,accuracy:0.00001)
        XCTAssertEqual(CiCompanionPresentation.seed("ci:한글"),0.1909,accuracy:0.00001)
        var motion = CiCompanionMotion(id:"ci")
        let unknown = ciWait("unknown")
        let initial = motion.angle
        motion.update(unknown,dt:1,now:10)
        XCTAssertNotEqual(motion.angle,initial,"An evidenced unknown wait moves without claiming success")
        let last = motion.angle
        let passed = ciWait("passed",waiting:false)
        motion.update(passed,dt:0,now:11)
        XCTAssertEqual(motion.angle,last,"Result keeps the final orbit pose")
        XCTAssertTrue(motion.visible(passed,now:12))
        XCTAssertFalse(motion.visible(passed,now:16),"Expiry is independent of animation dt")
        XCTAssertFalse(CiCompanionPresentation.active(ciWait("failed",waiting:false)))
        XCTAssertFalse(CiCompanionPresentation.active(ciWait("running",waiting:false)))
        XCTAssertFalse(CiCompanionPresentation.active(ciWait("queued",waiting:false)))
        for phase in ["unknown", "queued", "running"] {
            var fresh = CiCompanionMotion(id: "ci")
            fresh.update(passed,dt:0,now:20)
            let inactive=ciWait(phase,waiting:false,openedAt:2)
            fresh.update(inactive,dt:0,now:21)
            XCTAssertFalse(fresh.visible(inactive,now:21),"Old result cannot leak into a different nonwaiting record")
        }
    }

    private func ciWait(_ phase: String, waiting: Bool = true, openedAt: Int = 1) -> CiWaitStatus {
        .init(kind: "ci", provider: "github-actions", phase: phase, agentWaiting: waiting,
              evidence: "github", openedAt: openedAt, checks: .init(total: 10, passed: 7, failed: 0, pending: 3), pr: 432)
    }

    func testPrimaryPermissionFrameOverridesStaleIdleCiRosterForEveryCreatureKind() {
        for kind in ["claude-code", "codex-cli", "opencode", "hermes", "kiro-cli", "antigravity"] {
            for permission in [AgentConnectionState.awaitingPermission, .awaitingOption, .awaitingDiff] {
                var dashboard = DashboardState()
                dashboard.state = permission; dashboard.agentType = kind; dashboard.sessionId = "self"
                dashboard.siblingSessions = [SessionInfo(id: "self",port: 0,projectName: "Work",agentType: kind,state: "idle")]
                dashboard.siblingSessions[0].waitingOn = ciWait("running")
                let state = dashboard.toTerrariumState()
                XCTAssertEqual(AquariumResident.project(state).first?.activity,.waiting,kind)
                XCTAssertNil(state.ciWaits["self"],kind)
                XCTAssertNil(state.ciWaitLabels["self"],kind)
                XCTAssertFalse(state.ciWaitingIDs.contains("self"),kind)
            }
        }
    }

    func testCiStationVisitsKeepSeparateCodexIdentitiesAndPermissionPriority() {
        var dashboard = DashboardState()
        dashboard.state = .idle
        dashboard.siblingSessions = [session(id: "a", project: "Same"), session(id: "b", project: "Same"), session(id: "permission", project: "Same", state: "awaiting_permission")]
        for i in dashboard.siblingSessions.indices { dashboard.siblingSessions[i].waitingOn = ciWait("running", openedAt: 3-i) }
        let state = dashboard.toTerrariumState()
        XCTAssertEqual(Set(state.cloudCreatures.map(\.id)), ["a", "b", "permission"])
        XCTAssertEqual(state.ciWaitingIDs, ["a", "b"])
        XCTAssertNil(state.ciWaitLabels["permission"])
        XCTAssertEqual(Set(state.ciWaits.keys),["a","b"])
        XCTAssertEqual(state.ciWaitLabels["a"], "CI RUNNING #432 · 7/10")
        let items = AquariumResident.project(state)
        XCTAssertEqual(AquariumResident.foreground(items, focusedID: nil).first?.id, "permission")
    }

    @MainActor
    func testCanvasCiCompanionLeavesSessionAtItsNormalHomeAndClearsOnNull() {
        let plain = TerrariumRenderer(), waiting = TerrariumRenderer()
        plain.animateHermes = false; waiting.animateHermes = false; waiting.animateCompanions = false
        var state = TerrariumState()
        state.hermesCreatures = [.init(id:"ci",projectName:"Work",activity:.idle)]
        plain.update(dt:0,state:state)
        state.ciWaits = ["ci":ciWait("unknown")]
        waiting.update(dt:0,state:state)
        XCTAssertEqual(plain.creatureAtPoint(nx:0.5,ny:0.82-2.5/7),"ci")
        XCTAssertEqual(waiting.creatureAtPoint(nx:0.5,ny:0.82-2.5/7),"ci")
        state.ciWaits = [:]; waiting.update(dt:0,state:state)
        XCTAssertEqual(waiting.creatureAtPoint(nx:0.5,ny:0.82-2.5/7),"ci")
    }

    @MainActor
    func testOriginalOctocatCanvasMotionPreviewAndSpriteResource() throws {
        XCTAssertEqual(CiCompanionPresentation.sprite?.width,896)
        let renderer = TerrariumRenderer()
        var state = TerrariumState()
        state.creatures = [.init(id:"ci-preview",projectName:"Agent session",modelName:nil,state:.floating,homeX:0.50,homeY:0.50,scale:1)]
        state.ciWaits = ["ci-preview":ciWait("running")]
        let folder = URL(fileURLWithPath:"/tmp/ci-orbit-preview",isDirectory:true)
        try FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
        for frame in 0..<32 {
            for _ in 0..<10 { renderer.update(dt:0.025,state:state) }
            let image = ImageRenderer(content:Canvas { c,size in renderer.draw(context:&c,size:size) }.frame(width:800,height:500))
            image.scale = 1
            let data = try XCTUnwrap(image.nsImage?.tiffRepresentation)
            let png = try XCTUnwrap(NSBitmapImageRep(data:data)?.representation(using:.png,properties:[:]))
            try png.write(to:folder.appendingPathComponent(String(format:"canvas-%02d.png",frame)))
        }
    }

    @MainActor
    func testCiCompanionCanvasCrowdsRenderEveryPhaseAndAbsent() throws {
        for count in [0, 1, 8, 48] {
            for phase in ["unknown", "queued", "running", "passed", "failed"] {
                for (width,height) in [(1200,750), (600,900)] {
                    let renderer = TerrariumRenderer()
                    renderer.animateCompanions = false; renderer.animateHermes = false
                    var state = TerrariumState()
                    let slots = CreatureLayout.layoutOctopuses(count: count)
                    state.creatures = (0..<count).map { .init(id: "s\($0)", projectName: "Work \($0)", modelName: nil,
                        state: .floating, homeX: slots[$0].x, homeY: slots[$0].y, scale: slots[$0].scale) }
                    state.ciWaits = Dictionary(uniqueKeysWithValues: state.creatures.map { ($0.id, ciWait(phase, waiting: phase != "passed" && phase != "failed", openedAt: Int($0.id.dropFirst()) ?? 0)) })
                    state.ciWaitingIDs = phase == "passed" ? [] : Set(state.creatures.map(\.id))
                    renderer.update(dt: 0, state: state)
                    let image = ImageRenderer(content: Canvas { context,size in renderer.draw(context: &context,size: size) }.frame(width: CGFloat(width),height: CGFloat(height)))
                    image.scale = 1
                    let bitmap = try XCTUnwrap(image.nsImage?.tiffRepresentation)
                    XCTAssertGreaterThan(bitmap.count, 100)
                    do {
                        let output = ProcessInfo.processInfo.environment["AGENTDECK_CI_VISUAL_OUTPUT"] ?? "/tmp/ci-orbit-visuals"
                        let folder = URL(fileURLWithPath: output, isDirectory: true)
                        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                        let data = try XCTUnwrap(NSBitmapImageRep(data: bitmap)?.representation(using: .png, properties: [:]))
                        try data.write(to: folder.appendingPathComponent("canvas-\(count)-\(phase)-\(width)x\(height).png"))
                    }
                }
            }
        }
    }
}
#endif
