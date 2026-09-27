// EinkEsp32Previews.swift — E-ink readers + ESP32 display boards.
//
// E-ink previews deliberately use a cream/paper-white canvas with near-black
// creature outlines — this mirrors the CremaS / Kobo rendering pipeline which
// forces the drawable into 2-bit or 4-bit greyscale. The color e-ink variant
// (Pantone6) tints the creature with the agent brand because the device
// actually supports ~6 colours.
//
// ESP32 previews are all framed device bodies with a creature + HUD. The real
// firmware is LVGL + custom draw routines that we don't try to port here.

import SwiftUI

// MARK: - E-ink Mono

struct EinkMonoPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 10) {
            DeviceBezel(
                cornerRadius: 14,
                bezelWidth: 16,
                bezelColor: Color(white: 0.85),
                screenColor: Color(red: 0.95, green: 0.94, blue: 0.90)
            ) {
                EinkScreenLayout(selection: selection, isColor: false)
            }
            .frame(width: 240, height: 320)
            Text("E-ink mono • CremaS / Kobo")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - E-ink Color (Pantone6)

struct EinkColorPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 10) {
            DeviceBezel(
                cornerRadius: 14,
                bezelWidth: 16,
                bezelColor: Color(white: 0.88),
                screenColor: Color(red: 0.96, green: 0.95, blue: 0.88)
            ) {
                EinkScreenLayout(selection: selection, isColor: true)
            }
            .frame(width: 240, height: 320)
            Text("E-ink color • Pantone6")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

private struct EinkScreenLayout: View {
    let selection: DevicePreviewSelection
    let isColor: Bool

    var body: some View {
        ZStack {
            background
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("AgentDeck")
                        .font(.system(size: 11, weight: .semibold, design: .serif))
                    Spacer()
                    Text(isColor ? "PANTONE6" : "CREMAS")
                        .font(.system(size: 8, weight: .medium, design: .monospaced))
                        .opacity(0.55)
                }
                .foregroundStyle(.black.opacity(0.86))

                HStack(alignment: .top, spacing: 7) {
                    PreviewMiniSessionList(selection: selection, dark: false, compact: true)
                        .frame(width: 70, height: 112)

                    VStack(alignment: .leading, spacing: 5) {
                        HStack(alignment: .center, spacing: 5) {
                            PreviewCreatureGlyph(
                                agent: focusAgent,
                                state: focusState,
                                size: 54,
                                tintOverride: creatureTint
                            )
                            VStack(alignment: .leading, spacing: 2) {
                                Text(focusSession?.projectName ?? focusAgent.displayName)
                                    .font(.system(size: 13, weight: .bold, design: .serif))
                                    .foregroundStyle(creatureTint)
                                    .lineLimit(1)
                                Text("STATE \(focusState.displayName.uppercased())")
                                    .font(.system(size: 7, weight: .semibold, design: .monospaced))
                                    .foregroundStyle(.black.opacity(0.58))
                                Text("\(sessionTotal) SESSION\(sessionTotal == 1 ? "" : "S")")
                                    .font(.system(size: 7, design: .monospaced))
                                    .foregroundStyle(.black.opacity(0.45))
                            }
                            Spacer(minLength: 0)
                        }
                        usageStrip
                    }
                }

                Divider()
                    .overlay(Color.black.opacity(0.28))

                PreviewTimelineMini(selection: selection, dark: false, compact: true)
                Spacer(minLength: 0)
            }
            .padding(9)
        }
    }

    private var background: some View {
        LinearGradient(
            colors: isColor
                ? [
                    Color(red: 0.82, green: 0.87, blue: 0.89),
                    Color(red: 0.92, green: 0.93, blue: 0.91),
                    Color(red: 0.96, green: 0.95, blue: 0.88),
                ]
                : [Color(white: 0.84), Color(white: 0.90), Color(white: 0.95)],
            startPoint: .top,
            endPoint: .bottom
        )
    }

    // Focused session (real in live-follow, else the synthesized primary) — the
    // large creature + name reflect it; the mini list beside it shows the rest.
    private var focusSession: PreviewDisplaySession? { selection.displaySessions.first }
    private var focusAgent: PixooPreviewAgent { focusSession?.agent ?? selection.agent }
    private var focusState: PixooPreviewState { focusSession?.state ?? selection.state }
    private var sessionTotal: Int {
        selection.live != nil ? selection.displaySessions.count : selection.sessionCount
    }

    private var creatureTint: Color {
        isColor ? StateColors.brand(agent: focusAgent.rawValue) : .black.opacity(0.82)
    }

    private var usageStrip: some View {
        // Real Claude window in live-follow mode, else the placeholder gauge.
        let usage = selection.displayUsageRows.first
        return HStack(spacing: 4) {
            if (usage?.p5 ?? 0.42) >= 0 { einkGauge("5h", fill: CGFloat(usage?.p5 ?? 0.42)) }
            if usage?.secondaryLabel != "MCP", (usage?.p7 ?? 0.68) >= 0 { einkGauge("7d", fill: CGFloat(usage?.p7 ?? 0.68)) }
        }
    }

    private func einkGauge(_ label: String, fill: CGFloat) -> some View {
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2)
                .stroke(Color.black.opacity(0.32), lineWidth: 0.8)
            RoundedRectangle(cornerRadius: 2)
                .fill((isColor ? TerrariumHUD.ledGreen : Color.black).opacity(isColor ? 0.55 : 0.18))
                .frame(width: 42 * fill)
            Text(label)
                .font(.system(size: 7, weight: .bold, design: .monospaced))
                .foregroundStyle(.black.opacity(0.62))
                .padding(.leading, 4)
        }
        .frame(width: 42, height: 12)
    }
}

