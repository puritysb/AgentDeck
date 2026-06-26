#if os(macOS)
// SquatterCleaner.swift — App-Store-safe cleanup of same-bundle-ID port squatters.
//
// When NWListener bind fails (EADDRINUSE) it's often because a previous instance
// of THIS app (crashed debug build, suspended Xcode runner, etc.) still holds
// the port's socket descriptor. App Sandbox forbids killing arbitrary PIDs, but
// `NSRunningApplication.forceTerminate()` is allowed against processes that
// share our bundle identifier. That's the only automatic cleanup we can
// perform under App Store rules. External daemons (e.g. `agentdeck daemon` Node
// CLI) have different bundle identifiers / no bundle ID at all, so they are
// out of reach — the user must close them manually or change the daemon port.

import AppKit
import Foundation

enum SquatterCleaner {
    /// Force-terminate any running app instances sharing our bundle ID (other
    /// than ourselves). Returns the number of instances actually terminated.
    /// Waits up to `timeout` seconds for the processes to exit.
    @MainActor
    static func forceTerminateOwnBundleSiblings(timeout: TimeInterval = 2.0) -> Int {
        let myPid = getpid()
        let bundleId = Bundle.main.bundleIdentifier ?? "bound.serendipity.agent.deck"
        let allSiblings = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
            .filter { $0.processIdentifier != myPid && !$0.isTerminated }

        // Zombies/P_WEXIT processes won't respond to forceTerminate; waiting
        // on them burns 2s for nothing. Let SingletonGuard's purge handle them.
        let siblings = allSiblings.filter { !isExiting(pid: $0.processIdentifier) }
        let skipped = allSiblings.count - siblings.count
        if skipped > 0 {
            DaemonLogger.shared.info("SquatterCleaner: skipping \(skipped) zombie sibling(s) that won't respond")
        }

        guard !siblings.isEmpty else { return 0 }

        DaemonLogger.shared.info("SquatterCleaner: found \(siblings.count) sibling \(bundleId) instance(s); forceTerminating")
        for app in siblings {
            // App-Store-safe: same-bundle-ID forceTerminate is equivalent to the
            // Dock's "Force Quit" and requires no special entitlements.
            _ = app.forceTerminate()
        }

        // Poll until terminated or timeout elapses.
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if siblings.allSatisfy({ $0.isTerminated }) {
                DaemonLogger.shared.info("SquatterCleaner: all siblings terminated")
                return siblings.count
            }
            Thread.sleep(forTimeInterval: 0.1)
        }

        let stillAlive = siblings.filter { !$0.isTerminated }.count
        if stillAlive > 0 {
            DaemonLogger.shared.error("SquatterCleaner: \(stillAlive) sibling(s) still alive after \(timeout)s")
        }
        return siblings.count - stillAlive
    }

    /// Return true if the PID is a zombie or in P_WEXIT (exit started but not
    /// reaped). Same detection as SingletonGuard — duplicated here to keep the
    /// cleaner self-contained.
    private static func isExiting(pid: Int32) -> Bool {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        let result = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
        guard result == 0, size > 0 else { return true }
        if info.kp_proc.p_stat == 5 { return true }              // SZOMB
        if (Int32(info.kp_proc.p_flag) & 0x2000) != 0 { return true }  // P_WEXIT
        return false
    }
}
#endif
