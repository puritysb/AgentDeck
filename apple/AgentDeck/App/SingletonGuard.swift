#if os(macOS)
// SingletonGuard.swift — Ensures only one AgentDeck.app instance runs at a time.
//
// Checks for other running instances with the same bundle identifier via
// NSRunningApplication at app launch. If another instance is found, activates
// that instance and terminates self before any UI/daemon startup.

import AppKit
import Foundation

enum SingletonGuard {
    /// Check for existing instances. If one is running, activate it and exit.
    /// Call this BEFORE @main or as the very first thing in app startup.
    /// - Returns: true if this is the only instance (safe to continue), false if terminating.
    @MainActor
    static func enforce() -> Bool {
        // Under xcodebuild test / xctest, the test runner launches the host app
        // inside an existing user session where a dev build may already be
        // running. Skip the singleton check so the test runner can establish
        // its XPC connection before the app exits.
        if ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
            || ProcessInfo.processInfo.environment["XCTestBundlePath"] != nil
            || ProcessInfo.processInfo.environment["XCTestSessionIdentifier"] != nil {
            NSLog("[AgentDeck] xctest environment detected — skipping singleton guard")
            return true
        }

        let myPid = getpid()
        let myBundleId = Bundle.main.bundleIdentifier ?? "bound.serendipity.agent.deck"

        // Find other instances with the same bundle id (excluding self)
        let others = NSRunningApplication.runningApplications(withBundleIdentifier: myBundleId)
            .filter { $0.processIdentifier != myPid && !$0.isTerminated }

        guard !others.isEmpty else { return true }

        // Filter out zombies and processes in the middle of exiting — they show
        // up in NSRunningApplication as not-terminated but will never respond.
        // Xcode Debug Stop frequently leaves such zombies behind (SIGSTOP'd
        // process that launchd hasn't reaped yet).
        let liveOthers = others.filter { !isProcessExiting(pid: $0.processIdentifier) }
        if liveOthers.isEmpty {
            NSLog("[AgentDeck] Detected \(others.count) sibling(s) but all are zombies/exiting — proceeding with launch")
            // Purge any registry/state files the zombie left behind. Their
            // daemon.json would otherwise point at a port nobody listens on,
            // making the next startup burn ~8s on health-probe timeouts
            // before it gives up and rebinds fresh.
            purgeStaleRegistryFiles()
            return true
        }

        // Another instance is running — try to activate it
        let other = liveOthers[0]
        let otherPid = other.processIdentifier
        NSLog("[AgentDeck] Another instance detected (PID \(otherPid))")

        // Unstick suspended/stopped processes (e.g. Debug builds waiting for debugger
        // that never attached). Without this the existing instance stays frozen and
        // the user sees what looks like a zombie.
        if isProcessSuspended(pid: otherPid) {
            NSLog("[AgentDeck] Existing instance is SUSPENDED (T state) — sending SIGCONT")
            _ = Darwin.kill(otherPid, SIGCONT)
            Thread.sleep(forTimeInterval: 0.3)
        }

        // Activate existing instance so user sees a window come to front
        other.activate(options: [.activateAllWindows])
        Thread.sleep(forTimeInterval: 0.2)
        NSLog("[AgentDeck] Activated existing instance — this instance exiting")
        exit(0)
    }

    /// Read BSD process info via sysctl. Returns (p_stat, p_flag) or nil if the
    /// process is no longer in kernel tables.
    private static func processInfo(pid: Int32) -> (stat: Int32, flag: Int32)? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        let result = sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0)
        guard result == 0, size > 0 else { return nil }
        return (Int32(info.kp_proc.p_stat), Int32(info.kp_proc.p_flag))
    }

    /// Check if a process is in T (stopped/traced) state using sysctl.
    /// p_stat: SIDL=1, SRUN=2, SSLEEP=3, SSTOP=4, SZOMB=5
    private static func isProcessSuspended(pid: Int32) -> Bool {
        processInfo(pid: pid)?.stat == 4  // SSTOP
    }

    /// Check if a process is a zombie, exiting, or gone. NSRunningApplication
    /// still lists such processes as non-terminated until launchd reaps them,
    /// so we must check kernel state directly.
    ///
    /// Detects:
    ///   - p_stat == SZOMB (5): fully zombied
    ///   - P_WEXIT (0x2000) set in p_flag: process is in exit() but kernel
    ///     hasn't finished tearing it down (common when Xcode debug Stop
    ///     leaves SIGSTOP'd processes orphaned to launchd)
    ///   - sysctl failure: process already gone from kernel tables
    private static func isProcessExiting(pid: Int32) -> Bool {
        guard let info = processInfo(pid: pid) else {
            return true
        }
        if info.stat == 5 { return true }              // SZOMB
        if (info.flag & 0x2000) != 0 { return true }   // P_WEXIT
        return false
    }

    /// Atomic cleanup: remove daemon.json. Safe to call from signal handlers or atexit.
    /// Uses direct POSIX unlink to avoid any Swift runtime/Task complications.
    static func removeDaemonInfoFile() {
        // Resolve via AgentDeckPaths so the App Store data container is used;
        // unlink is async-signal-safe (see caller docs) and works on either path.
        _ = unlink(AgentDeckPaths.daemonJson.path)
    }

    /// Remove daemon.json left behind by a crashed / killed previous instance.
    /// Called when SingletonGuard determines all sibling processes are zombies,
    /// so we know no live daemon owns that file. sessions.json is left alone
    /// because it can contain entries from other agentdeck processes (e.g.
    /// CLI sessions) that we shouldn't touch.
    static func purgeStaleRegistryFiles() {
        removeDaemonInfoFile()
        NSLog("[AgentDeck] Purged stale daemon.json from zombie siblings")
    }

    /// Install atexit + signal handlers that remove daemon.json on any exit path.
    /// This is the last line of defense if normal shutdown hangs or panics.
    static func installCleanupHandlers() {
        // atexit fires on normal exit(), _exit() does NOT call it so we need signals too
        atexit {
            SingletonGuard.removeDaemonInfoFile()
        }

        // POSIX signal handlers — MUST be async-signal-safe, so only do file unlink.
        // Do not call Swift runtime / log / print from here.
        let handler: @convention(c) (Int32) -> Void = { sig in
            SingletonGuard.removeDaemonInfoFile()
            // Re-raise with default handler so the process actually terminates
            signal(sig, SIG_DFL)
            raise(sig)
        }
        signal(SIGHUP, handler)
        signal(SIGQUIT, handler)
        signal(SIGABRT, handler)
        signal(SIGBUS, handler)
        signal(SIGSEGV, handler)
        signal(SIGPIPE, SIG_IGN)  // Prevent EPIPE from killing the app
        // SIGTERM and SIGINT are handled by DaemonService with clean async shutdown
    }
}
#endif
