// MonitorHUD.swift — Semi-transparent HUD overlay (matches Android MonitorHUD)

import SwiftUI

#if os(macOS)
import CoreLocation
import WeatherKit

extension Notification.Name {
    static let weatherSettingsChanged = Notification.Name("dev.agentdeck.weatherSettingsChanged")
}

private struct DashboardWeatherFeed: Decodable {
    struct Glance: Decodable { let weather: DashboardWeatherSnapshot? }
    let deckSig: String
    let unchanged: Bool?
    let glance: Glance?
}

private struct DashboardWeatherSnapshot: Decodable {
    struct Source: Decodable {
        let id: String?
        let displayName: String
        let attributionUrl: String
        let markUrlDark: String?
    }
    let place: String?
    let tempC: Int?
    let code: Int?
    let summary: String?
    let todayMinC: Int?
    let todayMaxC: Int?
    let source: Source?

    static func wmo(_ raw: String) -> Int {
        let value = raw.lowercased()
        if value.contains("thunder") { return 95 }
        if value.contains("snow") || value.contains("sleet") { return 75 }
        if value.contains("rain") { return 63 }
        if value.contains("fog") || value.contains("haze") { return 45 }
        if value.contains("cloud") || value.contains("overcast") { return 3 }
        if value.contains("clear") { return 0 }
        return 2
    }

    static func summary(_ raw: String) -> String {
        switch wmo(raw) {
        case 0: "Clear"; case 3: "Cloudy"; case 45: "Fog"; case 63: "Rain"
        case 75: "Snow"; case 95: "Storm"; default: "Fair"
        }
    }
}
#endif

/// Shared landscape bounds for HUD cards. The water region ends where the
/// Timeline begins, so both side rails must consume the same finite budget.
/// Width grows modestly on larger dashboards to reduce wrapped session names,
/// then caps so the terrarium remains the visual center.
enum DashboardHUDLayout {
    static let edgePadding: CGFloat = 12
    static let timelineClearance: CGFloat = 12
    static let minimumPanelHeight: CGFloat = 80
    static let compactSwitcherHeight: CGFloat = 30
    static let compactSwitcherGap: CGFloat = 6

    static func landscapePanelMaxHeight(
        availableHeight: CGFloat,
        showsTimeline: Bool
    ) -> CGFloat {
        let visibleRegion = showsTimeline
            ? availableHeight * (1 - MonitorLayout.sandFraction)
            : availableHeight
        return max(0, visibleRegion - edgePadding - timelineClearance)
    }

    static func sessionPanelWidth(availableWidth: CGFloat) -> CGFloat {
        min(max(220, availableWidth * 0.25), 280)
    }

    /// A phone in portrait cannot support two readable HUD rails side by
    /// side. iPad portrait stays in the dual-rail composition.
    static func usesSingleReadableRail(
        availableWidth: CGFloat,
        availableHeight: CGFloat
    ) -> Bool {
        availableHeight > availableWidth && availableWidth < 600
    }

    static func compactPanelWidth(availableWidth: CGFloat) -> CGFloat {
        min(max(0, availableWidth - 16), 420)
    }

    static func compactPanelMaxHeight(
        availableHeight: CGFloat,
        showsTimeline: Bool
    ) -> CGFloat {
        max(
            0,
            landscapePanelMaxHeight(
                availableHeight: availableHeight,
                showsTimeline: showsTimeline
            ) - compactSwitcherHeight - compactSwitcherGap
        )
    }

    static func setupCardLeadingInset(
        availableWidth: CGFloat,
        isLandscape: Bool,
        showsSessionList: Bool
    ) -> CGFloat {
        guard isLandscape, showsSessionList else { return 14 }
        return edgePadding + sessionPanelWidth(availableWidth: availableWidth) + timelineClearance
    }

    static func usesCompactSessionRows(sessionCount: Int) -> Bool {
        sessionCount > 6
    }
}

private enum CompactDashboardHUDPage: String, CaseIterable, Identifiable {
    case sessions = "Sessions"
    case system = "System"

    var id: String { rawValue }
}

