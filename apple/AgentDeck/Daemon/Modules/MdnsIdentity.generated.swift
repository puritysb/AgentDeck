// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/mdns-identity.ts
// Regenerate: pnpm generate-mdns-identity (drift gated by shared/src/__tests__/mdns-identity.test.ts)
#if os(macOS)

import Foundation

/// How this daemon names itself on `_agentdeck._tcp`.
///
/// A DNS-SD instance name must be unique per network SEGMENT, not per host,
/// and both daemons used to publish `AgentDeck-<port>` — the same string on
/// every Mac in an office. See the TypeScript source for the full story.
enum MdnsIdentity {
    /// TXT schema version, in lockstep with the Node daemon.
    static let txtSchemaVersion = "3"
    static let hostLabelMax = 20

    /// Characters that are safe and readable in a DNS-SD instance label.
    static func sanitizeLabel(_ raw: String, maxLength: Int = hostLabelMax) -> String {
        let shortName = raw.split(separator: ".").first.map(String.init) ?? ""
        var out = ""
        var lastWasDash = false
        for ch in shortName {
            if ch.isASCII && (ch.isLetter || ch.isNumber) {
                out.append(ch)
                lastWasDash = false
            } else if !lastWasDash {
                out.append("-")
                lastWasDash = true
            }
        }
        while out.hasPrefix("-") { out.removeFirst() }
        while out.hasSuffix("-") { out.removeLast() }
        return String(out.prefix(maxLength))
    }

    /// Short, stable, non-reversible tag for the OS user this daemon runs as.
    /// FNV-1a — a disambiguator, never a secret, and never the account name,
    /// which multicast would otherwise publish to the whole segment.
    static func userTag(uid: UInt32, username: String = "") -> String {
        var hash: UInt32 = 0x811c9dc5
        for byte in Array("\(uid):\(username)".utf8) {
            hash ^= UInt32(byte)
            hash = hash &* 0x01000193
        }
        return String(String(format: "%08x", hash).prefix(4))
    }

    /// This process's tag.
    static func currentUserTag() -> String {
        userTag(uid: getuid(), username: NSUserName())
    }

    /// The instance name to publish. Any empty component collapses out, so a
    /// platform that cannot answer one of the questions degrades to the old
    /// `project-port` shape rather than emitting a malformed name.
    static func instanceName(project: String, hostname: String, userTag: String, port: Int) -> String {
        let host = sanitizeLabel(hostname)
        let user = sanitizeLabel(userTag, maxLength: 8)
        return [project, host, user, String(port)].filter { !$0.isEmpty }.joined(separator: "-")
    }
}
#endif
