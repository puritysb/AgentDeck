import XCTest
@testable import AgentDeck
#if os(macOS)
import UserNotifications
#endif

#if os(iOS)
import SwiftUI
import UIKit

@MainActor
final class CompanionOnboardingLayoutTests: XCTestCase {
    func testConnectionGuidanceScrollsWithRecoveryAbovePinnedControls() async throws {
        let suite = "CompanionOnboarding.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = AppPreferences(defaults: defaults)
        let state = AgentStateHolder()
        for (size, typeSize) in [
            (CGSize(width: 375, height: 667), DynamicTypeSize.large),
            (CGSize(width: 667, height: 375), .large),
            (CGSize(width: 375, height: 667), .accessibility3),
            (CGSize(width: 768, height: 1024), .large),
        ] {
            let view = OnboardingScreen(connecting: true)
                .environmentObject(preferences)
                .environmentObject(state)
                .environment(\.dynamicTypeSize, typeSize)
            let host = UIHostingController(rootView: view)
            let window = UIWindow(frame: CGRect(origin: .zero, size: size))
            window.rootViewController = host
            window.makeKeyAndVisible()
            host.view.frame = window.bounds
            host.view.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
            host.view.layoutIfNeeded()

            func scrollViews(in view: UIView) -> [UIScrollView] {
                ((view as? UIScrollView).map { [$0] } ?? []) + view.subviews.flatMap { scrollViews(in: $0) }
            }
            let scrolls = scrollViews(in: host.view)
            XCTAssertEqual(scrolls.count, 1, "Guidance and recovery must share one scroll surface")
            let scroll = try XCTUnwrap(scrolls.first)
            let frame = scroll.convert(scroll.bounds, to: host.view)
            XCTAssertLessThanOrEqual(frame.minY, host.view.safeAreaInsets.top + 1,
                "A fixed heading above the scroll view truncates setup instructions on small phones")
            XCTAssertLessThan(frame.maxY, host.view.bounds.maxY - 44,
                "Back / Dashboard / Explore must remain outside the scrolling content")
            if typeSize.isAccessibilitySize || size.height < 400 {
                XCTAssertGreaterThan(scroll.contentSize.height, scroll.bounds.height)
            }
            let renderer = UIGraphicsImageRenderer(bounds: host.view.bounds)
            let screenshot = renderer.image { _ in host.view.drawHierarchy(in: host.view.bounds, afterScreenUpdates: true) }
            let attachment = XCTAttachment(image: screenshot)
            attachment.name = "companion-setup-\(Int(size.width))x\(Int(size.height))-\(typeSize)"
            attachment.lifetime = .keepAlways
            add(attachment)
            window.isHidden = true
        }
        XCTAssertFalse(preferences.hasSeenOnboarding)
    }
}
#endif

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
    func testCompanionDoesNotInferMissingMacSetupFromMissingData() {
        for descriptor in IntegrationCatalog.all {
            let status = IntegrationStatusEvaluator.companionStatus(for: descriptor,
                state: DashboardState(), hostConnected: true)
            XCTAssertEqual(status.label, "Awaiting data", descriptor.id)
            XCTAssertFalse(status.needsAttention, descriptor.id)
            XCTAssertTrue(status.detail?.contains("on your Mac") == true, descriptor.id)
        }
    }

    func testCompanionUsesLiveSessionsAndRejectsDisconnectedCachedEvidence() {
        var state = DashboardState()
        state.siblingSessions = [SessionInfo(id: "test", port: 9120, projectName: "Fixture", agentType: "claude-code")]
        let received = IntegrationStatusEvaluator.companionStatus(for: IntegrationCatalog.claudeCode,
            state: state, hostConnected: true)
        XCTAssertEqual(received.label, "Connected")
        XCTAssertEqual(IntegrationStatusEvaluator.companionStatus(for: IntegrationCatalog.claudeCode,
            state: state, hostConnected: false).label, "Awaiting data")
        state.siblingSessions[0].alive = false
        XCTAssertEqual(IntegrationStatusEvaluator.companionStatus(for: IntegrationCatalog.claudeCode,
            state: state, hostConnected: true).label, "Awaiting data")
    }

    func testCompanionKeepsExplicitHostFailuresActionableOnTheMac() {
        var state = DashboardState()
        state.gatewayAuthStatus = "auth_failed"
        state.siblingSessions = [SessionInfo(id: "cached", port: 9120, projectName: "Fixture", agentType: "openclaw")]
        let failure = IntegrationStatusEvaluator.companionStatus(for: IntegrationCatalog.openClaw,
            state: state, hostConnected: true)
        XCTAssertEqual(failure.label, "Auth failed")
        XCTAssertTrue(failure.detail?.contains("on your Mac") == true)
        state.gatewayAuthStatus = "unsupported_protocol"
        XCTAssertEqual(IntegrationStatusEvaluator.companionStatus(for: IntegrationCatalog.openClaw,
            state: state, hostConnected: true).label, "Unsupported")
    }

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

#if os(macOS)
/// The onboarding / Settings "Choose Notifications…" press is the only place
/// AgentDeck asks for notifications, so each system state must lead somewhere
/// the user can act on — never a second dialog in front of the system's own,
/// and never a dead end once the system has said no.
final class NotificationPermissionChoiceTests: XCTestCase {
    func testUndecidedGoesStraightToTheSystemDialog() {
        XCTAssertEqual(NotificationPermission.action(for: .notDetermined), .requestAuthorization)
    }

    func testDeniedOffersSystemSettingsInsteadOfARetryThatCannotWork() {
        XCTAssertEqual(NotificationPermission.action(for: .denied), .explainDenied)
    }

    func testEveryGrantedStateReadsAsOn() {
        for status: UNAuthorizationStatus in [.authorized, .provisional] {
            XCTAssertEqual(NotificationPermission.action(for: status), .confirmEnabled)
        }
    }

    func testSettingsURLOpensAgentDecksOwnPage() {
        let url = NotificationPermission.settingsURL(bundleIdentifier: "bound.serendipity.agent.deck")
        XCTAssertEqual(url.scheme, "x-apple.systempreferences")
        XCTAssertTrue(url.absoluteString.hasPrefix("x-apple.systempreferences:com.apple.Notifications-Settings.extension"))
        XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value,
                       "bound.serendipity.agent.deck")
        XCTAssertNil(URLComponents(url: NotificationPermission.settingsURL(bundleIdentifier: nil),
                                   resolvingAgainstBaseURL: false)?.queryItems)
    }
}
#endif
