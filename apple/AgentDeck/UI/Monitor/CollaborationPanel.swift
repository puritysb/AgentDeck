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
    static let maximumWidth: CGFloat = 1_060
    static let maximumHeight: CGFloat = 760

    @EnvironmentObject private var inspection: DashboardInspection
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @StateObject private var feed: CollaborationFeed
    @ObservedObject private var communications: CommunicationFeed
    @State private var selectedTaskID: String?
    @State private var refreshID = UUID()
    let port: Int
    let attention: ((SessionInfo) -> AnyView)?

    init(port: Int, feed: CollaborationFeed = CollaborationFeed(),
         communications: CommunicationFeed = CommunicationFeed(), attention: ((SessionInfo) -> AnyView)? = nil) {
        self.port = port
        self.communications = communications
        self.attention = attention
        _feed = StateObject(wrappedValue: feed)
    }

    private var inspectedID: String? { inspection.sessionId }

    private var selected: SessionInfo? {
        stateHolder.state.siblingSessions.first { $0.id == inspectedID }
    }
    private var visibleTask: CollaborationTask? {
        guard let selected, let task = feed.task,
              task.sessionId == ObservedAgentRules.rawSessionId(selected.id),
              selectedTaskID == nil || task.id == selectedTaskID else { return nil }
        return task
    }

    private var observationKey: String {
        "\(port)|\(stateHolder.state.bridgeConnected)|\(selected?.id ?? "")|\(selectedTaskID ?? "latest")|\(refreshID)"
    }

    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let split = width >= 720
            let listWidth = split ? min(300, width * 0.36) : width
            let detailWidth = split ? width - listWidth : width
            let showsList = split || inspectedID == nil
            let showsDetail = split || inspectedID != nil

            // Keep both scroll views mounted. Resizing only changes their frames
            // and visibility, so neither the task picker nor list position resets.
            ZStack {
                queue
                    .frame(width: listWidth)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .opacity(showsList ? 1 : 0)
                    .allowsHitTesting(showsList)
                    .disabled(!showsList)
                    .accessibilityHidden(!showsList)

                detail(showBack: !split)
                    .frame(width: detailWidth)
                    .overlay(alignment: .leading) {
                        if split {
                            Rectangle().fill(DesignTokens.Ink.s500.opacity(0.38))
                                .frame(width: 1)
                                .accessibilityHidden(true)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .opacity(showsDetail ? 1 : 0)
                    .allowsHitTesting(showsDetail)
                    .disabled(!showsDetail)
                    .accessibilityHidden(!showsDetail)
            }
        }
        .background(DesignTokens.UI.popupBgDeep.opacity(0.78))
        .clipShape(.rect(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(DesignTokens.Ink.s500.opacity(0.42))
                .allowsHitTesting(false)
        }
        .foregroundStyle(DesignTokens.Tide.s50)
        .onChange(of: inspectedID) { _, _ in selectedTaskID = nil }
        .task(id: observationKey) {
            await feed.observe(sessionId: selected?.id ?? "", port: port,
                connected: stateHolder.state.bridgeConnected, taskId: selectedTaskID)
        }
    }

    private var queue: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Work", systemImage: "list.bullet.rectangle")
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            ScrollView {
                workList.frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            .accessibilityLabel("Work list")
        }
        .padding(16)
        .background(DesignTokens.Ink.s800.opacity(0.23))
    }

    private func detail(showBack: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if showBack {
                Button {
                    inspection.select(nil, state: stateHolder.state)
                } label: {
                    Label("Back to work", systemImage: "chevron.left")
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("dashboard-work-back")
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let selected {
                        sessionDetail(selected)
                    } else {
                        Label(inspectedID == nil ? "Select a work item" : "The selected session is no longer available",
                              systemImage: "list.bullet.rectangle")
                            .font(.subheadline)
                            .foregroundStyle(DesignTokens.Ink.s300)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .scrollBounceBehavior(.basedOnSize)
            .id(inspectedID)
            .accessibilityLabel("Work detail")
        }
        .padding(16)
    }

    @ViewBuilder
    private func sessionDetail(_ session: SessionInfo) -> some View {
        sessionHeader(session)
        if CollaborationProjection.needsInput(session), let attention {
            attention(session)
        }
        if let task = visibleTask {
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
            .background(DesignTokens.Ink.s700.opacity(0.40), in: RoundedRectangle(cornerRadius: 12))
        }
        liveWork(session)
        if feed.state != .ready {
            feedStatus
        }
        if visibleTask != nil && !feed.children.isEmpty {
            CollaborationRows(title: "Delegated work", symbol: "arrow.triangle.branch",
                              rows: feed.children, limit: 4,
                              isCompleted: { $0.phase == "completed" }, content: childRow)
                .id(inspectedID)
        }
        if visibleTask != nil {
            relationSections.id(inspectedID)
        }
        if let task = visibleTask, feed.state == .ready {
            handoffs(task: task)
            if !hasWorkHistory {
                Text("No delegated work or background jobs recorded for this task")
                    .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
            }
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

    private var workList: some View {
        let sessions = CollaborationProjection.prioritizedSessions(
            stateHolder.state.siblingSessions.filter { $0.agentType != "daemon" }
        )
        let attention = sessions.filter(CollaborationProjection.needsInput)
        let working = sessions.filter { !CollaborationProjection.needsInput($0) && CollaborationProjection.isWorking($0) }
        let others = sessions.filter { !CollaborationProjection.needsInput($0) && !CollaborationProjection.isWorking($0) }
        return VStack(alignment: .leading, spacing: 10) {
            if sessions.isEmpty {
                Text("No sessions observed yet").font(.subheadline)
            }
            workGroup("Needs your input", sessions: attention, symbol: "hand.raised.fill", tint: DesignTokens.UI.attn)
            workGroup("In progress", sessions: working, symbol: "waveform", tint: DesignTokens.UI.cyan)
            if !others.isEmpty {
                if attention.isEmpty && working.isEmpty {
                    workGroup("Other sessions", sessions: others, symbol: "pause.circle", tint: DesignTokens.Ink.s300)
                } else {
                    DisclosureGroup("Other sessions · \(others.count)") {
                        ForEach(others, content: sessionShortcut)
                    }.font(.caption)
                }
            }
        }
    }

    @ViewBuilder
    private func workGroup(_ title: String, sessions: [SessionInfo], symbol: String, tint: Color) -> some View {
        if !sessions.isEmpty {
            Label(title, systemImage: symbol)
                .font(.caption.bold()).foregroundStyle(tint)
                .accessibilityAddTraits(.isHeader)
            ForEach(sessions, content: sessionShortcut)
        }
    }

    private func sessionName(_ session: SessionInfo) -> String {
        [session.displayName, session.projectName, session.agentType]
            .compactMap { $0 }.first { !$0.isEmpty } ?? "Session"
    }

    private func sessionStatus(_ session: SessionInfo) -> String {
        if !session.alive || session.state == "disconnected" { return "Offline" }
        if CollaborationProjection.needsInput(session) { return "Needs your input" }
        if session.state == "processing" { return "Working" }
        if CollaborationProjection.isWorking(session) { return "Background work running" }
        if session.state == "idle" { return "Idle" }
        if session.state == "error" { return "Error" }
        return "State unavailable"
    }

    private func sessionHeader(_ session: SessionInfo) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(sessionName(session)).font(.headline).lineLimit(2)
            Text([session.agentType, sessionStatus(session)].compactMap { $0 }.joined(separator: " · "))
                .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
            if let activity = session.activity, !activity.isEmpty {
                Text(activity).font(.subheadline).lineLimit(3)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func sessionShortcut(_ session: SessionInfo) -> some View {
        Button {
            inspection.select(session.id, state: stateHolder.state)
        } label: {
            HStack(alignment: .top, spacing: 8) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(sessionName(session)).font(.subheadline.bold()).lineLimit(2)
                    Text([session.agentType, sessionStatus(session)].compactMap { $0 }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
                    let summary = CollaborationProjection.needsInput(session)
                        ? session.question ?? session.activity : session.activity
                    if let summary, !summary.isEmpty {
                        Text(summary).font(.caption).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption)
            }
            .padding(8).frame(maxWidth: .infinity, alignment: .leading)
            .background(
                inspectedID == session.id ? DesignTokens.Ink.s700.opacity(0.82) : DesignTokens.Ink.s800.opacity(0.52),
                in: RoundedRectangle(cornerRadius: 8)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(inspectedID == session.id ? .isSelected : [])
        .accessibilityIdentifier("dashboard-work-\(session.id)")
    }

    @ViewBuilder
    private func handoffs(task: CollaborationTask) -> some View {
        if communications.state == .ready {
            let history = CommunicationHistory.project(snapshot: communications.snapshot, roster: stateHolder.state.siblingSessions)
            let deliveries = history.messages.filter { $0.belongsToTask(sessionID: task.sessionId, relations: feed.relations) }
            if !deliveries.isEmpty {
                CollaborationRows(title: "Confirmed deliveries", symbol: "tray.and.arrow.down",
                                  rows: deliveries, limit: 4, isCompleted: { _ in false }) { message in
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(history.name(message.sender)) → \(history.name(message.recipient))").font(.caption.bold())
                        if let detail = message.detail { Text(detail).font(.caption).lineLimit(3) }
                    }
                }
            }
        }
    }

    private func liveWork(_ session: SessionInfo) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("Live session work", systemImage: "waveform").font(.caption.bold())
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
