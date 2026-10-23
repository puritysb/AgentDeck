#if os(macOS)
import AppKit
import SwiftUI
import os

private let aquariumWindowLogger = Logger(subsystem: "bound.serendipity.agent.deck", category: "aquarium-window")

/// Settings shares the main executor with RealityKit. Yield the optional 3D
/// renderer while editing settings, or when its own window cannot be seen.
/// This is independent of the Dock policy: minimized windows still count as
/// open there, but have no reason to keep a renderer here.
enum AquariumWindowRenderingPolicy {
    static func shouldRender(
        attached: Bool,
        visible: Bool,
        miniaturized: Bool,
        occluded: Bool,
        keyWindowID: String?,
        mainWindowID: String? = nil
    ) -> Bool {
        // AppKit clears the key window when another app becomes active, but
        // keeps the main window. Settings must not restart the renderer every
        // time focus briefly moves to another app or an automation tool.
        let foregroundWindowID = keyWindowID ?? mainWindowID
        return attached && visible && !miniaturized && !occluded && foregroundWindowID != "settings"
    }
}

struct AquariumWindowActivityReader: NSViewRepresentable {
    @Binding var renderingEnabled: Bool

    func makeNSView(context: Context) -> AquariumWindowActivityView {
        let view = AquariumWindowActivityView()
        view.onChange = { renderingEnabled = $0 }
        return view
    }

    func updateNSView(_ view: AquariumWindowActivityView, context: Context) {
        view.onChange = { renderingEnabled = $0 }
        view.scheduleUpdate()
    }

    static func dismantleNSView(_ view: AquariumWindowActivityView, coordinator: ()) {
        view.onChange = nil
    }
}

final class AquariumWindowActivityView: NSView {
    var onChange: ((Bool) -> Void)?
    private var updateScheduled = false
    private var lastValue: Bool?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        for name in [
            NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
            NSWindow.didBecomeMainNotification, NSWindow.didResignMainNotification,
            NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification,
            NSWindow.didChangeOcclusionStateNotification, NSWindow.willCloseNotification,
            NSApplication.didHideNotification, NSApplication.didUnhideNotification,
            NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification,
        ] {
            NotificationCenter.default.addObserver(self, selector: #selector(windowStateChanged), name: name, object: nil)
        }
    }

    required init?(coder: NSCoder) { nil }

    deinit { NotificationCenter.default.removeObserver(self) }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        scheduleUpdate()
    }

    @objc private func windowStateChanged(_ notification: Notification) {
        scheduleUpdate()
    }

    func scheduleUpdate() {
        guard !updateScheduled else { return }
        updateScheduled = true
        // Window close/key transitions and SwiftUI's representable update must
        // settle before publishing state back into the view tree.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.updateScheduled = false
            let value = AquariumWindowRenderingPolicy.shouldRender(
                attached: self.window != nil,
                visible: self.window?.isVisible == true,
                miniaturized: self.window?.isMiniaturized == true,
                occluded: self.window?.occlusionState.contains(.visible) != true,
                keyWindowID: NSApp.keyWindow?.identifier?.rawValue,
                mainWindowID: NSApp.mainWindow?.identifier?.rawValue
            )
            guard self.lastValue != value else { return }
            self.lastValue = value
            aquariumWindowLogger.notice("Aquarium rendering enabled=\(value), key=\(NSApp.keyWindow?.identifier?.rawValue ?? "none", privacy: .public), main=\(NSApp.mainWindow?.identifier?.rawValue ?? "none", privacy: .public)")
            self.onChange?(value)
        }
    }
}
#endif
