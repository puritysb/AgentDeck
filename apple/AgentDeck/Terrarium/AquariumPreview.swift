import SwiftUI
import RealityKit
import os
import Observation

private let aquariumAssetLogger = Logger(subsystem: "bound.serendipity.agent.deck", category: "aquarium-assets")

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
    #if os(macOS)
    @State private var dot = DotAquariumResident()
    @State private var showDot = false
    #endif
    @State private var cameraRig = AquariumCameraRig()
    @State private var cancelUpdate: (() -> Void)?
    @State private var visible = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var controllers: [AnimationPlaybackController] = []
    @State private var assets = AquariumAssetLoader()

    var body: some View {
        GeometryReader { geometry in
            if let loaded = assets.loaded {
                RealityView { content in
                    content.camera = .virtual
                    let camera = PerspectiveCamera()
                    camera.camera.fieldOfViewInDegrees = geometry.size.width / max(1, geometry.size.height) > CGFloat(TerrariumRules.nativeCameraWideAspect) ? TerrariumRules.nativeCameraWideFov : TerrariumRules.nativeCameraFov
                    camera.look(at: [0, 1.65, -0.7], from: [0, 4.8, 14], relativeTo: nil)
                    content.add(camera)
                    #if os(macOS)
                    content.add(dot.root)
                    #endif
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
                        let root = loaded.habitat
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
                        let library = loaded.residents
                        residents.loadTemplates(library)
                        guard residents.templateCount == 6 else { throw CocoaError(.fileReadCorruptFile) }
                        residents.loadHermesTemplate(loaded.hermes)
                        guard residents.templateCount == 7 else { throw CocoaError(.fileReadCorruptFile) }
                        residents.loadCiCompanion(loaded.ciCompanion)
                        content.add(residents.root)
                        residents.sync(terrariumState, aspect: Float(geometry.size.width / max(1, geometry.size.height)))
                        let stepCompanion = companionStepper()
                        let subscription = content.subscribe(to: SceneEvents.Update.self) { [weak residents, weak cameraRig] event in
                            residents?.step(event.deltaTime)
                            stepCompanion(event.deltaTime)
                            cameraRig?.step(event.deltaTime)
                        }
                        cancelUpdate = { subscription.cancel() }
                    } catch {
                        assets.reportSceneFailure(error, templateCount: residents.templateCount)
                    }
                } update: { _ in
                    cameraRig.viewing = viewingMode
                    cameraRig.reduceMotion = reduceMotion
                    residents.labelsVisible = !viewingMode
                    cameraRig.camera?.camera.fieldOfViewInDegrees = geometry.size.width / max(1, geometry.size.height) > CGFloat(TerrariumRules.nativeCameraWideAspect) ? TerrariumRules.nativeCameraWideFov : TerrariumRules.nativeCameraFov
                    residents.sync(terrariumState, aspect: Float(geometry.size.width / max(1, geometry.size.height)))
                }
                .gesture(SpatialTapGesture().targetedToAnyEntity().onEnded { value in
                    #if os(macOS)
                    if DotAquariumResident.contains(value.entity) { showDot = true; return }
                    #endif
                    if let id = AquariumResidents.sessionID(for: value.entity) { onCreatureTapped?(id) }
                    else if value.entity.name == "aquarium-background" { onBackgroundTapped?() }
                })
                .overlay {
                    if let failure = assets.failure {
                        TerrariumView(terrariumState: terrariumState, includeHabitat: false,
                                      onCreatureTapped: onCreatureTapped, onBackgroundTapped: onBackgroundTapped)
                        Text(failure).padding().background(.regularMaterial)
                    }
                }
            } else {
                TerrariumView(terrariumState: terrariumState, onCreatureTapped: onCreatureTapped, onBackgroundTapped: onBackgroundTapped)
                    .overlay { if let failure = assets.failure { Text(failure).padding().background(.regularMaterial) } }
            }
        }
        .task { await assets.load() }
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
        #if os(macOS)
        .task {
            while !Task.isCancelled {
                dot.sync(await DotHost.shared.snapshot(), now: Int(Date().timeIntervalSince1970 * 1000))
                try? await Task.sleep(for: .seconds(1))
            }
        }
        .sheet(isPresented: $showDot) {
            VStack {
                HStack { Text("Dot requests and relationships").font(.headline); Spacer(); Button("Done") { showDot = false } }
                ScrollView { DotSettingsView() }
            }.padding().frame(width: 580, height: 650)
        }
        #endif
        .onAppear { visible = true; updatePlayback() }
        .onChange(of: controllers.count) { _, _ in updatePlayback() }
        .onChange(of: reduceMotion) { _, _ in updatePlayback() }
        .onChange(of: scenePhase) { _, _ in updatePlayback() }
        .onDisappear {
            visible = false
            assets.invalidate()
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

    private func companionStepper() -> (Double) -> Void {
        #if os(macOS)
        return { [weak dot] in dot?.step($0) }
        #else
        return { _ in }
        #endif
    }

    private func updatePlayback() {
        let playing = visible && !reduceMotion && scenePhase == .active
        residents.animate = playing
        #if os(macOS)
        dot.animate = playing
        #endif
        // Keep expiry checks alive on a retained visible scene even under Reduce Motion.
        if visible && scenePhase == .active, cancelUpdate == nil, let scene = residents.root.scene {
            let stepCompanion = companionStepper()
            let subscription = scene.subscribe(to: SceneEvents.Update.self) { [weak residents, weak cameraRig] event in
                residents?.step(event.deltaTime)
                            stepCompanion(event.deltaTime)
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


/// Asset I/O has its own view lifetime. RealityView.make remains synchronous:
/// roster/preference changes during import cannot latch a cancellation as a
/// corrupt-asset failure or let an obsolete attempt overwrite a newer load.
@available(iOS 18.0, macOS 15.0, *)
@MainActor
@Observable
final class AquariumAssetLoader {
    struct Assets {
        let habitat: Entity
        let residents: Entity
        let hermes: Entity
        let ciCompanion: Entity
    }
    private(set) var loaded: Assets?
    private(set) var failure: String?
    private var generation = 0
    func invalidate() { generation += 1 }
    func load(importEntity: @MainActor (URL) async throws -> Entity = { try await Entity(contentsOf: $0) }) async {
        guard loaded == nil else { return }
        generation += 1
        let current = generation
        failure = nil
        var stage = "habitat"
        do {
            func url(_ name: String) throws -> URL {
                guard let url = Bundle.main.url(forResource: name, withExtension: "usdz") else { throw CocoaError(.fileNoSuchFile) }
                return url
            }
            func checkCurrent() throws {
                try Task.checkCancellation()
                guard current == generation else { throw CancellationError() }
            }
            let habitat = try await importEntity(url("living-aquarium")); try checkCurrent()
            stage = "resident library"
            let residents = try await importEntity(url("3d-residents")); try checkCurrent()
            stage = "Hermes resident"
            let hermes = try await importEntity(url("hermes-mermaid")); try checkCurrent()
            stage = "CI companion"
            let ciCompanion = try await importEntity(url("ci-companion")); try checkCurrent()
            loaded = Assets(habitat: habitat, residents: residents, hermes: hermes, ciCompanion: ciCompanion)
            aquariumAssetLogger.debug("Loaded all aquarium assets")
        } catch is CancellationError {
            aquariumAssetLogger.debug("Cancelled aquarium asset load at \(stage, privacy: .public)")
        } catch {
            guard current == generation, !Task.isCancelled else { return }
            aquariumAssetLogger.error("Could not load \(stage, privacy: .public): \(String(describing: error), privacy: .public)")
            failure = "The 3D aquarium could not be opened. Your dashboard is still available."
        }
    }
    func reportSceneFailure(_ error: Error, templateCount: Int) {
        aquariumAssetLogger.error("Could not assemble aquarium: \(String(describing: error), privacy: .public); resident templates \(templateCount)")
        failure = "The 3D aquarium could not be opened. Your dashboard is still available."
    }
}
