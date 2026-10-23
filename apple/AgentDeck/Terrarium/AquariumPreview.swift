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
    var renderingEnabled = true
    var viewingMode = false
    var terrariumState = TerrariumState()
    var communications = AquariumCommunications.empty
    var communicationLabelInsets = EdgeInsets()
    #if AGENTDECK_DOT_PREVIEW
    var dotSnapshot: DotSurfaceSnapshot?
    #endif
    var onCreatureTapped: ((String) -> Void)?
    var onBackgroundTapped: (() -> Void)?
    @State private var scene = AquariumSceneState()
    #if AGENTDECK_DOT_PREVIEW
    @State private var dot = DotAquariumResident()
    @State private var showDot = false
    #endif
    @State private var rendererLifetime = AquariumRendererLifetime()

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var assets = AquariumAssetLoader()

    private var residents: AquariumResidents { scene.residents }
    private var visible: Bool { rendererLifetime.isVisible }

    var body: some View {
        GeometryReader { geometry in
            if renderingEnabled, visible, let loaded = assets.loaded {
                realitySurface(loaded: loaded, size: geometry.size)
                .id(rendererLifetime.identity)
                .overlay {
                    AquariumCommunicationOverlay(communications: communications, labels: !viewingMode, labelInsets: communicationLabelInsets) { id in
                        residents.communicationPosition(id, aspect: Float(geometry.size.width / max(1, geometry.size.height)))
                    }
                }
                .gesture(SpatialTapGesture().targetedToAnyEntity().onEnded { value in
                    #if AGENTDECK_DOT_PREVIEW
                    if DotAquariumResident.contains(value.entity) { showDot = true; return }
                    #endif
                    if let id = AquariumResidents.sessionID(for: value.entity) { onCreatureTapped?(id) }
                    else if value.entity.name == "aquarium-background" { onBackgroundTapped?() }
                })
                .overlay {
                    if let failure = assets.failure {
                        TerrariumView(terrariumState: terrariumState, includeHabitat: false,
                                      communications: communications, showsCommunicationLabels: !viewingMode, communicationLabelInsets: communicationLabelInsets,
                                      onCreatureTapped: onCreatureTapped, onBackgroundTapped: onBackgroundTapped)
                        Text(failure).padding().background(.regularMaterial)
                    }
                }
            } else {
                TerrariumView(terrariumState: terrariumState, animationPaused: !renderingEnabled || !visible, communications: communications,
                              showsCommunicationLabels: !viewingMode, communicationLabelInsets: communicationLabelInsets, onCreatureTapped: onCreatureTapped, onBackgroundTapped: onBackgroundTapped)
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
        #if AGENTDECK_DOT_PREVIEW
        .sheet(isPresented: $showDot) {
            VStack {
                HStack { Text("Dot requests and relationships").font(.headline); Spacer(); Button("Done") { showDot = false } }
                if let dotSnapshot { DotSurfaceView(snapshot: dotSnapshot) }
            }.padding().frame(width: 580, height: 650)
        }
        .onChange(of: dotSnapshot?.appearance?.id) { _, _ in dot.sync(dotSnapshot, now: Int(Date().timeIntervalSince1970 * 1000)) }
        #endif
        .onAppear { rendererLifetime.appear(); updatePlayback() }
        .onChange(of: renderingEnabled) { _, enabled in
            if !enabled {
                rendererLifetime.invalidateRenderer()
                scene.suspend()
            }
            updatePlayback()
        }
        .onChange(of: reduceMotion) { _, _ in updatePlayback() }
        .onChange(of: scenePhase) { _, _ in updatePlayback() }
        .onDisappear {
            rendererLifetime.disappear()
            assets.invalidate()
            updatePlayback()
            scene.suspend()
        }
    }

    private func realitySurface(loaded: AquariumAssetLoader.Assets, size: CGSize) -> AquariumRealitySurface {
        var surface = AquariumRealitySurface(
            scene: scene, loaded: loaded, state: terrariumState, size: size,
            viewingMode: viewingMode, reduceMotion: reduceMotion,
            active: visible && renderingEnabled && scenePhase == .active,
            onFailure: { assets.reportSceneFailure($0, templateCount: residents.templateCount) }
        )
        #if AGENTDECK_DOT_PREVIEW
        surface.companion = dot.root
        surface.updateCompanion = {
            dot.labelsVisible = !viewingMode
            dot.sync(dotSnapshot, now: Int(Date().timeIntervalSince1970 * 1000))
        }
        surface.stepCompanion = { [weak dot] in dot?.step($0) }
        #endif
        return surface
    }

    private func updatePlayback() {
        let active = visible && renderingEnabled && scenePhase == .active
        scene.updatePlayback(active: active, reduceMotion: reduceMotion)
        #if AGENTDECK_DOT_PREVIEW
        dot.animate = active && !reduceMotion
        #endif
    }
}

/// SwiftUI may retain a covered view and coalesce its offscreen body updates.
/// A new identity on disappearance still forces a fresh renderer on return.
struct AquariumRendererLifetime {
    private(set) var isVisible = false
    private(set) var identity = UUID()

    mutating func appear() { isVisible = true }

    mutating func invalidateRenderer() { identity = UUID() }

    mutating func disappear() {
        guard isVisible else { return }
        isVisible = false
        invalidateRenderer()
    }
}

/// Only this child owns a renderer lifetime. The parent retains the imported
/// assets and scene state while Settings or an obscured Dashboard suspends it.
@available(iOS 18.0, macOS 15.0, *)
private struct AquariumRealitySurface: View {
    let scene: AquariumSceneState
    let loaded: AquariumAssetLoader.Assets
    let state: TerrariumState
    let size: CGSize
    let viewingMode: Bool
    let reduceMotion: Bool
    let active: Bool
    let onFailure: (Error) -> Void
    var companion: Entity?
    var updateCompanion: () -> Void = {}
    var stepCompanion: (Double) -> Void = { _ in }
    @State private var mountID = UUID()

    var body: some View {
        RealityView { content in
            guard !Task.isCancelled else { return }
            do {
                try scene.prepare(loaded)
                scene.beginMount(mountID)
                content.camera = .virtual
                for entity in scene.entities { content.add(entity) }
                if let companion { content.add(companion) }
                // A retained entity may still belong to the old RealityView's
                // content. Remove it through that owner before another mount
                // attaches it; dropping the SwiftUI child alone is insufficient.
                let mountedContent = content
                let mountedEntities = scene.entities + (companion.map { [$0] } ?? [])
                scene.installDetachment(mountID: mountID) {
                    for entity in mountedEntities { mountedContent.remove(entity) }
                    let attached = mountedEntities.filter { $0.scene != nil }.count
                    aquariumAssetLogger.notice("Detached aquarium renderer; roots still attached: \(attached)")
                }
                synchronize()
                scene.startAnimationsIfNeeded()
                let attached = mountedEntities.filter { $0.scene != nil }.count
                aquariumAssetLogger.notice("Attached aquarium renderer; roots attached: \(attached)/\(mountedEntities.count)")
                let token = mountID
                let companionFrame = stepCompanion
                let subscription = content.subscribe(to: SceneEvents.Update.self) { [weak scene = scene] event in
                    if scene?.step(event.deltaTime, mountID: token) == true {
                        companionFrame(event.deltaTime)
                    }
                }
                scene.installSubscription(mountID: mountID) { subscription.cancel() }
            } catch {
                onFailure(error)
            }
        } update: { _ in
            guard scene.isMounted(mountID) else { return }
            synchronize()
        }
        .onDisappear { scene.endMount(mountID) }
    }

    private func synchronize() {
        scene.synchronize(state, size: size, viewingMode: viewingMode,
                          reduceMotion: reduceMotion, active: active)
        updateCompanion()
    }
}

/// Model identity, camera motion and animation clocks outlive the RealityView.
/// Renderer subscriptions do not: a late callback from an old mount is inert.
@available(iOS 18.0, macOS 15.0, *)
@MainActor
final class AquariumSceneState {
    let residents = AquariumResidents()
    let cameraRig = AquariumCameraRig()
    private(set) var entities: [Entity] = []
    private(set) var controllers: [AnimationPlaybackController] = []
    private var habitat: Entity?
    private var habitatAnimation: AnimationResource?
    private var suspendedAnimationTime: TimeInterval = 0
    private var currentMount: UUID?
    private var cancelUpdate: (() -> Void)?
    private var detachContent: (() -> Void)?
    private var updatesEnabled = false
    private var playing = false
    private var reportedMountFrame = false

    func prepare(_ loaded: AquariumAssetLoader.Assets) throws {
        guard entities.isEmpty else { return }
        let camera = PerspectiveCamera()
        camera.look(at: [0, 1.65, -0.7], from: [0, 4.8, 14], relativeTo: nil)
        cameraRig.camera = camera
        residents.camera = camera
        let background = Entity()
        background.name = "aquarium-background"
        background.position.z = -5
        background.components.set(CollisionComponent(shapes: [.generateBox(size: [100, 100, 0.01])]))
        background.components.set(InputTargetComponent())
        let sun = DirectionalLight()
        sun.light.intensity = 5_000
        sun.look(at: [0, 0, 0], from: [-4, 8, 5], relativeTo: nil)
        let fill = DirectionalLight()
        fill.light.intensity = 900
        fill.look(at: [0, 1, 0], from: [4, 4, -4], relativeTo: nil)
        applyWaterMaterial(to: loaded.habitat)
        residents.shoal.load(loaded.habitat)
        residents.loadTemplates(loaded.residents)
        guard residents.templateCount == 6 else { throw CocoaError(.fileReadCorruptFile) }
        residents.loadHermesTemplate(loaded.hermes)
        guard residents.templateCount == 7 else { throw CocoaError(.fileReadCorruptFile) }
        residents.loadCiCompanion(loaded.ciCompanion)
        habitat = loaded.habitat
        habitatAnimation = loaded.habitat.availableAnimations.first?.repeat()
        entities = [camera, background, sun, fill, loaded.habitat, residents.shoal.root, residents.root]
        aquariumAssetLogger.notice("Assembled aquarium with \(self.residents.templateCount) templates")
    }

    func beginMount(_ id: UUID) {
        suspend()
        // Register a fresh camera in each renderer without resetting the
        // retained camera pose, projection or camera-rig interpolation state.
        if let previous = cameraRig.camera,
           let index = entities.firstIndex(where: { $0 === previous }) {
            let camera = PerspectiveCamera()
            camera.transform = previous.transform
            camera.camera = previous.camera
            entities[index] = camera
            cameraRig.camera = camera
            residents.camera = camera
        }
        currentMount = id
        reportedMountFrame = false
        aquariumAssetLogger.notice("Mounted aquarium renderer \(id.uuidString, privacy: .public)")
    }

    func isMounted(_ id: UUID) -> Bool { currentMount == id }

    func installSubscription(mountID: UUID, cancel: @escaping () -> Void) {
        guard isMounted(mountID) else { cancel(); return }
        cancelUpdate?()
        cancelUpdate = cancel
    }

    func installDetachment(mountID: UUID, detach: @escaping () -> Void) {
        guard isMounted(mountID) else { detach(); return }
        detachContent?()
        detachContent = detach
    }

    func endMount(_ id: UUID) {
        guard isMounted(id) else { return }
        suspend()
    }

    func suspend() {
        if let currentMount { aquariumAssetLogger.notice("Suspended aquarium renderer \(currentMount.uuidString, privacy: .public)") }
        currentMount = nil
        let cancel = cancelUpdate
        cancelUpdate = nil
        cancel?()
        if let controller = controllers.first, controller.isValid, controller.time.isFinite {
            suspendedAnimationTime = controller.time
        }
        updatePlayback(active: false, reduceMotion: cameraRig.reduceMotion)
        // Keep RealityViewContent alive only until its own roots are removed.
        // Clear ownership before invoking cleanup so late callbacks cannot
        // retain or detach a replacement renderer.
        let detach = detachContent
        detachContent = nil
        detach?()
    }

    func synchronize(_ state: TerrariumState, size: CGSize, viewingMode: Bool,
                     reduceMotion: Bool, active: Bool) {
        cameraRig.viewing = viewingMode
        cameraRig.reduceMotion = reduceMotion
        let aspect = Float(size.width / max(1, size.height))
        cameraRig.camera?.camera.fieldOfViewInDegrees = aspect > TerrariumRules.nativeCameraWideAspect
            ? TerrariumRules.nativeCameraWideFov : TerrariumRules.nativeCameraFov
        residents.labelsVisible = !viewingMode
        updatePlayback(active: active, reduceMotion: reduceMotion)
        residents.sync(state, aspect: aspect)
    }

    func startAnimationsIfNeeded() {
        // USDZ exposes the same tracks through global and per-node libraries.
        // One retained scene clip avoids competing transforms after remounting.
        if let controller = controllers.first, controller.isValid, !controller.isComplete, !controller.isStopped {
            applyPlayback()
            return
        }
        // A destroyed RealityKit scene can invalidate its playback controller.
        // Keep the graph, but recreate that controller at the saved playhead.
        if let habitat, let habitatAnimation {
            let controller = habitat.playAnimation(habitatAnimation, startsPaused: true)
            controller.time = suspendedAnimationTime
            controllers = [controller]
        }
        applyPlayback()
    }

    func updatePlayback(active: Bool, reduceMotion: Bool) {
        updatesEnabled = currentMount != nil && active
        playing = updatesEnabled && !reduceMotion
        residents.animate = playing
        applyPlayback()
    }

    private func applyPlayback() {
        for controller in controllers {
            if playing { controller.resume() }
            else { controller.pause() }
        }
    }

    @discardableResult
    func step(_ seconds: TimeInterval, mountID: UUID) -> Bool {
        guard isMounted(mountID), updatesEnabled, cameraRig.step(seconds) else { return false }
        if !reportedMountFrame {
            reportedMountFrame = true
            let camera = cameraRig.camera
            let cameraState = renderState(camera)
            let habitatState = renderState(habitat)
            let residentState = renderState(residents.root)
            let finite: Bool
            if let transform = camera?.transform {
                let values = [transform.translation.x, transform.translation.y, transform.translation.z,
                              transform.rotation.vector.x, transform.rotation.vector.y, transform.rotation.vector.z, transform.rotation.vector.w,
                              transform.scale.x, transform.scale.y, transform.scale.z]
                finite = values.allSatisfy { $0.isFinite }
            } else {
                finite = false
            }
            aquariumAssetLogger.notice("Aquarium first frame \(mountID.uuidString, privacy: .public): camera [\(cameraState, privacy: .public)] finite=\(finite); habitat [\(habitatState, privacy: .public)]; residents [\(residentState, privacy: .public)]")
        }
        // Keep expiry checks alive on a retained active scene under Reduce Motion.
        residents.step(seconds)
        return true
    }

    private func renderState(_ entity: Entity?) -> String {
        guard let entity else { return "missing" }
        return "active=\(entity.isActive),anchored=\(entity.isAnchored),enabled=\(entity.isEnabledInHierarchy)"
    }

    /// A token-bound unlit material lets the enclosure recede behind residents.
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
}

/// Keep camera motion independent of HUD layout and resident animation state.
@available(iOS 18.0, macOS 15.0, *)
@MainActor
final class AquariumCameraRig {
    var camera: PerspectiveCamera?
    var viewing = false
    var reduceMotion = false
    private var distanceScale: Float = 1
    private var reportedInvalidFrame = false
    private var reportedFirstFrame = false

    @discardableResult
    func step(_ seconds: TimeInterval) -> Bool {
        // An invalid frame must not poison the persistent camera transform.
        // NaN survives every later interpolation; a negative interval can
        // overflow exp() and turn even a stationary camera into NaN.
        guard seconds.isFinite, seconds >= 0 else {
            if !reportedInvalidFrame {
                aquariumAssetLogger.error("Ignored invalid aquarium frame interval: \(seconds, privacy: .public)")
                reportedInvalidFrame = true
            }
            return false
        }
        reportedInvalidFrame = false
        if !reportedFirstFrame, let camera {
            aquariumAssetLogger.info("First aquarium frame; camera attached: \(camera.scene != nil); interval: \(seconds, privacy: .public)")
            reportedFirstFrame = true
        }
        let target: Float = viewing ? TerrariumRules.nativeViewingDistance : 1
        let blend: Float = reduceMotion ? 1 : 1 - exp(-Float(min(seconds, 0.1)) / TerrariumRules.nativeViewingResponseSeconds)
        distanceScale += (target - distanceScale) * blend
        camera?.look(at: [0, 1.65, -0.7],
                     from: [0, 1.65 + 3.15 * distanceScale, -0.7 + 14.7 * distanceScale], relativeTo: nil)
        return true
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
            aquariumAssetLogger.info("Loaded all aquarium assets")
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
