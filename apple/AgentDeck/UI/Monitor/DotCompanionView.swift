#if os(macOS)
import SwiftUI
import AppKit

/// A separate request companion, never a synthetic coding session or a provider logo.
struct DotCompanionView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var snapshot = DotHostSnapshot(available: false, status: "Stopped", origin: "", clientID: "", consents: [], grants: [], reports: [])
    @State private var now = Int(Date().timeIntervalSince1970 * 1000)
    @State private var expanded = false
    @State private var chatGPTIsRunning = false
    private let pollLive: Bool
    init(snapshot: DotHostSnapshot? = nil) {
        _snapshot = State(initialValue: snapshot ?? DotHostSnapshot(available: false, status: "Stopped", origin: "", clientID: "", consents: [], grants: [], reports: []))
        pollLive = snapshot == nil
    }
    private var presentation: DotPresentation {
        .resolve(hosting: snapshot.hosting, connected: !snapshot.grants.isEmpty, request: snapshot.reports.first, now: now)
    }
    private var tint: Color { DotPresentation.tint(presentation.phase) }
    var body: some View {
        Group {
            if snapshot.available && !snapshot.origin.isEmpty {
                Button { expanded = true } label: {
                    HStack(spacing: 10) {
                        TimelineView(.animation(minimumInterval: 1.0 / 15, paused: reduceMotion || presentation.phase != .working)) { timeline in
                            let motion = reduceMotion ? 0.0 : sin(timeline.date.timeIntervalSinceReferenceDate * 2)
                            ZStack {
                                Circle().fill(tint.opacity(0.18)).frame(width: 54, height: 54)
                                Circle().fill(tint).frame(width: 36, height: 36)
                                HStack(spacing: 8) {
                                    Capsule().fill(DesignTokens.Ink.s900).frame(width: 3, height: presentation.phase == .completed ? 3 : 7)
                                    Capsule().fill(DesignTokens.Ink.s900).frame(width: 3, height: presentation.phase == .completed ? 3 : 7)
                                }.offset(y: -1)
                                if presentation.phase == .attention { Image(systemName: "exclamationmark.circle.fill").foregroundStyle(DesignTokens.Session.awaiting).offset(x: 20, y: -20) }
                                if [.offline, .stale].contains(presentation.phase) { Image(systemName: "questionmark.circle").foregroundStyle(DesignTokens.Tide.s50).offset(x: 20, y: -20) }
                            }.offset(y: presentation.phase == .working ? motion * 3 : 0)
                        }.frame(width: 60, height: 60).accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Dot").font(.headline)
                            Text(presentation.label).font(.caption).fixedSize(horizontal: false, vertical: true)
                            if let edge = snapshot.reports.first?.interactions?.last {
                                Text(verbatim: DotSettingsView.displayText(edge.label)).font(.caption2).lineLimit(3)
                            }
                            if let report = snapshot.reports.first?.report {
                                Text(Date(timeIntervalSince1970: Double(report.receivedAt) / 1000), format: .dateTime.month().day().hour().minute())
                                    .font(.caption2).foregroundStyle(.secondary)
                            }
                        }.frame(maxWidth: 180, alignment: .leading)
                    }.padding(10).background(DesignTokens.Ink.s800, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.xl))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dot. \(presentation.label). Open briefing requests and results.")
                .sheet(isPresented: $expanded) {
                    VStack {
                        HStack { Text("Dot requests and results").font(.headline); Spacer(); Button("Done") { expanded = false } }
                        Text(chatGPTIsRunning ? "ChatGPT app is running locally" : "ChatGPT app is not running locally").font(.caption)
                        Text("App presence does not establish cloud Dot activity.").font(.caption).foregroundStyle(.secondary)
                        ScrollView { DotSettingsView() }
                    }.padding().frame(width: 580, height: 650)
                }
            }
        }
        .task {
            guard pollLive else { return }
            while !Task.isCancelled {
                snapshot = await DotHost.shared.snapshot()
                chatGPTIsRunning = NSWorkspace.shared.runningApplications.contains { $0.bundleIdentifier == "com.openai.chat" }
                now = Int(Date().timeIntervalSince1970 * 1000)
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }
}
#endif
