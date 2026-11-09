#if os(macOS)
import SwiftUI

enum CollaborationReadState: Equatable {
    case noSelection, disconnected, loading, ready, empty, unsupported, failed, tooLarge, taskUnavailable

    var message: String {
        switch self {
        case .noSelection: "Select a session on the left"
        case .disconnected: "Disconnected · reconnect to read collaboration history"
        case .loading: "Reading collaboration history…"
        case .ready: "Task history"
        case .empty: "No task has been recorded for this session yet"
        case .unsupported: "Collaboration history is unavailable from this daemon"
        case .failed: "Refresh failed · previously read history may be out of date"
        case .tooLarge: "This task's history is too large to read here"
        case .taskUnavailable: "This task is no longer in recent history. Choose another task."
        }
    }

    var isFailure: Bool { self == .failed || self == .tooLarge }
}

enum CollaborationReadError: Error { case unsupported, tooLarge }

@MainActor
final class CollaborationFeed: ObservableObject {
    @Published var task: CollaborationTask?
    @Published var recentTasks: [CollaborationTask] = []
    @Published var children: [CollaborationChild] = []
    @Published var relations: [CollaborationRelation] = []
    @Published var state: CollaborationReadState = .noSelection
    @Published var fetchedAt: Date?
    private var generation = UUID()
    private var context = ""
    private let load: @Sendable (URL) async throws -> Data
    private let pause: @Sendable () async throws -> Void

    init(load: @escaping @Sendable (URL) async throws -> Data = CollaborationFeed.fetch,
         pause: @escaping @Sendable () async throws -> Void = { try await Task.sleep(for: .seconds(15)) }) {
        self.load = load
        self.pause = pause
    }

    func observe(sessionId: String, port: Int, connected: Bool = true, taskId: String? = nil) async {
        let current = UUID()
        generation = current
        let nextContext = "\(port)|\(sessionId)|\(taskId ?? "latest")"
        if context != nextContext {
            task = nil; recentTasks = []; children = []; relations = []; fetchedAt = nil
            context = nextContext
        }
        guard connected, port > 0 else { state = .disconnected; return }
        guard !sessionId.isEmpty else { state = .noSelection; return }
        state = .loading
        let sampleSessionID = ObservedAgentRules.rawSessionId(sessionId)
        while !Task.isCancelled && generation == current {
            do {
                var url = URLComponents(string: "http://127.0.0.1:\(port)/apme/tasks")!
                url.queryItems = [URLQueryItem(name: "session", value: sampleSessionID), URLQueryItem(name: "limit", value: "8")]
                let page: CollaborationTaskPage = try await read(url.url!)
                try Task.checkCancellation()
                guard generation == current else { return }
                // Validate the whole page before offering historical navigation.
                guard page.tasks.allSatisfy({ $0.sessionId == sampleSessionID }) else {
                    throw CollaborationReadError.unsupported
                }
                recentTasks = Array(page.tasks.prefix(8))
                let requested = taskId.flatMap { id in recentTasks.first { $0.id == id } }
                if let latest = taskId == nil ? recentTasks.first : requested {
                    let detailURL = URL(string: "http://127.0.0.1:\(port)/apme/tasks")!
                        .appendingPathComponent(latest.id)
                    let detail: CollaborationDetail = try await read(detailURL)
                    try Task.checkCancellation()
                    guard generation == current else { return }
                    if let sample = detail.sample {
                        guard sample.sessionId == sampleSessionID, sample.id == latest.id else {
                            throw CollaborationReadError.unsupported
                        }
                    }
                    task = latest
                    children = CollaborationProjection.children(sample: detail.sample, sessionId: sampleSessionID, taskId: latest.id)
                    relations = CollaborationProjection.relations(sample: detail.sample, sessionId: sampleSessionID, taskId: latest.id)
                    state = detail.sample == nil ? .unsupported : .ready
                } else {
                    task = nil; children = []; relations = []; state = taskId == nil ? .empty : .taskUnavailable
                }
                fetchedAt = Date()
            } catch {
                guard !Task.isCancelled, generation == current else { return }
                switch error {
                case CollaborationReadError.unsupported: state = .unsupported
                case CollaborationReadError.tooLarge: state = .tooLarge
                default: state = .failed
                }
            }
            do { try await pause() } catch { return }
        }
    }

