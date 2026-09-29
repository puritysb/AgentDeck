// SessionJumpRow.swift — Compact session row used in the menu bar
// ControlTower panel. Tapping the row issues a `focus_session`
// command so the dashboard terrarium centers this session.

#if os(macOS)
import SwiftUI
import AppKit

struct SessionJumpRow: View {
    let session: SessionInfo
    /// Live tool name (e.g., "Bash", "Write file"). Only populated for the
    /// focused session — the bridge protocol streams tool state for one
    /// session at a time.
    var tool: String? = nil
    let onFocus: () -> Void

    private var state: AgentConnectionState {
        AgentConnectionState(rawValue: session.state ?? "idle") ?? .idle
    }

    private var stateDotColor: Color { StateColors.color(for: state) }

    private var brandColor: Color { SessionBrand.color(for: session.agentType) }

    private var agentLabel: String { displayAgentLabel(session.agentType) }

    var body: some View {
        Button(action: onFocus) {
            HStack(spacing: 8) {
                ZStack(alignment: .topTrailing) {
                    SessionCreatureIcon(
                        agentType: session.agentType,
                        tint: brandColor,
                        size: 22
                    )
                    .opacity(state == .disconnected ? 0.35 : 1.0)
                    Circle()
                        .fill(stateDotColor)
                        .frame(width: 7, height: 7)
                        .overlay(
                            Circle()
                                .stroke(TerrariumColors.deepSea, lineWidth: 1.5)
                        )
                        .offset(x: 3, y: -2)
                }
                .frame(width: 24, height: 22)

                VStack(alignment: .leading, spacing: 1) {
                    Text(session.projectName ?? "Unknown")
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                    Text(subtitleText)
                        .font(.system(size: 10))
                        .foregroundColor(TerrariumHUD.subtext)
                        .lineLimit(1)
                }

                Spacer(minLength: 4)

                if let started = relativeTime(session.startedAt) {
                    Text(started)
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundColor(TerrariumHUD.subtext)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.md)
                .fill(DesignTokens.Tide.s50.opacity(0.04))
        )
        .overlay(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.md)
                .stroke(DesignTokens.Tide.s50.opacity(0.10), lineWidth: 0.5)
        )
    }

    private var subtitleText: String {
        var parts: [String] = [agentLabel]
        if let model = session.modelName, !model.isEmpty {
            parts.append(shortModel(model))
        }
        if let tool, !tool.isEmpty {
            parts.append(tool)
        }
        return parts.joined(separator: " · ")
    }

    private func shortModel(_ name: String) -> String { displayShortModelName(name) }

    private func relativeTime(_ iso: String?) -> String? { displayRelativeTime(iso) }
}
#endif
