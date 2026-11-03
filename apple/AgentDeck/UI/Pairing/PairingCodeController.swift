#if os(macOS)
// PairingCodeController.swift — host side of the pairing-code flow.
//
// The daemon has served `POST /pair/open`, `GET /pair/status` and
// `POST /pair/close` since the pairing window shipped, and the Android client
// has redeemed against them for just as long (`PairingCodeClient.redeem`). The
// only caller on THIS side was `agentdeck pair` — a CLI the App Store build
// does not ship and a standalone user does not have. So the one credential path
// meant for a device with no camera and no cable was reachable from every
// surface except the app that owns the daemon, and an e-ink reader's only
// remaining option was hand-typing a 32-hex-character token off the QR window
// next door.
//
// This talks HTTP over loopback rather than reaching PairingWindowStore
// directly, so one path opens a window on whichever daemon owns the port: the
// in-process Swift one, or an external Node daemon this app is merely a client
// of. The store is @DaemonActor state of ONE daemon; the port is the thing both
// answer for.

import Foundation

@MainActor
final class PairingCodeController: ObservableObject {

    struct Knock: Identifiable, Equatable {
        var id: String { key }
        let key: String
        let ip: String
        let deviceId: String?
        let attempts: Int
        let staleToken: Bool

        /// What the approval will actually be recorded against. An operator
        /// approving a row deserves to know whether the grant follows the
        /// device or merely its current address — behind NAT those are very
        /// different promises.
        var scope: String {
            deviceId.map { "device \(PairingCodeRules.shortDeviceId($0))" } ?? "address only"
        }

        /// A device that presented a token we no longer accept is a different
        /// story from one that presented nothing, and the operator's next move
        /// differs — so never collapse the two into "unknown device".
        var detail: String {
            let tries = attempts == 1 ? "1 attempt" : "\(attempts) attempts"
            let base = "\(tries) · \(scope)"
            return staleToken ? "\(base) · stale credential" : base
        }
    }

    struct ApprovedPeer: Identifiable, Equatable {
        var id: String { key }
        let key: String
        let deviceId: String?
        let lastIP: String

        var label: String {
            if let deviceId {
                let suffix = lastIP.isEmpty ? "" : " · \(lastIP)"
                return "device \(PairingCodeRules.shortDeviceId(deviceId))\(suffix)"
            }
            return lastIP.isEmpty ? key : lastIP
        }

        /// An address-scoped grant is the legacy shape and carries the caveats a
        /// device-scoped one escapes; the row says which it is rather than
        /// letting the two read alike.
        var isAddressScoped: Bool { deviceId == nil }
    }

    struct Redemption: Identifiable, Equatable {
        let id: Int          // epoch ms — unique per redemption within a window
        let name: String
        let kind: String
        let ip: String

        var label: String {
            let who = name.isEmpty ? (kind.isEmpty ? "device" : kind) : name
            return ip.isEmpty ? who : "\(who) · \(ip)"
        }
    }

    @Published private(set) var code: String?
    @Published private(set) var isOpen = false
    @Published private(set) var secondsRemaining = 0
    @Published private(set) var attemptsRemaining = 0
    @Published private(set) var redemptions: [Redemption] = []
    @Published private(set) var failureCount = 0
    @Published private(set) var busy = false

    /// Peers the daemon refused and the operator has not answered yet. This is
    /// the primary path now: the device does nothing, and the operator approves
    /// an address they can see. See PairingKnockStore for why the identity is
    /// an IP and what that costs (a DHCP lease change retires an approval).
    @Published private(set) var knocks: [Knock] = []
    @Published private(set) var approvedPeers: [ApprovedPeer] = []
    @Published private(set) var error: String?

    /// Resolved per call rather than stored: the daemon can move ports under
    /// us (fallback, restart), and a window opened against a stale port would
    /// report "nothing paired" forever.
    private var portProvider: () -> Int = { 9120 }

    func bind(portProvider: @escaping () -> Int) {
        self.portProvider = portProvider
    }

    // MARK: - Operations

