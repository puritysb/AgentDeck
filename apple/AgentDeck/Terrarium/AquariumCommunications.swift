import SwiftUI

/// The graph and habitat share observed message identities.
/// A current needs two live roster identities.
struct AquariumCommunications {
    struct Current: Identifiable, Equatable {
        let id: String
        let senderID: String
        let recipientID: String
        let senderName: String
        let recipientName: String
        let observedAt: Double
        let status: String
        let crossed: Bool

    }

    let currents: [Current]
    let capturedAt: Double
    let fresh: Bool
    let truncated: Bool
    static let empty = Self(currents: [], capturedAt: 0, fresh: false, truncated: false)

    func clock(_ date: Date) -> Double {
        fresh ? date.timeIntervalSince1970 * 1_000 : capturedAt
    }

    static func project(snapshot: CommunicationSnapshot?, roster: [SessionInfo],
                        visibleIDs: Set<String>, focusedID: String?, fresh: Bool) -> Self {
        let network = CommunicationNetwork.project(snapshot: snapshot, roster: roster)
        let nodes = Dictionary(uniqueKeysWithValues: network.nodes.map { ($0.id, $0) })
        let currents = network.links.sorted {
            $0.lastObservedAt == $1.lastObservedAt ? $0.id < $1.id : $0.lastObservedAt > $1.lastObservedAt
        }.compactMap { link -> Current? in
            guard let sender = nodes[link.latestSender], let recipient = nodes[link.latestRecipient],
                  let from = sender.rosterID, let to = recipient.rosterID,
                  visibleIDs.contains(from), visibleIDs.contains(to),
                  focusedID == nil || focusedID == from || focusedID == to else { return nil }
            return Current(id: link.id, senderID: from, recipientID: to,
                           senderName: sender.name, recipientName: recipient.name,
                           observedAt: link.lastObservedAt, status: link.status, crossed: link.crossed)
        }
        return Self(currents: Array(currents.prefix(CollaborationPresentation.aquariumLinkLimit)),
                    capturedAt: snapshot?.capturedAt ?? 0, fresh: fresh, truncated: snapshot?.truncated ?? false)
    }
}