struct MonitorHUD: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var preferences: AppPreferences
    @State private var compactPage: CompactDashboardHUDPage = .sessions
    #if os(macOS)
    @EnvironmentObject private var daemonService: DaemonService
    @AppStorage("dashboardCollaborationEnabled") private var collaborationEnabled = false
    @State private var weather: DashboardWeatherSnapshot?
    @State private var weatherDeckSig: String?
    @State private var nativeWeatherFetchedAt: Date?
    #endif

    var body: some View {
        GeometryReader { geo in
            let isLandscape = geo.size.width > geo.size.height
            let panelMaxHeight = DashboardHUDLayout.landscapePanelMaxHeight(
                availableHeight: geo.size.height,
                showsTimeline: preferences.showTimeline
            )
            let usesSingleRail = DashboardHUDLayout.usesSingleReadableRail(
                availableWidth: geo.size.width,
                availableHeight: geo.size.height
            )

            if usesSingleRail {
                compactPhoneHUD(geo: geo)
            } else if isLandscape {
                // iPad landscape: matches Android Box layout
                ZStack(alignment: .topLeading) {
                    // Top-left: bounded session roster. Unlike the previous
                    // natural-height card, this can never paint into Timeline.
                    if preferences.showSessionList {
                        if panelMaxHeight >= DashboardHUDLayout.minimumPanelHeight {
                            SessionListPanel(maxHeight: panelMaxHeight)
                                .frame(width: DashboardHUDLayout.sessionPanelWidth(
                                    availableWidth: geo.size.width
                                ))
                                .padding(.leading, DashboardHUDLayout.edgePadding)
                                .padding(.top, DashboardHUDLayout.edgePadding)
                        }
                    }

                    // Top-right: relationship-centric topology rail
                    // (replaces old TankStatus + DeviceDiagnostic boxes).
                    // Visible if either of the legacy preferences is on; the
                    // rail is a single unified view so we don't try to hide
                    // upstream or downstream independently anymore.
                    if showsRightRail {
                        if panelMaxHeight >= DashboardHUDLayout.minimumPanelHeight {
                            HStack {
                                Spacer()
                                dashboardRightRail(maxHeight: panelMaxHeight)
                                    .frame(maxWidth: min(geo.size.width * 0.32, rightRailWidth))
                                    .padding(.trailing, DashboardHUDLayout.edgePadding)
                                    .padding(.top, DashboardHUDLayout.edgePadding)
                            }
                        }
                    }

                    #if os(macOS)
                    // Quiet center-top context: outside conditions enrich the
                    // aquarium without taking space from either information
                    // rail. Attribution stays visible beside the forecast.
                    if let weather {
                        HStack {
                            Spacer()
                            DashboardWeatherPill(weather: weather)
                            Spacer()
                        }
                        .padding(.top, DashboardHUDLayout.edgePadding)
                    }
                    #endif

                    // Stale data banner when disconnected
                    if !stateHolder.state.bridgeConnected, let lastReceived = stateHolder.lastDataReceivedAt {
                        VStack {
                            Spacer()
                            HStack {
                                Spacer()
                                StaleDataBanner(lastReceived: lastReceived)
                                Spacer()
                            }
                            .padding(.bottom, 12)
                        }
                    }
                }
            } else {
                // iPhone portrait: vertical stack
                VStack(spacing: 0) {
                    // Stale data banner when disconnected
                    if !stateHolder.state.bridgeConnected, let lastReceived = stateHolder.lastDataReceivedAt {
                        StaleDataBanner(lastReceived: lastReceived)
                            .padding(.top, 8)
                    }

                    HStack(alignment: .top, spacing: 8) {
                        if preferences.showSessionList {
                            SessionListPanel(maxHeight: panelMaxHeight)
                                .frame(maxWidth: .infinity)
                        }
                        if showsRightRail {
                            dashboardRightRail(maxHeight: panelMaxHeight)
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.top, 8)

                    Spacer()
                }
            }
        }
        #if os(macOS)
        .task(id: daemonService.port) { await weatherRefreshLoop() }
        .onReceive(NotificationCenter.default.publisher(for: .weatherSettingsChanged)) { _ in
            weatherDeckSig = nil
            Task { await refreshWeather() }
        }
        #endif
    }

    private var showsRightRail: Bool {
        #if os(macOS)
        collaborationEnabled || preferences.showTankStatus || preferences.showDeviceDiagnostic
        #else
        preferences.showTankStatus || preferences.showDeviceDiagnostic
        #endif
    }

    private var rightRailWidth: CGFloat {
        #if os(macOS)
        collaborationEnabled ? 390 : 300
        #else
        300
        #endif
    }

    @ViewBuilder
    private func dashboardRightRail(maxHeight: CGFloat) -> some View {
        #if os(macOS)
        if collaborationEnabled {
            CollaborationPanel(maxHeight: maxHeight)
        } else {
            TopologyRail(maxHeight: maxHeight)
        }
        #else
        TopologyRail(maxHeight: maxHeight)
        #endif
    }

    /// Compact portrait keeps the full information set but avoids squeezing
    /// Sessions and System into two ~half-width columns. The explicit switch
    /// makes the alternate rail discoverable while each page keeps readable
    /// line lengths and its own bounded scroll position.
    @ViewBuilder
    private func compactPhoneHUD(geo: GeometryProxy) -> some View {
        let showsSessions = preferences.showSessionList
        let showsSystem = preferences.showTankStatus || preferences.showDeviceDiagnostic
        let pages: [CompactDashboardHUDPage] = [
            showsSessions ? .sessions : nil,
            showsSystem ? .system : nil,
        ].compactMap { $0 }
        let resolvedPage: CompactDashboardHUDPage? = pages.contains(compactPage)
            ? compactPage
            : pages.first
        let contentMaxHeight = DashboardHUDLayout.compactPanelMaxHeight(
            availableHeight: geo.size.height,
            showsTimeline: preferences.showTimeline
        )

        VStack(spacing: DashboardHUDLayout.compactSwitcherGap) {
            if pages.count > 1 {
                CompactDashboardHUDSwitcher(
                    pages: pages,
                    selection: compactPage,
                    onSelect: { compactPage = $0 }
                )
                .frame(height: DashboardHUDLayout.compactSwitcherHeight)
            }

            if contentMaxHeight >= DashboardHUDLayout.minimumPanelHeight {
                switch resolvedPage {
                case .sessions:
                    SessionListPanel(maxHeight: contentMaxHeight)
                case .system:
                    TopologyRail(maxHeight: contentMaxHeight)
                case nil:
                    EmptyView()
                }
            }
        }
        .frame(width: DashboardHUDLayout.compactPanelWidth(availableWidth: geo.size.width))
        .padding(.top, 8)
        .frame(maxWidth: .infinity, alignment: .top)
    }

    #if os(macOS)
    @MainActor
    private func weatherRefreshLoop() async {
        await refreshWeather()
        while !Task.isCancelled {
            do { try await Task.sleep(for: .seconds(30 * 60)) } catch { return }
            await refreshWeather()
        }
    }

    @MainActor
    private func refreshWeather() async {
        if await refreshNativeWeather() {
            weatherDeckSig = nil
            return
        }
        // The native request can be unavailable before the signed WeatherKit
        // capability is enabled. Fall back visibly to the portable provider;
        // its own source attribution prevents a silent provider switch.
        weatherDeckSig = nil
        var components = URLComponents(string: "http://127.0.0.1:\(daemonService.port)/feed")
        if let weatherDeckSig {
            components?.queryItems = [URLQueryItem(name: "sig", value: weatherDeckSig)]
        }
        guard let url = components?.url else { return }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            let feed = try JSONDecoder().decode(DashboardWeatherFeed.self, from: data)
            weatherDeckSig = feed.deckSig
            if feed.unchanged != true { weather = feed.glance?.weather }
        } catch {
            // Apple Weather is only a short in-memory performance cache. Do
            // not leave it on screen indefinitely when both providers fail.
            if weather?.source?.id == "apple-weather",
               let nativeWeatherFetchedAt,
               Date().timeIntervalSince(nativeWeatherFetchedAt) >= 60 * 60 {
                weather = nil
            }
        }
    }

    @MainActor
    private func refreshNativeWeather() async -> Bool {
        guard let data = try? Data(contentsOf: AgentDeckPaths.settingsJson),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let config = root["weather"] as? [String: Any],
              let latitude = (config["lat"] as? NSNumber)?.doubleValue,
              let longitude = (config["lon"] as? NSNumber)?.doubleValue else { return false }
        do {
            let result = try await WeatherService.shared.weather(
                for: CLLocation(latitude: latitude, longitude: longitude)
            )
            let attribution = try await WeatherService.shared.attribution
            let currentCondition = String(describing: result.currentWeather.condition)
            let today = result.dailyForecast.forecast.first
            weather = DashboardWeatherSnapshot(
                place: config["place"] as? String,
                tempC: Int(result.currentWeather.temperature.converted(to: .celsius).value.rounded()),
                code: DashboardWeatherSnapshot.wmo(currentCondition),
                summary: DashboardWeatherSnapshot.summary(currentCondition),
                todayMinC: today.map { Int($0.lowTemperature.converted(to: .celsius).value.rounded()) },
                todayMaxC: today.map { Int($0.highTemperature.converted(to: .celsius).value.rounded()) },
                source: .init(
                    id: "apple-weather",
                    displayName: attribution.serviceName,
                    attributionUrl: attribution.legalPageURL.absoluteString,
                    markUrlDark: attribution.combinedMarkDarkURL.absoluteString
                )
            )
            nativeWeatherFetchedAt = Date()
            return true
        } catch {
            // A failed WeatherKit call falls back to the portable MET Norway
            // feed, whose own attribution makes the switch visible on screen —
            // but nothing else says WHY. Measured 2026-09-02: every build,
            // including one whose profile carried the entitlement, showed
            // "MET Norway" because the App ID had WeatherKit enabled under
            // Capabilities but not under App Services, and this catch was
            // silent. Name the error so the next diagnosis reads it here.
            DaemonLogger.shared.error(
                "WeatherKit request failed; showing the portable feed instead: \(error)"
            )
            return false
        }
    }
    #endif
}

