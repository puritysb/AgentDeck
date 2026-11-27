import SwiftUI
import UserNotifications
import WatchKit

/// Long-look view for a forwarded Remote attention alert. The alert itself is
/// content-free by contract; this view adds only what this Watch already holds
/// for the same iCloud account — its last cached snapshot — and labels it as
/// such. It makes no network request and offers no reply.
final class AttentionNotificationController: WKUserNotificationHostingController<AttentionNotificationView> {
    private var glance = WatchGlance.unavailable

    override var body: AttentionNotificationView { AttentionNotificationView(glance: glance) }

    override func didReceive(_ notification: UNNotification) {
        let now = Date()
        #if DEBUG
        if let pinned = WatchFixture.fromLaunchArguments(now: now) {
            glance = WatchGlance.make(pinned, at: now)
            return
        }
        #endif
        glance = WatchGlance.make(WatchSnapshotCache().load(localIdentity: RemoteLocalIdentity.current(), now: now), at: now)
    }
}

struct AttentionNotificationView: View {
    let glance: WatchGlance

    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                Circle().fill(WatchTheme.waiting.opacity(0.18))
                Circle().strokeBorder(WatchTheme.waiting, lineWidth: 3)
                    .phaseAnimator([false, true]) { ring, lit in ring.scaleEffect(lit ? 1.06 : 0.96).opacity(lit ? 1 : 0.6) }
                        animation: { _ in .easeInOut(duration: 0.9) }
                agents
            }
            .frame(width: 84, height: 84)
            Text(headline).font(.headline).foregroundStyle(WatchTheme.text).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            if let line = contextLine {
                Text(line).font(.caption2).foregroundStyle(WatchTheme.subtext).multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("Respond on your Mac or a device on its network.")
                .font(.system(size: 11)).foregroundStyle(WatchTheme.faint).multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.vertical, 4)
        .containerBackground(WatchTheme.background(for: .needsYou), for: .navigation)
    }

    /// Up to three waiting agents from a recent cache; otherwise a generic mark.
    @ViewBuilder
    private var agents: some View {
        let shown = glance.historical ? [] : Array(glance.waitingAgents.prefix(3))
        if shown.isEmpty {
            Image(systemName: "hand.raised.fill").font(.system(size: 34)).foregroundStyle(WatchTheme.waiting)
        } else {
            HStack(spacing: shown.count == 1 ? 0 : 4) {
                ForEach(Array(shown.enumerated()), id: \.offset) { _, agent in
                    AgentBadge(agent: agent, size: shown.count == 1 ? 46 : 28, ring: shown.count == 1 ? WatchTheme.waiting : nil)
                }
            }
        }
    }

    /// The alert is one event; a recent cache may know several agents are waiting.
    private var headline: String {
        guard glance.hasCounts, !glance.historical, let waiting = glance.waiting, waiting > 1 else {
            return String(localized: "An agent needs you")
        }
        return String(localized: "\(waiting) agents need you")
    }

    private var contextLine: String? {
        guard glance.hasCounts, !glance.historical, (glance.waiting ?? 0) > 0 else { return nil }
        let names = glance.waitingAgents.prefix(2).map(\.displayName).joined(separator: ", ")
        guard !names.isEmpty, let observedAt = glance.observedAt else { return nil }
        return String(localized: "\(names) · \(observedAt.formatted(date: .omitted, time: .shortened))")
    }
}