/// Screen-space water currents, anchored each frame to real resident poses.
/// Both renderers use this painter: camera movement cannot detach a 3D link.
enum AquariumCommunicationDrawing {
    static func draw(context: inout GraphicsContext, size: CGSize, communications: AquariumCommunications,
                     date: Date, reduceMotion: Bool, labels: Bool, traces: Bool = true,
                     labelInsets: EdgeInsets = EdgeInsets(), avoiding: [CGRect] = [],
                     pose: (String) -> SIMD2<Float>?) {
        let now = communications.clock(date)
        var labelRects = avoiding
        for current in communications.currents {
            guard let from = pose(current.senderID), let to = pose(current.recipientID),
                  (0...1).contains(from.x), (0...1).contains(from.y),
                  (0...1).contains(to.x), (0...1).contains(to.y) else { continue }
            let a = CGPoint(x: CGFloat(from.x) * size.width, y: CGFloat(from.y) * size.height)
            let b = CGPoint(x: CGFloat(to.x) * size.width, y: CGFloat(to.y) * size.height)
            let dx = b.x - a.x, dy = b.y - a.y, length = hypot(dx, dy)
            guard length > 32 else { continue }
            // A shallow eddy, lifted above the sand instead of a rigid wire.
            let control = CGPoint(x: (a.x + b.x) / 2, y: min(a.y, b.y) - min(90, length * 0.2))
            func point(_ t: Double) -> CGPoint {
                let u = 1 - t
                return CGPoint(x: u*u*a.x + 2*u*t*control.x + t*t*b.x,
                               y: u*u*a.y + 2*u*t*control.y + t*t*b.y)
            }
            if traces {
                var path = Path(); path.move(to: point(0.08))
                for step in 1...32 { path.addLine(to: point(0.08 + Double(step) / 32 * 0.84)) }
                context.stroke(path, with: .color(DesignTokens.UI.cyan.opacity(0.10)), style: StrokeStyle(lineWidth: 7, lineCap: .round))
                context.stroke(path, with: .color(DesignTokens.UI.cyan.opacity(communications.fresh ? 0.48 : 0.23)),
                               style: StrokeStyle(lineWidth: 1, lineCap: .round, dash: [3, 6]))
                let recent = now >= current.observedAt && now - current.observedAt < Double(CollaborationPresentation.aquariumRecentMessageMs)
                let flows = communications.fresh && recent && !reduceMotion && !current.crossed
                let phase = flows ? date.timeIntervalSince1970 / Double(CollaborationPresentation.aquariumBubbleTravelSeconds) : 0
                for index in 0..<CollaborationPresentation.aquariumBubbleCount {
                    let fraction = (phase + Double(index) / Double(CollaborationPresentation.aquariumBubbleCount)).truncatingRemainder(dividingBy: 1)
                    let p = point(0.12 + fraction * 0.76)
                    let radius = recent ? 2.5 : 1.5
                    context.stroke(Path(ellipseIn: CGRect(x: p.x-radius, y: p.y-radius, width: radius*2, height: radius*2)),
                                   with: .color(DesignTokens.UI.cyan.opacity(0.7)), lineWidth: 1)
                }
                if !current.crossed {
                    let tip = point(0.88), tail = point(0.84)
                    let angle = atan2(tip.y-tail.y, tip.x-tail.x)
                    var fin = Path(); fin.move(to: CGPoint(x: tip.x-6*cos(angle-0.55), y: tip.y-6*sin(angle-0.55)))
                    fin.addLine(to: tip); fin.addLine(to: CGPoint(x: tip.x-6*cos(angle+0.55), y: tip.y-6*sin(angle+0.55)))
                    context.stroke(fin, with: .color(DesignTokens.UI.cyan.opacity(0.8)), style: StrokeStyle(lineWidth: 1.2, lineCap: .round))
                }
            }
            if labels {
                let middle = point(0.5)
                let names = "\(current.senderName.prefix(18)) \(current.crossed ? "↔" : "→") \(current.recipientName.prefix(18))"
                let caption = current.status + (communications.fresh ? "" : " · stale")
                let text = context.resolve(Text(names + "\n" + caption).font(.custom("IBMPlexSans", size: 10))
                    .foregroundColor(DesignTokens.Tide.s50))
                let measured = text.measure(in: CGSize(width: 260, height: 40))
                let box = CommunicationLabelLayout.place(preferred: CGPoint(x: middle.x, y: middle.y-14),
                    size: CGSize(width: measured.width+12, height: measured.height+8),
                    bounds: CGRect(x: labelInsets.leading+8, y: labelInsets.top+8,
                        width: max(1, size.width-labelInsets.leading-labelInsets.trailing-16),
                        height: max(1, size.height-labelInsets.top-labelInsets.bottom-16)), avoiding: labelRects)
                labelRects.append(box)
                context.fill(Path(roundedRect: box, cornerRadius: 8), with: .color(DesignTokens.Ink.s900.opacity(0.86)))
                context.draw(text, at: CGPoint(x: box.midX, y: box.midY))
            }
        }
    }
}

struct AquariumCommunicationOverlay: View {
    let communications: AquariumCommunications
    var labels = true
    var labelInsets = EdgeInsets()
    let pose: (String) -> SIMD2<Float>?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0/30)) { timeline in
            Canvas { context, size in
                AquariumCommunicationDrawing.draw(context: &context, size: size, communications: communications,
                    date: timeline.date, reduceMotion: reduceMotion, labels: labels, labelInsets: labelInsets, pose: pose)
            }
        }
        .allowsHitTesting(false)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(communications.currents.map {
            "\($0.senderName) to \($0.recipientName), \($0.status)"
        }.joined(separator: "; "))
    }
}
