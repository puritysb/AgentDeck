// TopologyRail.swift — Right-rail topology visualization for the dashboard HUD
//
// Replaces the previous `TankStatusPanel` + `DeviceDiagnosticPanel` stack with a
// single top-to-bottom flow:
//
//      ┌─ UPSTREAM ─────────────┐
//      │ ● Claude  · OAuth      │
//      │   [▓▓▓▓░░ 62%  2h14]🦑│  ← rate gauge + consumer creature dots
//      │ ● OpenClaw :18789  🦀  │
//      │ ● MLX · Qwen3.5-30B    │
//      │ ○ Ollama · stopped     │
//      ├────────────────────────┤
//      │      ▼                 │
//      │  ⎔ AgentDeck :9120     │  ← hub node (stacked-deck mark, neon cyan)
//      │      ▼                 │
//      ├─ DOWNSTREAM ───────────┤
//      │ ● Stream Deck+  8 keys │
//      │ ● D200H         14 keys│
//      │ ● Pixoo64       64×64  │
//      │ ◐ ESP32         reconn │
//      └────────────────────────┘
//
// Reads as "sessions pull capacity from upstream providers, flow through the
// AgentDeck hub, and are dispatched to downstream devices." Preserves the
// terrarium dark-glass HUD palette (`TerrariumHUD.*`) so it sits on top of the
// aquarium without clashing.

import SwiftUI
#if !os(macOS)
import UIKit
#endif

