// DevicePreviewScreen.swift — Capstone window for the Device Preview track.
//
// Layout:
//   - Sidebar: grouped list of standalone device types across 6 categories
//     (17 in the App Store build, 20 when an external desktop bridge is active).
//   - Main canvas: the selected device's view, centered with a header + byline.
//   - Toolbar: Agent / State / Sessions pickers. A running animation clock
//     ticks `selection.animationFrame` forward twice per second so dynamic
//     devices (Stream Deck+ slot, TUI terrarium) visibly animate.
//
// This window opens via:
//   - macOS menu bar: "Preview Devices" button in ControlTowerPanel.
//   - First launch: the device-empty banner nudges the user here.
//   - `openWindow(id: "device-preview")` from anywhere else.
//   - iOS/iPadOS no-Mac recovery: "Explore without a Mac".
//
// The macOS catalog is a dedicated window. iOS/iPadOS presents the same
// synthetic previews as a sheet from the disconnected state, giving users and
// App Review a useful local path even before a Mac is paired.

import SwiftUI

// MARK: - Screen

struct DevicePreviewScreen: View {
    @State private var selection = DevicePreviewSelection(
        agent: .claudeCode,
        state: .processing,
        sessionCount: 1,
        device: .streamDeckPlus
    )

    /// Live-follow mode: derive agent/state/session-count from the daemon's
    /// aggregate state instead of the toolbar pickers, so each preview shows
    /// (approximately) what that device is rendering RIGHT NOW. First step
    /// toward per-device emulators — the mapping is coarse (the preview input
    /// model is agent+state+count), but it turns the catalog into a live
    /// mirror for QA without hardware.
    @State private var followLive = false
    @EnvironmentObject private var stateHolder: AgentStateHolder

    /// Mark first-view-seen. The window is the only caller that should write
    /// this flag — don't leak the side-effect into subviews.
    @EnvironmentObject private var preferences: AppPreferences

    private let sessionCountOptions: [Int] = [0, 1, 2, 4]

#if os(macOS)
    /// External CLI daemon presence gates the desktop-bridge-only device
    /// previews. When absent, the picker hides Android / e-ink / TC001
    /// rows so the catalog reflects only what this app can drive itself.
    @EnvironmentObject private var daemonService: DaemonService

    private var visibleDevices: [PreviewDevice] {
        if daemonService.isUsingExternalDaemon {
            return PreviewDevice.allCases
        }
        return PreviewDevice.allCases.filter { !$0.requiresDesktopBridge }
    }
#else
    private var visibleDevices: [PreviewDevice] {
        PreviewDevice.allCases.filter { !$0.requiresDesktopBridge }
    }
#endif

    var body: some View {
        #if os(macOS)
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 320)
                .scrollContentBackground(.hidden)
        } detail: {
            detail
        }
        .frame(minWidth: 900, minHeight: 600)
        .aquariumSurface()
        .onAppear {
            if !preferences.hasSeenDevicePreview {
                preferences.hasSeenDevicePreview = true
            }
            let pool = visibleDevices
            if !pool.contains(selection.device), let first = pool.first {
                selection.device = first
            }
        }
        #else
        // iPad gets a compact two-card studio rather than the macOS toolbar
        // squeezed into one horizontal row. ViewThatFits stacks the same
        // cards on iPhone without maintaining a second interaction model.
        iosDetail
        .aquariumSurface()
        .onAppear {
            if !preferences.hasSeenDevicePreview {
                preferences.hasSeenDevicePreview = true
            }
            let pool = visibleDevices
            if !pool.contains(selection.device), let first = pool.first {
                selection.device = first
            }
        }
        #endif
    }

