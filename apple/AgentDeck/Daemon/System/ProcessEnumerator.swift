#if os(macOS)
// ProcessEnumerator.swift — sandbox-safe process metadata enumeration.
//
// Shared sysctl helper for passive observers (LocalKiroObserver,
// OpenCodeObserver). Reads the kernel process table via
// `sysctl(KERN_PROC_ALL)` and per-process argv via `sysctl(KERN_PROCARGS2)`
// — no `ps`, no `Process()`, no helper binaries, so it stays inside the
// App Store sandbox (process enumeration needs no entitlement).

import Darwin
import Foundation

enum ProcessEnumerator {
    struct ProcessSnapshot {
        let pid: pid_t
        let startedAt: Date
        let arguments: [String]
    }

    /// `--flag value` extraction from an argv array.
    static func value(after flag: String, in args: [String]) -> String? {
        guard let idx = args.firstIndex(of: flag), idx + 1 < args.count else { return nil }
        let candidate = args[idx + 1].trimmingCharacters(in: .whitespacesAndNewlines)
        return candidate.isEmpty ? nil : candidate
    }

    static func processSnapshots() -> [ProcessSnapshot] {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
        var size = 0
        guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0, size > 0 else {
            return []
        }

        let count = size / MemoryLayout<kinfo_proc>.stride
        var processes = [kinfo_proc](repeating: kinfo_proc(), count: count)
        let ok = processes.withUnsafeMutableBytes { ptr in
            sysctl(&mib, u_int(mib.count), ptr.baseAddress, &size, nil, 0)
        }
        guard ok == 0 else { return [] }

        return processes.compactMap { info in
            let pid = info.kp_proc.p_pid
            guard pid > 0 else { return nil }
            let args = processArguments(pid: pid)
            guard !args.isEmpty else { return nil }
            let startedAt = Date(
                timeIntervalSince1970: TimeInterval(info.kp_proc.p_starttime.tv_sec)
                    + TimeInterval(info.kp_proc.p_starttime.tv_usec) / 1_000_000
            )
            return ProcessSnapshot(pid: pid, startedAt: startedAt, arguments: args)
        }
    }

    /// One row per process the kernel will describe: pid, parent pid and the
    /// argv joined into a command line. The coordination tracker walks the
    /// parent chain (a `claude -p` worker's ancestry reaches the session that
    /// launched it) and scans argv (a background job names the session's
    /// scratchpad). `sysctl(KERN_PROC_ALL)` + `KERN_PROCARGS2`, no `ps`.
    struct ProcessRow: Sendable, Equatable {
        let pid: Int
        let ppid: Int
        let command: String
    }

    static func processTable() -> [ProcessRow] {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_ALL, 0]
        var size = 0
        guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0, size > 0 else { return [] }
        let count = size / MemoryLayout<kinfo_proc>.stride
        var processes = [kinfo_proc](repeating: kinfo_proc(), count: count)
        let ok = processes.withUnsafeMutableBytes { ptr in
            sysctl(&mib, u_int(mib.count), ptr.baseAddress, &size, nil, 0)
        }
        guard ok == 0 else { return [] }
        return processes.compactMap { info in
            let pid = Int(info.kp_proc.p_pid)
            guard pid > 0 else { return nil }
            let args = processArguments(pid: pid_t(pid))
            guard !args.isEmpty else { return nil }
            return ProcessRow(pid: pid, ppid: Int(info.kp_eproc.e_ppid), command: args.joined(separator: " "))
        }
    }

    static func processArguments(pid: pid_t) -> [String] {
        var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
        var size = 0
        guard sysctl(&mib, u_int(mib.count), nil, &size, nil, 0) == 0, size > 0 else {
            return []
        }

        var buffer = [UInt8](repeating: 0, count: size)
        let ok = buffer.withUnsafeMutableBytes { ptr in
            sysctl(&mib, u_int(mib.count), ptr.baseAddress, &size, nil, 0)
        }
        guard ok == 0, size >= MemoryLayout<Int32>.size else { return [] }

        let argc = buffer.withUnsafeBytes { raw -> Int in
            Int(raw.load(as: Int32.self))
        }
        guard argc > 0 else { return [] }

        var idx = MemoryLayout<Int32>.size
        while idx < size && buffer[idx] != 0 { idx += 1 }
        while idx < size && buffer[idx] == 0 { idx += 1 }

        var args: [String] = []
        while idx < size && args.count < argc {
            let start = idx
            while idx < size && buffer[idx] != 0 { idx += 1 }
            if idx > start,
               let value = String(bytes: buffer[start..<idx], encoding: .utf8),
               !value.isEmpty {
                args.append(value)
            }
            while idx < size && buffer[idx] == 0 { idx += 1 }
        }
        return args
    }
}
#endif
