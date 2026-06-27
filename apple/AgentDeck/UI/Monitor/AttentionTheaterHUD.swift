// AttentionTheaterHUD.swift — Dashboard variant of the attention theater
//
// Renders whatever PromptOption[] the bridge currently emits for the focused
// awaiting session. This popup used to hardcode Yes/No/Always, which
// misrepresented real Claude Code prompts — plan approvals (5+ options),
// /openclaw scope selection, numbered multi-select lists, etc. Now the UI
// mirrors `DashboardState.options` directly so each CC step (Scope → Token →
// Submit etc.) appears as its own option set.
//
// Layout rules:
//  • ≤3 short options (≤14 char labels) → horizontal row, color-coded by
//    index (green/red/cyan) to keep the familiar tool-approval look.
//  • Anything else → vertical scrollable list, neutral palette with
//    `recommended` highlighted green and `cursorIndex` highlighted.
//
// Button action dispatches `respond(option.index)` — same canonical
// `select_option` path used by D200H buttons and keyboard shortcuts.

import SwiftUI

struct AttentionTheaterHUD: View {
    let session: SessionInfo
    let question: String?
    let queuedCount: Int
    let options: [PromptOption]
    let promptType: PromptType?
    let cursorIndex: Int
    let navigable: Bool
    let respond: (Int) -> Void
    let onFocus: () -> Void

    @State private var breatheLarge = false
    @State private var auraPhase = false

    private var agentLabel: String {
        switch session.agentType {
        case "claude-code": return "Claude"
        case "codex-cli":   return "Codex CLI"
        case "codex-app":   return "Codex App"
        case "openclaw":    return "OpenClaw"
        case "opencode":    return "OpenCode"
        default:            return session.agentType?.capitalized ?? "Agent"
        }
    }

    /// Options to render — exactly what the bridge/daemon delivered. When empty
    /// the prompt isn't remotely answerable (a no-PTY session with no gated
    /// requestId, or a Notification-only awaiting signal), so we DON'T fabricate
    /// a yes/no/always trio that would silently go nowhere — `optionsContent`
    /// shows a "respond in the terminal" hint instead.
    private var effectiveOptions: [PromptOption] { options }
    private var hasFreeformInputOption: Bool { effectiveOptions.contains { $0.isFreeformInput } }
    private var attentionTitle: String { hasFreeformInputOption ? "INPUT NEEDED" : "ATTENTION" }

