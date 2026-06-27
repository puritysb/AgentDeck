// AttentionTheaterView.swift — "Attention Theater" hero card (MenuBar)
//
// Mirrors `AttentionTheaterHUD` (Dashboard variant) but in the cream
// menubar palette. Renders whatever PromptOption[] the focused session
// currently needs — the old hardcoded Yes/No/Always trio misrepresented
// plan approvals, /openclaw scope selection, and any other multi-option
// CC prompt, so the popup now reflects `DashboardState.options` directly.
//
// Layout rules match the dashboard variant: ≤3 short options render in a
// horizontal row with the classic colored palette; everything else falls
// back to a scrollable vertical list with neutral tiles, recommended
// highlighted, deny-style labels tinted red.

#if os(macOS)
import SwiftUI
import AppKit

/// Publishes the vertical option list's natural height so the surrounding
/// ScrollView frame can collapse to it instead of greedily filling
/// `optionsCap`. Single GeometryReader source → reduce adopts latest.
/// Defined file-local (not shared with ControlTowerPanel's ContentHeightKey)
/// so the two scrollable surfaces inside the same popup don't fight over
/// the same PreferenceKey bubble.
private struct OptionsHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

struct AttentionTheaterView: View {
    let session: SessionInfo
    let question: String?
    let options: [PromptOption]
    let promptType: PromptType?
    let cursorIndex: Int
    let navigable: Bool
    /// Button handler — `index` matches `PluginCommand.selectOption`.
    let respond: (Int) -> Void

    @State private var breatheLarge: Bool = false

    /// Natural height of the vertical option list. Same SwiftUI-ScrollView-
    /// is-greedy mitigation as `ControlTowerPanel.measuredContentHeight`:
    /// without this binding the inner ScrollView claims the full
    /// `optionsCap` (e.g. 315pt) even when only 3 options render, leaving
    /// empty space below the buttons and surfacing a scrollbar prematurely.
    @State private var measuredOptionsHeight: CGFloat = 0

    private var agentType: String? { session.agentType }
    private var brandColor: Color { SessionBrand.color(for: agentType) }
    private var agentLabel: String { displayAgentLabel(agentType) }

    /// Options to render — exactly what the daemon delivered. Empty means the
    /// prompt isn't remotely answerable (no-PTY session without a gated
    /// requestId, or a Notification-only signal); `optionsContent` then shows a
    /// terminal hint rather than fabricating dead Yes/No/Always buttons.
    private var effectiveOptions: [PromptOption] { options }
    private var hasFreeformInputOption: Bool { effectiveOptions.contains { $0.isFreeformInput } }
    private var attentionTitle: String { hasFreeformInputOption ? "INPUT NEEDED" : "NEEDS ATTENTION" }

