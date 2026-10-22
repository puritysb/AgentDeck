#if os(macOS)
import SwiftUI

@MainActor
final class CommunicationFeed: ObservableObject {
    @Published var refreshID = UUID()
    @Published var snapshot: CommunicationSnapshot?
    @Published var state: CollaborationReadState = .loading
    private var generation = UUID()
    private var lastPort = 0
    private let load: @Sendable (URL) async throws -> Data
    private let pause: @Sendable () async throws -> Void

    init(load: @escaping @Sendable (URL) async throws -> Data = CollaborationFeed.fetch,
         pause: @escaping @Sendable () async throws -> Void = {
             try await Task.sleep(for: .seconds(CollaborationPresentation.networkRefreshSeconds))
         }) {
        self.load = load; self.pause = pause
    }

    func observe(port: Int, connected: Bool) async {
        let current = UUID(); generation = current
        if lastPort != port { snapshot = nil; lastPort = port }
        guard connected, port > 0 else { state = .disconnected; return }
        state = .loading
        while !Task.isCancelled && generation == current {
            do {
                let data = try await load(URL(string: "http://127.0.0.1:\(port)/apme/communications")!)
                let value = try JSONDecoder().decode(CommunicationSnapshot.self, from: data)
                try Task.checkCancellation()
                guard generation == current else { return }
                guard value.schema == "agentdeck-communications/v1", value.capturedAt.isFinite,
                      value.since.isFinite, value.since <= value.capturedAt,
                      value.events.count <= CollaborationPresentation.networkEventLimit else {
                    throw CollaborationReadError.unsupported
                }
                snapshot = value; state = .ready
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
}

struct CommunicationGraphView: View {
    @ObservedObject var feed: CommunicationFeed
    let roster: [SessionInfo]
    let selectedID: String?
    var expanded = false
    let inspect: (String) -> Void
    var retry: () -> Void = {}
    @State private var expandedGraph = false
    @State private var selectedLink: String?

    var body: some View {
        let network = CommunicationNetwork.project(snapshot: feed.snapshot, roster: roster)
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Session communications", systemImage: "point.3.connected.trianglepath.dotted")
                    .font(.headline)
                Spacer()
                if !expanded {
                    Button { expandedGraph = true } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                        .help("Expand all session communications")
                }
                Button(action: retry) { Image(systemName: "arrow.clockwise") }.help("Refresh communication graph")
            }
            Text(feed.snapshot == nil ? "\(roster.count) roster sessions · message history unavailable"
                 : "\(roster.count) roster sessions · \(network.links.count) observed conversations · last \(CollaborationPresentation.networkHistoryWindowMs / 3_600_000) h")
                .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
            if feed.state != .ready {
                Text(status).font(.caption).foregroundStyle(DesignTokens.Ink.s300)
            }
            if feed.snapshot?.truncated == true {
                Text("Partial history · newest \(CollaborationPresentation.networkEventLimit) message observations")
                    .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
            }
            TimelineView(.periodic(from: .now, by: 1)) { clock in
                // A failed/disconnected snapshot freezes ages at capture time.
                let now = feed.state == .ready ? clock.date.timeIntervalSince1970 * 1000 : feed.snapshot?.capturedAt ?? 0
                VStack(alignment: .leading, spacing: 10) {
                    graph(network, now: now)
                    if network.links.isEmpty {
                        Text(feed.snapshot == nil ? "Links appear when message history is available"
                             : "No session messages observed in this history window")
                            .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
                    } else {
                        let links = selectedLink.flatMap { id in network.links.first { $0.id == id } }.map { [$0] }
                            ?? (expanded ? network.links : Array(network.links.prefix(3)))
                        ForEach(links) { link in conversation(link, network: network, now: now) }
                        if !expanded && network.links.count > 3 && selectedLink == nil {
                            Button("Show all \(network.links.count) conversations") { expandedGraph = true }.font(.caption)
                        }
                        if selectedLink != nil { Button("Show all links") { selectedLink = nil }.font(.caption) }
                    }
                }
            }
            Text("Dashed: explicit reply request pending. Notifications have no timer.")
                .font(.caption2).foregroundStyle(DesignTokens.Ink.s300)
                .help("Arrows show the latest message. Timers require explicit reply-request wording in the complete message. Notifications do not answer requests. Legacy or unclear intent has no timer; reply matching can remain unknown.")
        }
        .padding(12)
        .background(DesignTokens.Ink.s800.opacity(0.65), in: RoundedRectangle(cornerRadius: 12))
        .sheet(isPresented: $expandedGraph) {
            VStack {
                HStack { Text("All session communications").font(.title2); Spacer(); Button("Done") { expandedGraph = false } }
                ScrollView {
                    CommunicationGraphView(feed: feed, roster: roster, selectedID: selectedID,
                        expanded: true, inspect: { id in inspect(id); expandedGraph = false }, retry: retry)
                }
            }.padding(20).frame(minWidth: 850, idealWidth: 1050, minHeight: 650)
                .aquariumSurface()
        }
    }

    private var status: String {
        switch feed.state {
        case .ready: ""
        case .loading: "Reading communication history…"
        case .unsupported: "Communication history is unavailable from this daemon"
        case .disconnected: "Disconnected · retained history is frozen"
        default: "Refresh failed · retained history is frozen"
        }
    }

    private func elapsed(_ since: Double, now: Double) -> String {
        let seconds = max(0, Int((now - since) / 1000))
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m \(seconds % 60)s" }
        return "\(seconds / 3600)h \((seconds % 3600) / 60)m"
    }

    private func graph(_ network: CommunicationNetwork, now: Double) -> some View {
        let width: CGFloat = expanded ? max(760, CGFloat(network.nodes.count) * 62) : max(310, CGFloat(network.nodes.count) * 42)
        let height: CGFloat = expanded ? max(390, width * 0.5) : max(230, width * 0.65)
        let nodeWidth: CGFloat = expanded ? 130 : 98
        let centerX: CGFloat = width / 2
        let centerY: CGFloat = height / 2
        let radiusX: CGFloat = width / 2 - nodeWidth / 2 - 8
        let radiusY: CGFloat = height / 2 - 38
        let nodeCount: Double = Double(max(1, network.nodes.count))
        let pointPairs: [(String, CGPoint)] = network.nodes.enumerated().map { index, node in
            let angle: Double = Double(index) / nodeCount * Double.pi * 2 - Double.pi / 2
            let x: CGFloat = centerX + CGFloat(cos(angle)) * radiusX
            let y: CGFloat = centerY + CGFloat(sin(angle)) * radiusY
            return (node.id, CGPoint(x: x, y: y))
        }
        let points = Dictionary(uniqueKeysWithValues: pointPairs)
        var occupied = points.values.map { CGRect(x: $0.x-nodeWidth/2, y: $0.y-32, width: nodeWidth, height: 64) }
        var badges: [String: CGRect] = [:]
        for link in network.links {
            guard let start = points[link.latestSender], let end = points[link.latestRecipient] else { continue }
            let rect = CommunicationLabelLayout.place(preferred: CGPoint(x: (start.x+end.x)/2, y: (start.y+end.y)/2),
                size: CGSize(width: 72, height: 24), bounds: CGRect(x: 4, y: 4, width: width-8, height: height-8), avoiding: occupied)
            badges[link.id] = rect; occupied.append(rect)
        }
        return ScrollView([.horizontal, .vertical]) {
            ZStack {
                ForEach(network.links) { link in
                    if let start = points[link.latestSender], let end = points[link.latestRecipient] {
                        let dx = end.x - start.x, dy = end.y - start.y
                        let length = max(1, hypot(dx, dy))
                        let ux = dx / length, uy = dy / length
                        let inset = min((nodeWidth / 2 + 5) / max(0.001, abs(ux)), 36 / max(0.001, abs(uy)))
                        let tip = CGPoint(x: end.x - ux * inset, y: end.y - uy * inset)
                        Path { path in
                            path.move(to: start); path.addLine(to: tip)
                        }.stroke(DesignTokens.UI.cyan.opacity(selectedLink == nil || selectedLink == link.id ? 0.75 : 0.15),
                                 style: StrokeStyle(lineWidth: selectedLink == link.id ? 2 : 1, dash: link.noReplySince == nil ? [] : [4, 4]))
                        Path { path in
                            path.move(to: CGPoint(x: tip.x - dx / length * 9 + dy / length * 5, y: tip.y - dy / length * 9 - dx / length * 5))
                            path.addLine(to: tip)
                            path.addLine(to: CGPoint(x: tip.x - dx / length * 9 - dy / length * 5, y: tip.y - dy / length * 9 + dx / length * 5))
                        }.stroke(DesignTokens.UI.cyan.opacity(selectedLink == nil || selectedLink == link.id ? 0.75 : 0.15),
                                 lineWidth: selectedLink == link.id ? 2 : 1)
                        if let badge = badges[link.id] {
                            Path { path in
                                path.move(to: CGPoint(x: (start.x+end.x)/2, y: (start.y+end.y)/2))
                                path.addLine(to: CGPoint(x: badge.midX, y: badge.midY))
                            }.stroke(DesignTokens.UI.cyan.opacity(0.3), lineWidth: 0.5)
                        }
                        Button {
                            selectedLink = selectedLink == link.id ? nil : link.id
                        } label: {
                            Text(link.noReplySince.map { elapsed($0, now: now) } ?? (link.crossed ? "↔" : "·"))
                                .font(.system(size: 10, design: .monospaced)).padding(4)
                                .background(DesignTokens.Ink.s900, in: Capsule())
                        }.buttonStyle(.plain)
                            .position(x: badges[link.id]?.midX ?? 0, y: badges[link.id]?.midY ?? 0)
                            .zIndex(2)
                            .help("Inspect conversation · dashed line: reply requested")
                    }
                }
                ForEach(network.nodes) { node in
                    Button {
                        if let id = node.rosterID { inspect(id) }
                    } label: {
                        VStack(spacing: 3) {
                            Text(node.name).font(.system(size: expanded ? 12 : 10, weight: .semibold)).lineLimit(1)
                            Text(node.project.map { "\($0) · \(node.id.prefix(6))" } ?? (node.unresolved ? "Identity unresolved" : "Not in live roster"))
                                .font(.system(size: 9)).lineLimit(1)
                            Text(stateLabel(node.state)).font(.system(size: 9)).lineLimit(1)
                                .foregroundStyle(node.state?.hasPrefix("awaiting") == true ? DesignTokens.UI.attn : DesignTokens.Ink.s300)
                        }.padding(7).frame(width: nodeWidth)
                            .background(DesignTokens.Ink.s900, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(
                                node.rosterID == selectedID ? DesignTokens.UI.cyan : DesignTokens.Ink.s500,
                                style: StrokeStyle(lineWidth: 1, dash: node.unresolved ? [3, 3] : [])))
                    }.buttonStyle(.plain).disabled(node.rosterID == nil)
                        .position(points[node.id]!)
                        .help(node.rosterID == nil ? "Peer identity or live session is unavailable" : "Inspect this session")
                }
            }.frame(width: width, height: height)
        }.frame(height: expanded ? min(540, height + 12) : 250)
    }

    private func stateLabel(_ state: String?) -> String {
        if state?.hasPrefix("awaiting") == true { return "Needs your input" }
        switch state {
        case "processing": return "Working"
        case "idle": return "Idle"
        case "offline", "disconnected": return "Offline"
        default: return "State unavailable"
        }
    }

    private func conversation(_ link: CommunicationLink, network: CommunicationNetwork, now: Double) -> some View {
        let sender = network.nodes.first { $0.id == link.latestSender }
        let recipient = network.nodes.first { $0.id == link.latestRecipient }
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("\(sender?.name ?? "Unknown") → \(recipient?.name ?? "Unknown")").font(.caption.bold())
                Spacer()
            }
            Text(link.status)
                .font(.caption).foregroundStyle(DesignTokens.UI.cyan)
            ForEach(Array(link.waits.enumerated()), id: \.offset) { _, wait in
                let waiting = network.nodes.first { $0.id == wait.sender }?.name ?? "Unknown"
                let answering = network.nodes.first { $0.id == wait.recipient }?.name ?? "Unknown"
                Text("\(waiting) waits for \(answering) · \(elapsed(wait.since, now: now)) · \(wait.requestCount) \(wait.requestCount == 1 ? "request" : "requests")")
                    .font(.system(.caption, design: .monospaced)).foregroundStyle(DesignTokens.UI.cyan)
            }
            if recipient?.rosterID == nil {
                Text(recipient?.unresolved == true ? "Recipient identity unresolved" : "Recipient not in roster · current state unknown")
                    .font(.caption2).foregroundStyle(DesignTokens.Ink.s300)
            }
            if let detail = link.detail, !detail.isEmpty { Text(detail).font(.caption).lineLimit(expanded ? 3 : 2) }
            HStack {
                if let id = sender?.rosterID { Button("Inspect sender") { inspect(id) } }
                if let id = recipient?.rosterID { Button("Inspect recipient") { inspect(id) } }
            }.font(.caption2)
        }.padding(9).frame(maxWidth: .infinity, alignment: .leading)
            .background(DesignTokens.Ink.s900.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
    }
}
#endif