    // Decode off the UI actor: most bytes are tool payloads we never retain.
    nonisolated private func read<T: Decodable & Sendable>(_ url: URL) async throws -> T {
        try JSONDecoder().decode(T.self, from: await load(url))
    }

    nonisolated static func fetch(_ url: URL) async throws -> Data {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 5
        configuration.timeoutIntervalForResource = 8
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        var authorized = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        let token = await AuthManager.shared.token
        authorized.queryItems = (authorized.queryItems ?? []) + [URLQueryItem(name: "token", value: token)]
        let (bytes, response) = try await session.bytes(from: authorized.url!)
        guard let response = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        if response.statusCode == 404 || response.statusCode == 501 { throw CollaborationReadError.unsupported }
        guard response.statusCode == 200 else { throw URLError(.badServerResponse) }
        guard response.expectedContentLength <= 2_097_152 else { throw CollaborationReadError.tooLarge }
        var data = Data()
        for try await byte in bytes {
            guard data.count < 2_097_152 else { throw CollaborationReadError.tooLarge }
            data.append(byte)
        }
        return data
    }
}

struct CollaborationPanel: View {
    @EnvironmentObject private var inspection: DashboardInspection
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @StateObject private var feed: CollaborationFeed
    @ObservedObject private var communications: CommunicationFeed
    @State private var inspectedID: String?
    @State private var selectedTaskID: String?
    @State private var showsSystem = false
    @State private var refreshID = UUID()
    @State private var navigationHistory: [String] = []
    let maxHeight: CGFloat
    let port: Int
    let panelSelection: Binding<Bool>?

    init(maxHeight: CGFloat, port: Int, feed: CollaborationFeed = CollaborationFeed(),
         communications: CommunicationFeed = CommunicationFeed(), inspectedID: String? = nil,
         panelSelection: Binding<Bool>? = nil) {
        self.maxHeight = maxHeight
        self.port = port
        self.communications = communications
        self.panelSelection = panelSelection
        _feed = StateObject(wrappedValue: feed)
        _inspectedID = State(initialValue: inspectedID)
    }

