#if os(macOS)
// LocalPeerOwnership.swift — who owns the process behind a same-machine daemon.
// Mirrors the CONTRACT of `localPeerOwnership` in bridge/src/auth.ts.

import Foundation
import Darwin

/// Who owns the process behind a same-machine daemon.
///
/// "Same machine" and "us" were the same question while the only two daemons
/// on a Mac were this app and the CLI belonging to the same human. On a shared
/// host they are not, and every privileged same-machine interaction rides on
/// the second one: adopting an incumbent's pairing token, standing our own
/// server down for it, attaching to it as a client and rendering ITS sessions,
/// prompts and project names in this user's dashboard.
///
/// Three values, and the third is not a rounding of the other two:
///
///  - `sameUser`  the peer process runs as this user.
///  - `otherUser` it demonstrably does not.
///  - `unknown`   no pid was reported, the process is gone, or the lookup
///                failed — including because the sandbox refused it.
///
/// **`unknown` stays permissive**, exactly as on the Node side: refusing
/// whenever ownership cannot be proven would break the documented
/// one-machine-one-token convergence, and a fleet that cannot authenticate is
/// a far likelier and far worse outcome than a token adopted across users on a
/// shared host.
///
/// This mirrors the Node contract, NOT its syscall. Node asks `kill(pid, 0)`
/// and reads EPERM as "another user owns it"; under the App Sandbox that same
/// EPERM would mostly mean "the sandbox said no", which would turn every
/// ordinary same-user handover into a refusal — the one failure mode that
/// locks a whole paired fleet out. `proc_pidinfo` answers the actual question
/// (what uid owns this pid) and its failures land in `unknown`, which is the
/// safe direction.
enum LocalPeerOwnership {
    case sameUser
    case otherUser
    case unknown

    static func of(pid: Int?) -> LocalPeerOwnership {
        guard let pid, pid > 0 else { return .unknown }
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        let read = proc_pidinfo(Int32(pid), PROC_PIDTBSDINFO, 0, &info, size)
        guard read == size else { return .unknown }
        return info.pbi_uid == getuid() ? .sameUser : .otherUser
    }

    /// True when a peer daemon demonstrably belongs to another user and must
    /// therefore be left entirely alone — not adopted from, not stood down
    /// for, not attached to.
    static func isForeignDaemon(health: [String: Any]?) -> Bool {
        let pid = health?["pid"] as? Int
        return of(pid: pid) == .otherUser
    }
}
#endif
