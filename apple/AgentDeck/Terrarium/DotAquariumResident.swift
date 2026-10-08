#if os(macOS)
import SwiftUI
import RealityKit

/// Original companion geometry. It has no session ID and never joins the agent roster.
@MainActor
final class DotAquariumResident {
    let root = Entity()
    private let body: ModelEntity
    private var phase: DotPresentation.Phase = .offline
    private var elapsed: Double = 0
    var animate = false
    private let home = SIMD3<Float>(3.1, 3.8, 0.8)

    init() {
        root.name = "dot-companion"
        root.position = home
        root.isEnabled = false
        body = ModelEntity(mesh: .generateSphere(radius: 0.28), materials: [])
        body.name = "dot-body"
        root.addChild(body)
        for x: Float in [-0.09, 0.09] {
            let eye = ModelEntity(mesh: .generateSphere(radius: 0.035), materials: [UnlitMaterial(color: NSColor(DesignTokens.Ink.s900))])
            eye.scale = [1, 1.7, 0.6]
            eye.position = [x, 0.04, 0.26]
            root.addChild(eye)
        }
        root.components.set(CollisionComponent(shapes: [.generateSphere(radius: 0.34)]))
        root.components.set(InputTargetComponent())
    }

    func sync(_ snapshot: DotHostSnapshot, now: Int) {
        root.isEnabled = snapshot.available && !snapshot.origin.isEmpty
        phase = DotPresentation.resolve(hosting: snapshot.hosting, connected: !snapshot.grants.isEmpty,
                                        request: snapshot.reports.first, now: now).phase
        body.model?.materials = [SimpleMaterial(color: NSColor(DotPresentation.tint(phase)), roughness: 0.5, isMetallic: false)]
        if ![.working, .completed].contains(phase) { root.position = home }
    }

    func step(_ delta: Double) {
        guard animate && root.isEnabled && [.working, .completed].contains(phase) else { return }
        elapsed += min(max(delta, 0), 1.0 / 20)
        root.position = home + [0, Float(sin(elapsed * 2)) * 0.06, 0]
    }

    static func contains(_ entity: Entity) -> Bool {
        var current: Entity? = entity
        while let node = current {
            if node.name == "dot-companion" { return true }
            current = node.parent
        }
        return false
    }
}

extension DotPresentation {
    static func tint(_ phase: Phase) -> Color {
        switch phase {
        case .working: DesignTokens.Session.working
        case .attention: DesignTokens.Session.awaiting
        case .failed: DesignTokens.Session.error
        case .offline, .stale, .unlinked: DesignTokens.Ink.s300
        default: DesignTokens.Kelp.s300
        }
    }
}
#endif
