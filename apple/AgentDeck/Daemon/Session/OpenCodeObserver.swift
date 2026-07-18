#if os(macOS)
// OpenCodeObserver.swift — opt-in discovery + lifecycle for OpenCode
// session monitoring (Tier 1, sandboxed App Store daemon).
//
// Default OFF (`AppPreferences.openCodeMonitoringEnabled`); while disabled
// this makes ZERO network probes. When the user enables it in Settings →
// Integrations, the observer looks for a user-run OpenCode server via three
// mechanisms — all pointed at servers the user started themselves:
//   1. the user-configured URL (Settings, default http://127.0.0.1:4096),
//   2. the `opencode serve` default port 4096 health probe
//      (fixed-port probe, same shape as GatewayProbe's 18789),
//   3. sysctl argv inspection for an explicit `opencode … --port N`
//      (ProcessEnumerator; excludes agentdeck-managed processes — those are
//      Tier 2's job and the whole Swift daemon stands down anyway).
// A bare `opencode` TUI binds an ephemeral random port that appears nowhere
// in argv — deliberately NOT discoverable (no port scanning; documented
// limitation in docs/appstore-feature-matrix.md).
//
// Once connected it consumes the `/global/event` SSE stream and forwards
// classified OpenCodeSessionUpdate values to DaemonServer, which merges them
// into `pushedSessionsById` (same contract as the Codex OTel path). The 5s
// tick doubles as keepalive (so entries aren't TTL-evicted between events)
// and as the reconnect backoff after a stream drop.

import Foundation

// Holds daemon state → runs on the daemon's executor. See DaemonActor.
// Global-actor isolation also makes this type Sendable, which it must be: it
// hands a closure to `OpenCodeSSEClient.streamEvents`, whose parameter is
// `@Sendable`. That closure does NOT inherit the daemon's isolation, so it
// re-enters through `deliver` with an explicit `await`.
@DaemonActor
final class OpenCodeObserver {
    nonisolated static let defaultServerURL = "http://127.0.0.1:4096"
    private static let tickSeconds: UInt64 = 5

    struct Callbacks {
        /// A classified SSE event (or connect-time seed) for one session.
        var onUpdate: (OpenCodeSessionUpdate) -> Void
        /// Stream dropped / observer disabled — mark tracked sessions idle.
        var onDisconnect: () -> Void
        /// Connection healthy this tick — refresh eviction timestamps.
        var onKeepalive: () -> Void
    }

    private var callbacks: Callbacks?
    private var loopTask: Task<Void, Never>?
    private var streamTask: Task<Void, Never>?
    private(set) var connectedURL: URL?

    func start(callbacks: Callbacks) {
        guard loopTask == nil else { return }
        self.callbacks = callbacks
        loopTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                try? await Task.sleep(nanoseconds: Self.tickSeconds * 1_000_000_000)
            }
        }
    }

    func stop() {
        loopTask?.cancel()
        loopTask = nil
        disconnect(notify: false)
        callbacks = nil
    }

    // MARK: - Tick

    private func tick() async {
        let enabled = AppPreferences.shared.openCodeMonitoringEnabled
        guard enabled else {
            if streamTask != nil { disconnect(notify: true) }
            return
        }

        if streamTask != nil {
            // Connected — refresh eviction timestamps so idle-but-alive
            // sessions aren't reaped between SSE events.
            callbacks?.onKeepalive()
            return
        }

        // Not connected — discover and attach.
        let userURL = AppPreferences.shared.openCodeServerURL
        let candidates = await Task.detached(priority: .utility) {
            Self.candidateURLs(userConfigured: userURL)
        }.value

        for url in candidates {
            let client = OpenCodeSSEClient(baseURL: url)
            guard let health = await client.health(), health.healthy else { continue }
            DaemonLogger.shared.info("OpenCode server found at \(url.absoluteString)")
            connect(client: client, url: url)
            return
        }
    }

    // MARK: - Discovery (pure-ish; no network)

    /// Ordered, deduped candidate base URLs. Exposed for tests.
    nonisolated static func candidateURLs(
        userConfigured: String,
        processArgs: [[String]]? = nil
    ) -> [URL] {
        var seen = Set<String>()
        var out: [URL] = []
        func add(_ raw: String) {
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
                .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
            guard !trimmed.isEmpty,
                  let url = URL(string: trimmed),
                  let scheme = url.scheme, scheme == "http" || scheme == "https",
                  seen.insert(trimmed.lowercased()).inserted
            else { return }
            out.append(url)
        }

        add(userConfigured)
        add(defaultServerURL)

        let argvList = processArgs ?? ProcessEnumerator.processSnapshots().map(\.arguments)
        for args in argvList {
            if let port = explicitPort(inOpenCodeArgs: args) {
                add("http://127.0.0.1:\(port)")
            }
        }
        return out
    }

    /// Extract an explicit `--port N` from an `opencode` process argv.
    /// Nil unless the process IS opencode and the port is genuinely in argv
    /// (bare TUIs bind an ephemeral port that never appears here).
    /// agentdeck-managed opencode processes are excluded — they belong to the
    /// Tier 2 CLI daemon.
    nonisolated static func explicitPort(inOpenCodeArgs args: [String]) -> Int? {
        guard let first = args.first else { return nil }
        let binary = (first as NSString).lastPathComponent
        guard binary == "opencode" || first.hasSuffix("/opencode") else { return nil }
        guard !args.contains(where: { $0.contains("agentdeck") }) else { return nil }
        guard let raw = ProcessEnumerator.value(after: "--port", in: args),
              let port = Int(raw), (1...65_535).contains(port)
        else { return nil }
        return port
    }

    // MARK: - Connection

    private func connect(client: OpenCodeSSEClient, url: URL) {
        connectedURL = url
        streamTask = Task { [weak self] in
            // Seed sessions already mid-turn: their SSE work signals fired
            // before we attached, so without this they'd stay invisible
            // until the next event.
            let busy = await client.sessionStatus().filter { $0.value == "busy" }.map(\.key)
            for sid in busy {
                let summary = await client.session(id: sid)
                await self?.deliver(OpenCodeSessionUpdate(
                    sessionID: sid,
                    kind: .processing,
                    title: summary?.title,
                    directory: summary?.directory
                ))
            }

            do {
                try await client.streamEvents { [weak self] update in
                    await self?.deliver(update)
                }
                DaemonLogger.shared.info("OpenCode SSE stream ended (\(url.absoluteString))")
            } catch is CancellationError {
                return
            } catch {
                DaemonLogger.shared.debug("OpenCode", "SSE stream error: \(error.localizedDescription)")
            }

            await self?.handleStreamDropped()
        }
    }

    /// Single delivery seam for SSE updates — keeps the `@Sendable` stream
    /// closure from having to touch actor state directly.
    private func deliver(_ update: OpenCodeSessionUpdate) {
        callbacks?.onUpdate(update)
    }

    private func handleStreamDropped() {
        guard streamTask != nil else { return }
        streamTask = nil
        connectedURL = nil
        // The 5s tick loop is the reconnect backoff — next tick re-probes.
        callbacks?.onDisconnect()
    }

    private func disconnect(notify: Bool) {
        streamTask?.cancel()
        streamTask = nil
        connectedURL = nil
        if notify { callbacks?.onDisconnect() }
    }
}
#endif