#if os(iOS)
    // MARK: - iPhone / iPad detail

    private var iosDetail: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: DesignTokens.Spacing.s5) {
                    Label("Interactive preview · no hardware required", systemImage: "sparkles")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(TerrariumHUD.subtext)

                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .top, spacing: DesignTokens.Spacing.s5) {
                            iosSetupCard
                                .frame(width: 250)
                            iosPreviewCard
                                .frame(minWidth: 340)
                        }

                        VStack(spacing: DesignTokens.Spacing.s5) {
                            iosSetupCard
                            iosPreviewCard
                        }
                    }
                }
                .frame(maxWidth: 980, alignment: .leading)
                .padding(.horizontal, geometry.size.width >= 600 ? 20 : 16)
                .padding(.top, DesignTokens.Spacing.s4)
                .padding(.bottom, DesignTokens.Spacing.s8)
                .frame(maxWidth: .infinity)
            }
        }
    }

    private var iosSetupCard: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Spacing.s5) {
            VStack(alignment: .leading, spacing: DesignTokens.Spacing.s1) {
                Text("PREVIEW SETUP")
                    .font(HUDFont.sectionHeader)
                    .kerning(1.2)
                    .foregroundStyle(DesignTokens.UI.cyan)
                Text("Choose a device and sample activity.")
                    .font(.subheadline)
                    .foregroundStyle(TerrariumHUD.subtext)
            }

            Divider()
                .overlay(DesignTokens.Ink.s500.opacity(0.5))

            iosMenuField(
                title: "Device",
                systemImage: "rectangle.3.group",
                selection: $selection.device
            ) {
                ForEach(visibleDevices) { device in
                    Text(device.displayName).tag(device)
                }
            }

            iosMenuField(
                title: "Agent",
                systemImage: "cpu",
                selection: $selection.agent
            ) {
                ForEach(PixooPreviewAgent.allCases) { agent in
                    Text(agent.displayName).tag(agent)
                }
            }
            .disabled(followLive)

            iosMenuField(
                title: "State",
                systemImage: "waveform.path.ecg",
                selection: $selection.state
            ) {
                ForEach(PixooPreviewState.allCases) { state in
                    Text(state.displayName).tag(state)
                }
            }
            .disabled(followLive)

            VStack(alignment: .leading, spacing: DesignTokens.Spacing.s2) {
                Label("Sessions", systemImage: "square.stack.3d.up")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(TerrariumHUD.subtext)

                Picker("Sessions", selection: $selection.sessionCount) {
                    ForEach(sessionCountOptions, id: \.self) { count in
                        Text("\(count)").tag(count)
                    }
                }
                .pickerStyle(.segmented)
                .disabled(followLive)
            }

            if stateHolder.state.bridgeConnected {
                Toggle(isOn: $followLive) {
                    Label("Follow live activity", systemImage: "dot.radiowaves.left.and.right")
                        .font(.subheadline.weight(.medium))
                }
                .tint(DesignTokens.Kelp.s500)
            } else {
                Label("Offline sample", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(DesignTokens.Kelp.s300)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, DesignTokens.Spacing.s3)
                    .frame(minHeight: 42)
                    .background(
                        DesignTokens.Kelp.s700.opacity(0.24),
                        in: RoundedRectangle(cornerRadius: DesignTokens.Radius.xl, style: .continuous)
                    )
            }
        }
        .padding(DesignTokens.Spacing.s5)
        .background(
            DesignTokens.Ink.s800.opacity(0.88),
            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.xxxxl, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: DesignTokens.Radius.xxxxl, style: .continuous)
                .stroke(DesignTokens.Ink.s500.opacity(0.55), lineWidth: 1)
        }
    }

    private var iosPreviewCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: DesignTokens.Spacing.s3) {
                VStack(alignment: .leading, spacing: DesignTokens.Spacing.s1) {
                    Text(selection.device.displayName)
                        .font(.title3.weight(.bold))
                        .foregroundStyle(TerrariumHUD.text)
                    Text(selection.device.byline)
                        .font(.caption)
                        .foregroundStyle(TerrariumHUD.subtext)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: DesignTokens.Spacing.s2)

                Text(selection.state.displayName.uppercased())
                    .font(.caption2.weight(.bold))
                    .kerning(0.8)
                    .foregroundStyle(previewStateColor)
                    .padding(.horizontal, DesignTokens.Spacing.s3)
                    .padding(.vertical, 7)
                    .background(
                        previewStateColor.opacity(0.13),
                        in: Capsule()
                    )
            }
            .padding(DesignTokens.Spacing.s5)

            Divider()
                .overlay(DesignTokens.Ink.s500.opacity(0.5))

            TimelineView(.animation(minimumInterval: 0.1, paused: false)) { context in
                deviceBody(animationFrame: frameFromTimeline(context.date))
                    .scaleEffect(iosPreviewScale)
            }
            .frame(maxWidth: .infinity, minHeight: 430)
            .padding(DesignTokens.Spacing.s5)

            Text("Change any option to see the device update instantly.")
                .font(.caption)
                .foregroundStyle(TerrariumHUD.subtext)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.horizontal, DesignTokens.Spacing.s5)
                .padding(.bottom, DesignTokens.Spacing.s5)
        }
        .background(
            DesignTokens.Ink.s900.opacity(0.72),
            in: RoundedRectangle(cornerRadius: DesignTokens.Radius.xxxxl, style: .continuous)
        )
        .overlay {
            RoundedRectangle(cornerRadius: DesignTokens.Radius.xxxxl, style: .continuous)
                .stroke(DesignTokens.UI.cyan.opacity(0.18), lineWidth: 1)
        }
    }

    private func iosMenuField<Value: Hashable, Options: View>(
        title: String,
        systemImage: String,
        selection: Binding<Value>,
        @ViewBuilder options: () -> Options
    ) -> some View {
        VStack(alignment: .leading, spacing: DesignTokens.Spacing.s2) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(TerrariumHUD.subtext)

            Picker(title, selection: selection, content: options)
                .pickerStyle(.menu)
                .labelsHidden()
                .tint(DesignTokens.UI.cyan)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, DesignTokens.Spacing.s3)
                .frame(minHeight: 44)
                .background(
                    DesignTokens.Ink.s900.opacity(0.58),
                    in: RoundedRectangle(cornerRadius: DesignTokens.Radius.xl, style: .continuous)
                )
        }
    }

    private var iosPreviewScale: CGFloat {
        switch selection.device {
        case .streamDeckKey:  return 1.65
        case .streamDeckPlus: return 1.28
        case .d200hKey:       return 1.25
        default:              return 1
        }
    }

    private var previewStateColor: Color {
        switch selection.state {
        case .processing:     return DesignTokens.Status.processing
        case .awaitingPrompt: return DesignTokens.Status.awaiting
        case .idle, .disconnected: return DesignTokens.Status.idle
        }
    }