#if os(macOS)
private struct DashboardWeatherPill: View {
    let weather: DashboardWeatherSnapshot

    private var symbol: String {
        switch weather.code ?? 2 {
        case 0: "sun.max.fill"
        case 1...2: "cloud.sun.fill"
        case 3: "cloud.fill"
        case 45, 48: "cloud.fog.fill"
        case 71...77, 85, 86: "cloud.snow.fill"
        case 95...99: "cloud.bolt.rain.fill"
        case 51...67, 80...82: "cloud.rain.fill"
        default: "cloud.sun.fill"
        }
    }

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: symbol)
                .font(.system(size: 18, weight: .medium))
                .symbolRenderingMode(.hierarchical)
                .foregroundStyle(TerrariumHUD.tetraNeon)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    if let tempC = weather.tempC { Text("\(tempC)°") }
                    if let summary = weather.summary { Text(summary) }
                }
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                HStack(spacing: 5) {
                    if let low = weather.todayMinC, let high = weather.todayMaxC {
                        Text("L \(low)°  H \(high)°")
                    }
                    if let place = weather.place { Text(place) }
                }
                .font(.system(size: 9, design: .rounded))
                .foregroundStyle(TerrariumHUD.subtext)
            }
            if let source = weather.source,
               let legalURL = URL(string: source.attributionUrl) {
                Link(destination: legalURL) {
                    Group {
                        if let mark = source.markUrlDark.flatMap(URL.init(string:)) {
                            AsyncImage(url: mark) { image in
                                image.resizable().scaledToFit()
                            } placeholder: {
                                // WeatherKit's mark is fetched independently
                                // from the forecast. Keep the required
                                // trademark visible if that image is still
                                // loading or temporarily unavailable.
                                Text(source.id == "apple-weather" ? " Weather" : source.displayName)
                            }
                        } else {
                            Text(source.id == "apple-weather" ? " Weather" : source.displayName)
                        }
                    }
                    .font(.system(size: 8, weight: .medium))
                    .frame(maxWidth: 74, maxHeight: 12)
                    .foregroundStyle(TerrariumHUD.subtext)
                }
                .buttonStyle(.plain)
                .help("Weather data attribution")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(TerrariumHUD.bg.opacity(0.82), in: Capsule())
        .overlay(Capsule().stroke(TerrariumHUD.tetraNeon.opacity(0.18), lineWidth: 0.5))
        .accessibilityElement(children: .combine)
    }
}
#endif