    private var useHorizontalLayout: Bool {
        let opts = effectiveOptions
        guard opts.count <= 3 else { return false }
        if opts.contains(where: { $0.isFreeformInput }) { return false }
        if promptType == .multiSelect { return false }
        let maxLen = opts.map(\.label.count).max() ?? 0
        return maxLen <= 14
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            LinearGradient(
                colors: [
                    Color(red: 1.0, green: 0.913, blue: 0.78),
                    Color(red: 1.0, green: 0.851, blue: 0.627),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
            .overlay(
                Circle()
                    .fill(Color.white.opacity(0.45))
                    .frame(width: 140, height: 140)
                    .blur(radius: 40)
                    .offset(x: 40, y: -40),
                alignment: .topTrailing
            )

            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top, spacing: 12) {
                    creatureBadge
                    VStack(alignment: .leading, spacing: 2) {
                        Text(attentionTitle)
                            .font(.system(size: 9.5, weight: .bold))
                            .kerning(1.2)
                            .foregroundColor(Color(red: 0.541, green: 0.416, blue: 0.125))
                        Text(session.projectName ?? "Session")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundColor(Color(red: 0.102, green: 0.102, blue: 0.122))
                            .lineLimit(1)
                        Text(subtitle)
                            .font(.system(size: 10.5))
                            .foregroundColor(Color(red: 0.416, green: 0.353, blue: 0.188))
                            .lineLimit(1)
                        if let question, !question.isEmpty {
                            Text(question)
                                .font(.system(size: 12))
                                .foregroundColor(Color(red: 0.102, green: 0.102, blue: 0.122))
                                .lineLimit(2)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 7)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(
                                    RoundedRectangle(cornerRadius: 8)
                                        .fill(Color.white.opacity(0.75))
                                )
                                .padding(.top, 6)
                        }
                    }
                }

                optionsContent
            }
            .padding(14)
        }
        .overlay(
            Rectangle()
                .fill(Color.black.opacity(0.08))
                .frame(height: 0.5),
            alignment: .bottom
        )
    }

    @ViewBuilder
    private var optionsContent: some View {
        let opts = effectiveOptions
        if opts.isEmpty {
            // Not remotely answerable — point the user to the terminal instead
            // of showing buttons that can't drive the agent.
            HStack(spacing: 6) {
                Image(systemName: "terminal")
                    .font(.system(size: 11))
                Text("Respond in the terminal to continue")
                    .font(.system(size: 11.5, weight: .medium))
                    .lineLimit(2)
            }
            .foregroundColor(Color(red: 0.416, green: 0.353, blue: 0.188))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
            .padding(.horizontal, 10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.5)))
        } else if useHorizontalLayout {
            HStack(spacing: 6) {
                ForEach(opts) { option in
                    theaterButton(option: option, vertical: false)
                }
            }
        } else {
            // Adaptive cap that shares the screen budget with the body
            // ScrollView + footer chrome below. Sizing rule:
            //   options + ~140 (badge/question chrome) + ~150 (banner+
            //   pill+footer) + 80 (body floor) + 24 (safety) ≤ screen
            // → options ≤ screen - 394. We use 0.35 * screen with an
            // absolute 380pt ceiling: that satisfies the invariant on
            // typical screens (≥800pt) while keeping the cap reasonable
            // on 4K displays. Typical prompts (Yes/No/Always, plan-
            // approval trios, ≤8 options) never reach the ceiling so no
            // scrollbar appears; pathological lists (e.g. /openclaw
            // scope's 30+ entries) scroll internally instead of pushing
            // the sessions list and footer off the popup.
            let screenHeight = NSScreen.main?.visibleFrame.height ?? 900
            let optionsCap = min(380, screenHeight * 0.35)
            ScrollView(
                .vertical,
                showsIndicators: measuredOptionsHeight > optionsCap
            ) {
                VStack(spacing: 6) {
                    ForEach(opts) { option in
                        if option.isFreeformInput {
                            freeformInputRow(option)
                        } else {
                            theaterButton(option: option, vertical: true)
                        }
                    }
                }
                .background(
                    GeometryReader { proxy in
                        Color.clear.preference(
                            key: OptionsHeightKey.self,
                            value: proxy.size.height
                        )
                    }
                )
            }
            .frame(
                maxHeight: measuredOptionsHeight > 0
                    ? min(optionsCap, measuredOptionsHeight)
                    : optionsCap
            )
            .onPreferenceChange(OptionsHeightKey.self) { measuredOptionsHeight = $0 }
        }
    }

    private var subtitle: String {
        var parts: [String] = [agentLabel]
        if let model = session.modelName, !model.isEmpty {
            parts.append(shortModel(model))
        }
        if let started = relativeTime(session.startedAt) {
            parts.append(started)
        }
        return parts.joined(separator: " · ")
    }

    private var creatureBadge: some View {
        RoundedRectangle(cornerRadius: 14)
            .fill(Color.white)
            .frame(width: 54, height: 54)
            .overlay(
                SessionCreatureIcon(
                    agentType: agentType,
                    tint: brandColor,
                    size: 38
                )
            )
            .shadow(color: Color.black.opacity(0.12), radius: 8, x: 0, y: 4)
            .scaleEffect(breatheLarge ? 1.04 : 1.0)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                    breatheLarge = true
                }
            }
    }

    private func theaterButton(option: PromptOption, vertical: Bool) -> some View {
        let isCursor = navigable && option.index == cursorIndex
        let bg = buttonFill(option: option, vertical: vertical)
        let fg = buttonTextColor(option: option, vertical: vertical)
        let hint = shortcutHint(for: option)
        return Button(action: { respond(option.index) }) {
            Group {
                if vertical {
                    HStack(alignment: .center, spacing: 8) {
                        if option.selected == true {
                            Text("✓")
                                .font(.system(size: 11, weight: .bold))
                        }
                        Text(option.label)
                            .font(.system(size: 12.5, weight: option.recommended == true ? .semibold : .regular))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .lineLimit(2)
                        if let hint {
                            Text(hint)
                                .font(.system(size: 9, design: .monospaced))
                                .opacity(0.8)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                } else {
                    VStack(spacing: 1) {
                        Text(option.label)
                            .font(.system(size: 13, weight: .semibold))
                            .lineLimit(1)
                        if let hint {
                            Text(hint)
                                .font(.system(size: 9, design: .monospaced))
                                .opacity(0.8)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 9)
                }
            }
            .foregroundColor(fg)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(bg)
                    .shadow(color: bg.opacity(0.35), radius: 4, x: 0, y: 2)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(Color.black.opacity(isCursor ? 0.55 : 0), lineWidth: 1.5)
            )
        }
        .buttonStyle(.plain)
    }

    private func freeformInputRow(_ option: PromptOption) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "keyboard")
                .font(.system(size: 11, weight: .semibold))
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label)
                    .font(.system(size: 12.5, weight: .semibold))
                    .lineLimit(1)
                Text("Type this response in the terminal")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundColor(Color(red: 0.416, green: 0.353, blue: 0.188))
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .foregroundColor(Color(red: 0.102, green: 0.102, blue: 0.122))
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.58)))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.black.opacity(0.12), lineWidth: 1)
        )
    }

    /// Horizontal palette mirrors the dashboard variant (index 0/1/2 =
    /// green/red/blue). Vertical palette uses cream tiles by default with
    /// recommended lit green and deny-style labels lit red.
    private func buttonFill(option: PromptOption, vertical: Bool) -> Color {
        if vertical {
            if option.recommended == true { return Color(red: 0.102, green: 0.616, blue: 0.290) }
            if isDenyLabel(option.label) { return Color(red: 0.788, green: 0.188, blue: 0.188) }
            return Color.white.opacity(0.85)
        }
        switch option.index {
        case 0: return Color(red: 0.102, green: 0.616, blue: 0.290)
        case 1: return Color(red: 0.788, green: 0.188, blue: 0.188)
        case 2: return Color(red: 0.165, green: 0.435, blue: 0.847)
        default: return Color.white.opacity(0.85)
        }
    }

    private func buttonTextColor(option: PromptOption, vertical: Bool) -> Color {
        if vertical {
            if option.recommended == true || isDenyLabel(option.label) {
                return .white
            }
            return Color(red: 0.102, green: 0.102, blue: 0.122)
        }
        return .white
    }

    private func isDenyLabel(_ label: String) -> Bool {
        let l = label.lowercased()
        return l.hasPrefix("no") || l.hasPrefix("deny") || l.contains("don't") || l.contains("don\u{2019}t")
    }

    private func shortcutHint(for option: PromptOption) -> String? {
        if let sc = option.shortcut, !sc.isEmpty {
            return "⌘\(sc.uppercased())"
        }
        if option.index < 9 {
            return "⌘\(option.index + 1)"
        }
        return nil
    }

    private func shortModel(_ name: String) -> String { displayShortModelName(name) }

    private func relativeTime(_ iso: String?) -> String? { displayRelativeTime(iso) }
}

