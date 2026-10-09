import SwiftUI
import ImageIO

/// One read-only companion across local/remote hosts and Apple surfaces.
struct DotSurfaceView: View {
    let snapshot: DotSurfaceSnapshot
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
                        Circle().stroke(Self.tint(snapshot.effectiveCode), lineWidth: 2).frame(width: 52, height: 52)
                        DotCharacterImage(appearance: snapshot.appearance, tint: Self.tint(snapshot.effectiveCode)).frame(width: 42, height: 42)
                    }.accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Dot").font(.headline)
                        Text(snapshot.label).font(.caption)
                        if let relation = snapshot.relation, relation.evidence == "dot_report" {
                            Text(verbatim: relation.label).font(.caption2).lineLimit(3)
                        }
                        Text(snapshot.reportState == nil ? "Integration" : "Dot report").font(.caption2).foregroundStyle(.secondary)
                    }.frame(maxWidth: 200, alignment: .leading)
                }.padding(10).background(DesignTokens.Ink.s800, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.xl))
            }.buttonStyle(.plain).accessibilityLabel("Dot. (snapshot.label). Open report details.")
        }
        .sheet(isPresented: $expanded) {
            VStack(alignment: .leading, spacing: 12) {
                HStack { Text("Dot report").font(.headline); Spacer(); Button("Done") { expanded = false } }
                Text(snapshot.label)
                if let stamp = snapshot.reportedAt {
                    Text(Date(timeIntervalSince1970: Double(stamp) / 1000), format: .dateTime).font(.caption)
                }
                if let relation = snapshot.relation, relation.evidence == "dot_report" { Text(verbatim: relation.label) }
            }.padding().frame(minWidth: 280)
        }
    }
}