// MARK: - ESP32 terrarium scene (shared across boards)
//
// Real ESP32 firmware renders a full terrarium (deepSea → shallowWater
// gradient, creatures swimming, kelp, particles) with a HUD bar at the
// bottom carrying the AgentDeck wordmark + session name on the left and
// 5h / 7d water-fill gauges on the right. See esp32/src/ui/widgets/
// hud_bar.cpp for the reference layout and esp32/src/ui/terrarium/* for
// the scene renderer. We don't port the LVGL renderer — instead we
// reproduce its visual signature (water gradient, subtle creature
// silhouette, HUD bar with gauges) so the preview reads as the same
// artifact the user will see on-device.

private struct Esp32TerrariumScene<Content: View>: View {
    let selection: DevicePreviewSelection
    let isRound: Bool
    let hudHeight: CGFloat
    @ViewBuilder let overlay: () -> Content

    init(
        selection: DevicePreviewSelection,
        isRound: Bool = false,
        hudHeight: CGFloat = 58,
        @ViewBuilder overlay: @escaping () -> Content = { EmptyView() }
    ) {
        self.selection = selection
        self.isRound = isRound
        self.hudHeight = hudHeight
        self.overlay = overlay
    }

    var body: some View {
        ZStack {
            // Water gradient background — the terrarium renderer's base layer.
            LinearGradient(
                colors: [TerrariumColors.deepSea, TerrariumColors.midWater, TerrariumColors.shallowWater],
                startPoint: .top,
                endPoint: .bottom
            )

            // Water surface highlight at y ≈ 14% — echoes the bright
            // caustic band the firmware draws just below the top edge.
            GeometryReader { geo in
                Rectangle()
                    .fill(
                        LinearGradient(
                            colors: [Color.white.opacity(0.0), Color.white.opacity(0.05), Color.white.opacity(0.0)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .frame(height: max(6, geo.size.height * 0.08))
                    .offset(y: geo.size.height * 0.12)
            }

            // Swimming creatures — ONE PER SESSION, like the real terrarium
            // (each session spawns a creature; the old preview drew a single
            // creature regardless of session count). Deterministic spread so
            // the scene is stable frame-to-frame.
            GeometryReader { geo in
                let sessions = selection.displaySessions
                let base = min(geo.size.width, geo.size.height)
                ForEach(Array(sessions.enumerated()), id: \.offset) { index, session in
                    let fraction = CGFloat(index) / CGFloat(max(1, sessions.count))
                    PreviewCreatureGlyph(
                        agent: session.agent,
                        state: session.state,
                        size: base * (index == 0 ? 0.24 : 0.17)
                    )
                    .position(
                        x: geo.size.width * (0.30 + 0.45 * fraction),
                        y: geo.size.height * ((isRound ? 0.30 : 0.36) + (isRound ? 0.10 : 0.14) * CGFloat(index % 2))
                    )
                }
            }

            // Bottom HUD bar — matches hud_bar.cpp layout direction.
            // hudHeight <= 0 means the board has no HUD bar at all (TTGO's
            // metric panel replaces it) — skip entirely, a 0-height frame
            // still lets the bar's text overflow into the scene.
            if hudHeight > 0 {
                VStack {
                    Spacer()
                    Esp32HudBar(selection: selection, isRound: isRound)
                        .frame(height: hudHeight)
                }
            }

            overlay()
        }
    }
}

/// Mini HUD bar that mirrors the real firmware's bottom panel
/// (hud_bar.cpp, non-IPS10 boards): left side carries the AgentDeck
/// wordmark + accent underline + a per-session LIST (state dot ·
/// project); right side carries PROVIDER TANK GROUPS — a brand-coloured
/// "● CLAUDE" header over its 5h/7d water tanks, plus a "● CODEX" group
/// only when a Codex session is present (makeTankGroup). Values are
/// placeholders — the real firmware drives them from the usage relay.
private struct Esp32HudBar: View {
    let selection: DevicePreviewSelection
    let isRound: Bool

    var body: some View {
        if isRound {
            // Keep the bottom panel inside the circle's safe chord. Three
            // providers use two rows, matching the firmware's compact groups.
            let rows = selection.displayUsageRows
            VStack(spacing: 4) {
                if rows.count > 2, let first = rows.first { providerTanks(first) }
                HStack(alignment: .bottom, spacing: 6) {
                    ForEach(rows.count > 2 ? Array(rows.dropFirst()) : rows) { providerTanks($0) }
                }
            }
            .frame(width: 150)
            .padding(.bottom, 22)
        } else {
        HStack(alignment: .bottom, spacing: 10) {
            // Left panel: logo + underline + session list (lblSessions)
            VStack(alignment: .leading, spacing: 2) {
                Text("AgentDeck")
                    .font(.system(size: 11, weight: .heavy, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.text)
                Rectangle()
                    .fill(TerrariumColors.tetraNeon.opacity(0.55))
                    .frame(width: 46, height: 1)
                let sessions = selection.displaySessions
                if sessions.isEmpty {
                    Text("no sessions")
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext)
                } else {
                    ForEach(Array(sessions.prefix(3).enumerated()), id: \.offset) { _, session in
                        HStack(spacing: 4) {
                            PreviewStateDot(state: session.state, size: 5)
                            Text(session.projectName)
                                .font(.system(size: 8.5, design: .monospaced))
                                .foregroundStyle(TerrariumHUD.text.opacity(0.88))
                                .lineLimit(1)
                                .truncationMode(.tail)
                        }
                    }
                }
            }
            Spacer(minLength: 4)

            // Right panel: provider tank groups (brand header + 5h/7d tanks) —
            // real usage windows in live-follow mode, else the placeholders.
            HStack(alignment: .bottom, spacing: 10) {
                ForEach(selection.displayUsageRows) { row in
                    tankGroup(name: row.label, brand: SessionBrand.color(for: row.agentType),
                              p5: CGFloat(row.p5), p7: row.secondaryLabel == "MCP" ? -1 : CGFloat(row.p7))
                }
            }
        }
        .padding(.horizontal, isRound ? 30 : 10)
        .padding(.vertical, 6)
        .background(
            Rectangle()
                .fill(Color.black.opacity(isRound ? 0.0 : 0.35))
        )
        }
    }

    private func providerTanks(_ row: PreviewDisplayUsageRow) -> some View {
        tankGroup(name: row.label, brand: SessionBrand.color(for: row.agentType),
                  p5: CGFloat(row.p5), p7: row.secondaryLabel == "MCP" ? -1 : CGFloat(row.p7))
    }

    /// Provider tank group — port of makeTankGroup: "● NAME" brand header
    /// stacked over the provider's 5h/7d tanks.
    private func tankGroup(name: String, brand: Color, p5: CGFloat, p7: CGFloat) -> some View {
        VStack(spacing: 2) {
            HStack(spacing: 3) {
                Circle().fill(brand).frame(width: 5, height: 5)
                Text(name)
                    .font(.system(size: 7.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(brand)
            }
            HStack(spacing: 6) {
                if p5 >= 0 { waterGauge(period: "5h", percent: p5, single: p7 < 0) }
                if p7 >= 0 { waterGauge(period: "7d", percent: p7, single: p5 < 0) }
            }
        }
    }

    /// Water-fill gauge — mirrors the firmware's `createGauge`: glass
    /// background, bottom-aligned tinted fill, period label at top,
    /// percentage in the center.
    private func waterGauge(period: String, percent: CGFloat, single: Bool) -> some View {
        let size: CGFloat = isRound ? 30 : 36
        let color = UsageSeverity.color(Double(percent) * 100)
        return ZStack(alignment: .bottom) {
            RoundedRectangle(cornerRadius: 5)
                .fill(Color.white.opacity(0.12))
                .overlay(
                    RoundedRectangle(cornerRadius: 5)
                        .stroke(Color.white.opacity(0.22), lineWidth: 0.5)
                )
            RoundedRectangle(cornerRadius: 5)
                .fill(color.opacity(0.20))
                .frame(height: size * percent)
            VStack(spacing: 0) {
                Text(period)
                    .font(.system(size: 8, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .padding(.top, 3)
                Spacer(minLength: 0)
                Text("\(Int(percent * 100))%")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundStyle(color)
                    .padding(.bottom, 3)
            }
        }
        .frame(width: size, height: size)
    }
}

// MARK: - ESP32 86Box (4" square, 480×480 ST7701 — wall-box form factor)

struct Esp3286BoxPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 10) {
            DeviceBezel(cornerRadius: 18, bezelWidth: 14, bezelColor: Color(white: 0.94)) {
                Esp32TerrariumScene(selection: selection, hudHeight: 52)
            }
            .frame(width: 260, height: 260)
            Text("ESP32 86Box • 4\" 480×480")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - ESP32 IPS 3.5" Landscape

struct Esp3235LandscapePreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 10) {
            DeviceBezel(cornerRadius: 14, bezelWidth: 10) {
                Esp32TerrariumScene(selection: selection)
            }
            // Real panel is 480×320 — keep the 1.5 aspect (was 400×240 = 1.67).
            .frame(width: 360, height: 240)
            Text("ESP32 IPS 3.5\" landscape • 480×320")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - ESP32 IPS 3.5" Portrait

struct Esp3235PortraitPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 10) {
            DeviceBezel(cornerRadius: 14, bezelWidth: 10) {
                Esp32TerrariumScene(selection: selection, hudHeight: 64)
            }
            .frame(width: 240, height: 360)
            Text("ESP32 IPS 3.5\" portrait")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - ESP32 Round AMOLED 1.8" (JC3636W518, 360×360)

struct Esp32RoundPreview: View {
    let selection: DevicePreviewSelection

    var body: some View {
        VStack(spacing: 10) {
            Esp32TerrariumScene(
                selection: selection,
                isRound: true,
                hudHeight: 106
            )
            .frame(width: 230, height: 230)
            .clipShape(Circle())
            .overlay(
                Circle()
                    .stroke(Color(white: 0.14), lineWidth: 10)
            )
            Text("ESP32 round AMOLED 1.8\" • 360×360")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - ESP32 TTGO T-Display 1.14" (135×240 portrait)
//
// The smallest LCD board. The firmware does NOT draw the shared HUD bar
// here — the no-PSRAM classic ESP32 renders the terrarium into a
// 135×160 buffer at the top, and the remaining 135×80 strip is the
// TTGO metric panel (ttgo_state.cpp): warm-brown background 0x2A1F14
// with the agent state, project, model and mini 5h/7d usage text.
// Preview scales the panel 1.5× so the text stays legible.

struct Esp32TtgoPreview: View {
    let selection: DevicePreviewSelection

    private let metricBg = Color(red: 0x2A / 255.0, green: 0x1F / 255.0, blue: 0x14 / 255.0)

    var body: some View {
        VStack(spacing: 10) {
            DeviceBezel(cornerRadius: 12, bezelWidth: 12, bezelColor: Color(white: 0.10)) {
                VStack(spacing: 0) {
                    // Terrarium in the top 135×160 slice — no HUD overlay.
                    Esp32TerrariumScene(selection: selection, hudHeight: 0) { EmptyView() }
                        .frame(height: 160 * 1.5)
                        .clipped()
                    ttgoMetricPanel
                        .frame(height: 80 * 1.5)
                }
            }
            .frame(width: 135 * 1.5, height: 240 * 1.5)
            Text("ESP32 TTGO T-Display • 135×240")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }

    /// TTGO metric panel — ttgo_state.cpp createMetricPanel: state (colored),
    /// project, model, then mini 5h/7d usage lines on 0x2A1F14.
    private var ttgoMetricPanel: some View {
        // Focused session (real in live-follow, else the synthesized primary) +
        // its provider's usage on the mini gauge line.
        let session = selection.displaySessions.first
        let state = session?.state ?? selection.state
        let agent = session?.agent ?? selection.agent
        let model = session?.modelName ?? (agent == .codex ? "gpt-5" : "opus-4-7")
        let usage = selection.displayUsageRows.first
        return VStack(alignment: .leading, spacing: 3) {
            Text(state.displayName.uppercased())
                .font(.system(size: 13, weight: .heavy, design: .monospaced))
                .foregroundStyle(StateColors.color(for: state.sessionStateStringForUI))
            Text(session?.projectName ?? "\(agent.displayName.lowercased())-project")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Color(red: 0xE2 / 255.0, green: 0xE8 / 255.0, blue: 0xF0 / 255.0))
                .lineLimit(1)
            Text(model)
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(Color(red: 0x94 / 255.0, green: 0xA3 / 255.0, blue: 0xB8 / 255.0))
            Spacer(minLength: 0)
            if let usage {
                Text([usage.p5 >= 0 ? "5h \(Int(usage.p5 * 100))%" : nil,
                      usage.secondaryLabel != "MCP" && usage.p7 >= 0 ? "7d \(Int(usage.p7 * 100))%" : nil].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(Color(red: 0x94 / 255.0, green: 0xA3 / 255.0, blue: 0xB8 / 255.0))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(metricBg)
    }
}

// MARK: - ESP32 IPS 10.1" (JC8012P4A1C, logical 1280×800 landscape)
//
// The largest LVGL board — an ESP32-P4 with a 10.1" MIPI-DSI panel
// (logical 1280×800 via PPA hardware rotation). The firmware does NOT
// render the aquarium terrarium here: the layout is the D1 tablet
// arrangement (hud_bar.cpp `BOARD_IPS10` + terrarium/office.cpp) —
//   • full-width top bar: brand mark + wordmark ("Deck" in cyan),
//     daemon status, Claude/Codex usage blocks on the right;
//   • left ~408px: the "office" sprite scene — dark-green carpet,
//     desk pods with room labels, agent workers with state bubbles and
//     a state legend chip bottom-left;
//   • right: the session-cards pane (tap a card → detail modal).
// The preview mirrors that structure at 0.45× scale.

struct Esp32Ips10Preview: View {
    let selection: DevicePreviewSelection

    // Firmware palette (hud_bar.cpp / office.cpp constants).
    private let topBarBg = Color(red: 0x07 / 255.0, green: 0x14 / 255.0, blue: 0x0F / 255.0)
    private let carpetA = Color(red: 0x17 / 255.0, green: 0x3A / 255.0, blue: 0x33 / 255.0)
    private let carpetEdge = Color(red: 0x0E / 255.0, green: 0x2A / 255.0, blue: 0x25 / 255.0)
    private let deskTop = Color(red: 0x34 / 255.0, green: 0x57 / 255.0, blue: 0x4F / 255.0)
    private let cardBg = Color(red: 0x0D / 255.0, green: 0x27 / 255.0, blue: 0x23 / 255.0)
    private let hudText = Color(red: 0xE2 / 255.0, green: 0xE8 / 255.0, blue: 0xF0 / 255.0)
    private let hudDim = Color(red: 0x94 / 255.0, green: 0xA3 / 255.0, blue: 0xB8 / 255.0)
    private let d1Cyan = Color(red: 0x3E / 255.0, green: 0xD6 / 255.0, blue: 0xE8 / 255.0)
    private let d1Amber = Color(red: 0xFF / 255.0, green: 0xA9 / 255.0, blue: 0x3D / 255.0)
    private let d1Idle = Color(red: 0x7A / 255.0, green: 0x8A / 255.0, blue: 0x9C / 255.0)

    private let scale: CGFloat = 0.45

    var body: some View {
        VStack(spacing: 10) {
            DeviceBezel(cornerRadius: 16, bezelWidth: 12, bezelColor: Color(white: 0.08)) {
                VStack(spacing: 0) {
                    // IPS10_TOPBAR_H = 56, IPS10_TERRARIUM_W = 408 (hud_bar.cpp).
                    topBar
                        .frame(height: 56 * scale)
                    HStack(spacing: 4) {
                        officeScene
                            .frame(width: 408 * scale)
                        cardsPane
                    }
                    .frame(maxHeight: .infinity)
                }
                .background(Color.black)
            }
            .frame(width: 1280 * scale, height: 800 * scale)
            Text("ESP32 IPS 10.1\" • 1280×800 (P4 + PPA rotate)")
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary)
        }
    }

    // Full-width D1 top bar: brand · daemon status · usage blocks.
    private var topBar: some View {
        HStack(spacing: 8) {
            AgentDeckLogo(size: 12, color: hudText)
            Text("\(Text("Agent").foregroundStyle(hudText))\(Text("Deck").foregroundStyle(d1Cyan))")
                .font(.system(size: 10, weight: .bold))
            Text(selection.state == .disconnected ? "daemon offline" : "daemon :9120")
                .font(.system(size: 7, design: .monospaced))
                .foregroundStyle(hudDim)
            Spacer(minLength: 4)
            // Real usage windows in live-follow mode, else the placeholders.
            ForEach(selection.displayUsageRows) { row in
                usageBlock(agentType: row.agentType, p5: CGFloat(row.p5), p7: CGFloat(row.p7), secondaryLabel: row.secondaryLabel)
            }
        }
        .padding(.horizontal, 10)
        .background(topBarBg)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color(red: 0x1B / 255.0, green: 0x3F / 255.0, blue: 0x39 / 255.0))
                .frame(height: 0.7)
        }
    }

    /// Compact per-agent usage block: brand glyph beside a 5H-over-7D column.
    private func usageBlock(agentType: String, p5: CGFloat, p7: CGFloat, secondaryLabel: String) -> some View {
        HStack(spacing: 4) {
            PreviewUsageMark(agentType: agentType, size: 11, color: SessionBrand.color(for: agentType))
            VStack(alignment: .leading, spacing: 1.5) {
                if p5 >= 0 { usageFill(label: "5H", pct: p5) }
                if p7 >= 0 { usageFill(label: secondaryLabel, pct: p7) }
            }
        }
    }

    private func usageFill(label: String, pct: CGFloat) -> some View {
        HStack(spacing: 3) {
            Text(label)
                .font(.system(size: 6, weight: .bold, design: .monospaced))
                .foregroundStyle(hudDim)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.12))
                Capsule().fill(d1Cyan.opacity(0.7)).frame(width: 34 * pct)
            }
            .frame(width: 34, height: 4)
            Text("\(Int(pct * 100))%")
                .font(.system(size: 6, design: .monospaced))
                .foregroundStyle(hudDim)
        }
    }

    // Left office scene — carpet + desk pods + agent workers + legend chip.
    private var officeScene: some View {
        ZStack(alignment: .bottomLeading) {
            carpetA
            VStack(spacing: 10) {
                ForEach(Array(selection.displaySessions.prefix(3).enumerated()), id: \.offset) { _, session in
                    officePod(session: session)
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            legendChip
                .padding(.leading, 6)
                .padding(.bottom, 5)
        }
        .overlay(
            Rectangle().stroke(carpetEdge, lineWidth: 1.5)
        )
        .clipped()
    }

    /// One project pod: desk slab + worker creature with a state bubble.
    private func officePod(session: PreviewDisplaySession) -> some View {
        let state = session.state
        return VStack(spacing: 2) {
            HStack(spacing: 8) {
                PreviewCreatureGlyph(agent: session.agent, state: state, size: 26)
                    .overlay(alignment: .topTrailing) {
                        Text(bubbleChar(for: state))
                            .font(.system(size: 8, weight: .heavy, design: .monospaced))
                            .foregroundStyle(bubbleColor(for: state))
                            .offset(x: 7, y: -5)
                    }
                RoundedRectangle(cornerRadius: 2)
                    .fill(deskTop)
                    .frame(width: 52, height: 12)
            }
            Text(session.projectName)
                .font(.system(size: 6.5, design: .monospaced))
                .foregroundStyle(Color(red: 0xF4 / 255.0, green: 0xF4 / 255.0, blue: 0xE8 / 255.0).opacity(0.8))
                .lineLimit(1)
        }
        .padding(6)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(carpetEdge.opacity(0.7))
        )
    }

    private func bubbleChar(for state: PixooPreviewState) -> String {
        switch state {
        case .awaitingPrompt: return "?"
        case .processing:     return "w"
        case .idle:           return "z"
        case .disconnected:   return "!"
        }
    }

    private func bubbleColor(for state: PixooPreviewState) -> Color {
        switch state {
        case .awaitingPrompt: return d1Amber
        case .processing:     return d1Cyan
        case .idle:           return d1Idle
        case .disconnected:   return Color(red: 1.0, green: 0x6B / 255.0, blue: 0x6B / 255.0)
        }
    }

    /// Bottom-left state legend chip (Awaiting / Working / Idle swatches).
    private var legendChip: some View {
        HStack(spacing: 8) {
            legendItem(color: d1Amber, label: "Awaiting")
            legendItem(color: d1Cyan, label: "Working")
            legendItem(color: d1Idle, label: "Idle")
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 4)
        .background(RoundedRectangle(cornerRadius: 5).fill(topBarBg.opacity(0.8)))
    }

    private func legendItem(color: Color, label: String) -> some View {
        HStack(spacing: 3) {
            Circle().fill(color).frame(width: 5, height: 5)
            Text(label)
                .font(.system(size: 6.5, design: .monospaced))
                .foregroundStyle(hudDim)
        }
    }

    // Right session-cards pane (D1 mosaic).
    private var cardsPane: some View {
        let sessions = selection.displaySessions
        return VStack(spacing: 6) {
            if sessions.isEmpty {
                Text("no active sessions")
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundStyle(hudDim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ForEach(Array(sessions.enumerated()), id: \.offset) { _, session in
                    sessionCard(session: session)
                }
                Spacer(minLength: 0)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func sessionCard(session: PreviewDisplaySession) -> some View {
        let state = session.state
        let accent = bubbleColor(for: state)
        return HStack(spacing: 8) {
            RoundedRectangle(cornerRadius: 1.5)
                .fill(accent)
                .frame(width: 3)
            PreviewCreatureGlyph(agent: session.agent, state: state, size: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.projectName)
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(hudText)
                    .lineLimit(1)
                // Live-follow adds the real model line; manual stays state-only.
                Text(session.modelName ?? state.displayName.uppercased())
                    .font(.system(size: 6.5, weight: .semibold, design: .monospaced))
                    .foregroundStyle(session.modelName != nil ? hudDim : accent)
            }
            Spacer(minLength: 0)
        }
        .padding(7)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(cardBg)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(state == .awaitingPrompt ? d1Amber.opacity(0.7) : hudDim.opacity(0.25), lineWidth: 1)
                )
        )
    }
}