struct TopologyRail: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    #if os(macOS)
    @EnvironmentObject private var daemonService: DaemonService
    @EnvironmentObject private var preferences: AppPreferences
    #endif
    @State private var hubPulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionHeader("UPSTREAM")
            upstreamRows
            hubZone
            sectionHeader("DOWNSTREAM")
            downstreamRows
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(TerrariumHUD.bg, in: RoundedRectangle(cornerRadius: 8))
        .opacity(stateHolder.state.bridgeConnected ? 1.0 : 0.6)
    }

    // MARK: - Header / hub

    private func sectionHeader(_ title: String) -> some View {
        HStack(spacing: 4) {
            Text(title)
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .kerning(1.4)
                .foregroundStyle(TerrariumHUD.subtext)
            Rectangle()
                .fill(TerrariumHUD.tetraNeon.opacity(0.25))
                .frame(height: 0.5)
        }
        .padding(.bottom, 4)
    }

    private var hubZone: some View {
        hubRow
            .padding(.vertical, 6)
    }

    private var hubRow: some View {
        let visual = hubVisualState
        let glowOpacity = visual == .awaiting ? (hubPulse ? 0.58 : 0.18) : visual.glowOpacity
        return HStack(spacing: 6) {
            AgentDeckLogo(size: 16, color: visual.accent)
            Text("AgentDeck")
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(TerrariumHUD.text)
            Text(":\(daemonPortText)")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(TerrariumColors.midWater.opacity(visual.fillOpacity))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 7)
                .stroke(visual.accent.opacity(visual.borderOpacity), lineWidth: 1)
        )
        .shadow(color: visual.accent.opacity(glowOpacity), radius: visual.shadowRadius)
        .onAppear {
            withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
                hubPulse = true
            }
        }
    }

    private enum HubVisualState {
        case offline, live, active, awaiting

        var accent: Color {
            switch self {
            case .offline: return TerrariumHUD.subtext.opacity(0.55)
            case .live, .active: return TerrariumHUD.tetraNeon
            case .awaiting: return TerrariumHUD.ledAmber
            }
        }

        var fillOpacity: Double {
            switch self {
            case .offline: return 0.36
            case .live: return 0.68
            case .active, .awaiting: return 0.78
            }
        }

        var borderOpacity: Double {
            switch self {
            case .offline: return 0.16
            case .live: return 0.42
            case .active: return 0.64
            case .awaiting: return 0.78
            }
        }

        var glowOpacity: Double {
            switch self {
            case .offline: return 0.0
            case .live: return 0.20
            case .active: return 0.34
            case .awaiting: return 0.58
            }
        }

        var shadowRadius: CGFloat {
            switch self {
            case .offline: return 0
            case .live: return 5
            case .active: return 7
            case .awaiting: return 9
            }
        }
    }

    private var hubVisualState: HubVisualState {
        guard stateHolder.state.bridgeConnected else { return .offline }
        if stateHolder.state.state.isAwaiting ||
            stateHolder.state.siblingSessions.contains(where: { AgentConnectionState(rawValue: $0.state ?? "")?.isAwaiting == true }) {
            return .awaiting
        }
        if stateHolder.state.state == .processing ||
            stateHolder.state.siblingSessions.contains(where: { $0.state == "processing" }) {
            return .active
        }
        return .live
    }

    /// Hub port surfaces in descending order of trust: explicit daemonService
    /// port (populated when the Swift daemon is in-process) is unavailable
    /// from this view (daemonService is only exposed to the menubar panel),
    /// so we fall back to the state-level session port when we have one.
    private var daemonPortText: String {
        if let port = stateHolder.state.daemonPort, port > 0 {
            return String(port)
        }
        if let url = stateHolder.connection.url,
           let parsed = URL(string: url),
           let port = parsed.port {
            return String(port)
        }
        return String(AppPreferences.defaultDaemonPort)
    }

    // MARK: - Upstream rows

    private var upstreamRows: some View {
        VStack(alignment: .leading, spacing: 5) {
            claudeRow
            openClawRow
            mlxRow
            ollamaRow
            antigravityRow
            // `showSubscriptionsSection` lives in the macOS-only Settings
            // "Tank Status Sections" group; on iOS there is no toggle UI, so
            // surface the footer whenever data is present (matches behaviour
            // before the toggle was wired up).
            #if os(macOS)
            let subscriptionsAllowed = preferences.showSubscriptionsSection
            #else
            let subscriptionsAllowed = true
            #endif
            if subscriptionsAllowed && !stateHolder.state.subscriptions.isEmpty {
                subscriptionsFooter
            }
        }
    }

    /// Subtitles carry real info (model lists, plan names) — the LED dot
    /// already conveys status, so text like "OAuth" / "Gateway" is
    /// redundant chrome and gets dropped. Only surface a status string as
    /// the subtitle when there's no better content to show (e.g. Claude
    /// isn't connected yet → "Not connected"; OpenClaw waiting for auth →
    /// short reason from `gatewayAuthStatus`).

    /// Which provider "owns" the current `modelCatalog`. The catalog is
    /// published by the primary session's state_update — it contains the
    /// models visible to THAT session only, so we must gate catalog-backed
    /// subtitles on the primary agentType or we'll mislabel models under
    /// the wrong row. Bug caught when `claude-opus` rendered under the
    /// "OpenClaw" row because `openClawDisplayLines` was reading a Claude
    /// session's catalog.
    ///
    /// Conservative mapping — only the two agent types we know ship a
    /// provider-scoped catalog. Codex / OpenCode may or may not publish
    /// their model list via the same field; treat them as unknown rather
    /// than risk mis-attribution.
    private var catalogOwner: ProviderKey {
        switch stateHolder.state.agentType {
        case "claude-code": return .claude
        case "openclaw":    return .openclaw
        default:            return .unknown
        }
    }

    private var claudeRow: some View {
        #if os(macOS)
        let hooksOn = preferences.hooksInstalled
        #else
        let hooksOn = false
        #endif
        let base = ProviderRailEvaluator.claude(
            state: stateHolder.state,
            hooksInstalled: hooksOn
        )
        // Only read `modelCatalog` here when the primary session is a
        // Claude session — otherwise the catalog belongs to some other
        // provider and spilling it into the Claude row is actively wrong.
        let claudeModels: [String] = {
            guard catalogOwner == .claude else { return [] }
            return DashboardDataRules.sortedModelCatalog(stateHolder.state.modelCatalog)
                .filter(\.available)
                .map { shortClaudeModel($0.name) }
        }()
        let subtitle: String? = claudeModels.isEmpty
            ? base.subtitle
            : claudeModels.joined(separator: ", ")
        return ProviderRow(
            name: "Claude",
            status: base.status,
            subtitle: subtitle,
            rateLimits: rateLimitChips,
            consumers: consumerCreatures(for: .claude)
        )
    }

    private var openClawRow: some View {
        guard let base = ProviderRailEvaluator.openClaw(state: stateHolder.state) else {
            return AnyView(EmptyView())
        }
        // Same catalog-ownership gate as Claude — only surface the catalog
        // under OpenClaw when an OpenClaw-hosted session is primary.
        let lines: [String] = {
            guard catalogOwner == .openclaw else { return [] }
            return DashboardDataRules.openClawDisplayLines(stateHolder.state.modelCatalog)
        }()
        let subtitle: String? = lines.isEmpty
            ? base.subtitle
            : lines.joined(separator: ", ")
        return AnyView(
            ProviderRow(
                name: "OpenClaw",
                status: base.status,
                subtitle: subtitle,
                rateLimits: [],
                consumers: consumerCreatures(for: .openclaw)
            )
        )
    }

    private var mlxRow: some View {
        guard !stateHolder.state.mlxModels.isEmpty else { return AnyView(EmptyView()) }
        let selected = stateHolder.state.mlxModels.joined(separator: ", ")
        let extraCount = max(0, stateHolder.state.mlxModelCatalog.count - stateHolder.state.mlxModels.count)
        let subtitle = extraCount > 0 ? "\(selected) · +\(extraCount) available" : selected
        return AnyView(
            ProviderRow(
                name: "MLX",
                status: .ok,
                subtitle: subtitle,
                rateLimits: [],
                consumers: consumerCreatures(for: .mlx)
            )
        )
    }

    private var ollamaRow: some View {
        guard let ollama = stateHolder.state.ollamaStatus else { return AnyView(EmptyView()) }
        let status: LEDStatus = ollama.available ? .ok : .dim
        // Split installed models into chat vs embed. Embedding models
        // (bge-*, nomic-embed, bert family, …) never sit resident between
        // requests — Ollama pulls them per-call and unloads via keep_alive.
        // Framing them with a loaded/unloaded badge is misleading, so we
        // group them separately with the "always on-demand" semantics.
        let chat = ollama.models.filter { ($0.kind ?? "chat") != "embed" }
        let embed = ollama.models.filter { ($0.kind ?? "chat") == "embed" }

        let subtitle: String? = {
            guard ollama.available else { return "stopped" }
            if chat.isEmpty && embed.isEmpty { return "installed, no models" }

            var lines: [String] = []
            if !chat.isEmpty {
                let names = chat.map { m in
                    m.sizeVram > 0 ? "\(m.name) (loaded)" : m.name
                }.joined(separator: ", ")
                lines.append("Chat: \(names)")
            }
            if !embed.isEmpty {
                lines.append("Embed: \(embed.map(\.name).joined(separator: ", "))")
            }
            return lines.joined(separator: "\n")
        }()

        return AnyView(
            ProviderRow(
                name: "Ollama",
                status: status,
                subtitle: subtitle,
                rateLimits: [],
                consumers: consumerCreatures(for: .ollama)
            )
        )
    }

    /// Antigravity is a Google-hosted model product — when the bridge
    /// surfaces an active plan, it belongs in the upstream rail alongside
    /// Claude/OpenClaw/MLX/Ollama. Hidden when `planName` is nil or blank.
    private var antigravityRow: some View {
        guard let status = stateHolder.state.antigravityStatus,
              let plan = status.planName, !plan.isEmpty else {
            return AnyView(EmptyView())
        }
        return AnyView(
            ProviderRow(
                name: "Antigravity",
                status: .ok,
                subtitle: plan,
                rateLimits: [],
                consumers: []  // no session → antigravity mapping yet
            )
        )
    }

    /// Strip long Claude model prefixes/date suffixes so the compact
    /// subtitle row can fit 3 model names horizontally.
    private func shortClaudeModel(_ name: String) -> String {
        var s = name
        if s.hasPrefix("claude-") { s = String(s.dropFirst("claude-".count)) }
        if let r = s.range(of: #"-\d{8}$"#, options: .regularExpression) {
            s = String(s[s.startIndex..<r.lowerBound])
        }
        return s
    }

    private var subscriptionsFooter: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("SUBSCRIPTIONS")
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .kerning(0.8)
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.8))
            ForEach(Array(stateHolder.state.subscriptions.enumerated()), id: \.offset) { _, sub in
                HStack(spacing: 4) {
                    Text(sub.name)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.text)
                    let trailing = Self.subscriptionTrailing(for: sub.until, now: Date())
                    if let trailing {
                        Spacer(minLength: 4)
                        Text(trailing.text)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(trailing.expired ? TerrariumHUD.ledAmber : TerrariumHUD.subtext)
                    }
                }
            }
        }
        .padding(.top, 4)
    }

    /// Resolve what (if anything) sits to the right of the subscription
    /// name. Codex writes `chatgpt_subscription_active_until` once at login
    /// and never refreshes it on auto-renewal, so a past date here is the
    /// common case after a few months — surface it as "renewal needed"
    /// instead of hiding the row silently. `nil` means "no trailing text"
    /// (the subscription has no `until` field at all, e.g. Claude).
    static func subscriptionTrailing(for until: String?, now: Date) -> (text: String, expired: Bool)? {
        guard let until, !until.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        guard let parsed = parseUntilDate(until) else {
            return ("renewal needed", true)
        }
        if parsed > now {
            return (formatShortDate(until), false)
        }
        return ("renewal needed", true)
    }

    private static func formatShortDate(_ input: String) -> String {
        guard let date = parseUntilDate(input) else { return input }
        let fmt = DateFormatter()
        fmt.dateFormat = "MMM d"
        return fmt.string(from: date)
    }

    // MARK: - Downstream rows
    //
    // Behaviour across build variants:
    //
    //   * App Store build — ADB is status-only: the in-process daemon never
    //     spawns `adb` (Apple 2.5.2) and its stub snapshot stays
    //     `available=false` with no devices, so no Android rows render.
    //     D200H / Pixoo / ESP32-serial all run: `device.usb` and
    //     `device.serial` entitlements are granted, and serial I/O + Wi-Fi
    //     provisioning to ESP32 go through direct FileHandle writes
    //     (no Process()).
    //
    //   * Node CLI / unsigned dev build — every module runs, including
    //     ADB, so Android / Ulanzi TC001 devices become visible too.

    /// True when at least one downstream module is going to render a row.
    /// Computed up-front so the empty-state placeholder only appears when
    /// nothing real is present.
    private var hasAnyDownstreamRow: Bool {
        guard let health = stateHolder.state.moduleHealth else { return false }
        if let adb = health.adb, (adb.available || !adb.devices.isEmpty || adb.lastError != nil) {
            return true
        }
        if health.d200h != nil { return true }
        if let pixoo = health.pixoo, pixoo.configuredDeviceCount > 0 { return true }
        if let timebox = health.timebox, timebox.configuredDeviceCount > 0 { return true }
        if let idm = health.idotmatrix, idm.configuredDeviceCount > 0 { return true }
        if let serial = health.serial, !serial.connectedBoards.isEmpty { return true }
        if let sd = health.streamDeck, !sd.devices.isEmpty { return true }
        return false
    }

    /// Downstream devices grouped by transport / physical family. The
    /// sub-headers ("USB HID", "Wi-Fi LED", …) make the taxonomy legible
    /// at a glance — previously every device was a flat row and a user
    /// with both a Pixoo and an AMOLED ESP32 couldn't tell at first
    /// glance which was which. Headers only appear when a section has
    /// content, so sparse setups stay tight.
    ///
    /// On iOS/iPadOS the dashboard is a pure client — physical devices
    /// like D200H/Pixoo/Stream Deck/ESP32 are managed by the daemon
    /// machine (typically a Mac), not by the iPhone/iPad running this
    /// view. Mirroring the daemon's full downstream rail there reads as
    /// "these devices are mine" which is wrong, so the iOS branch shows
    /// a single self-row instead.
    private var downstreamRows: some View {
        VStack(alignment: .leading, spacing: 8) {
            #if os(macOS)
            if let health = stateHolder.state.moduleHealth {
                streamDeckSection(health: health)
                usbHidSection(health: health)
                pixelDisplaySection(health: health)
                bleMatrixSection(health: health)
                usbSerialSection(health: health)
                androidSection(health: health)
            }
            if !hasAnyDownstreamRow {
                emptyDownstreamPlaceholder
            }
            #else
            DeviceRailRow(
                name: "This \(selfDeviceLabel)",
                status: .ok,
                detail: "dashboard client"
            )
            #endif
        }
    }

    #if !os(macOS)
    /// User-facing label for the current iOS/iPadOS device. Matches the
    /// Android side's "This Tablet" / "This Phone" pattern in
    /// `android/.../ui/monitor/TopologyRail.kt`.
    private var selfDeviceLabel: String {
        switch UIDevice.current.userInterfaceIdiom {
        case .pad: return "iPad"
        case .phone: return "iPhone"
        default: return "Device"
        }
    }
    #endif

    /// Stream Deck plugin-driven hardware. Only renders when the Elgato
    /// plugin has sent a `client_register` announcement — i.e. the plugin
    /// is installed, running via Elgato's Stream Deck app, and has at
    /// least one physical device paired. App Store build never probes
    /// for the plugin or suggests installing it; this section simply
    /// mirrors the devices the plugin volunteered.
    @ViewBuilder
    private func streamDeckSection(health: ModuleHealthState) -> some View {
        if let sd = health.streamDeck, !sd.devices.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                downstreamSubheader("Stream Deck")
                ForEach(sd.devices, id: \.id) { dev in
                    DeviceRailRow(
                        name: streamDeckDisplayName(for: dev),
                        status: .ok,
                        detail: streamDeckDetail(for: dev)
                    )
                }
            }
        }
    }

    private func streamDeckDisplayName(for dev: StreamDeckDeviceInfo) -> String {
        if !dev.name.isEmpty { return dev.name }
        switch dev.family {
        case "streamdeckplus":   return "Stream Deck+"
        case "streamdeck":       return "Stream Deck"
        case "streamdeckmini":   return "Stream Deck Mini"
        case "streamdeckxl":     return "Stream Deck XL"
        case "streamdeckpedal":  return "Stream Deck Pedal"
        default:                 return "Stream Deck"
        }
    }

    private func streamDeckDetail(for dev: StreamDeckDeviceInfo) -> String {
        if let c = dev.columns, let r = dev.rows, c > 0, r > 0 {
            return "\(c)×\(r) keys"
        }
        return dev.family ?? ""
    }

    @ViewBuilder
    private func usbHidSection(health: ModuleHealthState) -> some View {
        if let d200h = health.d200h {
            VStack(alignment: .leading, spacing: 3) {
                downstreamSubheader("USB HID")
                DeviceRailRow(
                    name: "D200H",
                    status: d200h.connected
                        ? .ok
                        : (d200h.managerOpened ? .warn : .dim),
                    detail: d200h.connected
                        ? "HID · 14 keys"
                        : (d200h.lastOpenError
                           ?? (d200h.usbEntitlementPresent ? "Disconnected" : "No USB entitlement"))
                )
            }
        }
    }

    /// LED matrix / pixel displays — Pixoo (Wi-Fi HTTP).
    ///
    /// NOTE: the Ulanzi TC001 is NOT here — it is an ESP32 board (USB serial /
    /// WiFi WS) and renders in the USB-serial section via `esp32DisplayName`.
    /// The legacy `AdbDeviceClass.ulanziTc001` lookup was removed on 2026-06-25.
    @ViewBuilder
    private func pixelDisplaySection(health: ModuleHealthState) -> some View {
        if let pixoo = health.pixoo, pixoo.configuredDeviceCount > 0 {
            VStack(alignment: .leading, spacing: 3) {
                downstreamSubheader("Pixel displays")
                ForEach(pixoo.devices, id: \.ip) { dev in
                    DeviceRailRow(
                        name: "Pixoo",
                        status: pixooStatus(for: dev, hasFrame: pixoo.hasFrame),
                        detail: pixooDetail(for: dev, hasFrame: pixoo.hasFrame)
                    )
                }
            }
        }
    }

    /// BLE matrix panels — Divoom Timebox Mini (11×11) and iDotMatrix (32×32),
    /// both driven over Bluetooth-LE. Kept in their own section (not folded into
    /// "Pixel displays") because the transport differs and the daemon reports a
    /// live `statusReason` we surface as the row detail — so a panel that's
    /// configured but not yet streaming reads as "connecting…" / "retrying"
    /// rather than vanishing. Only renders a panel that's actually configured.
    @ViewBuilder
    private func bleMatrixSection(health: ModuleHealthState) -> some View {
        let timebox = health.timebox.flatMap { $0.configuredDeviceCount > 0 ? $0 : nil }
        let idm = health.idotmatrix.flatMap { $0.configuredDeviceCount > 0 ? $0 : nil }
        if timebox != nil || idm != nil {
            VStack(alignment: .leading, spacing: 3) {
                downstreamSubheader("BLE matrix")
                if let timebox {
                    DeviceRailRow(
                        name: "Timebox Mini",
                        status: bleMatrixStatus(timebox),
                        detail: bleMatrixDetail(timebox, fallback: "11×11 · BLE")
                    )
                }
                if let idm {
                    DeviceRailRow(
                        name: "iDotMatrix",
                        status: bleMatrixStatus(idm),
                        detail: bleMatrixDetail(idm, fallback: "32×32 · BLE")
                    )
                }
            }
        }
    }

    /// Map a BLE-matrix `statusReason` to a status dot. The Swift daemon fills
    /// `connected`/`statusReason`; the Node daemon reports only that a panel is
    /// configured, so a status-less configured panel reads as `.dim` ("managed,
    /// state unknown") rather than a false error.
    private func bleMatrixStatus(_ h: BLEMatrixHealth) -> LEDStatus {
        if h.connected { return .ok }
        let reason = (h.statusReason ?? "").lowercased()
        if reason.contains("paused") { return .dim }
        if reason.contains("connecting") || reason.contains("retry") || reason.contains("backed off") { return .warn }
        if h.lastError != nil || reason.contains("error") || reason.contains("fail") { return .error }
        return h.statusReason == nil ? .dim : .warn
    }

    private func bleMatrixDetail(_ h: BLEMatrixHealth, fallback: String) -> String {
        if h.connected { return h.displayDimmed ? "\(fallback) · paused" : fallback }
        if let reason = h.statusReason, !reason.isEmpty { return reason }
        if let err = h.lastError, !err.isEmpty { return err }
        return fallback
    }

    @ViewBuilder
    private func usbSerialSection(health: ModuleHealthState) -> some View {
        if let serial = health.serial, !serial.connectedBoards.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                downstreamSubheader("USB serial")
                ForEach(serial.connectedBoards, id: \.port) { info in
                    let short = info.port.components(separatedBy: "/").last ?? info.port
                    DeviceRailRow(
                        name: SerialPortInfo.esp32DisplayName(for: info.board),
                        status: .ok,
                        detail: short
                    )
                }
            }
        }
    }

    /// Android section — split into e-ink readers (Crema / Pantone /
    /// Kobo, which need slow low-contrast rendering) and tablets
    /// (Lenovo + generic, which get normal Android UI). TC001 is
    /// excluded here — it renders under Pixel displays instead. The
    /// in-process AdbModule is a stub, so this section only renders
    /// when an external desktop bridge pushes ADB device data.
    @ViewBuilder
    private func androidSection(health: ModuleHealthState) -> some View {
        if let adb = health.adb {
            let eInk = adb.classifiedDevices.filter { $0.deviceClass.hasPrefix("e-ink.") }
            let tablets = adb.classifiedDevices.filter { $0.deviceClass == AdbDeviceClass.androidTablet.rawValue }
            // Fallback "ADB" aggregate row: when we have a signal
            // (available / lastError) but no per-device classification yet
            // — e.g. older daemons or the 1-2s window before `getprop`
            // completes for the first time.
            let needsAggregate = adb.classifiedDevices.isEmpty
                && (adb.available || !adb.devices.isEmpty || adb.lastError != nil)

            if !eInk.isEmpty || !tablets.isEmpty || needsAggregate {
                VStack(alignment: .leading, spacing: 3) {
                    downstreamSubheader("Android")
                    ForEach(eInk, id: \.serial) { dev in
                        DeviceRailRow(
                            name: eInkRowName(for: dev.deviceClass),
                            status: .ok,
                            detail: dev.model ?? dev.serial
                        )
                    }
                    ForEach(tablets, id: \.serial) { dev in
                        let label = [dev.manufacturer, dev.model].compactMap { $0 }.joined(separator: " ")
                        DeviceRailRow(
                            name: "Tablet",
                            status: .ok,
                            detail: label.isEmpty ? dev.serial : label
                        )
                    }
                    if needsAggregate {
                        DeviceRailRow(
                            name: "ADB",
                            status: adb.available ? .ok : (adb.lastError != nil ? .warn : .dim),
                            detail: {
                                if !adb.devices.isEmpty {
                                    let devLabel = "\(adb.devices.count) device\(adb.devices.count == 1 ? "" : "s")"
                                    let reverse = adb.reverseReadyCount > 0
                                        ? " · \(adb.reverseReadyCount) reverse"
                                        : ""
                                    return devLabel + reverse
                                }
                                if let err = adb.lastError, !err.isEmpty { return err }
                                return "No devices"
                            }()
                        )
                    }
                }
            }
        }
    }

    private func eInkRowName(for deviceClass: String) -> String {
        switch deviceClass {
        case AdbDeviceClass.eInkCrema.rawValue: return "Crema"
        case AdbDeviceClass.eInkPantone.rawValue: return "Pantone"
        case AdbDeviceClass.eInkKobo.rawValue: return "Kobo"
        default: return "E-ink"
        }
    }

    private func pixooStatus(for device: PixooDeviceHealth, hasFrame: Bool) -> LEDStatus {
        if !device.online || device.backedOff { return .warn }
        if device.failures > 0 || !hasFrame { return .warn }
        return .ok
    }

    private func pixooDetail(for device: PixooDeviceHealth, hasFrame: Bool) -> String {
        if !device.online || device.backedOff {
            return "retry paused · fail \(device.failures)"
        }
        if device.failures > 0 {
            return "retrying · fail \(device.failures) · \(device.ip)"
        }
        return hasFrame ? "streaming · \(device.ip)" : "warming up · \(device.ip)"
    }

    /// Subtle mid-weight header for the downstream sub-sections. Sits
    /// below the main DOWNSTREAM divider so the visual hierarchy reads
    /// as: DOWNSTREAM > transport family > device row.
    private func downstreamSubheader(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 9, weight: .medium, design: .monospaced))
            .kerning(1.0)
            .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
    }

    /// Lists the device families this app surfaces directly. Android and
    /// Ulanzi TC001 are not mentioned because they ride a separate desktop
    /// bridge — they appear automatically once that bridge connects, so
    /// listing them here would imply they're missing rather than optional.
    /// macOS-only: iOS now renders a self-row instead of the empty-state
    /// placeholder, so there is no iOS branch here anymore.
    private var emptyDownstreamPlaceholder: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("no devices connected")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.8))
            Text("Stream Deck (USB) · D200H (USB) · Pixoo (Wi-Fi) · ESP32 (USB serial)")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.55))
        }
        .padding(.vertical, 4)
    }

    // MARK: - Rate-limit chips (inline under Claude row)

    /// Compact chips for 5h/7d usage. Rendered inline under the Claude row
    /// because Claude is the only provider that reports rate limits today.
    ///
    /// `stale` flag: surfaced prominently because stale usage data is the
    /// single most common source of "the number is wrong" confusion. When
    /// `state.usageStale == true` (bridge hasn't fetched fresh usage for >
    /// 10 min — e.g. API backoff, sandbox OAuth blocked, daemon just woke
    /// from sleep) we show `stale` in the reset slot instead of hiding
    /// reset info silently. Either the chip becomes a loud marker of
    /// "don't trust this yet" or it shows fresh data with a real reset
    /// timer — no silent middle state.
    private var rateLimitChips: [RateChip] {
        // Progressive enhancement gate: Claude subscription quota gauges
        // depend on OAuth token / sibling relay data the sandboxed App
        // Store build can't produce on its own. When no external Node
        // daemon is relaying usage (`isUsingExternalDaemon == false`) and
        // there's genuinely no cached percent to show, yield no chips so
        // the Claude row collapses cleanly instead of reserving empty
        // space. Stale-cache fallback (`usagePct != nil`) keeps the chip
        // alive across brief daemon restarts — otherwise hiding would
        // flicker every time the external daemon blipped.
        #if os(macOS)
        let hasPercent = stateHolder.state.fiveHourPercent != nil
            || stateHolder.state.sevenDayPercent != nil
        guard daemonService.isUsingExternalDaemon || hasPercent else { return [] }
        #endif
        var chips: [RateChip] = []
        let isStale = stateHolder.state.usageStale == true
        if let pct = stateHolder.state.fiveHourPercent {
            chips.append(.init(
                label: "5h",
                percent: pct,
                reset: formatResetTime(stateHolder.state.fiveHourResetsAt),
                stale: isStale
            ))
        }
        if let pct = stateHolder.state.sevenDayPercent {
            chips.append(.init(
                label: "7d",
                percent: pct,
                reset: formatResetTime(stateHolder.state.sevenDayResetsAt),
                stale: isStale
            ))
        }
        return chips
    }

    // MARK: - Consumer creatures (session ↔ provider mapping)

    /// Return the agent brand color of every alive session whose model maps
    /// to the given provider. Rendered as dots on the right edge of the
    /// provider row so "who's using Claude right now" is visible at a
    /// glance. De-duped by agentType to avoid two claude sessions eating two
    /// dots on the Claude row.
    private func consumerCreatures(for provider: ProviderKey) -> [ConsumerBadge] {
        var seen = Set<String>()
        var out: [ConsumerBadge] = []
        for session in stateHolder.state.siblingSessions where session.alive {
            let key = Self.providerFor(
                modelName: session.modelName,
                mlxModels: stateHolder.state.mlxModels,
                ollama: stateHolder.state.ollamaStatus
            )
            guard key == provider else { continue }
            let dedupKey = session.agentType ?? session.id
            if seen.contains(dedupKey) { continue }
            seen.insert(dedupKey)
            out.append(ConsumerBadge(
                id: dedupKey,
                color: SessionBrand.color(for: session.agentType)
            ))
        }
        return out
    }

    // MARK: - Provider inference

    enum ProviderKey: Equatable {
        case claude, openclaw, mlx, ollama, unknown
    }

    /// Best-effort mapping from a session's `modelName` to a provider row.
    /// Intentionally conservative — unknowns fall through so we don't
    /// mis-attribute a creature badge to the wrong reef.
    static func providerFor(
        modelName: String?,
        mlxModels: [String],
        ollama: OllamaStatus?
    ) -> ProviderKey {
        guard let raw = modelName?.lowercased(), !raw.isEmpty else { return .unknown }
        if raw.hasPrefix("claude-") || raw.hasPrefix("opus") || raw.hasPrefix("sonnet") || raw.hasPrefix("haiku") {
            return .claude
        }
        if raw.hasPrefix("glm") || raw.contains("qwen-plus") || raw.contains("deepseek") || raw.hasPrefix("z-") {
            return .openclaw
        }
        if raw.hasPrefix("gpt-") || raw.hasPrefix("o1-") || raw.hasPrefix("o3-") {
            return .openclaw
        }
        for m in mlxModels where raw.contains(m.lowercased()) || m.lowercased().contains(raw) {
            return .mlx
        }
        if let ollama, ollama.models.contains(where: { raw.contains($0.name.lowercased()) }) {
            return .ollama
        }
        return .unknown
    }

    // MARK: - Formatting helpers

    /// Parse an ISO8601 timestamp from `SubscriptionInfo.until`. Returns `nil`
    /// when the string is empty, malformed, or unparseable. The renderer uses
    /// the result to decide between "Mar 4" (date in the future) and
    /// "renewal needed" (date in the past) — see `subscriptionTrailing`. The
    /// bare-date branch gates on a regex because `DateFormatter` quietly
    /// accepts variants like `2026/05/06` even with `dateFormat =
    /// "yyyy-MM-dd"`, which would smuggle malformed strings past the
    /// expired-vs-future check.
    static func parseUntilDate(_ input: String) -> Date? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let withFractions = ISO8601DateFormatter()
        withFractions.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFractions.date(from: trimmed) { return date }
        let plain = ISO8601DateFormatter()
        if let date = plain.date(from: trimmed) { return date }
        // Tolerate "YYYY-MM-DD" (no time component) — `chatgpt_subscription_active_until`
        // sometimes lands as a date-only string after token rewrites.
        guard trimmed.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
            return nil
        }
        let dateOnly = DateFormatter()
        dateOnly.calendar = Calendar(identifier: .iso8601)
        dateOnly.locale = Locale(identifier: "en_US_POSIX")
        dateOnly.timeZone = TimeZone(secondsFromGMT: 0)
        dateOnly.dateFormat = "yyyy-MM-dd"
        dateOnly.isLenient = false
        return dateOnly.date(from: trimmed)
    }
}

