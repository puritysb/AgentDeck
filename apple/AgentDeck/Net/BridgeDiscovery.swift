// BridgeDiscovery.swift — mDNS discovery for AgentDeck bridges
// Uses Network.framework NWBrowser (Apple native Bonjour)

import Foundation
import Network
import Combine

struct DiscoveredBridge: Identifiable, Sendable {
    let name: String
    let host: String
    let port: Int
    let token: String?
    var project: String?
    var agentType: String?

    /// Use mDNS service name as ID — same service on different interfaces (WiFi/Ethernet)
    /// resolves to different IPs but is the same bridge. Dedup by name, not host:port.
    var id: String { name }

    var wsUrl: String {
        // IPv6 literals must be wrapped in brackets per RFC 3986, otherwise
        // Foundation `URL(string:)` returns nil and BridgeConnection reports
        // "Invalid URL". A simple heuristic: if the host contains ':' but isn't
        // already bracketed, wrap it. IPv4 and DNS names contain no ':'.
        let hostLiteral: String = {
            if host.contains(":") && !host.hasPrefix("[") {
                return "[\(host)]"
            }
            return host
        }()
        var url = "ws://\(hostLiteral):\(port)"
        if let token { url += "?token=\(token)" }
        return url
    }
}

final class BridgeDiscovery: ObservableObject, @unchecked Sendable {
    @Published private(set) var bridges: [DiscoveredBridge] = []
    @Published private(set) var isSearching = false
    /// True when the NWBrowser reports the iOS Local Network privacy permission is
    /// denied (PolicyDenied / -65570). Without this the browser silently loops on an
    /// empty bridge list forever; the UI uses this flag to surface an actionable
    /// "enable Local Network in Settings" prompt instead of an endless spinner.
    @Published private(set) var localNetworkDenied = false

    private var browser: NWBrowser?
    private let queue = DispatchQueue(label: "dev.agentdeck.discovery")
    private var isTerminating = false
    /// Debounce for clearing `localNetworkDenied`: a genuine denial flickers
    /// ready→waiting(PolicyDenied) every restart, so we only treat the browser as
    /// permitted once it stays `.ready` for a beat without re-entering PolicyDenied.
    private var clearDeniedWork: DispatchWorkItem?
    #if DEBUG
    /// Deterministic no-Mac path for Simulator/App Review regression captures
    /// **and** for unit tests of the connection waterfall. The developer machine
    /// normally advertises its own daemon, so a simulator or test host would
    /// immediately connect and could never exercise the empty discovery terminal
    /// state. Settable (not `let`) so a test can suppress the browser without a
    /// launch argument — an XCTest run cannot set its own process arguments, and
    /// starting a real `NWBrowser` under test would also put a Local Network
    /// permission prompt in CI's path. Compiled out of Release builds.
    var isBrowserEnabled = !ProcessInfo.processInfo.arguments.contains("-AgentDeckDisableDiscovery")
    #endif

    // MARK: - Start/Stop

    func startSearching() {
        guard !isTerminating else { return }
        #if DEBUG
        guard isBrowserEnabled else {
            print("[Discovery] browser suppressed (capture argument or test)")
            return
        }
        #endif
        guard browser == nil else { return }

        let params = NWParameters()
        params.includePeerToPeer = true

        let browser = NWBrowser(for: .bonjour(type: "_agentdeck._tcp", domain: nil), using: params)
        self.browser = browser

        browser.stateUpdateHandler = { [weak self] state in
            print("[Discovery] browser state: \(state)")
            DispatchQueue.main.async {
                guard let self, !self.isTerminating else { return }
                switch state {
                case .ready:
                    self.isSearching = true
                    // If the browser settles into .ready without bouncing back to
                    // PolicyDenied, Local Network is effectively permitted — clear the
                    // flag (debounced to ignore the brief flicker of a true denial loop).
                    self.scheduleClearLocalNetworkDenied()
                case .waiting(let error):
                    // .waiting means either (a) Local Network permission was just
                    // granted / the network changed (restart to pick it up), or
                    // (b) permission is DENIED (PolicyDenied / -65570) and the browser
                    // will never proceed — surface an in-app prompt instead of spinning.
                    let denied = Self.isLocalNetworkDenied(error)
                    print("[Discovery] browser waiting: \(error)\(denied ? " — Local Network DENIED" : "")")
                    self.isSearching = false
                    if denied {
                        self.clearDeniedWork?.cancel()
                        self.clearDeniedWork = nil
                        self.localNetworkDenied = true
                    }
                    self.restartBrowser()
                case .failed(let error):
                    print("[Discovery] browser failed: \(error)")
                    self.isSearching = false
                    // Auto-restart after failure (e.g., network change)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        self?.restartBrowser()
                    }
                case .cancelled:
                    self.isSearching = false
                default:
                    break
                }
            }
        }

