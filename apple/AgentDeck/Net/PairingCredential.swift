// PairingCredential.swift — how a discovered endpoint and a stored credential combine.
//
// Discovery answers WHERE the daemon is. It has never been allowed to answer
// WHAT the pairing token is — the daemon stopped advertising the token over
// mDNS TXT, the UDP beacon, and unauthenticated `/health` (GitHub #145, #149),
// because a credential handed out over the same channel that needs
// authenticating is not a credential. Tokens now arrive only by QR scan or a
// manually typed URL.
//
// That left every client holding an assumption that had silently become false:
// "a discovered bridge URL is a complete, dialable URL". It is not — it is an
// endpoint with no credential attached. Code that compared a discovered URL
// against the live one saw a permanent mismatch (`ws://host:9120` vs
// `ws://host:9120?token=…`) and concluded the daemon had moved, then dropped
// the stored credential and redialed without it. One transient blip cost a
// paired device its pairing.
//
// The two rules that fix it, and that any new call site must follow:
//   1. Compare bridges by ENDPOINT (host + port), never by full URL string —
//      a credential is not part of a daemon's identity.
//   2. An endpoint we already hold a credential for INHERITS it. Absent means
//      "no information", never "the credential is now empty" — the same rule
//      the wire protocol follows for optional booleans, and the same one the
//      ESP32 firmware follows for its provisioned token.
//
// Mirrored in Kotlin as `android/.../net/PairingCredential.kt`; the two test
// suites (`PairingCredentialTests`, `PairingCredentialTest`) share their cases.

import Foundation

enum PairingCredential {

    /// Host+port identity of a `ws://host:port?...` URL, ignoring credentials
    /// and path. Nil when the string isn't a parseable endpoint.
    static func endpoint(of url: String?) -> String? {
        guard let url, let comps = URLComponents(string: url), let host = comps.host else { return nil }
        // Default to the daemon port so `ws://host` and `ws://host:9120`
        // are recognized as the same daemon rather than two rival bridges.
        let port = comps.port ?? 9120
        return "\(host.lowercased()):\(port)"
    }

    /// True when both URLs name the same daemon, regardless of credentials.
    static func sameEndpoint(_ a: String?, _ b: String?) -> Bool {
        guard let lhs = endpoint(of: a), let rhs = endpoint(of: b) else { return false }
        return lhs == rhs
    }

    /// The `token` query item of a URL, if it carries one.
    static func token(in url: String?) -> String? {
        guard let url, let comps = URLComponents(string: url) else { return nil }
        let value = comps.queryItems?.first(where: { $0.name == "token" })?.value
        return (value?.isEmpty == false) ? value : nil
    }

    /// The URL to actually dial for `discoveredUrl`.
    ///
    /// When `savedUrl` holds a credential for the same endpoint, that credential
    /// is carried onto the discovered URL — discovery relocated the daemon, it
    /// did not un-pair the device. A different endpoint, or no stored
    /// credential, yields the discovered URL untouched (the client then needs a
    /// QR scan / manual URL, which is the intended pairing path).
    static func resolve(discoveredUrl: String, savedUrl: String?) -> String {
        guard token(in: discoveredUrl) == nil,
              sameEndpoint(discoveredUrl, savedUrl),
              let saved = savedUrl,
              token(in: saved) != nil
        else { return discoveredUrl }
        return saved
    }

    /// Keep credentials by endpoint; a tokenless success never erases a token.
    static func remembering(_ url: String?, in credentials: [String: String]) -> [String: String] {
        guard let key = endpoint(of: url), let url, token(in: url) != nil else { return credentials }
        var result = credentials
        result[key] = url
        return result
    }

    static func resolve(discoveredUrl: String, credentials: [String: String]) -> String {
        resolve(discoveredUrl: discoveredUrl, savedUrl: endpoint(of: discoveredUrl).flatMap { credentials[$0] })
    }

    /// Never turn a reconnect into a switch to a different computer.
    static func preferredURL(in urls: [String], selected: String?) -> String? {
        let endpoints = Array(Set(urls.compactMap { endpoint(of: $0) }))
        if let selected {
            return urls.first { sameEndpoint($0, selected) }
        }
        return endpoints.count == 1 ? urls.first : nil
    }

    static func approvalMessage(for url: String?) -> String {
        let host = endpoint(of: url) ?? "the selected host"
        return "Approval required for \(host). Open AgentDeck on that computer, choose Devices › Pair Device, and approve this device under Waiting to Connect. Then select this host again to retry."
    }

}
