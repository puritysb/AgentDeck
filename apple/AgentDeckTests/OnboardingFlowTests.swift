import XCTest
@testable import AgentDeck

@MainActor
final class OnboardingFlowTests: XCTestCase {
    func testBackAndContinuePreserveDeviceInterestAndBoundNavigation() {
        let flow = OnboardingFlow()
        flow.back()
        XCTAssertEqual(flow.step, .appearance)
        flow.next()
        flow.next()
        flow.interest = .streamDeck
        flow.back()
        XCTAssertEqual(flow.step, .agents)
        flow.next()
        flow.next()
        XCTAssertEqual(flow.step, .ready)
        XCTAssertEqual(flow.interest, .streamDeck)
    }

    func testAuthorizationIsNotEvidenceOfLiveActivity() {
        XCTAssertEqual(OnboardingFlow.Observation.resolve(installed: true, live: false), .ready)
        XCTAssertEqual(OnboardingFlow.Observation.resolve(installed: false, live: true), .receiving)
        // Cancel/failure leaves setup incomplete; an explicit successful retry
        // becomes ready, only receipt of a session changes it to receiving.
        let sequence = [(false, false), (false, false), (true, false), (true, true)]
        XCTAssertEqual(sequence.map { OnboardingFlow.Observation.resolve(installed: $0.0, live: $0.1) },
                       [.notConfigured, .notConfigured, .ready, .receiving])
    }

    func testSkippedAndUnselectedAgentsDoNotBecomeSetupWarnings() {
        XCTAssertFalse(OnboardingFlow.shouldSuggest("codex", selected: [], configured: false, live: false))
        XCTAssertFalse(OnboardingFlow.shouldSuggest("codex", selected: ["claude"], configured: false, live: false))
        XCTAssertTrue(OnboardingFlow.shouldSuggest("claude", selected: ["claude"], configured: false, live: false))
    }

    func testReturningUsersAndLaterSettingsOptInKeepRecovery() {
        XCTAssertTrue(OnboardingFlow.shouldSuggest("codex", selected: nil, configured: false, live: false))
        XCTAssertTrue(OnboardingFlow.shouldSuggest("codex", selected: [], configured: true, live: false))
        XCTAssertTrue(OnboardingFlow.shouldSuggest("codex", selected: [], configured: false, live: true))
    }
}

@MainActor
final class OnboardingPreferenceTests: XCTestCase {
    func testAppearanceAndExplicitSkipSurviveReopeningWithoutChangingConsent() {
        let suite = "OnboardingTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = AppPreferences(defaults: defaults)
        XCTAssertNil(first.onboardingAgents)
        first.dashboardType = .aquarium3D
        first.onboardingAgents = []
        first.hasSeenOnboarding = true
        let reopened = AppPreferences(defaults: defaults)
        XCTAssertEqual(reopened.dashboardType, .aquarium3D)
        XCTAssertEqual(reopened.onboardingAgents, [])
        XCTAssertEqual(reopened.hookInstallConsent, .unknown)
        XCTAssertEqual(reopened.codexConfigConsent, .unknown)
        reopened.hasSeenOnboarding = false
        XCTAssertEqual(reopened.dashboardType, .aquarium3D)
        XCTAssertEqual(reopened.onboardingAgents, [])
    }
}

#if os(macOS)
import AppKit
import SwiftUI

@MainActor
final class OnboardingPresentationTests: XCTestCase {
    func testFirstRunPagesRenderWithNoAgentsOrDevices() async throws {
        let suite = "OnboardingRender.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let prefs = AppPreferences(defaults: defaults)
        let state = AgentStateHolder()
        let daemon = DaemonService() // XCTest guard prevents starting the hub.
        let flow = OnboardingFlow()
        for page in ["appearance", "agents", "ready", "stream-deck", "displays"] {
            if page == "agents" || page == "ready" { flow.next() }
            if page == "stream-deck" { flow.interest = .streamDeck }
            if page == "displays" { flow.interest = .displays }
            let view = OnboardingSheet(flow: flow)
                .environmentObject(prefs)
                .environmentObject(state)
                .environmentObject(daemon)
                .environment(\.colorScheme, .light)
                .background(Color(nsColor: .windowBackgroundColor))
            let host = NSHostingView(rootView: view)
            host.appearance = NSAppearance(named: .aqua)
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 680, height: 660),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: .aqua)
            window.contentView = host
            host.frame = NSRect(x: 0, y: 0, width: 680, height: 660)
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(150))
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.png")
            attachment.name = "onboarding-\(page)"
            attachment.lifetime = .keepAlways
            add(attachment)
            XCTAssertFalse(prefs.hooksInstalled)
            XCTAssertFalse(prefs.codexConfigInstalled)
            XCTAssertEqual(prefs.hookInstallConsent, .unknown)
            XCTAssertEqual(prefs.codexConfigConsent, .unknown)
        }
    }
}
#endif

@MainActor
final class OnboardingIntegrationTests: XCTestCase {
    func testOpenCodeEnabledDoesNotClaimAConnectionBeforeASessionArrives() {
        let suite = "OnboardingIntegration.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let prefs = AppPreferences(defaults: defaults)
        prefs.openCodeMonitoringEnabled = true
        let status = IntegrationStatusEvaluator.status(for: IntegrationCatalog.openCode,
            state: DashboardState(), preferences: prefs, anthropicKeySaved: false)
        XCTAssertEqual(status.label, "Awaiting data")
        XCTAssertFalse(status.needsAttention)
    }
}
