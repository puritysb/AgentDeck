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
    let inspect: (String) -> Void
    @State private var selectedLink: String?

    var body: some View {
        let network = CommunicationNetwork.project(snapshot: feed.snapshot, roster: roster)
        VStack(alignment: .leading, spacing: 10) {
            Text("\(network.links.count) session \(network.links.count == 1 ? "pair" : "pairs") · last \(CollaborationPresentation.networkHistoryWindowMs / 3_600_000) h")
                .font(.caption).foregroundStyle(DesignTokens.Ink.s300)
            if feed.state != .ready {
                Text(status).font(.caption)
            }
            if network.links.isEmpty {
                if feed.snapshot != nil {
                    Text("No messages with identified session peers in this window").font(.caption)
                }
            } else {
                let drawn = Array(network.links.prefix(40))
                graph(network, links: drawn)
                if drawn.count < network.links.count {
                    Text("Showing the \(drawn.count) most recent session pairs.").font(.caption)
                }
                if let selectedLink, let link = drawn.first(where: { $0.id == selectedLink }) {
                    conversation(link, network: network)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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

    private func graph(_ network: CommunicationNetwork, links: [CommunicationLink]) -> some View {
        let ids = Set(links.flatMap { [$0.latestSender, $0.latestRecipient] })
        let nodes = network.nodes.filter { ids.contains($0.id) }
        let singlePair = nodes.count == 2
        let width: CGFloat = singlePair ? 310 : max(420, CGFloat(nodes.count) * 62)
        let height: CGFloat = singlePair ? 132 : max(250, width * 0.5)
        let nodeWidth: CGFloat = 106
        let centerX: CGFloat = width / 2
        let centerY: CGFloat = height / 2
        let radiusX: CGFloat = width / 2 - nodeWidth / 2 - 8
        let radiusY: CGFloat = height / 2 - 38
        let nodeCount: Double = Double(max(1, nodes.count))
        let pointPairs: [(String, CGPoint)] = nodes.enumerated().map { index, node in
            if singlePair {
                let offset = min(radiusX, 128)
                return (node.id, CGPoint(x: centerX + (index == 0 ? -offset : offset), y: centerY))
            }
            let angle: Double = Double(index) / nodeCount * Double.pi * 2 - Double.pi / 2
            let x: CGFloat = centerX + CGFloat(cos(angle)) * radiusX
            let y: CGFloat = centerY + CGFloat(sin(angle)) * radiusY
            return (node.id, CGPoint(x: x, y: y))
        }
        let points = Dictionary(uniqueKeysWithValues: pointPairs)
        var occupied = points.values.map { CGRect(x: $0.x-nodeWidth/2, y: $0.y-32, width: nodeWidth, height: 64) }
        var badges: [String: CGRect] = [:]
        for link in links {
            guard let start = points[link.latestSender], let end = points[link.latestRecipient] else { continue }
            let rect = CommunicationLabelLayout.place(preferred: CGPoint(x: (start.x+end.x)/2, y: (start.y+end.y)/2),
                size: CGSize(width: 72, height: 24), bounds: CGRect(x: 4, y: 4, width: width-8, height: height-8), avoiding: occupied)
            badges[link.id] = rect; occupied.append(rect)
        }
        return ScrollView([.horizontal, .vertical]) {
            ZStack {
                ForEach(links) { link in
                    if let start = points[link.latestSender], let end = points[link.latestRecipient] {
                        let dx = end.x - start.x, dy = end.y - start.y
                        let length = max(1, hypot(dx, dy))
                        let ux = dx / length, uy = dy / length
                        let inset = min((nodeWidth / 2 + 5) / max(0.001, abs(ux)), 36 / max(0.001, abs(uy)))
                        let tip = CGPoint(x: end.x - ux * inset, y: end.y - uy * inset)
                        Path { path in
                            path.move(to: start); path.addLine(to: tip)
                        }.stroke(DesignTokens.UI.cyan.opacity(selectedLink == nil || selectedLink == link.id ? 0.75 : 0.15),
                                 style: StrokeStyle(lineWidth: selectedLink == link.id ? 2 : 1))
                        if !link.crossed {
                            Path { path in
                                path.move(to: CGPoint(x: tip.x - dx / length * 9 + dy / length * 5, y: tip.y - dy / length * 9 - dx / length * 5))
                                path.addLine(to: tip)
                                path.addLine(to: CGPoint(x: tip.x - dx / length * 9 - dy / length * 5, y: tip.y - dy / length * 9 + dx / length * 5))
                            }.stroke(DesignTokens.UI.cyan.opacity(selectedLink == nil || selectedLink == link.id ? 0.75 : 0.15),
                                     lineWidth: selectedLink == link.id ? 2 : 1)
                        }
                        if let badge = badges[link.id] {
                            Path { path in
                                path.move(to: CGPoint(x: (start.x+end.x)/2, y: (start.y+end.y)/2))
                                path.addLine(to: CGPoint(x: badge.midX, y: badge.midY))
                            }.stroke(DesignTokens.UI.cyan.opacity(0.3), lineWidth: 0.5)
                        }
                        Button {
                            selectedLink = selectedLink == link.id ? nil : link.id
                        } label: {
                            Text(link.crossed ? "↔" : "·")
                                .font(.system(size: 10, design: .monospaced)).padding(4)
                                .background(DesignTokens.Ink.s900, in: Capsule())
                        }.buttonStyle(.plain)
                            .position(x: badges[link.id]?.midX ?? 0, y: badges[link.id]?.midY ?? 0)
                            .zIndex(2)
                            .help("Inspect recent messages")
                    }
                }
                ForEach(nodes) { node in
                    Button {
                        if let id = node.rosterID { inspect(id) }
                    } label: {
                        VStack(spacing: 3) {
                            Text(node.name).font(.system(size: 11, weight: .semibold)).lineLimit(1)
                            Text(node.project.map { "\($0) · \(node.id.prefix(6))" } ?? "Not in live roster")
                                .font(.system(size: 9)).lineLimit(1)
                            Text(stateLabel(node.state)).font(.system(size: 9)).lineLimit(1)
                                .foregroundStyle(node.state?.hasPrefix("awaiting") == true ? DesignTokens.UI.attn : DesignTokens.Ink.s300)
                        }.padding(7).frame(width: nodeWidth)
                            .background(DesignTokens.Ink.s900, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(
                                node.rosterID == selectedID ? DesignTokens.UI.cyan : DesignTokens.Ink.s500,
                                lineWidth: 1))
                    }.buttonStyle(.plain).disabled(node.rosterID == nil)
                        .position(points[node.id]!)
                        .help(node.rosterID == nil ? "Session is outside the live roster" : "Inspect this session")
                }
            }.frame(width: width, height: height)
        }.frame(height: min(330, height + 12))
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

    private func conversation(_ link: CommunicationLink, network: CommunicationNetwork) -> some View {
        let sender = network.nodes.first { $0.id == link.latestSender }
        let recipient = network.nodes.first { $0.id == link.latestRecipient }
        return VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("\(sender?.name ?? "Unknown") \(link.crossed ? "↔" : "→") \(recipient?.name ?? "Unknown")").font(.caption.bold())
                Spacer()
            }
            Text(link.status)
                .font(.caption).foregroundStyle(DesignTokens.UI.cyan)
            Text(Date(timeIntervalSince1970: link.lastObservedAt / 1_000), format: .dateTime.month().day().hour().minute())
                .font(.caption2).foregroundStyle(DesignTokens.Ink.s300)
            if let detail = link.detail, !detail.isEmpty { Text(detail).font(.caption).lineLimit(3) }
            HStack {
                if let id = sender?.rosterID { Button("Inspect sender") { inspect(id) } }
                if let id = recipient?.rosterID { Button("Inspect recipient") { inspect(id) } }
            }.font(.caption2)
        }.padding(9).frame(maxWidth: .infinity, alignment: .leading)
            .background(DesignTokens.Ink.s900.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
    }
}

struct DashboardMessageHistory: View {
    @ObservedObject var feed: CommunicationFeed
    let roster: [SessionInfo]
    let selectedID: String?
    let inspect: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var showsGraph = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Recent messages").font(.headline)
                Spacer()
                Button { feed.refreshID = UUID() } label: {
                    Label("Refresh messages", systemImage: "arrow.clockwise").labelStyle(.iconOnly)
                }
                Button("Done") { dismiss() }
            }
            Picker("Message view", selection: $showsGraph) {
                Text("History").tag(false)
                Text("Graph").tag(true)
            }.pickerStyle(.segmented).labelsHidden()
            ScrollView {
                if showsGraph {
                    CommunicationGraphView(feed: feed, roster: roster, selectedID: selectedID,
                                           inspect: openSession)
                } else {
                    messageList
                }
            }
            .frame(minHeight: 200, idealHeight: 390)
            .id(showsGraph)
        }
        .padding(16)
        .frame(minWidth: 340, idealWidth: 640, maxWidth: 820)
        .aquariumSurface()
        .accessibilityIdentifier("dashboard-message-history")
    }

    private func openSession(_ id: String) {
        inspect(id)
        dismiss()
    }

    private var messageList: some View {
        let network = CommunicationNetwork.project(snapshot: feed.snapshot, roster: roster)
        let nodes = Dictionary(uniqueKeysWithValues: network.nodes.map { ($0.id, $0) })
        return LazyVStack(alignment: .leading, spacing: 10) {
            if feed.state != .ready {
                Text(feed.state.message).font(.caption)
            }
            if feed.snapshot?.truncated == true {
                Text("Showing the most recent observations available.").font(.caption)
            }
            if feed.state == .ready && network.messages.isEmpty {
                Text("No messages with identified peers in the last 24 hours").font(.caption)
            }
            ForEach(network.messages) { message in
                let sender = nodes[message.sender]
                let recipient = nodes[message.recipient]
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(sender?.name ?? message.sender) → \(recipient?.name ?? message.recipient)").font(.subheadline.bold())
                    HStack {
                        Text(message.received ? "Delivery observed" : "Send observed")
                        Text(Date(timeIntervalSince1970: message.observation.ts / 1_000),
                             format: .dateTime.month().day().hour().minute())
                    }.font(.caption).foregroundStyle(DesignTokens.Ink.s300)
                    if let detail = message.detail { Text(detail).font(.caption).lineLimit(4) }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(DesignTokens.Ink.s800, in: RoundedRectangle(cornerRadius: 8))
            }
            if !network.unidentified.isEmpty {
                DisclosureGroup("Unidentified peers · \(network.unidentified.count)") {
                    ForEach(network.unidentified) { event in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(event.peerName ?? "Peer name unavailable").font(.caption.bold())
                            Text(Date(timeIntervalSince1970: event.ts / 1_000),
                                 format: .dateTime.month().day().hour().minute()).font(.caption)
                            if let detail = event.detail { Text(detail).font(.caption).lineLimit(3) }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
#endif
