import SwiftUI
import RealityKit

/// An opt-in native model trial; the existing live dashboard remains the default.
struct AquariumPreview: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if #available(iOS 18.0, macOS 15.0, *) {
                LivingAquariumScene()
            } else {
                Text("The 3D aquarium requires iOS 18 or later.")
                    .padding()
            }
            Button("Back to dashboard") { dismiss() }
                .buttonStyle(.borderedProminent)
                .padding()
        }
        .frame(minWidth: 320, minHeight: 300)
    }
}

@available(iOS 18.0, macOS 15.0, *)
struct LivingAquariumScene: View {
    var viewingMode = false
    var terrariumState = TerrariumState()
    var onCreatureTapped: ((String) -> Void)?
    var onBackgroundTapped: (() -> Void)?
    @State private var residents = AquariumResidents()
    @State private var cameraRig = AquariumCameraRig()
    @State private var cancelUpdate: (() -> Void)?
    @State private var visible = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var controllers: [AnimationPlaybackController] = []
    @State private var failure: String?

    var body: some View {
        GeometryReader { geometry in
            RealityView { content in
                content.camera = .virtual
                let camera = PerspectiveCamera()
                camera.camera.fieldOfViewInDegrees = geometry.size.width / max(1, geometry.size.height) > CGFloat(TerrariumRules.nativeCameraWideAspect) ? TerrariumRules.nativeCameraWideFov : TerrariumRules.nativeCameraFov
                camera.look(at: [0, 1.65, -0.7], from: [0, 4.8, 14], relativeTo: nil)
                content.add(camera)
                cameraRig.camera = camera
                residents.camera = camera
                cameraRig.viewing = viewingMode
                cameraRig.reduceMotion = reduceMotion
                let background = Entity()
                background.name = "aquarium-background"
                background.position.z = -5
                background.components.set(CollisionComponent(shapes: [.generateBox(size: [100,100,0.01])]))
                background.components.set(InputTargetComponent())
                content.add(background)
                let sun = DirectionalLight()
                sun.light.intensity = 5_000
                sun.look(at: [0, 0, 0], from: [-4, 8, 5], relativeTo: nil)
                content.add(sun)
                let fill = DirectionalLight()
                fill.light.intensity = 900
                fill.look(at: [0, 1, 0], from: [4, 4, -4], relativeTo: nil)
                content.add(fill)
                do {
                    guard let url = Bundle.main.url(forResource: "living-aquarium", withExtension: "usdz") else {
                        throw CocoaError(.fileNoSuchFile)
                    }
                    let root = try await Entity(contentsOf: url)
                    applyWaterMaterial(to: root)
                    content.add(root)
                    residents.shoal.load(root)
                    content.add(residents.shoal.root)
                    // USDZ exposes the same tracks through global and per-node libraries.
                    // Playing all of them overlays competing transforms; use one scene clip.
                    var playback: [AnimationPlaybackController] = []
                    if let animation = root.availableAnimations.first {
                        playback.append(root.playAnimation(animation.repeat(), startsPaused: true))
                    }
                    controllers = playback
                    guard let residentURL = Bundle.main.url(forResource: "3d-residents", withExtension: "usdz") else {
                        throw CocoaError(.fileNoSuchFile)
                    }
                    let library = try await Entity(contentsOf: residentURL)
                    residents.loadTemplates(library)
                    guard residents.templateCount == 6 else { throw CocoaError(.fileReadCorruptFile) }
                    content.add(residents.root)
                    residents.sync(terrariumState, aspect: Float(geometry.size.width / max(1, geometry.size.height)))
                    let subscription = content.subscribe(to: SceneEvents.Update.self) { [weak residents, weak cameraRig] event in
                        residents?.step(event.deltaTime)
                        cameraRig?.step(event.deltaTime)
                    }
                    cancelUpdate = { subscription.cancel() }
                } catch {
                    failure = "The 3D aquarium could not be opened. Your dashboard is still available."
                }
            } update: { _ in
                cameraRig.viewing = viewingMode
                cameraRig.reduceMotion = reduceMotion
                residents.labelsVisible = !viewingMode
                cameraRig.camera?.camera.fieldOfViewInDegrees = geometry.size.width / max(1, geometry.size.height) > CGFloat(TerrariumRules.nativeCameraWideAspect) ? TerrariumRules.nativeCameraWideFov : TerrariumRules.nativeCameraFov
                residents.sync(terrariumState, aspect: Float(geometry.size.width / max(1, geometry.size.height)))
            }
            .gesture(SpatialTapGesture().targetedToAnyEntity().onEnded { value in
                if let id = AquariumResidents.sessionID(for: value.entity) { onCreatureTapped?(id) }
                else if value.entity.name == "aquarium-background" { onBackgroundTapped?() }
            })
            .overlay {
                if let failure {
                    TerrariumView(terrariumState: terrariumState, includeHabitat: false,
                                  onCreatureTapped: onCreatureTapped, onBackgroundTapped: onBackgroundTapped)
                    Text(failure).padding().background(.regularMaterial)
                }
            }
        }
        .overlay(alignment: .bottom) {
            let count = AquariumResident.project(terrariumState).count
            if !viewingMode && count > TerrariumRules.nativeResidentLimit {
                Text("\(count) residents · Select a session in the list to bring it into view")
                    .font(.caption)
                    .foregroundStyle(TerrariumColors.hudText)
                    .padding(8)
                    .background(TerrariumColors.deepSea.opacity(0.95), in: RoundedRectangle(cornerRadius: 8))
                    .padding(.bottom, 8)
                    .allowsHitTesting(false)
            }
        }
        // The async loader captures the initial environment. Reconcile playback
        // in the refreshed view so a background → active transition during load
        // cannot leave the newly-created controller paused forever.
        .onAppear { visible = true; updatePlayback() }
        .onChange(of: controllers.count) { _, _ in updatePlayback() }
        .onChange(of: reduceMotion) { _, _ in updatePlayback() }
        .onChange(of: scenePhase) { _, _ in updatePlayback() }
        .onDisappear {
            visible = false
            updatePlayback()
            cancelUpdate?()
            cancelUpdate = nil
        }
    }