    func open(ttlSeconds: Double, devices: Int) async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            let body: [String: Any] = ["ttlMs": ttlSeconds * 1000, "redemptions": devices]
            let json = try await post("/pair/open", body: body)
            code = json["code"] as? String
            isOpen = code != nil
            redemptions = []
            failureCount = 0
            await refresh()
        } catch {
            self.error = Self.describe(error)
        }
    }

    func close() async {
        busy = true
        defer { busy = false }
        _ = try? await post("/pair/close", body: [:])
        code = nil
        isOpen = false
        secondsRemaining = 0
        // Redemptions deliberately survive the close: the window closes ITSELF
        // on the last redemption, so clearing here would erase the receipt in
        // exactly the successful case the operator is waiting to see.
        await refresh()
    }

    /// One poll of `/pair/status`. Errors are swallowed on purpose — a poll
    /// that failed says nothing about the window, and overwriting a live
    /// `error` (from `open`) with a transient socket blip hides the real one.
    func refresh() async {
        guard let json = try? await get("/pair/status") else { return }
        let open = json["open"] as? Bool ?? false
        isOpen = open
        secondsRemaining = (json["secondsRemaining"] as? NSNumber)?.intValue ?? 0
        attemptsRemaining = (json["attemptsRemaining"] as? NSNumber)?.intValue ?? 0
        if !open { code = nil }
        let rows = json["redemptions"] as? [[String: Any]] ?? []
        redemptions = rows.map {
            Redemption(
                id: ($0["at"] as? NSNumber)?.intValue ?? 0,
                name: $0["name"] as? String ?? "",
                kind: $0["kind"] as? String ?? "",
                ip: $0["ip"] as? String ?? ""
            )
        }
        failureCount = (json["failures"] as? [[String: Any]] ?? []).count
        await refreshKnocks()
    }

    private func refreshKnocks() async {
        guard let json = try? await get("/pair/knocks") else { return }
        knocks = (json["knocks"] as? [[String: Any]] ?? []).map {
            let rawId = $0["deviceId"] as? String ?? ""
            return Knock(
                key: $0["key"] as? String ?? "",
                ip: $0["ip"] as? String ?? "",
                deviceId: rawId.isEmpty ? nil : rawId,
                attempts: ($0["attempts"] as? NSNumber)?.intValue ?? 0,
                staleToken: $0["staleToken"] as? Bool ?? false
            )
        }.filter { !$0.key.isEmpty }
        approvedPeers = (json["approved"] as? [[String: Any]] ?? []).map {
            let rawId = $0["deviceId"] as? String ?? ""
            return ApprovedPeer(
                key: $0["key"] as? String ?? "",
                deviceId: rawId.isEmpty ? nil : rawId,
                lastIP: $0["lastIP"] as? String ?? ""
            )
        }.filter { !$0.key.isEmpty }
    }

    func approve(_ key: String) async {
        busy = true
        defer { busy = false }
        _ = try? await post("/pair/approve", body: ["key": key])
        await refreshKnocks()
    }

    func dismiss(_ key: String) async {
        busy = true
        defer { busy = false }
        _ = try? await post("/pair/dismiss", body: ["key": key])
        await refreshKnocks()
    }

    func revoke(_ key: String) async {
        busy = true
        defer { busy = false }
        _ = try? await post("/pair/revoke", body: ["key": key])
        await refreshKnocks()
    }

    @Published private(set) var renewalBusy = false
    @Published private(set) var renewalStatus: String?

    func renewPairingToken() async {
        guard !renewalBusy else { return }
        renewalBusy = true; renewalStatus = nil
        defer { renewalBusy = false }
        do {
            guard AuthManager.shared.rotationAvailable else { throw PairingError.badPayload }
            let health = try await get("/health")
            guard let pid = health["pid"] as? Int, LocalPeerOwnership.of(pid: pid) == .sameUser,
                  let supported = health["pairingRotation"] as? NSNumber,
                  CFGetTypeID(supported) == CFBooleanGetTypeID(), supported.boolValue else { throw PairingError.badPayload }
            let floor = try PairingCredentialRules.metadata(health["pairingRetirement"]).revision
            let response = try await post("/pair/rotate", body: ["confirm": true, "minimumRevision": floor])
            guard response["scope"] as? String == PairingCredentialRules.rotationScope,
                  response["globalRevocation"] as? String == PairingCredentialRules.globalRevocation,
                  let confirmed = response["rotated"] as? NSNumber,
                  CFGetTypeID(confirmed) == CFBooleanGetTypeID(), confirmed.boolValue else { throw PairingError.badPayload }
            let receipt = try PairingCredentialRules.metadata(response["pairingRetirement"])
            guard receipt.revision > floor else { throw PairingError.badPayload }
            let current = try await get("/health")
            let observed = try PairingCredentialRules.metadata(current["pairingRetirement"])
            guard current["pid"] as? Int == pid, observed.revision >= receipt.revision,
                  observed.revision != receipt.revision || observed.eventId == receipt.eventId else { throw PairingError.badPayload }
            renewalStatus = "Active host token renewed. Pair its devices again. Global revocation is incomplete: offline or older hosts may still accept previous tokens."
        } catch {
            renewalStatus = "Renewal could not be confirmed. Check the active host before trying again."
        }
    }

    // MARK: - Transport

    private func url(_ path: String) -> URL? {
        var comps = URLComponents()
        comps.scheme = "http"
        comps.host = "127.0.0.1"   // never "localhost": the daemon binds IPv4
        comps.port = portProvider()
        comps.path = path
        comps.queryItems = [URLQueryItem(name: "token", value: AuthManager.shared.token)]
        return comps.url
    }

    private func post(_ path: String, body: [String: Any]) async throws -> [String: Any] {
        guard let url = url(path) else { throw PairingError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 5
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        return try await send(req)
    }

    private func get(_ path: String) async throws -> [String: Any] {
        guard let url = url(path) else { throw PairingError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 5
        return try await send(req)
    }

    private func send(_ req: URLRequest) async throws -> [String: Any] {
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw PairingError.http(status) }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw PairingError.badPayload
        }
        return json
    }

    enum PairingError: Error {
        case badURL
        case badPayload
        case http(Int)
    }

    private static func describe(_ error: Error) -> String {
        switch error {
        case PairingError.http(401), PairingError.http(403):
            return "The daemon refused this request. Try reconnecting first."
        case PairingError.http(let code):
            return "The daemon answered \(code)."
        case PairingError.badURL, PairingError.badPayload:
            return "The daemon's reply could not be read."
        default:
            return "Could not reach the daemon on this Mac."
        }
    }
}
#endif