    /// Use the compact horizontal row layout when we have ≤3 options and
    /// every label is short. This preserves the familiar tool-approval
    /// look for Yes/No/Always style prompts.
    private var useHorizontalLayout: Bool {
        let opts = effectiveOptions
        guard opts.count <= 3 else { return false }
        if opts.contains(where: { $0.isFreeformInput }) { return false }
        if promptType == .multiSelect { return false }
        let maxLen = opts.map(\.label.count).max() ?? 0
        return maxLen <= 14
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                creatureBadge
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(attentionTitle)
                            .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                            .kerning(1.4)
                            .foregroundStyle(TerrariumHUD.ledAmber)
                        if queuedCount > 0 {
                            Text("+\(queuedCount) queued")
                                .font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(TerrariumHUD.subtext)
                        }
                        Spacer(minLength: 0)
                    }
                    Text(session.projectName ?? "Session")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(TerrariumHUD.text)
                        .lineLimit(1)
                    Text(subtitle)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext)
                        .lineLimit(1)
                    if let question, !question.isEmpty {
                        Text(question)
                            .font(.system(size: 12))
                            .foregroundStyle(TerrariumHUD.text)
                            .lineLimit(3)
                            .padding(.top, 6)
                    }
                }
            }

            optionsContent
        }
        .padding(12)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.black.opacity(0.65))
                RoundedRectangle(cornerRadius: 12)
                    .stroke(TerrariumHUD.ledAmber.opacity(0.45), lineWidth: 1)
                RoundedRectangle(cornerRadius: 12)
                    .stroke(TerrariumHUD.ledAmber.opacity(auraPhase ? 0.35 : 0.1), lineWidth: 3)
                    .blur(radius: 4)
            }
        )
        .onTapGesture { onFocus() }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                breatheLarge = true
            }
            withAnimation(.easeInOut(duration: 1.2).repeatForever(autoreverses: true)) {
                auraPhase = true
            }
        }
    }

    @ViewBuilder
    private var optionsContent: some View {
        let opts = effectiveOptions
        if opts.isEmpty {
            // Not remotely answerable — guide the user to the terminal rather
            // than showing dead buttons.
            HStack(spacing: 6) {
                Image(systemName: "terminal")
                    .font(.system(size: 11))
                Text("Respond in the terminal to continue")
                    .font(.system(size: 11.5, weight: .medium))
                    .lineLimit(2)
            }
            .foregroundStyle(TerrariumHUD.subtext)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 8)
            .padding(.horizontal, 10)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.white.opacity(0.06)))
        } else if useHorizontalLayout {
            HStack(spacing: 6) {
                ForEach(opts) { option in
                    theaterButton(option: option, vertical: false)
                }
            }
        } else {
            ScrollView(.vertical, showsIndicators: opts.count > 5) {
                VStack(spacing: 6) {
                    ForEach(opts) { option in
                        if option.isFreeformInput {
                            freeformInputRow(option)
                        } else {
                            theaterButton(option: option, vertical: true)
                        }
                    }
                }
            }
            .frame(maxHeight: 260)
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
        ZStack {
            RoundedRectangle(cornerRadius: 12)
                .fill(Color.black.opacity(0.45))
                .frame(width: 50, height: 50)
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(TerrariumHUD.ledAmber.opacity(0.5), lineWidth: 1)
                )
            SessionCreatureIcon(
                agentType: session.agentType,
                tint: SessionBrand.color(for: session.agentType),
                size: 34
            )
        }
        .scaleEffect(breatheLarge ? 1.04 : 1.0)
    }

    private func theaterButton(option: PromptOption, vertical: Bool) -> some View {
        let isCursor = navigable && option.index == cursorIndex
        let fill = buttonFill(option: option, vertical: vertical)
        let hint = shortcutHint(for: option)
        return Button(action: { respond(option.index) }) {
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
                            .opacity(0.85)
                    }
                }
                .foregroundColor(Color.black.opacity(0.85))
                .padding(.horizontal, 10)
                .padding(.vertical, 9)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(fill)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.white.opacity(isCursor ? 0.9 : 0), lineWidth: 1.5)
                )
            } else {
                VStack(spacing: 1) {
                    Text(option.label)
                        .font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    if let hint {
                        Text(hint)
                            .font(.system(size: 9, design: .monospaced))
                            .opacity(0.85)
                    }
                }
                .foregroundColor(Color.black.opacity(0.85))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
                .background(
                    RoundedRectangle(cornerRadius: 8)
                        .fill(fill)
                        .shadow(color: fill.opacity(0.45), radius: 6, x: 0, y: 2)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(Color.white.opacity(isCursor ? 0.9 : 0), lineWidth: 1.5)
                )
            }
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
                    .foregroundStyle(TerrariumHUD.subtext)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(TerrariumHUD.text)
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.white.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(TerrariumHUD.ledAmber.opacity(0.35), lineWidth: 1)
        )
    }

    /// Pick a fill color. Horizontal layout uses the classic three-button
    /// palette (green/red/cyan) by index so tool approvals feel familiar.
    /// Vertical layout uses a neutral base with `recommended` lit green and
    /// deny-style labels lit red — better for long multi-option lists.
    private func buttonFill(option: PromptOption, vertical: Bool) -> Color {
        if vertical {
            if option.recommended == true { return TerrariumHUD.ledGreen.opacity(0.9) }
            if isDenyLabel(option.label) { return TerrariumHUD.ledRed.opacity(0.85) }
            return Color.white.opacity(0.85)
        }
        switch option.index {
        case 0: return TerrariumHUD.ledGreen
        case 1: return TerrariumHUD.ledRed
        case 2: return TerrariumHUD.tetraNeon
        default: return Color.white.opacity(0.85)
        }
    }

    private func isDenyLabel(_ label: String) -> Bool {
        let l = label.lowercased()
        return l.hasPrefix("no") || l.hasPrefix("deny") || l.contains("don't") || l.contains("don\u{2019}t")
    }

    private func shortcutHint(for option: PromptOption) -> String? {
        if let sc = option.shortcut, !sc.isEmpty {
            return "⌘\(sc.uppercased())"
        }
        // Index-based fallback for navigable multi-select (Cmd+1..9)
        if option.index < 9 {
            return "⌘\(option.index + 1)"
        }
        return nil
    }

    private func shortModel(_ name: String) -> String {
        var s = name
        for prefix in ["claude-", "gpt-", "o1-", "o3-"] {
            if s.hasPrefix(prefix) { s = String(s.dropFirst(prefix.count)) }
        }
        if let range = s.range(of: #"-\d{8}$"#, options: .regularExpression) {
            s = String(s[s.startIndex..<range.lowerBound])
        }
        return s
    }

    private func relativeTime(_ iso: String?) -> String? {
        guard let iso, !iso.isEmpty else { return nil }
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fmt.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else {
            return nil
        }
        let s = Int(Date().timeIntervalSince(date))
        if s < 60 { return "<1m" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 24 { return "\(h)h" }
        return "\(h / 24)d"
    }
}
