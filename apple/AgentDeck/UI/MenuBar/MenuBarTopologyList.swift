// MenuBarTopologyList.swift — Compact linear topology for the menu bar
//
// Replaces the radial `UnifiedGraphView`. Dashboard's `TopologyRail` already
// established a clear "UPSTREAM → AgentDeck hub → DOWNSTREAM" flow that
// reads well in a narrow rail; this is the menu-bar-cream-palette sibling,
// sized for the 380pt popover.
//
// Kept intentionally thin:
//   * Provider rows only surface Claude / OpenClaw / MLX / Ollama. No
//     Antigravity, subscriptions, rate chips, or consumer badges — those
//     live in dedicated menu-bar sections (rate limits are already below
//     this view), so duplicating them here is noise.
//   * Device rows surface ADB / D200H / Pixoo / ESP32 from `moduleHealth`.
//   * Hub node = AgentDeck logo + port, nothing more.
//
// Status/subtitle for Claude + OpenClaw is delegated to
// `ProviderRailEvaluator` (in IntegrationsView.swift) so Settings,
// Dashboard, and menu-bar can't drift on the "is Claude connected?"
// formula again. LEDStatus is the shared palette.

#if os(macOS)
import SwiftUI

struct MenuBarTopologyList: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var daemonService: DaemonService
    @EnvironmentObject private var preferences: AppPreferences

    /// Palette is a thin alias over the shared `TerrariumHUD` /
    /// `TerrariumColors` tokens so the menu-bar popup reads as part of
    /// the same visual system as the Dashboard and Monitor HUDs — no
    /// separate cream palette, no drifting hex codes.
    fileprivate enum Pal {
        static let text      = TerrariumHUD.text
        static let subtext   = TerrariumHUD.subtext
        static let divider   = Color.white.opacity(0.10)
        static let cardBg    = Color.white.opacity(0.04)
        static let hubFill   = TerrariumColors.midWater
        static let hubAccent = TerrariumColors.tetraNeon
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader("UPSTREAM")
            upstreamRows
            flowArrow
            hubNode
            flowArrow
            sectionHeader("DOWNSTREAM")
            downstreamRows
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(Pal.cardBg))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.black.opacity(0.06), lineWidth: 0.5)
        )
    }

    // MARK: - Headers / flow arrow / hub

    private func sectionHeader(_ title: String) -> some View {
        HStack(spacing: 6) {
            Text(title)
                .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                .kerning(1.2)
                .foregroundColor(Pal.subtext)
            Rectangle()
                .fill(Pal.divider)
                .frame(height: 0.5)
        }
    }

    private var flowArrow: some View {
        Text(verbatim: "▼")
            .font(.system(size: 9, design: .monospaced))
            .foregroundColor(Pal.hubAccent.opacity(0.55))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 2)
    }

    private var hubNode: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            AgentDeckLogo(size: 16, color: Pal.hubAccent)
            Text("AgentDeck")
                .font(.system(size: 12, weight: .bold, design: .monospaced))
                .foregroundColor(TerrariumHUD.text)
            Text(verbatim: ":\(hubPortText)")
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(TerrariumHUD.subtext)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6).fill(Pal.hubFill)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Pal.hubAccent.opacity(0.70), lineWidth: 1)
        )
    }

    /// Prefer the live daemon port. When the in-process daemon hasn't
    /// bound yet we still have a value worth showing — the configured
    /// default — rather than a blank or zero.
    private var hubPortText: String {
        if daemonService.port > 0 { return portString(daemonService.port) }
        return portString(AppPreferences.defaultDaemonPort)
    }

    // MARK: - Upstream rows

    @ViewBuilder
    private var upstreamRows: some View {
        VStack(alignment: .leading, spacing: 4) {
            claudeRow
            openClawRow
            mlxRow
            ollamaRow
        }
    }

    private var claudeRow: some View {
        let base = ProviderRailEvaluator.claude(
            state: stateHolder.state,
            hooksInstalled: preferences.hooksInstalled
        )
        return RailRow(
            status: base.status,
            name: "Claude",
            subtitle: base.subtitle
        )
    }

    @ViewBuilder
    private var openClawRow: some View {
        if let base = ProviderRailEvaluator.openClaw(state: stateHolder.state) {
            RailRow(
                status: base.status,
                name: "OpenClaw",
                subtitle: base.subtitle
            )
        }
    }

    @ViewBuilder
    private var mlxRow: some View {
        if !stateHolder.state.mlxModels.isEmpty {
            let primary = stateHolder.state.mlxModels.first ?? ""
            let extra = max(0, stateHolder.state.mlxModels.count - 1)
            let subtitle = extra > 0 ? "\(primary) · +\(extra)" : primary
            RailRow(status: .ok, name: "MLX", subtitle: subtitle)
        }
    }

    @ViewBuilder
    private var ollamaRow: some View {
        if let ollama = stateHolder.state.ollamaStatus {
            let status: LEDStatus = ollama.available ? .ok : .dim
            let subtitle: String = {
                if !ollama.available { return "stopped" }
                let running = ollama.models.filter { $0.sizeVram > 0 }
                let source = running.isEmpty ? ollama.models : running
                if source.isEmpty { return "idle" }
                return source.prefix(1).map(\.name).joined() +
                    (source.count > 1 ? " · +\(source.count - 1)" : "")
            }()
            RailRow(status: status, name: "Ollama", subtitle: subtitle)
        }
    }

    // MARK: - Downstream rows

    @ViewBuilder
    private var downstreamRows: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let health = stateHolder.state.moduleHealth {
                // Stream Deck — mirror TopologyRail's hierarchy
                if let sd = health.streamDeck, !sd.devices.isEmpty {
                    ForEach(sd.devices, id: \.id) { dev in
                        RailRow(
                            status: .ok,
                            name: streamDeckDisplayName(for: dev),
                            subtitle: streamDeckDetail(for: dev)
                        )
                    }
                }
                // Wi-Fi WS e-ink panels (XTeink X3 …) — volunteer roster, live only.
                if let eink = health.eink, !eink.devices.isEmpty {
                    ForEach(eink.devices, id: \.id) { dev in
                        RailRow(
                            status: .ok,
                            name: dev.name.isEmpty ? "E-ink panel" : dev.name,
                            subtitle: einkDetail(for: dev)
                        )
                    }
                }
                // D200H first — always the most permanent peripheral.
                if let d = health.d200h {
                    RailRow(
                        status: d.connected ? .ok : .dim,
                        name: "D200H",
                        subtitle: d.connected
                            ? "Ulanzi Studio · 14 keys"
                            : "Plugin disconnected"
                    )
                }
                // Pixel displays — Pixoo (Wi-Fi HTTP). The Ulanzi TC001 renders
                // in the USB-serial section below, not here — it is an ESP32
                // board, not an ADB device (legacy lookup removed 2026-06-25).
                if let pixoo = health.pixoo, pixoo.configuredDeviceCount > 0 {
                    ForEach(pixoo.devices, id: \.ip) { dev in
                        RailRow(
                            status: pixooStatus(for: dev, hasFrame: pixoo.hasFrame),
                            name: "Pixoo",
                            subtitle: pixooDetail(for: dev, hasFrame: pixoo.hasFrame)
                        )
                    }
                }
                // BLE matrix panels — TopologyRail parity (previously the
                // menubar silently omitted both, so a Timebox-only setup read
                // as "no devices" here while the dashboard showed it).
                if let timebox = health.timebox, timebox.configuredDeviceCount > 0 {
                    RailRow(
                        status: bleMatrixStatus(timebox),
                        name: "Timebox Mini",
                        subtitle: bleMatrixDetail(timebox, fallback: "11×11 · BLE")
                    )
                }
                if let idm = health.idotmatrix, idm.configuredDeviceCount > 0 {
                    RailRow(
                        status: bleMatrixStatus(idm),
                        name: "iDotMatrix",
                        subtitle: bleMatrixDetail(idm, fallback: "32×32 · BLE")
                    )
                }
                // USB serial / ESP32.
                if let serial = health.serial, !serial.connectedBoards.isEmpty {
                    ForEach(serial.connectedBoards, id: \.port) { info in
                        let short = info.port.components(separatedBy: "/").last ?? info.port
                        RailRow(
                            status: .ok,
                            name: SerialPortInfo.esp32DisplayName(for: info.board),
                            subtitle: info.wifiConnected == true ? "\(short) · WiFi" : short
                        )
                    }
                }
                // WiFi-WS ESP32 boards with no live serial path. Dual-homed
                // boards (serialActive) already render above — one row per
                // physical device (mirrors TopologyRail.wifiEsp32Section).
                let wifiOnlyBoards = (health.esp32Wifi?.devices ?? []).filter { !$0.serialActive }
                if !wifiOnlyBoards.isEmpty {
                    ForEach(wifiOnlyBoards, id: \.self) { dev in
                        RailRow(
                            status: dev.stale ? .warn : .ok,
                            name: SerialPortInfo.esp32DisplayName(for: dev.board),
                            subtitle: [dev.ip, "WiFi", dev.stale ? "stale" : nil]
                                .compactMap { $0 }
                                .joined(separator: " · ")
                        )
                    }
                }
                // TUI dashboards (`agentdeck dashboard`) — live-presence roster.
                if let tui = health.tuiDashboards, !tui.devices.isEmpty {
                    ForEach(tui.devices, id: \.id) { dev in
                        RailRow(status: .ok, name: "TUI Dashboard", subtitle: dev.name)
                    }
                }
                // WiFi WS Android dashboards — TopologyRail parity.
                if let ad = health.androidDashboards, !ad.devices.isEmpty {
                    ForEach(ad.devices, id: \.self) { dev in
                        RailRow(
                            status: .ok,
                            name: dev.kind == "eink" ? "E-ink" : "Tablet",
                            subtitle: (dev.name.isEmpty ? dev.id : dev.name) + " · WiFi"
                        )
                    }
                }
                // Android — e-ink + tablet, with aggregate fallback.
                if let adb = health.adb {
                    let eInk = adb.classifiedDevices.filter { $0.deviceClass.hasPrefix("e-ink.") }
                    let tablets = adb.classifiedDevices.filter { $0.deviceClass == AdbDeviceClass.androidTablet.rawValue }
                    ForEach(eInk, id: \.serial) { dev in
                        RailRow(status: .ok, name: eInkName(for: dev.deviceClass), subtitle: dev.model ?? dev.serial)
                    }
                    ForEach(tablets, id: \.serial) { dev in
                        let label = [dev.manufacturer, dev.model].compactMap { $0 }.joined(separator: " ")
                        RailRow(status: .ok, name: "Tablet", subtitle: label.isEmpty ? dev.serial : label)
                    }
                    if adb.classifiedDevices.isEmpty,
                       (adb.available || !adb.devices.isEmpty || adb.lastError != nil) {
                        RailRow(
                            status: adb.available ? .ok : (adb.lastError != nil ? .warn : .dim),
                            name: "ADB",
                            subtitle: adbDetail(adb)
                        )
                    }
                }
            }
            if !hasAnyDownstream {
                Text("no devices connected")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(Pal.subtext.opacity(0.85))
            }
        }
    }

    private func eInkName(for deviceClass: String) -> String {
        switch deviceClass {
        case AdbDeviceClass.eInkCrema.rawValue: return "Crema"
        case AdbDeviceClass.eInkPantone.rawValue: return "Pantone"
        case AdbDeviceClass.eInkKobo.rawValue: return "Kobo"
        default: return "E-ink"
        }
    }

    private func adbDetail(_ adb: AdbHealth) -> String {
        if !adb.devices.isEmpty {
            let dev = "\(adb.devices.count) device" + (adb.devices.count == 1 ? "" : "s")
            let rev = adb.reverseReadyCount > 0 ? " · \(adb.reverseReadyCount) reverse" : ""
            return dev + rev
        }
        if let err = adb.lastError, !err.isEmpty { return err }
        return "No devices"
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

    private var hasAnyDownstream: Bool {
        guard let h = stateHolder.state.moduleHealth else { return false }
        if let sd = h.streamDeck, !sd.devices.isEmpty { return true }
        if let eink = h.eink, !eink.devices.isEmpty { return true }
        if let adb = h.adb, (adb.available || !adb.devices.isEmpty || adb.lastError != nil) { return true }
        if h.d200h != nil { return true }
        if let p = h.pixoo, p.configuredDeviceCount > 0 { return true }
        if let s = h.serial, !s.connectedBoards.isEmpty { return true }
        if (h.esp32Wifi?.devices ?? []).contains(where: { !$0.serialActive }) { return true }
        if let tui = h.tuiDashboards, !tui.devices.isEmpty { return true }
        if let tb = h.timebox, tb.configuredDeviceCount > 0 { return true }
        if let idm = h.idotmatrix, idm.configuredDeviceCount > 0 { return true }
        if let ad = h.androidDashboards, !ad.devices.isEmpty { return true }
        return false
    }

    /// Mirrors TopologyRail's BLE-matrix status/detail mapping so the two
    /// surfaces can't disagree about why a panel isn't streaming.
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

    private func einkDetail(for dev: EinkDeviceInfo) -> String {
        if let c = dev.columns, let r = dev.rows, c > 0, r > 0 {
            return "\(c)×\(r) e-ink"
        }
        return dev.family ?? "e-ink"
    }

    private func streamDeckDisplayName(for dev: StreamDeckDeviceInfo) -> String {
        if !dev.name.isEmpty { return dev.name }
        switch dev.family {
        case "streamdeckplus":   return "Stream Deck+"
        case "streamdeckplusxl": return "Stream Deck + XL"
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

}

// MARK: - Row primitive

private struct RailRow: View {
    let status: LEDStatus
    let name: String
    let subtitle: String?

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            statusDot
                .frame(width: 8, height: 8)
                .padding(.top, 2)
            Text(name)
                .font(.system(size: 11, weight: .bold, design: .monospaced))
                .foregroundColor(MenuBarTopologyList.Pal.text)
                .frame(minWidth: 58, alignment: .leading)
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundColor(MenuBarTopologyList.Pal.subtext)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var statusDot: some View {
        if status.isFilled {
            Circle().fill(status.color)
        } else {
            Circle()
                .stroke(status.color, lineWidth: 1)
        }
    }
}

#endif