    /// The water enclosure should recede, not reflect the key light like a wall.
    /// A token-bound unlit material also avoids a bright horizon across imports.
    private func applyWaterMaterial(to entity: Entity) {
        if entity.name.lowercased().contains("garden") && entity.name.lowercased().contains("water"),
           var model = entity.components[ModelComponent.self] {
            #if os(macOS)
            let color = NSColor(TerrariumColors.deepSea)
            #else
            let color = UIColor(TerrariumColors.deepSea)
            #endif
            model.materials = [UnlitMaterial(color: color, applyPostProcessToneMap: false)]
            entity.components.set(model)
        }
        for child in entity.children { applyWaterMaterial(to: child) }
    }

    private func updatePlayback() {
        let playing = visible && !reduceMotion && scenePhase == .active
        residents.animate = playing
        if playing, cancelUpdate == nil, let scene = residents.root.scene {
            let subscription = scene.subscribe(to: SceneEvents.Update.self) { [weak residents, weak cameraRig] event in
                residents?.step(event.deltaTime)
                cameraRig?.step(event.deltaTime)
            }
            cancelUpdate = { subscription.cancel() }
        }
        for controller in controllers {
            if !playing { controller.pause() }
            else { controller.resume() }
        }
    }
}

/// Keep camera motion independent of HUD layout and resident animation state.
@available(iOS 18.0, macOS 15.0, *)
@MainActor
private final class AquariumCameraRig {
    var camera: PerspectiveCamera?
    var viewing = false
    var reduceMotion = false
    private var distanceScale: Float = 1

    func step(_ seconds: TimeInterval) {
        let target: Float = viewing ? TerrariumRules.nativeViewingDistance : 1
        let blend: Float = reduceMotion ? 1 : 1 - exp(-Float(min(seconds, 0.1)) / TerrariumRules.nativeViewingResponseSeconds)
        distanceScale += (target - distanceScale) * blend
        camera?.look(at: [0, 1.65, -0.7],
                     from: [0, 1.65 + 3.15 * distanceScale, -0.7 + 14.7 * distanceScale], relativeTo: nil)
    }
}