#endif

    // MARK: - Sidebar

    private var sidebar: some View {
        let pool = visibleDevices
        return List(selection: Binding<PreviewDevice?>(
            get: { selection.device },
            set: { new in if let new { selection.device = new } }
        )) {
            ForEach(PreviewDevice.Category.allCases) { cat in
                let entries = pool.filter { $0.category == cat }
                if !entries.isEmpty {
                    Section(cat.displayName) {
                        ForEach(entries) { dev in
                            Text(dev.displayName)
                                .tag(dev)
                                .listRowBackground(Color.clear)
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
#if os(macOS)
        .onChange(of: daemonService.isUsingExternalDaemon) { _, _ in
            if !pool.contains(selection.device), let first = pool.first {
                selection.device = first
            }
        }
#endif
    }

    // MARK: - Detail

    private var detail: some View {
        VStack(alignment: .leading, spacing: 0) {
            toolbar
            Divider()
            ScrollView {
                VStack(spacing: 24) {
                    // Tagline
                    Text("Hardware optional. Here's what your agents look like on each device.")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    // Device header
                    VStack(alignment: .leading, spacing: 4) {
                        Text(selection.device.displayName)
                            .font(.system(size: 22, weight: .bold))
                        Text(selection.device.byline)
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    // The device itself
                    TimelineView(.animation(minimumInterval: 0.1, paused: false)) { context in
                        deviceBody(animationFrame: frameFromTimeline(context.date))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                }
                .padding(24)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // Detail stays transparent — aquariumSurface paints the window.
            // A translucent dark veil keeps the preview area subtly distinct
            // from the sidebar without interrupting the gradient.
            .background(Color.black.opacity(0.18))
        }
    }

    // MARK: - Toolbar

    @ViewBuilder
    private var toolbar: some View {
        #if os(iOS)
        ScrollView(.horizontal, showsIndicators: false) {
            toolbarControls
                .frame(minWidth: 720)
        }
        #else
        toolbarControls
        #endif
    }

    private var toolbarControls: some View {
        HStack(spacing: 16) {
            #if os(iOS)
            Picker("Device", selection: $selection.device) {
                ForEach(visibleDevices) { device in
                    Text(device.displayName).tag(device)
                }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: 190)
            #endif

            Picker("Agent", selection: $selection.agent) {
                ForEach(PixooPreviewAgent.allCases) { agent in
                    Text(agent.displayName).tag(agent)
                }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: 180)
            .disabled(followLive)

            Picker("State", selection: $selection.state) {
                ForEach(PixooPreviewState.allCases) { state in
                    Text(state.displayName).tag(state)
                }
            }
            .pickerStyle(.menu)
            .frame(maxWidth: 180)
            .disabled(followLive)

            #if os(iOS)
            Text("Sessions")
                .font(.caption)
                .foregroundStyle(.secondary)
            #endif
            Picker("Sessions", selection: $selection.sessionCount) {
                ForEach(sessionCountOptions, id: \.self) { n in
                    Text("\(n)").tag(n)
                }
            }
            .pickerStyle(.segmented)
            .frame(maxWidth: 200)
            .disabled(followLive)

            Spacer()

            // Live-follow: mirror the daemon's current sessions instead of
            // the synthetic picker state.
            Toggle(isOn: $followLive) {
                Label("Live", systemImage: "dot.radiowaves.left.and.right")
            }
            .toggleStyle(.button)
            .help("Follow the live daemon state — previews mirror what devices show right now")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - Device dispatch

    @ViewBuilder
    private func deviceBody(animationFrame: Int) -> some View {
        // Merge the toolbar selection (or, in live-follow mode, the daemon's
        // aggregate state) with the animation frame so each per-device view
        // receives a single, coherent DevicePreviewSelection.
        let inputs = followLive ? Self.liveSelectionInputs(from: stateHolder.state) : nil
        let live = DevicePreviewSelection(
            agent: inputs?.agent ?? selection.agent,
            state: inputs?.state ?? selection.state,
            sessionCount: inputs?.sessionCount ?? selection.sessionCount,
            device: selection.device,
            animationFrame: animationFrame,
            // Rich per-session/usage snapshot for the emulator-grade previews
            // (D200H etc.). Only attached in live-follow mode; the coarse
            // agent/state/count above stays as the fallback for previews that
            // don't consume it yet.
            live: followLive ? LivePreviewData.from(stateHolder.state) : nil
        )

        switch selection.device {
        case .streamDeckKey:     StreamDeckKeyPreview(selection: live)
        case .streamDeckPlus:    StreamDeckPlusPreview(selection: live)
        case .d200hKey:          D200HKeyPreview(selection: live)
        case .d200hDeck:         D200HDeckPreview(selection: live)
        case .iPadLandscape:     IPadLandscapePreview(selection: live)
        case .androidTablet:     AndroidTabletPreview(selection: live)
        case .einkMono:          EinkMonoPreview(selection: live)
        case .einkColor:         EinkColorPreview(selection: live)
        case .inkDeck:           InkDeckPreview(selection: live)
        case .esp32_86box:       Esp3286BoxPreview(selection: live)
        case .esp32_35Landscape: Esp3235LandscapePreview(selection: live)
        case .esp32_35Portrait:  Esp3235PortraitPreview(selection: live)
        case .esp32Round:        Esp32RoundPreview(selection: live)
        case .esp32Ttgo:         Esp32TtgoPreview(selection: live)
        case .esp32Ips10:        Esp32Ips10Preview(selection: live)
        case .pixoo64:           Pixoo64Preview(selection: live)
        case .ulanziMatrix:      UlanziMatrixPreview(selection: live)
        case .timeboxMini:       TimeboxMiniPreview(selection: live)
        case .iDotMatrix:        IDotMatrixPreview(selection: live)
        case .terminalTerrarium: TerminalTerrariumPreview(selection: live)
        }
    }

    /// Convert a Date tick into a monotonic integer animation frame. We use
    /// seconds * 10 so Canvas / SessionSlotView animations feel smooth but
    /// don't burn CPU — the animations internally are cheap (angle/sin).
    private func frameFromTimeline(_ date: Date) -> Int {
        Int(date.timeIntervalSinceReferenceDate * 10)
    }

    // MARK: - Live-follow mapping

    /// Coarse daemon-state → preview-selection mapping for live-follow mode.
    /// Awaiting wins over processing (attention beats motion — same priority
    /// every physical surface uses); session count clamps to the preview's
    /// supported {0, 1, 2, 4} buckets.
    static func liveSelectionInputs(
        from state: DashboardState
    ) -> (agent: PixooPreviewAgent, state: PixooPreviewState, sessionCount: Int) {
        let alive = state.siblingSessions.filter(\.alive)
        guard state.bridgeConnected else { return (.claudeCode, .disconnected, 0) }

        let agentType = state.agentType ?? alive.first?.agentType
        let agent: PixooPreviewAgent
        switch agentType {
        case "codex-cli", "codex-app": agent = .codex
        case "opencode":               agent = .opencode
        case "openclaw":               agent = .openclaw
        case "antigravity":            agent = .antigravity
        default:                       agent = .claudeCode
        }

        let anyAwaiting = state.state.isAwaiting
            || alive.contains { AgentConnectionState(rawValue: $0.state ?? "")?.isAwaiting == true }
        let anyProcessing = state.state == .processing
            || alive.contains { $0.state == "processing" }
        let previewState: PixooPreviewState = anyAwaiting
            ? .awaitingPrompt
            : (anyProcessing ? .processing : .idle)

        let count: Int
        switch alive.count {
        case 0, 1, 2: count = alive.count
        case 3:       count = 2
        default:      count = 4
        }
        return (agent, previewState, count)
    }
}

#if DEBUG
#Preview("Device preview") {
    DevicePreviewScreen()
        .environmentObject(AppPreferences.shared)
        .environmentObject(AgentStateHolder())
        .frame(width: 1100, height: 760)
}
#endif