    private var selected: SessionInfo? {
        stateHolder.state.siblingSessions.first { $0.id == inspectedID }
    }
    private var observationKey: String {
        "\(port)|\(stateHolder.state.bridgeConnected)|\(selected?.id ?? "")|\(selectedTaskID ?? "latest")|\(refreshID)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                if let panelSelection {
                    DashboardPanelMenu(collaborationEnabled: panelSelection, title: "Collaboration")
                } else {
                    Label(CollaborationPresentation.heading, systemImage: "point.3.connected.trianglepath.dotted")
                        .font(.system(size: 17, weight: .semibold))
                }
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
            Text("Sessions, delegated work and background jobs")
                .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
            Divider().overlay(DesignTokens.Ink.s500)
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let selected {
                        if let previous = navigationHistory.last(where: { id in stateHolder.state.siblingSessions.contains { $0.id == id } }) {
                            Button {
                                if let index = navigationHistory.lastIndex(of: previous) {
                                    navigationHistory.removeSubrange(index...)
                                }
                                inspect(previous, remember: false)
                            } label: {
                                Label("Back to previous session", systemImage: "chevron.left")
                            }.buttonStyle(.plain)
                        }
                        sessionHeader(selected)
                        liveWork(selected)
                        feedStatus
                        if let task = feed.task {
                            VStack(alignment: .leading, spacing: 6) {
                                Menu {
                                    Button("Follow latest task") { selectedTaskID = nil }
                                    ForEach(feed.recentTasks) { item in
                                        Button(item.displayTitle) { selectedTaskID = item.id }
                                    }
                                } label: {
                                    Label(selectedTaskID == nil ? "Latest task" : "Selected task", systemImage: "clock.arrow.circlepath")
                                        .font(.caption).foregroundStyle(DesignTokens.UI.cyan)
                                }.help("Choose from the latest eight tasks in this session")
                                Text(task.displayTitle).font(.system(size: 16, weight: .medium)).lineLimit(3)
                                if let summary = task.summary?.trimmingCharacters(in: .whitespacesAndNewlines),
                                   !summary.isEmpty, summary != task.displayTitle {
                                    Text(summary).font(.caption).foregroundStyle(DesignTokens.Ink.s300).lineLimit(4)
                                }
                                Text(task.endedAt == nil ? "No task end recorded" : "Task ended")
                                    .font(.caption2).foregroundStyle(DesignTokens.Ink.s300)
                            }
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(DesignTokens.Ink.s700.opacity(0.55), in: RoundedRectangle(cornerRadius: 12))
                        }
                        if feed.state == .ready {
                            let peers = CollaborationProjection.relatedSessions(feed.relations,
                                roster: stateHolder.state.siblingSessions, excluding: selected.id)
                            if !peers.isEmpty {
                                CollaborationRows(title: "Related sessions · now", symbol: "person.2",
                                    rows: peers, limit: 3, isCompleted: { _ in false }, content: sessionShortcut)
                                    .id(inspectedID)
                            }
                        }
                        if !feed.children.isEmpty {
                            CollaborationRows(title: "Delegated work", symbol: "arrow.triangle.branch",
                                              rows: feed.children, limit: 4,
                                              isCompleted: { $0.phase == "completed" }, content: childRow)
                                .id(inspectedID)
                        }
                        relationSections.id(inspectedID)
                        if hasWorkHistory {
                            Text("History records observed activity; an end does not confirm that the result was integrated.")
                                .font(.caption2).foregroundStyle(DesignTokens.Ink.s300)
                        }
                        if feed.state == .ready && !hasWorkHistory {
                            VStack(spacing: 8) {
                                Image(systemName: "point.topleft.down.to.point.bottomright.curvepath")
                                    .font(.system(size: 28)).foregroundStyle(DesignTokens.Ink.s300)
                                Text("No collaboration recorded for this task").font(.subheadline)
                                Text("Live session counts above may include work from earlier tasks.")
                                    .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
                            }.frame(maxWidth: .infinity).padding(.vertical, 16)
                        }
                    } else {
                        Image(systemName: "cursorarrow.click.2").font(.largeTitle).padding(.top, 20)
                        Text(inspectedID == nil ? "Choose a session to see its task, delegates and results" : "The selected session left the roster. Pick another one.")
                            .font(.subheadline)
                        CollaborationRows(title: "Sessions · needs input first", symbol: "hand.raised",
                            rows: CollaborationProjection.prioritizedSessions(stateHolder.state.siblingSessions),
                            limit: 4, isCompleted: { _ in false }, content: sessionShortcut)
                    }
                    DisclosureGroup("Recent message history") {
                        CommunicationGraphView(feed: communications, roster: stateHolder.state.siblingSessions,
                        selectedID: inspectedID, inspect: { inspect($0) }, retry: { communications.refreshID = UUID() })
                            .padding(.top, 6)
                    }
                    .accessibilityIdentifier("collaboration-message-history")
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.scrollBounceBehavior(.basedOnSize).id(inspectedID)
        }
        .padding(16).frame(maxHeight: maxHeight)
        .background(DesignTokens.Ink.s900.opacity(0.94), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(DesignTokens.Ink.s500.opacity(0.6)))
        .foregroundStyle(DesignTokens.Tide.s50)
        .onAppear { inspectedID = inspection.sessionId }
        .onChange(of: inspection.sessionId) { _, id in
            if inspectedID != id { navigationHistory = []; inspectedID = id }
        }
        .onChange(of: inspectedID) { _, _ in selectedTaskID = nil }
        .task(id: observationKey) {
            await feed.observe(sessionId: selected?.id ?? "", port: port,
                connected: stateHolder.state.bridgeConnected, taskId: selectedTaskID)
        }
    }

    private var feedStatus: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top) {
                Label(feed.state.message, systemImage: feed.state.isFailure ? "exclamationmark.arrow.trianglehead.2.clockwise.rotate.90" : "clock")
                    .font(.caption)
                Spacer(minLength: 4)
                Button { refreshID = UUID() } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.plain)
                .help("Refresh collaboration history")
                .accessibilityLabel("Refresh collaboration history")
                .disabled(selected == nil || !stateHolder.state.bridgeConnected || feed.state == .loading)
            }
            if feed.state == .taskUnavailable {
                Button("Follow latest task") { selectedTaskID = nil }
                    .font(.caption)
            }
            if let fetched = feed.fetchedAt {
                HStack(spacing: 4) {
                    Text("Last read")
                    Text(fetched, style: .relative)
                    Text("ago · checks every 15 s")
                }.font(.system(size: 10))
            }
        }
        .foregroundStyle(feed.state.isFailure || feed.state == .disconnected ? DesignTokens.UI.attn : DesignTokens.Ink.s300)
        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
        .background(DesignTokens.Ink.s800, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
    }

    private func inspect(_ id: String, remember: Bool = true) {
        guard inspectedID != id, stateHolder.state.siblingSessions.contains(where: { $0.id == id }) else { return }
        if remember, let current = inspectedID, current != id { navigationHistory.append(current) }
        inspectedID = id
        inspection.select(id, state: stateHolder.state)
    }

    private func sessionHeader(_ session: SessionInfo) -> some View {
        let waiting = session.alive && session.state?.hasPrefix("awaiting") == true
        let working = session.alive && session.state == "processing"
        // Turn closed, but work it started is still running: the parent is
        // idle to the harness and waiting to the user. Say both.
        // These are separate censuses; do not add potentially overlapping
        // worker counts into a fabricated total. Direct children matter too.
        let hasActiveWorkers = (session.subagents?.active ?? 0) > 0
        let pendingJobs = session.coordination?.backgroundJobs ?? 0
        let awaitingResults = session.alive
            && CollaborationPresentation.phase(waiting, working, session.subagents?.active ?? 0, 0, pendingJobs) == 2
        let continuation = hasActiveWorkers ? "Session · turn closed · workers still running"
            : "Session · turn closed · \(pendingJobs) background jobs observed"
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
            Label(!session.alive ? "Session · offline"
                    : waiting ? "Session · needs your input"
                    : working ? "Session · working"
                    : awaitingResults ? continuation
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

    private func sessionShortcut(_ session: SessionInfo) -> some View {
        let waiting = session.alive && session.state?.hasPrefix("awaiting") == true
        let workers = (session.subagents?.active ?? 0) > 0
        let status = !session.alive ? "Offline" : waiting ? "Needs your input" : session.state == "processing" ? "Working"
            : workers ? "Workers still running" : (session.coordination?.backgroundJobs ?? 0) > 0 ? "Background jobs observed"
            : session.state == "idle" ? "Idle" : "State unavailable"
        return Button { inspect(session.id) } label: {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: waiting ? "hand.raised.fill" : "arrow.up.right.circle")
                    .foregroundStyle(waiting ? DesignTokens.UI.attn : DesignTokens.UI.cyan)
                VStack(alignment: .leading, spacing: 3) {
                    Text(session.projectName ?? "Session").font(.subheadline.bold()).lineLimit(2)
                    Text("\(session.agentType ?? "Agent") · \(status)")
                        .font(.caption).foregroundStyle(waiting ? DesignTokens.UI.attn : DesignTokens.Ink.s300)
                    workCounts(session)
                    if let activity = session.activity, !activity.isEmpty {
                        Text(activity).font(.caption).foregroundStyle(DesignTokens.Ink.s300).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption)
            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(DesignTokens.Ink.s800, in: RoundedRectangle(cornerRadius: 10))
        }.buttonStyle(.plain).help("Inspect session")
    }

    private func liveWork(_ session: SessionInfo) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Live work", systemImage: "waveform").font(.caption.bold())
            workCounts(session)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func workCounts(_ session: SessionInfo) -> some View {
        if session.alive, let census = session.subagents {
            Text("Delegates · \(max(0, census.active)) active · \(max(0, census.completed)) ended this wave")
                .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
        }
        if session.alive, let count = session.backgroundTaskCount {
            Text("Reported background tasks · \(max(0, count)) active")
                .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
        }
        if session.alive, let coord = session.coordination {
            Text("Background jobs · \(max(0, coord.backgroundJobs)) observed")
                .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
        }
    }

    private var hasWorkHistory: Bool {
        !feed.children.isEmpty || !CollaborationProjection.workRelations(feed.relations).isEmpty
    }

    private var relationSections: some View {
        let work = CollaborationProjection.workRelations(feed.relations)
        let launches = work.filter { $0.isLaunchObservation }
        let jobs = work.filter { $0.relation == "waiting_on" }
        return VStack(alignment: .leading, spacing: 8) {
            if !jobs.isEmpty {
                CollaborationRows(title: "Background job history", symbol: "hourglass",
                                  rows: jobs, limit: 6, isCompleted: { !$0.isOpen }) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.peerName ?? "Background job").font(.caption.bold())
                        Text(row.isOpen ? "Start observed" : "End observed")
                            .font(.caption2).foregroundStyle(DesignTokens.Ink.s300)
                        if let detail = row.detail, !detail.isEmpty { Text(detail).font(.caption).lineLimit(3) }
                    }
                }
            }
            if !launches.isEmpty {
                DisclosureGroup("Unlinked launch observations · \(launches.count)") {
                    CollaborationRows(title: "Launch requests", symbol: "arrow.up.right",
                                      rows: launches, limit: 6, isCompleted: { _ in false }) { row in
                        Text(row.detail ?? "Launch requested").font(.caption).lineLimit(3)
                    }
                }.font(.caption)
            }
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
                Text(ended ? "End recorded" : "Start recorded · current state unknown")
                    .font(.system(size: 10)).foregroundStyle(DesignTokens.Ink.s300)
                if let summary = child.summary, !summary.isEmpty {
                    Text(summary).font(.caption).lineLimit(4)
                }
            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(DesignTokens.Ink.s800, in: RoundedRectangle(cornerRadius: 10))
        }
    }
}
/// Keep pending observations visible before completed history, and make every
/// bounded list expandable. Order inside each group follows the projection.
private struct CollaborationRows<Row: Identifiable, Content: View>: View {
    let title: String
    let symbol: String
    let rows: [Row]
    let limit: Int
    let isCompleted: (Row) -> Bool
    @ViewBuilder let content: (Row) -> Content
    @State private var showAll = false
    @State private var showCompleted = false
    @State private var showAllCompleted = false

    var body: some View {
        let pending = rows.filter { !isCompleted($0) }
        let completed = rows.filter(isCompleted)
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: symbol).font(.caption).foregroundStyle(DesignTokens.UI.cyan)
            ForEach(Array(pending.prefix(showAll ? pending.count : limit)), content: content)
            if pending.count > limit {
                Button(showAll ? "Show fewer" : "Show all \(pending.count)") { showAll.toggle() }
                    .font(.caption)
            }
            if !completed.isEmpty {
                DisclosureGroup("Ended observations · \(completed.count)", isExpanded: $showCompleted) {
                    ForEach(Array(completed.prefix(showAllCompleted ? completed.count : limit)), content: content)
                    if completed.count > limit {
                        Button(showAllCompleted ? "Show fewer" : "Show all \(completed.count)") { showAllCompleted.toggle() }
                            .font(.caption)
                    }
                }.font(.caption)
            }
        }
    }
}
#endif
