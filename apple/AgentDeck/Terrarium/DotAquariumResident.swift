import SwiftUI
import RealityKit
import ImageIO
#if os(macOS)
import AppKit
private typealias DotNativeColor = NSColor
#else
import UIKit
private typealias DotNativeColor = UIColor
#endif

/// Original companion geometry. It has no session ID and never joins the agent roster.
@available(iOS 18.0, macOS 15.0, *)
@MainActor
final class DotAquariumResident {
    let root = Entity()
    private let body: ModelEntity
    private var code = 1
    private var displayedCode: Int?
    private var portraitID: String?
    private let portrait = ModelEntity()
    private let badge = ModelEntity()
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
            let eye = ModelEntity(mesh: .generateSphere(radius: 0.035), materials: [UnlitMaterial(color: DotNativeColor(DesignTokens.Ink.s900))])
            eye.scale = [1, 1.7, 0.6]
            eye.position = [x, 0.04, 0.26]
            root.addChild(eye)
        }
        portrait.name = "dot-portrait"
        portrait.model = ModelComponent(mesh: .generatePlane(width: 0.56, depth: 0.56), materials: [])
        portrait.orientation = simd_quatf(angle: .pi / 2, axis: [1, 0, 0])
        portrait.isEnabled = false
        root.addChild(portrait)
        badge.position = [-0.28, -0.4, 0.28]
        root.addChild(badge)
        root.components.set(CollisionComponent(shapes: [.generateSphere(radius: 0.34)]))
        root.components.set(InputTargetComponent())
    }

    func sync(_ snapshot: DotSurfaceSnapshot?, now: Int) {
        root.isEnabled = snapshot?.configured == true
        code = snapshot?.phase(at: now) ?? 1
        body.model?.materials = [SimpleMaterial(color: DotNativeColor(DotSurfaceView.tint(code)), roughness: 0.5, isMetallic: false)]
        if displayedCode != code {
            displayedCode = code
            let mark = "DOT " + DotAppearanceRules.labels[code]
            badge.model = ModelComponent(mesh: .generateText(mark, extrusionDepth: 0.002,
                font: .init(name: "IBMPlexSans-Bold", size: 0.07) ?? .systemFont(ofSize: 0.07)),
                materials: [UnlitMaterial(color: DotNativeColor(DotSurfaceView.tint(code)))])
        }
        if code != 2 { root.position = home }
        if snapshot?.appearance?.id != portraitID {
            portraitID = snapshot?.appearance?.id
            portrait.isEnabled = false; body.isEnabled = true
            for child in root.children where child !== body && child !== portrait && child !== badge { child.isEnabled = true }
            if let data = snapshot?.appearance?.portrait, let source = CGImageSourceCreateWithData(data as CFData, nil),
               let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceThumbnailMaxPixelSize: DotAppearanceRules.portraitSize] as CFDictionary),
               let texture = try? TextureResource.generate(from: image, options: .init(semantic: .color)) {
                var material = UnlitMaterial()
                material.color = .init(texture: .init(texture))
                material.blending = .transparent(opacity: .init(floatLiteral: 1))
                portrait.model?.materials = [material]; portrait.isEnabled = true; body.isEnabled = false
                for child in root.children where child !== body && child !== portrait && child !== badge { child.isEnabled = false }
            }
        }
    }
    #if os(macOS)
    func sync(_ snapshot: DotHostSnapshot, now: Int) {
        let frame = snapshot.deckSnapshot(now: now)
        let surface = frame.flatMap { try? JSONSerialization.data(withJSONObject: $0) }
            .flatMap { try? JSONDecoder().decode(DotSurfaceSnapshot.self, from: $0) }
        sync(surface, now: now)
    }
    #endif

    func step(_ delta: Double) {
        guard animate && root.isEnabled && code == 2 else { return }
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

#if os(macOS)
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