// MARK: - LED status

/// Four-level LED status shared by upstream and downstream rows. Maps to
/// `TerrariumHUD` palette so the dashboard reads consistently.
enum LEDStatus {
    case ok, warn, error, dim

    var color: Color {
        switch self {
        case .ok:    return TerrariumHUD.ledGreen
        case .warn:  return TerrariumHUD.ledAmber
        case .error: return TerrariumHUD.ledRed
        case .dim:   return TerrariumHUD.subtext.opacity(0.5)
        }
    }

    var glyph: String {
        switch self {
        case .ok, .warn, .error: return "●"
        case .dim:               return "○"
        }
    }

    /// Rails that render the status as a filled `Circle().fill(...)` vs an
    /// outlined `Circle().stroke(...)` (the menu-bar palette prefers the
    /// outline for `.dim` so "inactive / stopped" reads differently from
    /// "live but unhealthy"). Mirrors the `.glyph` filled/outline split.
    var isFilled: Bool {
        self != .dim
    }
}

// MARK: - Provider row

struct RateChip: Identifiable {
    let id = UUID()
    let label: String
    let percent: Double
    let reset: String?
    /// Data-is-stale marker (derived from `DashboardState.usageStale`).
    /// Renders a loud "stale" tag in place of the reset time and dims the
    /// bar so the user doesn't mistake cached numbers for current ones.
    var stale: Bool = false
}

