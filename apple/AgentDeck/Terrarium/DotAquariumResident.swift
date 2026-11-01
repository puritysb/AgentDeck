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

/// Pearl geometry only. The common resident layout, labels and shell clock own its presentation.
@available(iOS 18.0, macOS 15.0, *)
@MainActor
final class DotAquariumResident {
    let root = Entity()
    private let body: ModelEntity
    private let portrait = ModelEntity()
    private var portraitID: String?
    init() {
        root.name = "resident_dot"
        body = ModelEntity(mesh: .generateSphere(radius: Float(DotHabitatRules.pearlRadius)),
            materials: [SimpleMaterial(color: DotNativeColor(DesignTokens.Tide.s100), roughness: 0.22, isMetallic: false)])
        body.name = "pearl"
        root.addChild(body)
        for x: Float in [-Float(DotHabitatRules.pearlEyeX), Float(DotHabitatRules.pearlEyeX)] {
            let eye = ModelEntity(mesh: .generateSphere(radius: Float(DotHabitatRules.pearlEyeRadius)), materials: [UnlitMaterial(color: DotNativeColor(DesignTokens.Ink.s900))])
            eye.name = "pearl-eye"; eye.scale = [1, Float(DotHabitatRules.pearlEyeAspect), Float(DotHabitatRules.pearlEyeDepth)]; eye.position = [x, Float(DotHabitatRules.pearlEyeY), Float(DotHabitatRules.pearlEyeZ)]
            root.addChild(eye)
        }
        let shine = ModelEntity(mesh: .generateSphere(radius: Float(DotHabitatRules.pearlShineRadius)), materials: [UnlitMaterial(color: DotNativeColor(DesignTokens.Tide.s50))])
        shine.position = [Float(DotHabitatRules.pearlShineX), Float(DotHabitatRules.pearlShineY), Float(DotHabitatRules.pearlShineZ)]; shine.scale = [Float(DotHabitatRules.pearlShineWidth), Float(DotHabitatRules.pearlShineHeight), Float(DotHabitatRules.pearlShineDepth)];root.addChild(shine)
        portrait.name = "pearl-portrait"
        portrait.model = ModelComponent(mesh: .generatePlane(width: Float(DotHabitatRules.pearlDecalSize), depth: Float(DotHabitatRules.pearlDecalSize)), materials: [])
        portrait.orientation = simd_quatf(angle: .pi / 2, axis: [1,0,0]);portrait.position.z = Float(DotHabitatRules.pearlDecalZ)
        portrait.isEnabled = false;root.addChild(portrait)
        root.components.set(CollisionComponent(shapes: [.generateSphere(radius: 0.31)]))
        root.components.set(InputTargetComponent())
    }
    func sync(_ snapshot: DotSurfaceSnapshot?, now: Int) {
        guard snapshot?.appearance?.id != portraitID else { return }
        portraitID = snapshot?.appearance?.id;portrait.isEnabled = false
        for eye in root.children where eye.name == "pearl-eye" { eye.isEnabled = true }
        guard let data = snapshot?.appearance?.portrait,
              let source = CGImageSourceCreateWithData(data as CFData,nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,
                  kCGImageSourceThumbnailMaxPixelSize:DotAppearanceRules.portraitSize] as CFDictionary),
              let texture = try? TextureResource.generate(from:image,options:.init(semantic:.color)) else { return }
        var material = UnlitMaterial();material.color = .init(texture:.init(texture));material.blending = .transparent(opacity:.init(floatLiteral:1))
        portrait.model?.materials = [material];portrait.isEnabled = true
        for eye in root.children where eye.name == "pearl-eye" { eye.isEnabled = false }
    }
    static func contains(_ entity: Entity) -> Bool {
        var current: Entity? = entity
        while let node = current { if node.name == "resident_dot" || node.name == "session|habitat:dot" || node.name == "substrate|habitat:dot" { return true }; current=node.parent }
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
