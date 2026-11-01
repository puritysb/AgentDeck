import SwiftUI
import ImageIO

/// One read-only companion across local/remote hosts and Apple surfaces.
enum DotSurfaceStyle { case card, compact, habitat, timeline }

struct DotSurfaceView: View {
    let snapshot: DotSurfaceSnapshot
    var style: DotSurfaceStyle = .card
    var showsHabitatLabel = true
    private var compact: Bool { style == .compact }
    @State private var expanded = false
    static func tint(_ code: Int) -> Color {
        switch code {
        case 2: DesignTokens.Session.working
        case 3: DesignTokens.Session.awaiting
        case 4: DesignTokens.UI.ok
        case 5: DesignTokens.Session.error
        default: DesignTokens.Ink.s300
        }
    }
    private var phaseSymbol: String {
        switch snapshot.effectiveCode {
        case 2: "circle.dotted"
        case 3: "exclamationmark"
        case 4: "checkmark"
        case 5: "xmark"
        default: "questionmark"
        }
    }
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            Button { expanded = true } label: {
                if style == .habitat {
                    VStack(spacing: 4) {
                        DotCharacterImage(appearance: snapshot.appearance, tint: DesignTokens.Tide.s100)
                        if showsHabitatLabel {
                            Text("Dot").font(.custom("IBMPlexSans-Bold", size: 10))
                                .foregroundStyle(DesignTokens.Tide.s50).fixedSize()
                        }
                    }
                } else if style == .timeline {
                    HStack(spacing: 6) {
                        if let stamp = snapshot.reportedAt {
                            Text(Date(timeIntervalSince1970: Double(stamp) / 1000), format: .dateTime.hour().minute())
                                .foregroundStyle(.secondary)
                        }
                        Image(systemName: phaseSymbol).foregroundStyle(Self.tint(snapshot.effectiveCode))
                        Text("Dot").fontWeight(.semibold)
                        Text(snapshot.label.capitalized).foregroundStyle(Self.tint(snapshot.effectiveCode))
                        Text("· Dot report").foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").foregroundStyle(.secondary)
                    }.font(.custom("JetBrainsMono-Regular", size: 10)).lineLimit(1)
                        .padding(.vertical, 5).contentShape(Rectangle())
                } else {
                    HStack(spacing: 10) {
                        ZStack {
                            if !compact { Circle().stroke(Self.tint(snapshot.effectiveCode), lineWidth: 2).frame(width: 52, height: 52) }
                            DotCharacterImage(appearance: snapshot.appearance, tint: Self.tint(snapshot.effectiveCode)).frame(width: compact ? 24 : 42, height: compact ? 24 : 42)
                        }.accessibilityHidden(true)
                        if compact {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Dot").font(.caption.bold())
                                Text(snapshot.label.capitalized).font(.caption2).foregroundStyle(.secondary)
                            }
                        } else {
                            VStack(alignment: .leading, spacing: 3) {
                                Text("Dot").font(.headline)
                                Text(snapshot.label.capitalized).font(.caption)
                                if let relation = snapshot.relation, relation.evidence == "dot_report" {
                                    Text(verbatim: relation.label).font(.caption2).lineLimit(3)
                                }
                                Text(snapshot.reportState == nil ? "No activity shared yet" : "Dot report").font(.caption2).foregroundStyle(.secondary)
                            }.frame(maxWidth: 200, alignment: .leading)
                        }
                    }.padding(compact ? 4 : 10).background(compact ? Color.clear : DesignTokens.Ink.s800, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.xl))
                }
            }.buttonStyle(.plain).accessibilityLabel("Dot. \(snapshot.label). Open report details.")
        }
        .sheet(isPresented: $expanded) {
            VStack(alignment: .leading, spacing: 12) {
                HStack { Text("Dot report").font(.headline); Spacer(); Button("Done") { expanded = false } }
                Text(snapshot.label.capitalized)
                if snapshot.authorized == false {
                    Text("No client is authorized to share activity with AgentDeck. Configuring the host or installing the plugin does not complete the connection.").font(.callout).foregroundStyle(.secondary)
                } else if snapshot.reportState == nil {
                    Text("No activity has been shared with AgentDeck yet. A connection alone does not report Dot’s other tasks.").font(.callout).foregroundStyle(.secondary)
                }
                Text("This companion shows explicitly shared task reports, not all Dot activity.").font(.caption).foregroundStyle(.secondary)
                if let stamp = snapshot.reportedAt {
                    Text(Date(timeIntervalSince1970: Double(stamp) / 1000), format: .dateTime).font(.caption)
                }
                if let relation = snapshot.relation, relation.evidence == "dot_report" { Text(verbatim: relation.label) }
            }.padding().frame(minWidth: 280)
        }
    }
}
