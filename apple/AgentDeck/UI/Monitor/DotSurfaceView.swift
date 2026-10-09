import SwiftUI
import ImageIO

/// One read-only companion across local/remote hosts and Apple surfaces.
struct DotSurfaceView: View {
    let snapshot: DotSurfaceSnapshot
    var compact = false
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
    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            Button { expanded = true } label: {
                HStack(spacing: 10) {
                    ZStack {
                        if !compact { Circle().stroke(Self.tint(snapshot.effectiveCode), lineWidth: 2).frame(width: 52, height: 52) }
                        DotCharacterImage(appearance: snapshot.appearance, tint: Self.tint(snapshot.effectiveCode)).frame(width: compact ? 24 : 42, height: compact ? 24 : 42)
                    }.accessibilityHidden(true)
                    if compact {
                        Text("Dot").font(.headline)
                        Text(snapshot.label.capitalized).font(.caption).foregroundStyle(.secondary)
                        if let relation = snapshot.relation, relation.evidence == "dot_report" {
                            Label(relation.kind.capitalized + " report", systemImage: "arrow.triangle.branch")
                                .font(.caption2).accessibilityLabel(relation.label)
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
            }.buttonStyle(.plain).accessibilityLabel("Dot. \(snapshot.label). Open report details.")
        }
        .sheet(isPresented: $expanded) {
            VStack(alignment: .leading, spacing: 12) {
                HStack { Text("Dot report").font(.headline); Spacer(); Button("Done") { expanded = false } }
                Text(snapshot.label.capitalized)
                if snapshot.reportState == nil {
                    Text("No activity has been shared with AgentDeck yet. This does not indicate whether Dot is connected or working elsewhere.").font(.callout).foregroundStyle(.secondary)
                }
                if let stamp = snapshot.reportedAt {
                    Text(Date(timeIntervalSince1970: Double(stamp) / 1000), format: .dateTime).font(.caption)
                }
                if let relation = snapshot.relation, relation.evidence == "dot_report" { Text(verbatim: relation.label) }
            }.padding().frame(minWidth: 280)
        }
    }
}