private struct CompactDashboardHUDSwitcher: View {
    let pages: [CompactDashboardHUDPage]
    let selection: CompactDashboardHUDPage
    let onSelect: (CompactDashboardHUDPage) -> Void

    var body: some View {
        HStack(spacing: 3) {
            ForEach(pages) { page in
                Button {
                    onSelect(page)
                } label: {
                    Text(page.rawValue)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(
                            selection == page ? TerrariumHUD.text : TerrariumHUD.subtext
                        )
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(
                            selection == page
                                ? TerrariumHUD.tetraNeon.opacity(0.18)
                                : Color.clear,
                            in: RoundedRectangle(cornerRadius: 6)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Show \(page.rawValue.lowercased())")
            }
        }
        .padding(3)
        .background(TerrariumHUD.bg, in: RoundedRectangle(cornerRadius: 8))
    }
}

// MARK: - Stale Data Banner

private struct StaleDataBanner: View {
    let lastReceived: Date
    @State private var now = Date()

    private let timer = Timer.publish(every: 10, on: .main, in: .common).autoconnect()

    private var timeAgoText: String {
        let elapsed = now.timeIntervalSince(lastReceived)
        if elapsed < 60 {
            return "\(Int(elapsed))s"
        } else if elapsed < 3600 {
            return "\(Int(elapsed / 60))m"
        } else {
            return "\(Int(elapsed / 3600))h"
        }
    }

    var body: some View {
        Text("Data from \(timeAgoText) ago")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(.ultraThinMaterial, in: Capsule())
            .onReceive(timer) { self.now = $0 }
    }
}