// MARK: - Calm Header

/// Rendered in place of the theater when no session needs attention. Shows
/// the AgentDeck mark, session count, and daemon port.
struct CalmHeaderView: View {
    let sessionCount: Int
    let processingCount: Int
    let daemonPort: UInt16
    let bridgeConnected: Bool

    var body: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 8)
                .fill(LinearGradient(
                    colors: [
                        DesignTokens.UI.cyan.opacity(0.22),
                        DesignTokens.Ink.s800,
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                ))
                .frame(width: 28, height: 28)
                .overlay(
                    AgentDeckLogo(size: 18, color: DesignTokens.UI.cyan)
                )

            VStack(alignment: .leading, spacing: 0) {
                Text("All calm")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(TerrariumHUD.text)
                Text(subtitle)
                    .font(.system(size: 10))
                    .foregroundColor(TerrariumHUD.subtext)
            }

            Spacer(minLength: 6)

            HStack(spacing: 4) {
                Circle()
                    .fill(bridgeConnected ? DesignTokens.UI.ok : DesignTokens.UI.error)
                    .frame(width: 6, height: 6)
                if daemonPort > 0 {
                    Text(verbatim: ":\(portString(daemonPort))")
                        .font(.system(size: 10, design: .monospaced))
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(Color.white.opacity(0.08))
            )
            .foregroundColor(bridgeConnected ? DesignTokens.UI.ok : DesignTokens.UI.error)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .overlay(
            Rectangle()
                .fill(Color.white.opacity(0.08))
                .frame(height: 0.5),
            alignment: .bottom
        )
    }

    private var subtitle: String {
        let sessionWord = sessionCount == 1 ? "session" : "sessions"
        var s = "\(sessionCount) \(sessionWord)"
        if processingCount > 0 {
            s += " · \(processingCount) active"
        }
        return s
    }
}
#endif
