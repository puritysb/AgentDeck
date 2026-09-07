#if os(macOS)
import SwiftUI

@MainActor
final class CollaborationFeed: ObservableObject {
    @Published var task: CollaborationTask?
    @Published var children: [CollaborationChild] = []
    @Published var relations: [CollaborationRelation] = []
    @Published var message = "Select a session on the left"
    @Published var fetchedAt: Date?
    @Published var failed = false

    func observe(sessionId: String, port: Int) async {
        task = nil; children = []; relations = []; fetchedAt = nil; failed = false
        message = "Reading task relations…"
        guard !sessionId.isEmpty, port > 0 else {
            message = "Select a session on the left"; return
        }
        let sampleSessionID = ObservedAgentRules.rawSessionId(sessionId)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 8
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        while !Task.isCancelled {
            do {
                var url = URLComponents(string: "http://127.0.0.1:\(port)/apme/tasks")!
                url.queryItems = [URLQueryItem(name: "session", value: sampleSessionID), URLQueryItem(name: "limit", value: "1")]
                let page: CollaborationTaskPage = try await read(url.url!, using: session)
                try Task.checkCancellation()
                // Also validate the server's filter: an older route may ignore it.
                guard let latest = page.tasks.first, latest.sessionId == sampleSessionID else {
                    task = nil; children = []; relations = []; failed = false; fetchedAt = Date()
                    message = "No task record for this session yet"
                    try await Task.sleep(for: .seconds(15)); continue
                }
                let detailURL = URL(string: "http://127.0.0.1:\(port)/apme/tasks")!
                    .appendingPathComponent(latest.id)
                let detail: CollaborationDetail = try await read(detailURL, using: session)
                try Task.checkCancellation()
                task = latest
                children = CollaborationProjection.children(sample: detail.sample, sessionId: sampleSessionID, taskId: latest.id)
                relations = CollaborationProjection.relations(sample: detail.sample, sessionId: sampleSessionID, taskId: latest.id)
                fetchedAt = Date(); failed = false
                message = detail.sample == nil ? "This daemon does not serve per-task evidence" : "Observed relations only · whether results were integrated is not tracked"
            } catch {
                guard !Task.isCancelled else { return }
                failed = true
                message = fetchedAt == nil
                    ? "Could not read the task record · live session state is still shown"
                    : "Refresh failed · relations below are from the last successful read"
            }
            do { try await Task.sleep(for: .seconds(15)) } catch { return }
        }
    }