struct ConsumerBadge: Identifiable {
    let id: String
    let color: Color
}

private struct ProviderRow: View {
    let name: String
    let status: LEDStatus
    let subtitle: String?
    let rateLimits: [RateChip]
    let consumers: [ConsumerBadge]

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(status.glyph)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(status.color)
                Text(name)
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.text)
                Spacer(minLength: 4)
                ForEach(consumers.prefix(3)) { badge in
                    Circle()
                        .fill(badge.color)
                        .frame(width: 7, height: 7)
                        .overlay(
                            Circle()
                                .stroke(Color.black.opacity(0.35), lineWidth: 0.5)
                        )
                }
                if consumers.count > 3 {
                    Text("+\(consumers.count - 3)")
                        .font(.system(size: 9, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext)
                }
            }
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext)
                    // Wrap instead of truncating: MLX with two models + OpenClaw
                    // pairing hints with deviceId previously got "…"-clipped.
                    // `fixedSize(horizontal:false, vertical:true)` lets the Text
                    // grow vertically inside the available row width.
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 14)
            }
            if !rateLimits.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(rateLimits) { chip in
                        RateChipView(chip: chip)
                    }
                }
                .padding(.leading, 14)
                .padding(.top, 2)
            }
        }
    }
}

private struct RateChipView: View {
    let chip: RateChip