        browser.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self, !self.isTerminating else { return }
            print("[Discovery] browseResults changed: \(results.count) results")
            // A results callback means the browser is functioning — Local Network is
            // permitted. Clear any stale denied flag immediately.
            DispatchQueue.main.async {
                self.clearDeniedWork?.cancel()
                self.clearDeniedWork = nil
                self.localNetworkDenied = false
            }
            for r in results {
                print("[Discovery]   endpoint=\(r.endpoint) metadata=\(r.metadata)")
            }
            self.handleResults(results)
        }

        browser.start(queue: queue)
    }

    /// Restart the browser (e.g., after local network permission granted or network change)
    private func restartBrowser() {
        guard !isTerminating else { return }
        browser?.cancel()
        browser = nil
        // Brief delay to let the system settle after permission/network change
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            guard let self, !self.isTerminating else { return }
            self.startSearching()
        }
    }

    /// Detect the Local Network "PolicyDenied" condition from an NWBrowser waiting
    /// error. Network.framework surfaces it as DNS error -65570
    /// (`kDNSServiceErr_PolicyDenied`); we match by code with a description fallback
    /// for resilience across OS versions.
    private static func isLocalNetworkDenied(_ error: NWError) -> Bool {
        if case .dns(let code) = error, code == -65570 { return true }
        return String(describing: error).contains("PolicyDenied")
    }

    /// Clear `localNetworkDenied` only after the browser has stayed `.ready` for a
    /// beat — a true denial loop re-enters PolicyDenied within that window and cancels
    /// this, while a genuinely-permitted browser (even with no daemon present) clears.
    private func scheduleClearLocalNetworkDenied() {
        clearDeniedWork?.cancel()
        guard localNetworkDenied else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.isTerminating else { return }
            self.localNetworkDenied = false
        }
        clearDeniedWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: work)
    }

    func stopSearching() {
        browser?.cancel()
        browser = nil
        clearDeniedWork?.cancel()
        clearDeniedWork = nil
        DispatchQueue.main.async {
            self.isSearching = false
            self.bridges.removeAll()
        }
    }

    func prepareForTermination() {
        isTerminating = true
        clearDeniedWork?.cancel()
        clearDeniedWork = nil
        browser?.cancel()
        browser = nil
        DispatchQueue.main.async {
            self.isSearching = false
            self.bridges.removeAll()
        }
    }

    // MARK: - Result Handling

    private func handleResults(_ results: Set<NWBrowser.Result>) {
        guard !isTerminating else { return }
        // Dedup by service instance name — same service appears on multiple interfaces
        // (WiFi + Ethernet). Keep first occurrence (with metadata preferred).
        var seenNames = Set<String>()
        var uniqueResults: [NWBrowser.Result] = []
        // Prefer results with metadata (TXT records)
        let sorted = results.sorted { r1, r2 in
            if case .bonjour = r1.metadata { return true }
            return false
        }
        for result in sorted {
            guard case .service(let name, _, _, _) = result.endpoint else { continue }
            if seenNames.insert(name).inserted {
                uniqueResults.append(result)
            }
        }

        var needsResolve: [(name: String, endpoint: NWEndpoint, port: Int, token: String?, project: String?, agentType: String?)] = []

        for result in uniqueResults {
            guard case .service(let name, _, _, _) = result.endpoint else { continue }

            // Extract TXT metadata
            var token: String?
            var project: String?
            var agentType: String?
            var port: Int?

            if case .bonjour(let txtRecord) = result.metadata {
                token = txtRecord.getDictionaryValue(for: "token")
                project = txtRecord.getDictionaryValue(for: "project")
                agentType = txtRecord.getDictionaryValue(for: "agent")
                if let portStr = txtRecord.getDictionaryValue(for: "port") {
                    port = Int(portStr)
                }
                print("[Discovery] TXT for \(name): port=\(port ?? -1) agent=\(agentType ?? "nil") token=\(token != nil)")
            } else {
                // No metadata yet — parse port from service name (e.g., "Project-9121")
                let parts = name.split(separator: "-")
                if let last = parts.last, let parsedPort = Int(last) {
                    port = parsedPort
                }
                print("[Discovery] no TXT for \(name), parsed port=\(port ?? -1)")
            }
            port = port ?? 9120

            // Always resolve via endpoint — TXT ip field can be stale (Bonjour cache
            // after DHCP renewal). Endpoint resolution uses the system's live mDNS resolver.
            // TXT metadata (token, agent, project) is still extracted above for use after resolve.
            needsResolve.append((name, result.endpoint, port!, token, project, agentType))
        }

        // Resolve all endpoints via NWConnection (live mDNS, not cached TXT)
        for item in needsResolve {
            resolveEndpoint(item.endpoint) { [weak self] resolvedHost in
                guard let self, !self.isTerminating else { return }
                // Reject unusable addresses:
                //   nil            — resolve failed
                //   169.254.*      — IPv4 link-local (APIPA), can't route between devices
                //   fe80:*         — IPv6 link-local, unusable without zone ID (which we
                //                    strip in resolveEndpoint because URL() doesn't accept
                //                    %zone suffixes in a portable way)
                //   ::1 / 127.*    — loopback, not reachable from iPad
                guard let resolvedHost,
                      !resolvedHost.hasPrefix("169.254."),
                      !resolvedHost.lowercased().hasPrefix("fe80:"),
                      !resolvedHost.lowercased().hasPrefix("fe80%"),
                      resolvedHost != "::1",
                      !resolvedHost.hasPrefix("127.") else {
                    print("[Discovery] resolve rejected for \(item.name): host=\(resolvedHost ?? "nil")")
                    return
                }
                // If we have no token from TXT, try to fetch it from /health
                let token = item.token
                let port = item.port
                let name = item.name
                let project = item.project
                let agent = item.agentType

                // Always fetch /health to get agentType (TXT records may be empty)
                self.fetchHealthInfo(host: resolvedHost, port: port) { [weak self] health in
                    guard let self, !self.isTerminating else { return }
                    let resolvedToken = token ?? health.token
                    let resolvedAgent = agent ?? health.agentType
                    print("[Discovery] resolved \(name) to \(resolvedHost):\(port) token=\(resolvedToken != nil ? "yes" : "nil") agent=\(resolvedAgent ?? "nil")")
                    DispatchQueue.main.async {
                        guard !self.isTerminating else { return }
                        let bridge = DiscoveredBridge(
                            name: name,
                            host: resolvedHost,
                            port: port,
                            token: resolvedToken,
                            project: project,
                            agentType: resolvedAgent
                        )
                        if let idx = self.bridges.firstIndex(where: { $0.id == bridge.id }) {
                            self.bridges[idx] = bridge  // Update with health info
                        } else {
                            self.bridges.append(bridge)
                        }
                    }
                }
            }
        }

        DispatchQueue.main.async {
            guard !self.isTerminating else { return }
            // Remove bridges whose mDNS service disappeared (not in current browse results)
            let currentNames = Set(needsResolve.map(\.name))
            self.bridges.removeAll { !currentNames.contains($0.name) }
        }
    }

    // MARK: - Token Fetch

    /// Health info from bridge /health endpoint
    private struct HealthInfo: Sendable {
        let token: String?
        let agentType: String?  // "daemon", "session", etc.
    }

    /// Fetch token and agentType from bridge /health endpoint
    private func fetchHealthInfo(host: String, port: Int, completion: @escaping @Sendable (HealthInfo) -> Void) {
        // macOS: read auth-token from AgentDeckPaths (App Store sandbox
        // container for signed builds, ~/.agentdeck/ for dev).
        #if os(macOS)
        let tokenURL = AgentDeckPaths.authToken
        let localToken = try? String(contentsOf: tokenURL, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        #else
        let localToken: String? = nil
        #endif

        guard let url = makeHealthURL(host: host, port: port) else {
            print("[Discovery] invalid health URL host=\(host) port=\(port)")
            completion(HealthInfo(token: localToken, agentType: nil))
            return
        }
        var request = URLRequest(url: url, timeoutInterval: 3)
        request.httpMethod = "GET"
        print("[Discovery] fetching health from \(url.absoluteString)")
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                print("[Discovery] /health fetch error: \(error.localizedDescription)")
                completion(HealthInfo(token: localToken, agentType: nil))
                return
            }
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                print("[Discovery] /health parse failed")
                completion(HealthInfo(token: localToken, agentType: nil))
                return
            }
            let token = (json["pairingToken"] as? String) ?? localToken
            let mode = json["mode"] as? String  // "daemon" or "session"
            print("[Discovery] /health got token: \(token?.prefix(8) ?? "nil")... mode: \(mode ?? "nil")")
            completion(HealthInfo(token: token, agentType: mode))
        }.resume()
    }

    private func makeHealthURL(host: String, port: Int) -> URL? {
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty else { return nil }

        var components = URLComponents()
        components.scheme = "http"
        if trimmedHost.contains(":") && !trimmedHost.hasPrefix("[") && !trimmedHost.hasSuffix("]") {
            components.host = "[\(trimmedHost)]"
        } else {
            components.host = trimmedHost
        }
        components.port = port
        components.path = "/health"
        return components.url
    }

    // MARK: - Endpoint Resolution

    private func resolveEndpoint(_ endpoint: NWEndpoint, completion: @escaping @Sendable (String?) -> Void) {
        // Force IPv4 so Bonjour resolves to a Wi-Fi/Ethernet A record instead of
        // an unreachable link-local IPv6 (fe80::…). iPads on the same LAN can
        // always reach the Mac over IPv4; they often can't reach an fe80 address
        // because the %zone identifier doesn't survive NWEndpoint → String → URL
        // and the host interface may not even share the same IPv6 scope.
        let params = NWParameters.tcp
        if let ipOptions = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options {
            ipOptions.version = .v4
        }
        let connection = NWConnection(to: endpoint, using: params)
        let guard_ = ResolveGuard()

        connection.stateUpdateHandler = { state in
            guard guard_.tryComplete() else { return }
            switch state {
            case .ready:
                // Extract resolved IP from the connection's current path
                if let path = connection.currentPath,
                   let remoteEndpoint = path.remoteEndpoint,
                   case .hostPort(let host, _) = remoteEndpoint {
                    let hostStr = "\(host)"
                    // Strip interface suffix (e.g. "%en0") — zone IDs don't
                    // round-trip through URL() anyway. Any fe80:* result that
                    // slips through here will be rejected in handleResults.
                    let clean = hostStr.components(separatedBy: "%").first ?? hostStr
                    completion(clean)
                } else {
                    completion(nil)
                }
                connection.cancel()
            case .failed, .cancelled:
                completion(nil)
            default:
                guard_.reset()  // Not a terminal state, allow retry
            }
        }

        connection.start(queue: queue)

        // Timeout after 3 seconds
        queue.asyncAfter(deadline: .now() + 3) {
            guard guard_.tryComplete() else { return }
            completion(nil)
            connection.cancel()
        }
    }
}

// MARK: - Thread-safe completion guard

private final class ResolveGuard: @unchecked Sendable {
    private let lock = NSLock()
    private var _completed = false

    /// Returns true if this is the first call (i.e., we "won" the race).
    func tryComplete() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if _completed { return false }
        _completed = true
        return true
    }

    func reset() {
        lock.lock()
        defer { lock.unlock() }
        _completed = false
    }
}

// MARK: - NWTXTRecord helper

extension NWTXTRecord {
    func getDictionaryValue(for key: String) -> String? {
        guard let entry = getEntry(for: key) else { return nil }
        if case .string(let str) = entry {
            // entry is "key=value" format
            if let eqIdx = str.firstIndex(of: "=") {
                return String(str[str.index(after: eqIdx)...])
            }
            return str
        }
        return nil
    }
}