    // Iterate and decode off the UI actor: a real task can contain hundreds of
    // KiB of tool evidence even though this projection ignores those payloads.
    nonisolated private func read<T: Decodable & Sendable>(_ url: URL, using session: URLSession) async throws -> T {
        // Same authenticated local API as the existing APME window. Keep the
        // adopted daemon token only in ephemeral requests, never in UI/logs.
        var authorized = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let token = await AuthManager.shared.token
        authorized.queryItems = (authorized.queryItems ?? []) + [URLQueryItem(name: "token", value: token)]
        let (bytes, response) = try await session.bytes(from: authorized.url!)
        guard let response = response as? HTTPURLResponse, response.statusCode == 200,
              response.expectedContentLength <= 2_097_152 else { throw URLError(.badServerResponse) }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 2_097_152 else { throw URLError(.dataLengthExceedsMaximum) }
            data.append(byte)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

struct CollaborationPanel: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var daemonService: DaemonService
    @StateObject private var feed = CollaborationFeed()
    @State private var inspectedID: String?
    @State private var showsSystem = false
    let maxHeight: CGFloat

    private var selected: SessionInfo? {
        stateHolder.state.siblingSessions.first { $0.id == inspectedID }
    }
    private var observationKey: String {
        "\(daemonService.port)|\(stateHolder.state.bridgeConnected)|\(selected?.id ?? "")"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label("Collaboration", systemImage: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 17, weight: .semibold))
                Spacer()
                // Badge, not a word: the existing capsule idiom (caption-size
                // text, 6/2 padding, 20% tinted Capsule) used by the
                // connection overlay's `local` / agent chips.
                Text("BETA")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .kerning(0.8)
                    .foregroundStyle(DesignTokens.UI.cyan)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(DesignTokens.UI.cyan.opacity(0.18), in: Capsule())
                    .overlay(Capsule().stroke(DesignTokens.UI.cyan.opacity(0.35), lineWidth: 0.5))
                    .accessibilityLabel("Beta feature")
                Button { showsSystem.toggle() } label: {
                    Image(systemName: "network")
                }.help("Show system status").popover(isPresented: $showsSystem) {
                    TopologyRail(maxHeight: 560).frame(width: 330).padding(12)
                }
            }
            Text("Session → latest task → confirmed child agents and relations")
                .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
            Divider().overlay(DesignTokens.Ink.s500)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let selected {
                        sessionHeader(selected)
                        if let task = feed.task {
                            VStack(alignment: .leading, spacing: 6) {
                                Label(task.endedAt == nil ? "Latest task · open" : "Latest task · closed",
                                      systemImage: "square.stack.3d.up")
                                    .font(.caption).foregroundStyle(DesignTokens.UI.cyan)
                                Text(task.displayTitle).font(.system(size: 16, weight: .medium)).lineLimit(4)
                            }
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(DesignTokens.Ink.s700.opacity(0.55), in: RoundedRectangle(cornerRadius: 12))
                        }
                        if selected.subagents != nil || selected.coordination != nil {
                            HStack(spacing: 8) {
                                if let census = selected.subagents {
                                    metric(census.active, "Subagents active", "circle.dotted", DesignTokens.UI.cyan)
                                    metric(census.completed, "Done this wave", "checkmark.circle", DesignTokens.UI.ok)
                                }
                                if let coord = selected.coordination {
                                    metric(coord.spawnedActive, "Spawned running", "arrow.up.right.circle", DesignTokens.UI.cyan)
                                    metric(coord.backgroundJobs, "Jobs waited on", "hourglass", DesignTokens.UI.attn)
                                }
                            }
                            if let coord = selected.coordination, coord.messagesIn + coord.messagesOut > 0 {
                                Text("Peer messages · in \(coord.messagesIn) · out \(coord.messagesOut)\(coord.lastPeerName.map { " · last \($0)" } ?? "")")
                                    .font(.system(size: 10)).foregroundStyle(DesignTokens.Ink.s300)
                            }
                            Text("Live session census · may differ in scope from the task record below")
                                .font(.system(size: 10)).foregroundStyle(DesignTokens.Ink.s300)
                        }
                        if !feed.children.isEmpty {
                            Label("Observed child agents", systemImage: "arrow.triangle.branch")
                                .font(.caption).foregroundStyle(DesignTokens.UI.cyan)
                            ForEach(feed.children.prefix(24)) { child in childRow(child) }
                            if feed.children.count > 24 {
                                Text("+\(feed.children.count - 24) more · this panel shows 24").font(.caption)
                            }
                        } else {
                            VStack(spacing: 8) {
                                Image(systemName: "point.topleft.down.to.point.bottomright.curvepath")
                                    .font(.system(size: 28)).foregroundStyle(DesignTokens.Ink.s300)
                                Text("No confirmed branches yet").font(.subheadline)
                                Text("Sessions in the same project are never linked by assumption.")
                                    .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
                            }.frame(maxWidth: .infinity).padding(.vertical, 16)
                        }
                        relationSections
                        Label(feed.message, systemImage: feed.failed ? "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90" : "eye")
                            .font(.caption).foregroundStyle(feed.failed ? DesignTokens.UI.attn : DesignTokens.Ink.s300)
                        if let fetched = feed.fetchedAt {
                            Text("Read \(fetched.formatted(date: .omitted, time: .standard)) · refreshes every 15 s")
                                .font(.system(size: 10)).foregroundStyle(DesignTokens.Ink.s300)
                        }
                    } else {
                        Image(systemName: "cursorarrow.click.2").font(.largeTitle).padding(.top, 20)
                        Text(inspectedID == nil ? "Select a session in the roster or a creature in the habitat" : "The selected session left the roster. Pick another one.")
                            .font(.subheadline)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.scrollBounceBehavior(.basedOnSize)
        }
        .padding(16).frame(maxHeight: maxHeight)
        .background(DesignTokens.Ink.s900.opacity(0.94), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(DesignTokens.Ink.s500.opacity(0.6)))
        .foregroundStyle(DesignTokens.Tide.s50)
        .onAppear { inspectedID = stateHolder.state.focusedSessionId }
        .onChange(of: stateHolder.state.focusedSessionId) { _, id in inspectedID = id }
        .task(id: observationKey) {
            await feed.observe(sessionId: stateHolder.state.bridgeConnected ? (selected?.id ?? "") : "", port: Int(daemonService.port))
        }
    }

    private func sessionHeader(_ session: SessionInfo) -> some View {
        let waiting = session.state?.hasPrefix("awaiting") == true
        let working = session.state == "processing"
        // Turn closed, but work it started is still running: the parent is
        // idle to the harness and waiting to the user. Say both.
        let pending = (session.coordination?.spawnedActive ?? 0) + (session.coordination?.backgroundJobs ?? 0)
        let awaitingResults = !waiting && !working && pending > 0
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Image(systemName: waiting ? "person.crop.circle.badge.exclamationmark" : "circle.hexagongrid.fill")
                    .font(.system(size: 25)).foregroundStyle(waiting ? DesignTokens.UI.attn : DesignTokens.UI.cyan)
                VStack(alignment: .leading, spacing: 3) {
                    Text(session.projectName ?? "Unknown project").font(.headline).lineLimit(2)
                    Text("\(session.agentType ?? "Unknown agent") · \(ObservedAgentRules.rawSessionId(session.id).prefix(8))")
                        .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
                }
            }
            Label(waiting ? "Session · needs your input"
                    : working ? "Session · working"
                    : awaitingResults ? "Session · turn closed · waiting on \(pending) job\(pending == 1 ? "" : "s")"
                    : "Session · \(session.state ?? "unknown")",
                  systemImage: waiting ? "hand.raised.fill" : working ? "waveform" : awaitingResults ? "hourglass" : "pause.circle")
                .font(.caption).foregroundStyle(waiting || awaitingResults ? DesignTokens.UI.attn : DesignTokens.UI.cyan)
            if let activity = session.activity, !activity.isEmpty {
                Text(activity).font(.subheadline).lineLimit(3)
            }
            if waiting {
                Text(session.question ?? "See the question in the answer card")
                    .font(.subheadline).lineLimit(4).padding(10)
                    .background(DesignTokens.UI.attn.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                Text("Answer from the question card or in the agent itself")
                    .font(.caption).foregroundStyle(DesignTokens.UI.attn)
            }
        }
    }

    private func metric(_ number: Int, _ title: String, _ symbol: String, _ color: Color) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Label("\(max(0, number))", systemImage: symbol).font(.system(size: 24, weight: .semibold))
            Text(title).font(.system(size: 11))
        }.foregroundStyle(color).frame(maxWidth: .infinity, alignment: .leading).padding(10)
            .background(color.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    private var spawnedOut: [CollaborationRelation] { feed.relations.filter { $0.relation == "spawned" && $0.direction == "out" } }
    private var spawnedIn: [CollaborationRelation] { feed.relations.filter { $0.relation == "spawned" && $0.direction == "in" } }
    private var messages: [CollaborationRelation] { feed.relations.filter { $0.relation == "messaged" } }
    private var jobs: [CollaborationRelation] { feed.relations.filter { $0.relation == "waiting_on" } }

    /// Cross-session relations the sample carries. Each section names its
    /// evidence, and a peer that could not be resolved is shown with only the
    /// name the evidence had — never a guessed session.
    @ViewBuilder
    private var relationSections: some View {
        if !spawnedIn.isEmpty {
            Label("Spawned by", systemImage: "arrow.down.left.circle")
                .font(.caption).foregroundStyle(DesignTokens.UI.cyan)
            ForEach(spawnedIn.prefix(4)) { relationRow($0) }
        }
        if !spawnedOut.isEmpty {
            Label("Spawned sessions · by process ancestry", systemImage: "arrow.up.right.circle")
                .font(.caption).foregroundStyle(DesignTokens.UI.cyan)
            ForEach(spawnedOut.prefix(12)) { relationRow($0) }
            if spawnedOut.count > 12 {
                Text("+\(spawnedOut.count - 12) more").font(.caption).foregroundStyle(DesignTokens.Ink.s300)
            }
        }
        if !jobs.isEmpty {
            Label("Background jobs waited on", systemImage: "hourglass")
                .font(.caption).foregroundStyle(DesignTokens.UI.attn)
            ForEach(jobs.prefix(6)) { relationRow($0) }
        }
        if !messages.isEmpty {
            Label("Peer messages · latest \(min(messages.count, 8))", systemImage: "bubble.left.and.bubble.right")
                .font(.caption).foregroundStyle(DesignTokens.UI.cyan)
            ForEach(messages.suffix(8).reversed()) { relationRow($0) }
        }
    }

    private func relationRow(_ row: CollaborationRelation) -> some View {
        let peer: String = {
            if let name = row.peerName, !name.isEmpty { return name }
            if let sid = row.peerSessionId, !sid.isEmpty {
                let match = stateHolder.state.siblingSessions.first { ObservedAgentRules.rawSessionId($0.id) == sid }
                let project = match?.projectName ?? "Session"
                return "\(project) · \(sid.prefix(8))\(match == nil ? " · ended" : "")"
            }
            return row.relation == "spawned" ? "Session not resolved · launch observed" : "Unknown"
        }()
        let symbol: String
        let status: String
        let color: Color
        switch row.relation {
        case "spawned":
            symbol = row.direction == "in" ? "arrow.down.left" : "arrow.up.right"
            status = row.isOpen ? (row.evidence == "bash_claude_p" ? "Launch observed · session not yet seen" : "Running") : "Ended · result integration not tracked"
            color = row.isOpen ? DesignTokens.UI.cyan : DesignTokens.UI.ok
        case "waiting_on":
            symbol = "hourglass"
            status = row.isOpen ? "Running · this session resumes when it finishes" : "Ended"
            color = row.isOpen ? DesignTokens.UI.attn : DesignTokens.Ink.s300
        default:
            symbol = row.direction == "in" ? "arrow.down.left.circle" : "arrow.up.right.circle"
            status = (row.direction == "in" ? "Received" : "Sent") + " · " + Date(timeIntervalSince1970: row.observedAt / 1000).formatted(date: .omitted, time: .shortened)
            color = DesignTokens.UI.cyan
        }
        return HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol).foregroundStyle(color).padding(.top, 12)
            VStack(alignment: .leading, spacing: 4) {
                Text(peer).font(.subheadline.bold()).lineLimit(2)
                Text(status).font(.system(size: 10)).foregroundStyle(DesignTokens.Ink.s300)
                if let detail = row.detail, !detail.isEmpty {
                    Text(detail).font(.caption).lineLimit(3)
                }
            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(DesignTokens.Ink.s800, in: RoundedRectangle(cornerRadius: 10))
        }
    }

    private func childRow(_ child: CollaborationChild) -> some View {
        let ended = child.phase == "completed"
        return HStack(alignment: .top, spacing: 8) {
            // An explicit branch from the selected task, not a decorative network.
            Image(systemName: "arrow.turn.down.right").foregroundStyle(DesignTokens.Ink.s300).padding(.top, 12)
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Image(systemName: ended ? "checkmark.circle.fill" : "circle.dotted")
                        .foregroundStyle(ended ? DesignTokens.UI.ok : DesignTokens.UI.cyan)
                    Text(child.name).font(.subheadline.bold()).lineLimit(2)
                    Spacer(minLength: 0)
                }
                Text(ended ? "Ended · result integration not tracked" : "Started · see the live census for whether it still runs")
                    .font(.system(size: 10)).foregroundStyle(DesignTokens.Ink.s300)
                if let summary = child.summary, !summary.isEmpty {
                    Text(summary).font(.caption).lineLimit(4)
                }
            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(DesignTokens.Ink.s800, in: RoundedRectangle(cornerRadius: 10))
        }
    }
}
#endif
