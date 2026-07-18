#if os(macOS)
// ModuleManager.swift — Device module lifecycle management
// Ported from bridge/src/modules/index.ts

import Foundation

protocol DeviceModule: AnyObject, Sendable {
    var name: String { get }
    func start() async
    func stop() async
    func handleWake() async
}

extension DeviceModule {
    func handleWake() async {}  // Default no-op for modules that don't need wake recovery
}

// Holds daemon state → runs on the daemon's executor. See DaemonActor.
@DaemonActor
final class ModuleManager {
    private var modules: [DeviceModule] = []

    func register(_ module: DeviceModule) {
        modules.append(module)
    }

    func startAll() async {
        for module in modules {
            DaemonLogger.shared.debug("Modules", "Starting \(module.name)")
            await module.start()
        }
    }

    func stopAll() async {
        // Stop modules in PARALLEL, not sequentially. App termination gives the
        // whole shutdown a single ~3s budget (AppDelegate.applicationShouldTerminate),
        // and several stateful-push devices paint a farewell frame in stop()
        // (Pixoo "OFFLINE" over HTTP with a 2s cap, iDotMatrix/Timebox BLE blanks,
        // D200H OFFLINE). Sequential stops let an early slow module (Pixoo's 2s
        // HTTP deadline) eat the budget so later devices' farewell pushes get
        // cut off by the force-exit and the panel freezes on the last scene.
        // Each module's stop() touches an independent transport, so running them
        // concurrently is safe and keeps every farewell inside the budget.
        await withTaskGroup(of: Void.self) { group in
            for module in modules {
                group.addTask { await module.stop() }
            }
        }
    }

    /// Notify all modules of system wake — each module handles recovery independently (parallel)
    func wakeAll() async {
        await withTaskGroup(of: Void.self) { group in
            for module in modules {
                let name = module.name
                group.addTask {
                    let delaySec: Double
                    switch name {
                    case "d200h":
                        delaySec = 0.0
                    case "serial":
                        delaySec = 1.0
                    case "pixoo":
                        delaySec = 2.0
                    case "adb":
                        delaySec = 3.0
                    default:
                        delaySec = 0.0
                    }
                    
                    if delaySec > 0.0 {
                        DaemonLogger.shared.debug("Modules", "Staggering wake recovery for \(name) by \(delaySec)s")
                        try? await Task.sleep(for: .seconds(delaySec))
                    }
                    
                    DaemonLogger.shared.debug("Modules", "Wake recovery: \(name)")
                    await module.handleWake()
                }
            }
        }
    }
}
#endif
