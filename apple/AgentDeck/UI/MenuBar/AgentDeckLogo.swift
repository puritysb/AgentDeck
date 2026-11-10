// AgentDeckLogo.swift — Small-size product symbol for AgentDeck
//
// The full app icon is the aquarium dome over a hardware deck. At menu-bar
// sizes the illustration collapses, so this view keeps the same silhouette:
// glass dome, waterline, and button deck base. It intentionally replaces the
// older abstract stacked-card mark, which looked unrelated to the app icon.
//
// Implemented with basic Shape views rather than `Canvas` because
// Canvas-backed views do NOT render inside `MenuBarExtra` labels (they
// measure as zero-size, which is how the menubar icon went invisible).
// Shape views survive the same context, and render identically at 14pt and
// 32pt.
//
// Available on both iOS and macOS so the dashboard HUD (shared between
// the two platforms) can use the same mark.

import SwiftUI

/// Dashboard wordmark: the mark beside the monospaced product name. Every Apple
/// dashboard uses this one definition, with `AgentDeckBrandRule` beneath it.
struct AgentDeckWordmark: View {
    var body: some View {
        HStack(spacing: 6) {
            AgentDeckLogo(size: 20, color: TerrariumHUD.tetraNeon)
            Text("AgentDeck")
                .font(.system(size: 22, weight: .bold, design: .monospaced))
                .foregroundStyle(TerrariumHUD.text)
                .lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("AgentDeck")
    }
}

/// The neon rule under the dashboard wordmark: a soft glow over a crisp bar,
/// centred at 80% of the width it is given.
struct AgentDeckBrandRule: View {
    var body: some View {
        Canvas { context, size in
            let barWidth = size.width * 0.8
            let x = (size.width - barWidth) / 2
            context.fill(Path(roundedRect: CGRect(x: x, y: 0, width: barWidth, height: 3), cornerRadius: 1.5),
                         with: .color(TerrariumHUD.tetraNeon.opacity(0.3)))
            context.fill(Path(roundedRect: CGRect(x: x, y: 3, width: barWidth, height: 2), cornerRadius: 1),
                         with: .color(TerrariumHUD.tetraNeon))
        }
        .frame(height: 5)
        .accessibilityHidden(true)
    }
}

struct AgentDeckLogo: View {
    var size: CGFloat = 16
    var color: Color = .primary

    var body: some View {
        // Unit-space layout (0…24) so every piece scales from a single
        // `size` input and remains crisp at 16–20pt.
        let s = size / 24.0
        let stroke = max(1.0, 1.55 * s)
        ZStack(alignment: .topLeading) {
            Color.clear

            domePath(s: s)
                .stroke(
                    color,
                    style: StrokeStyle(lineWidth: stroke, lineCap: .round, lineJoin: .round)
                )

            waterlinePath(s: s)
                .stroke(
                    color.opacity(0.58),
                    style: StrokeStyle(lineWidth: max(0.75, 1.15 * s), lineCap: .round, lineJoin: .round)
                )

            highlightPath(s: s)
                .stroke(
                    color.opacity(0.34),
                    style: StrokeStyle(lineWidth: max(0.6, 0.9 * s), lineCap: .round, lineJoin: .round)
                )

            RoundedRectangle(cornerRadius: 2.2 * s)
                .stroke(
                    color.opacity(0.88),
                    style: StrokeStyle(lineWidth: stroke, lineCap: .round, lineJoin: .round)
                )
                .frame(width: 17.2 * s, height: 7.8 * s)
                .offset(x: 3.4 * s, y: 12.2 * s)

            deckKey(x: 6.5 * s, y: 15.4 * s, s: s, opacity: 0.70)
            deckKey(x: 10.4 * s, y: 15.4 * s, s: s, opacity: 0.92)
            deckKey(x: 14.3 * s, y: 15.4 * s, s: s, opacity: 0.70)

            Circle()
                .fill(color.opacity(0.62))
                .frame(width: 1.9 * s, height: 1.9 * s)
                .position(x: 9.6 * s, y: 9.0 * s)
            Circle()
                .fill(color.opacity(0.42))
                .frame(width: 1.2 * s, height: 1.2 * s)
                .position(x: 14.8 * s, y: 8.2 * s)
        }
        .frame(width: size, height: size)
        .accessibilityLabel("AgentDeck")
    }

    private func deckKey(x: CGFloat, y: CGFloat, s: CGFloat, opacity: Double) -> some View {
        RoundedRectangle(cornerRadius: 1.5 * s)
            .fill(color.opacity(opacity))
            .frame(width: 3.1 * s, height: 2.0 * s)
            .offset(x: x, y: y)
    }

    private func domePath(s: CGFloat) -> Path {
        Path { path in
            path.move(to: CGPoint(x: 4.7 * s, y: 12.8 * s))
            path.addCurve(
                to: CGPoint(x: 19.3 * s, y: 12.8 * s),
                control1: CGPoint(x: 5.3 * s, y: 4.9 * s),
                control2: CGPoint(x: 18.7 * s, y: 4.9 * s)
            )
        }
    }

    private func waterlinePath(s: CGFloat) -> Path {
        Path { path in
            path.move(to: CGPoint(x: 6.1 * s, y: 11.2 * s))
            path.addCurve(
                to: CGPoint(x: 17.9 * s, y: 11.2 * s),
                control1: CGPoint(x: 8.8 * s, y: 12.5 * s),
                control2: CGPoint(x: 15.2 * s, y: 12.5 * s)
            )
        }
    }

    private func highlightPath(s: CGFloat) -> Path {
        Path { path in
            path.move(to: CGPoint(x: 8.0 * s, y: 7.7 * s))
            path.addCurve(
                to: CGPoint(x: 15.8 * s, y: 6.1 * s),
                control1: CGPoint(x: 10.0 * s, y: 5.7 * s),
                control2: CGPoint(x: 13.2 * s, y: 5.4 * s)
            )
        }
    }
}

#Preview {
    VStack(spacing: 16) {
        AgentDeckLogo(size: 16, color: .primary)
        AgentDeckLogo(size: 28, color: .cyan)
        AgentDeckLogo(size: 48, color: .orange)
    }
    .padding()
}