    private var fillColor: Color {
        if chip.percent >= 90 { return TerrariumHUD.ledRed }
        if chip.percent >= 70 { return TerrariumHUD.ledAmber }
        return TerrariumHUD.ledGreen
    }

    /// Visual opacity — dimmed when the underlying data is marked stale
    /// so the row reads as "don't trust this yet" without user having to
    /// decode the text tag.
    private var barOpacity: Double {
        chip.stale ? 0.35 : 0.65
    }

    /// The rightmost slot shows either the live reset countdown or a
    /// "stale" marker when the data is known to be out of date. Cannot be
    /// both — if data is stale the reset timestamp is almost certainly
    /// stale too, so showing both would be double-noise.
    @ViewBuilder
    private var rightSlot: some View {
        if chip.stale {
            Text("stale")
                .font(.system(size: 9, weight: .semibold, design: .monospaced))
                .foregroundStyle(TerrariumHUD.ledAmber)
                .frame(width: 42, alignment: .trailing)
        } else if let reset = chip.reset {
            Text(reset)
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.75))
                .frame(width: 42, alignment: .trailing)
        } else {
            // Reset timestamp parses to "past-grace" (> 1h after the
            // stored reset). Treat it as a data-staleness signal too —
            // the bridge hasn't caught up with the new window yet.
            Text("—")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.4))
                .frame(width: 42, alignment: .trailing)
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(chip.label)
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext)
                .frame(width: 16, alignment: .leading)

            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 2)
                        .fill(Color.white.opacity(0.10))
                    RoundedRectangle(cornerRadius: 2)
                        .fill(fillColor.opacity(barOpacity))
                        .frame(width: max(0, min(1, chip.percent / 100)) * geo.size.width)
                }
            }
            .frame(height: 5)

            Text("\(Int(chip.percent))%")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(chip.stale ? TerrariumHUD.subtext : fillColor)
                .frame(width: 32, alignment: .trailing)

            rightSlot
        }
    }
}

// MARK: - Device row

private struct DeviceRailRow: View {
    let name: String
    let status: LEDStatus
    let detail: String

    var body: some View {
        HStack(spacing: 6) {
            Text(status.glyph)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(status.color)
            Text(name)
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundStyle(TerrariumHUD.text)
                .frame(minWidth: 60, alignment: .leading)
            Text(detail)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(TerrariumHUD.subtext)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer(minLength: 0)
        }
    }
}
