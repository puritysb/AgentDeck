// ProtocolTests.swift — Protocol decoding tests

import XCTest
@testable import AgentDeck

final class ProtocolTests: XCTestCase {

    // MARK: - iOS display sleep policy

    func testDisplaySyncFullOffRemainsAtZeroUntilWake() {
        let dim = DisplayDimInstruction(enabled: true, mode: "off", level: 10)
        XCTAssertEqual(
            DisplaySyncService.resolvedBrightness(displayOn: false, syncEnabled: true, dim: dim),
            0
        )
        XCTAssertNil(
            DisplaySyncService.resolvedBrightness(displayOn: true, syncEnabled: true, dim: dim)
        )
    }

    func testDisplaySyncLegacyEventUsesFullOff() {
        XCTAssertEqual(
            DisplaySyncService.resolvedBrightness(displayOn: false, syncEnabled: true, dim: nil),
            0
        )
    }

    func testDisplaySyncMinimumBrightnessIsClamped() {
        XCTAssertEqual(
            DisplaySyncService.resolvedBrightness(
                displayOn: false,
                syncEnabled: true,
                dim: DisplayDimInstruction(enabled: true, mode: "min", level: 25)
            ),
            0.25
        )
        XCTAssertEqual(
            DisplaySyncService.resolvedBrightness(
                displayOn: false,
                syncEnabled: true,
                dim: DisplayDimInstruction(enabled: true, mode: "min", level: 250)
            ),
            1.0
        )
    }

    func testDisplaySyncDisabledRestoresBrightness() {
        let dim = DisplayDimInstruction(enabled: true, mode: "off", level: 10)
        XCTAssertNil(
            DisplaySyncService.resolvedBrightness(displayOn: false, syncEnabled: false, dim: dim)
        )
        XCTAssertNil(
            DisplaySyncService.resolvedBrightness(
                displayOn: false,
                syncEnabled: true,
                dim: DisplayDimInstruction(enabled: false, mode: "off", level: 10)
            )
        )
    }

    // MARK: - Session Display Formatting

    func testDisplayShortModelNameCompactsProviderQualifiedIds() {
        XCTAssertEqual(
            displayShortModelName("openrouter/anthropic/claude-sonnet-4-5-20250929"),
            "sonnet-4-5"
        )
        XCTAssertEqual(
            displayShortModelName("openai/gpt-5.1-codex-max"),
            "5.1-codex-max"
        )
    }

    func testDisplayShortModelNameCanFitNarrowHudRows() {
        let label = displayShortModelName("deepseek/deepseek-r1-distill-llama-70b", maxLength: 18)
        XCTAssertLessThanOrEqual(label.count, 18)
        XCTAssertTrue(label.hasPrefix("deepseek-r"))
        XCTAssertTrue(label.hasSuffix("70b"))
    }

    // MARK: - State Update Decoding

    func testDecodeStateUpdate() throws {
        let json = """
        {
            "type": "state_update",
            "state": "processing",
            "permissionMode": "default",
            "projectName": "my-project",
            "modelName": "opus-4",
            "currentTool": "Read",
            "toolInput": "src/main.ts",
            "gatewayAvailable": true,
            "gatewayConnected": false
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .stateUpdate(let e) = event else {
            XCTFail("Expected stateUpdate, got \(String(describing: event))")
            return
        }

        XCTAssertEqual(e.state, "processing")
        XCTAssertEqual(e.permissionMode, "default")
        XCTAssertEqual(e.projectName, "my-project")
        XCTAssertEqual(e.modelName, "opus-4")
        XCTAssertEqual(e.currentTool, "Read")
        XCTAssertEqual(e.toolInput, "src/main.ts")
        XCTAssertEqual(e.gatewayAvailable, true)
        XCTAssertEqual(e.gatewayConnected, false)
    }

    func testDecodeStateUpdateWithCapabilities() throws {
        let json = """
        {
            "type": "state_update",
            "state": "idle",
            "agentType": "claude-code",
            "agentCapabilities": {
                "type": "claude-code",
                "displayName": "Claude Code",
                "hasTerminal": true,
                "hasModeSwitching": true,
                "hasDiffReview": true,
                "hasOptionLists": true,
                "hasNavigablePrompts": true,
                "hasSuggestedPrompts": true,
                "hasApiUsage": true
            }
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .stateUpdate(let e) = event else {
            XCTFail("Expected stateUpdate")
            return
        }

        XCTAssertEqual(e.agentType, "claude-code")
        XCTAssertNotNil(e.agentCapabilities)
        XCTAssertEqual(e.agentCapabilities?.hasTerminal, true)
        XCTAssertEqual(e.agentCapabilities?.displayName, "Claude Code")
    }

    func testDecodeStateUpdateWithFreeformPromptOptionKind() throws {
        let json = """
        {
            "type": "state_update",
            "state": "awaiting_option",
            "options": [
                {"index": 0, "label": "Proceed"},
                {"index": 3, "label": "Type custom instructions", "kind": "freeform_input"}
            ],
            "promptType": "multi_select",
            "navigable": true,
            "cursorIndex": 0
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .stateUpdate(let e) = event else {
            XCTFail("Expected stateUpdate")
            return
        }

        XCTAssertEqual(e.options?.count, 2)
        XCTAssertEqual(e.options?[1].kind, "freeform_input")
        XCTAssertEqual(e.options?[1].isFreeformInput, true)
    }

    func testDecodeStateUpdateWithCodexAuthMetadata() throws {
        let json = """
        {
            "type": "state_update",
            "state": "idle",
            "codexAuthMode": "chatgpt",
            "codexWebAuthConnected": true,
            "codexPlanType": "plus",
            "codexSubscriptionActiveUntil": "2026-05-01T00:00:00Z"
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .stateUpdate(let e) = event else {
            XCTFail("Expected stateUpdate")
            return
        }

        XCTAssertEqual(e.codexAuthMode, "chatgpt")
        XCTAssertEqual(e.codexWebAuthConnected, true)
        XCTAssertEqual(e.codexPlanType, "plus")
        XCTAssertEqual(e.codexSubscriptionActiveUntil, "2026-05-01T00:00:00Z")
    }

    func testDecodeModuleHealthTuiAndWifiEsp32() throws {
        let json = """
        {
            "type": "state_update",
            "state": "idle",
            "moduleHealth": {
                "tuiDashboards": {
                    "available": true,
                    "devices": [{"id": "myhost#42", "name": "myhost", "kind": "tui"}]
                },
                "esp32Wifi": {
                    "available": true,
                    "devices": [
                        {"board": "inkdeck", "ip": "192.168.68.64", "version": "0.1.2", "stale": false, "serialActive": false},
                        {"board": "ulanzi_tc001", "ip": "192.168.68.57", "stale": false, "serialActive": true}
                    ]
                },
                "serial": {
                    "connections": [
                        {"port": "/dev/cu.wchusbserial21130", "connected": true,
                         "deviceInfo": {"board": "ulanzi_tc001", "version": "0.1.2", "wifiConnected": true}}
                    ]
                }
            }
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .stateUpdate(let e) = event else {
            XCTFail("Expected stateUpdate")
            return
        }

        let tui = try XCTUnwrap(e.moduleHealth?.tuiDashboards)
        XCTAssertEqual(tui.devices, [TuiClientInfo(id: "myhost#42", name: "myhost")])

        let wifi = try XCTUnwrap(e.moduleHealth?.esp32Wifi)
        XCTAssertEqual(wifi.devices.count, 2)
        XCTAssertEqual(wifi.devices[0].board, "inkdeck")
        XCTAssertEqual(wifi.devices[0].ip, "192.168.68.64")
        XCTAssertFalse(wifi.devices[0].serialActive)
        // Dual-homed board carries serialActive so the rail can suppress it.
        XCTAssertTrue(wifi.devices[1].serialActive)

        let serialBoards = try XCTUnwrap(e.moduleHealth?.serial?.connectedBoards)
        XCTAssertEqual(serialBoards.first?.wifiConnected, true)
    }

    #if os(macOS)
    func testCodexObservationSetupDoesNotRequirePriorCodexAuthSignal() {
        XCTAssertTrue(AgentStateHolder.shouldShowCodexObservationSetup(
            codexAuthMode: nil,
            codexConfigInstalled: false,
            codexConfigConsent: .unknown
        ))
        XCTAssertFalse(AgentStateHolder.shouldShowCodexObservationSetup(
            codexAuthMode: nil,
            codexConfigInstalled: true,
            codexConfigConsent: .accepted
        ))
        XCTAssertFalse(AgentStateHolder.shouldShowCodexObservationSetup(
            codexAuthMode: "chatgpt",
            codexConfigInstalled: false,
            codexConfigConsent: .declined
        ))
    }

    func testClaudeSetupIsHiddenWhenOnlyOtherAgentsAreVisible() {
        var state = DashboardState()
        state.state = .idle
        state.agentType = "openclaw"
        state.siblingSessions = [
            SessionInfo(
                id: "codex-app",
                port: 0,
                projectName: "AgentDeck",
                agentType: "codex-app"
            )
        ]

        XCTAssertFalse(AgentStateHolder.shouldSurfaceClaudeSetup(for: state))
    }

    func testClaudeSetupStillShowsForEmptyOrClaudeSetups() {
        XCTAssertTrue(AgentStateHolder.shouldSurfaceClaudeSetup(for: DashboardState()))

        var state = DashboardState()
        state.siblingSessions = [
            SessionInfo(
                id: "claude",
                port: 0,
                projectName: "AgentDeck",
                agentType: "claude-code"
            )
        ]

        XCTAssertTrue(AgentStateHolder.shouldSurfaceClaudeSetup(for: state))
    }
    #endif

    func testIOSSetupPolicyDoesNotInferClaudeSetupFromSessionAbsence() {
        XCTAssertEqual(
            AgentStateHolder.iOSSetupDescriptors.map(\.id),
            [IntegrationCatalog.openClaw.id]
        )
        XCTAssertFalse(
            AgentStateHolder.iOSSetupDescriptors.contains { $0.id == IntegrationCatalog.claudeCode.id },
            "An idle Claude session list is not evidence that Mac-owned hooks are unconfigured"
        )
    }

    // MARK: - Usage Update

    func testDecodeUsageUpdate() throws {
        let json = """
        {
            "type": "usage_update",
            "sessionDurationSec": 3600,
            "inputTokens": 50000,
            "outputTokens": 25000,
            "toolCalls": 42,
            "fiveHourPercent": 72.5,
            "fiveHourResetsAt": "2026-03-12T18:00:00Z",
            "sevenDayPercent": 45.0,
            "oauthConnected": true
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .usageUpdate(let e) = event else {
            XCTFail("Expected usageUpdate")
            return
        }

        XCTAssertEqual(e.sessionDurationSec, 3600)
        XCTAssertEqual(e.inputTokens, 50000)
        XCTAssertEqual(e.outputTokens, 25000)
        XCTAssertEqual(e.toolCalls, 42)
        XCTAssertEqual(e.fiveHourPercent, 72.5)
        XCTAssertEqual(e.oauthConnected, true)
    }

    /// Usage fields merge retain-on-absent, which made `usageStale` a one-way
    /// latch: the Node daemon's cold-cache connect frame set it true and — with
    /// the key omitted whenever fresh — nothing could retract it, so the macOS
    /// Dashboard showed "stale" over live percentages until restart
    /// (2026-07-25).
    func testUsageStaleUnlatchesWhenAFrameCarriesFreshQuotaNumbers() {
        // The regression itself: live numbers with no explicit flag must
        // retract a latched stale badge.
        XCTAssertEqual(
            AgentStateHolder.mergedUsageStale(incoming: nil, frameHasQuota: true, previous: true),
            false
        )
        // An explicit true outranks data presence — the daemon legitimately
        // sends "had data, now stale" with percentages still riding along, and
        // handleUsageUpdate relies on that true to scrub the values.
        XCTAssertEqual(
            AgentStateHolder.mergedUsageStale(incoming: true, frameHasQuota: true, previous: false),
            true
        )
        // Neither flag nor numbers → retain; a partial frame must not claim
        // freshness.
        XCTAssertEqual(
            AgentStateHolder.mergedUsageStale(incoming: nil, frameHasQuota: false, previous: true),
            true
        )
        // An explicit false always wins.
        XCTAssertEqual(
            AgentStateHolder.mergedUsageStale(incoming: false, frameHasQuota: false, previous: true),
            false
        )
    }

    // MARK: - Connection Event

    func testDecodeConnectionEvent() throws {
        let json = """
        {"type": "connection", "status": "connected", "sessionId": "abc123"}
        """

        let event = BridgeEventParser.parse(json)
        guard case .connection(let e) = event else {
            XCTFail("Expected connection")
            return
        }

        XCTAssertEqual(e.status, "connected")
        XCTAssertEqual(e.sessionId, "abc123")
    }

    // MARK: - Sessions List

    func testDecodeSessionsList() throws {
        let json = """
        {
            "type": "sessions_list",
            "sessions": [
                {"id": "s1", "port": 9120, "projectName": "proj1", "agentType": "claude-code", "alive": true},
                {"id": "s2", "port": 9121, "projectName": "proj2", "alive": false}
            ]
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .sessionsList(let e) = event else {
            XCTFail("Expected sessionsList")
            return
        }

        XCTAssertEqual(e.sessions.count, 2)
        XCTAssertEqual(e.sessions[0].projectName, "proj1")
        XCTAssertEqual(e.sessions[0].agentType, "claude-code")
        XCTAssertEqual(e.sessions[1].alive, false)
    }

    // MARK: - Button State

    func testDecodeButtonState() throws {
        let json = """
        {
            "type": "button_state",
            "buttons": [
                {"slot": 0, "title": "DEFAULT", "bgColor": "#1e293b", "textColor": "#ffffff", "enabled": true, "action": "switch_mode"},
                {"slot": 7, "title": "STOP", "bgColor": "#991b1b", "textColor": "#ffffff", "enabled": true, "icon": "■", "action": "interrupt"}
            ]
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .buttonState(let e) = event else {
            XCTFail("Expected buttonState")
            return
        }

        XCTAssertEqual(e.buttons.count, 2)
        XCTAssertEqual(e.buttons[0].action, "switch_mode")
        XCTAssertEqual(e.buttons[1].icon, "■")
    }

    // MARK: - Encoder State

    func testDecodeEncoderState() throws {
        let json = """
        {
            "type": "encoder_state",
            "encoders": [
                {"slot": 0, "encoderType": "utility", "header": "VOLUME", "value": "65%", "icon": "🔊", "accentColor": "#22d3ee"},
                {"slot": 3, "encoderType": "voice", "header": "VOICE", "value": "Ready", "accentColor": "#a855f7", "voiceState": "idle"}
            ],
            "takeoverActive": false
        }
        """

        let event = BridgeEventParser.parse(json)
        guard case .encoderState(let e) = event else {
            XCTFail("Expected encoderState")
            return
        }

        XCTAssertEqual(e.encoders.count, 2)
        XCTAssertEqual(e.encoders[0].header, "VOLUME")
        XCTAssertEqual(e.encoders[1].voiceState, "idle")
        XCTAssertEqual(e.takeoverActive, false)
    }

    // MARK: - Unknown Event

    func testUnknownEventReturnsNil() {
        let json = """
        {"type": "future_event", "data": {}}
        """
        XCTAssertNil(BridgeEventParser.parse(json))
    }

    func testInvalidJsonReturnsNil() {
        XCTAssertNil(BridgeEventParser.parse("not json"))
        XCTAssertNil(BridgeEventParser.parse(""))
    }

    // MARK: - Plugin Command Encoding

    func testEncodeRespondCommand() throws {
        let cmd = PluginCommand.respond(value: "y")
        let data = try JSONEncoder().encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        XCTAssertEqual(json?["type"] as? String, "respond")
        XCTAssertEqual(json?["value"] as? String, "y")
    }

    func testEncodeSelectOptionCommand() throws {
        let cmd = PluginCommand.selectOption(index: 2)
        let data = try JSONEncoder().encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        XCTAssertEqual(json?["type"] as? String, "select_option")
        XCTAssertEqual(json?["index"] as? Int, 2)
    }

    func testEncodeSwitchModeCommand() throws {
        let cmd = PluginCommand.switchMode(mode: "plan")
        let data = try JSONEncoder().encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        XCTAssertEqual(json?["type"] as? String, "switch_mode")
        XCTAssertEqual(json?["mode"] as? String, "plan")
    }

    func testEncodeInterruptCommand() throws {
        let cmd = PluginCommand.interrupt
        let data = try JSONEncoder().encode(cmd)
        let json = try JSONSerialization.jsonObject(with: data) as? [String: Any]

        XCTAssertEqual(json?["type"] as? String, "interrupt")
    }

    #if os(macOS)
    func testStabilizeCodexAuthStatusPreservesChatGptPlanAcrossPartialRefresh() {
        let previous = CodexAuthStatus(
            authMode: "chatgpt",
            webAuthConnected: true,
            accessTokenPresent: true,
            planType: "plus",
            accountId: "acct_123",
            subscriptionActiveUntil: "2026-05-01",
            lastRefreshAt: "2026-04-09T00:00:00Z"
        )
        let current = CodexAuthStatus(
            authMode: nil,
            webAuthConnected: false,
            accessTokenPresent: true,
            planType: nil,
            accountId: nil,
            subscriptionActiveUntil: nil,
            lastRefreshAt: "2026-04-09T00:01:00Z"
        )

        let stabilized = UsageAPIClient.stabilizeCodexAuthStatus(previous: previous, current: current)

        XCTAssertEqual(stabilized?.authMode, "chatgpt")
        XCTAssertEqual(stabilized?.planType, "plus")
        XCTAssertEqual(stabilized?.accountId, "acct_123")
        XCTAssertEqual(stabilized?.subscriptionActiveUntil, "2026-05-01")
        XCTAssertEqual(stabilized?.lastRefreshAt, "2026-04-09T00:01:00Z")
    }

    func testStabilizeCodexAuthStatusDropsCachedChatGptPlanWhenAuthModeChanges() {
        let previous = CodexAuthStatus(
            authMode: "chatgpt",
            webAuthConnected: true,
            accessTokenPresent: true,
            planType: "plus",
            accountId: "acct_123",
            subscriptionActiveUntil: "2026-05-01",
            lastRefreshAt: nil
        )
        let current = CodexAuthStatus(
            authMode: "api",
            webAuthConnected: false,
            accessTokenPresent: false,
            planType: nil,
            accountId: nil,
            subscriptionActiveUntil: nil,
            lastRefreshAt: nil
        )

        let stabilized = UsageAPIClient.stabilizeCodexAuthStatus(previous: previous, current: current)

        XCTAssertEqual(stabilized?.authMode, "api")
        XCTAssertNil(stabilized?.planType)
    }

    // MARK: - Codex rollout selection (Node parity)

    /// The Swift daemon used to descend to the single newest day-directory and
    /// pick the newest file inside it, with no fall-through. That silently
    /// disagreed with the Node daemon on the same tree: a session started
    /// yesterday and still appending is the live one, while a fresh session that
    /// merely created today's directory carries no `rate_limits` at all. Port of
    /// `candidateRolloutFiles` + `parseFirstUsable` (bridge/src/codex-rate-limits.ts).
    func testCodexRolloutSelectionPrefersTheActivePriorDaySession() throws {
        let root = try makeCodexSessionsTree([
            // Newer day-dir, no rate_limits, older mtime.
            ("2026/08/05/rollout-2026-08-05T00-30-39-fresh.jsonl",
             "{\"type\":\"session_meta\"}\n",
             "2026-08-05T00:30:39Z"),
            // Prior day-dir, live snapshot, NEWEST mtime (still appending).
            ("2026/08/04/rollout-2026-08-04T20-30-56-active.jsonl",
             codexRolloutLine(usedPercent: 94, timestamp: "2026-08-04T18:38:42.076Z") + "\n",
             "2026-08-04T18:38:42Z"),
        ])
        defer { try? FileManager.default.removeItem(at: root) }

        let candidates = UsageAPIClient.codexRolloutCandidates(sessionsDir: root)
        let parsed = UsageAPIClient.parseFirstUsableCodexRollout(candidates)
        XCTAssertEqual(parsed?.primary?.usedPercent, 94)
        XCTAssertEqual(parsed?.capturedAt, "2026-08-04T18:38:42.076Z")
    }

    func testCodexRolloutSelectionFallsBackToFileMtime() throws {
        let root = try makeCodexSessionsTree([
            ("2026/08/04/rollout-2026-08-04T20-30-56-active.jsonl",
             codexRolloutLine(usedPercent: 41, timestamp: nil) + "\n",
             "2026-08-04T18:38:42Z"),
        ])
        defer { try? FileManager.default.removeItem(at: root) }

        let parsed = UsageAPIClient.parseFirstUsableCodexRollout(
            UsageAPIClient.codexRolloutCandidates(sessionsDir: root)
        )
        XCTAssertEqual(parsed?.primary?.usedPercent, 41)
        XCTAssertEqual(parsed?.capturedAt, "2026-08-04T18:38:42.000Z")
    }

    private func codexRolloutLine(usedPercent: Double, timestamp: String?) -> String {
        let ts = timestamp.map { "\"timestamp\":\"\($0)\"," } ?? ""
        return "{\(ts)\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"rate_limits\":"
            + "{\"limit_id\":\"codex\",\"primary\":{\"used_percent\":\(usedPercent),"
            + "\"window_minutes\":10080,\"resets_at\":1786459585},\"plan_type\":\"plus\"}}}"
    }

    /// Build a temp `<root>/YYYY/MM/DD/rollout-*.jsonl` tree with explicit mtimes.
    private func makeCodexSessionsTree(_ files: [(String, String, String)]) throws -> URL {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("codex-sessions-\(UUID().uuidString)")
        for (rel, content, mtime) in files {
            let full = root.appendingPathComponent(rel)
            try fm.createDirectory(at: full.deletingLastPathComponent(), withIntermediateDirectories: true)
            try content.write(to: full, atomically: true, encoding: .utf8)
            let date = ISO8601DateFormatter().date(from: mtime)!
            try fm.setAttributes([.modificationDate: date], ofItemAtPath: full.path)
        }
        return root
    }

    // MARK: - Codex snapshot freshness (mirror of shared/src/format-utils.ts)

    // Codex usage is a passive read of local rollout files: the numbers freeze the
    // moment Codex stops being used. `stale` cannot expose that — it fires only
    // once the WINDOW has ended, and the weekly window stays in the future for up
    // to 7 days. These pin the age half of the model, in lockstep with the TS SSOT
    // (`shared/src/__tests__/format-utils.test.ts` → "codex snapshot freshness").

    private var freshnessNow: Date {
        ISO8601DateFormatter().date(from: "2026-08-05T07:27:00Z")!
    }

    private func capturedAgo(_ seconds: TimeInterval) -> String {
        UsageAPIClient.codexCaptureISOString(freshnessNow.addingTimeInterval(-seconds))
    }

    func testCodexSnapshotThresholdMatchesTypeScript() {
        // 30 minutes, absolute — a fraction of the window length would scale to
        // 8h+ on the weekly window and never fire.
        XCTAssertEqual(CodexUsageFreshness.snapshotStaleInterval, 30 * 60)
    }

    func testCodexSnapshotAgeIgnoresMissingAndMalformedStamps() {
        XCTAssertNil(CodexUsageFreshness.snapshotAge(nil, now: freshnessNow))
        XCTAssertNil(CodexUsageFreshness.snapshotAge("not-a-date", now: freshnessNow))
        XCTAssertFalse(CodexUsageFreshness.isSnapshotAged(nil, now: freshnessNow))
        XCTAssertFalse(CodexUsageFreshness.isSnapshotAged("not-a-date", now: freshnessNow))
    }

    func testCodexSnapshotAgedOnlyPastTheThreshold() {
        XCTAssertFalse(CodexUsageFreshness.isSnapshotAged(capturedAgo(30 * 60), now: freshnessNow))
        XCTAssertTrue(CodexUsageFreshness.isSnapshotAged(capturedAgo(30 * 60 + 1), now: freshnessNow))
    }

    func testCodexSnapshotAgeLabelRoundsDown() {
        XCTAssertEqual(CodexUsageFreshness.formatSnapshotAge(capturedAgo(59), now: freshnessNow), "now")
        XCTAssertEqual(CodexUsageFreshness.formatSnapshotAge(capturedAgo(34 * 60 + 59), now: freshnessNow), "34m ago")
        XCTAssertEqual(CodexUsageFreshness.formatSnapshotAge(capturedAgo(3 * 3600 + 59 * 60), now: freshnessNow), "3h ago")
        XCTAssertEqual(CodexUsageFreshness.formatSnapshotAge(capturedAgo(47 * 3600), now: freshnessNow), "1d ago")
    }

    func testCodexFootnoteDatesAnAgedReadingOfALiveWindow() {
        // THE REGRESSION: weekly window six days out (not stale), snapshot 4h old.
        let live = CodexRateLimitWindow(usedPercent: 94, windowMinutes: 10080, resetsAt: "2026-08-11T14:46:25Z")
        XCTAssertNil(CodexUsageFreshness.footnote(window: live, capturedAt: capturedAgo(120), now: freshnessNow))
        XCTAssertEqual(
            CodexUsageFreshness.footnote(window: live, capturedAt: capturedAgo(4 * 3600), now: freshnessNow),
            "4h ago"
        )
    }

    func testCodexFootnoteEndedWindowOutranksAge() {
        let ended = CodexRateLimitWindow(usedPercent: 67, windowMinutes: 300, resetsAt: nil, stale: true)
        XCTAssertEqual(
            CodexUsageFreshness.footnote(window: ended, capturedAt: capturedAgo(5 * 3600), now: freshnessNow),
            "stale"
        )
    }

    func testCodexFootnoteSilentWithoutACaptureStamp() {
        // Absence of evidence is not evidence of staleness: a producer that sends
        // no `capturedAt` must not leave every Codex gauge permanently dimmed.
        let live = CodexRateLimitWindow(usedPercent: 94, windowMinutes: 10080, resetsAt: "2026-08-11T14:46:25Z")
        XCTAssertNil(CodexUsageFreshness.footnote(window: live, capturedAt: nil, now: freshnessNow))
    }

    func testD200HPreviewMirrorDatesAnAgedCodexTile() {
        // The Device Preview is a fidelity mirror of d200h-layout.ts; it must dim
        // and date the same tile the real device does.
        XCTAssertNil(D200HLayoutModel.codexFootnote(stale: false, capturedAt: capturedAgo(120), now: freshnessNow))
        XCTAssertEqual(
            D200HLayoutModel.codexFootnote(stale: false, capturedAt: capturedAgo(4 * 3600), now: freshnessNow),
            "4h ago"
        )
        XCTAssertEqual(
            D200HLayoutModel.codexFootnote(stale: true, capturedAt: capturedAgo(4 * 3600), now: freshnessNow),
            "stale"
        )
    }

    // MARK: - Codex rollout parsing (capturedAt anchor)

    func testCodexRateLimitsCapturedAtComesFromTheSnapshotLine() {
        // The rollout keeps growing with lines that carry no `rate_limits`, so the
        // file mtime drifts forward while the newest reading stays put. Anchoring
        // on the line's own timestamp is what keeps the age honest.
        let line = """
        {"timestamp":"2026-08-04T18:38:42.076Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":94.0,"window_minutes":10080,"resets_at":1786459585},"secondary":null,"plan_type":"plus"}}}
        """
        let parsed = UsageAPIClient.parseCodexRateLimits(line)
        XCTAssertEqual(parsed?.primary?.usedPercent, 94.0)
        XCTAssertEqual(parsed?.capturedAt, "2026-08-04T18:38:42.076Z")
    }

    func testCodexRateLimitsCapturedAtNilWhenLineHasNoTimestamp() {
        // Caller falls back to the file mtime; the parser must not invent one.
        let line = """
        {"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":41.0,"window_minutes":10080,"resets_at":1786459585},"plan_type":"plus"}}}
        """
        XCTAssertNil(UsageAPIClient.parseCodexRateLimits(line)?.capturedAt)
        XCTAssertNil(UsageAPIClient.normalizeCodexCaptureTimestamp("not-a-date"))
        XCTAssertNil(UsageAPIClient.normalizeCodexCaptureTimestamp(nil))
    }

    // Codex stamps the login-time billing window `[active_start, active_until]`
    // into auth.json's id_token and never recomputes it on silent refresh, so
    // for an auto-renewing plan `active_until` drifts into the past mid-cycle.
    // `resolveChatGptRenewalDate` rolls that stale snapshot forward to the next
    // real renewal boundary. Mirror of bridge/src/__tests__/codex-auth.test.ts.
    func testResolveChatGptRenewalDateRollsStaleMonthlyWindowForward() {
        let now = ISO8601DateFormatter().date(from: "2026-07-08T00:00:00Z")!
        // Window Jun 6 → Jul 6, today Jul 8 → next boundary Aug 5.
        let out = UsageAPIClient.resolveChatGptRenewalDate(
            activeStart: "2026-06-06T06:21:49+00:00",
            activeUntil: "2026-07-06T06:21:49+00:00",
            now: now
        )
        XCTAssertEqual(out, "2026-08-05T06:21:49.000Z")
    }

    func testResolveChatGptRenewalDateRollsStaleAnnualWindowForward() {
        let now = ISO8601DateFormatter().date(from: "2026-07-08T00:00:00Z")!
        let out = UsageAPIClient.resolveChatGptRenewalDate(
            activeStart: "2025-01-01T00:00:00Z",
            activeUntil: "2026-01-01T00:00:00Z",
            now: now
        )
        XCTAssertEqual(out, "2027-01-01T00:00:00.000Z")
    }

    func testResolveChatGptRenewalDatePassesFutureDateThrough() {
        let now = ISO8601DateFormatter().date(from: "2026-07-08T00:00:00Z")!
        let out = UsageAPIClient.resolveChatGptRenewalDate(
            activeStart: "2026-06-06",
            activeUntil: "2026-08-01T00:00:00Z",
            now: now
        )
        XCTAssertEqual(out, "2026-08-01T00:00:00Z")
    }

    func testResolveChatGptRenewalDateLeavesPastRawWithoutStart() {
        // Renderers still surface "renewal needed" as a genuine last resort.
        let now = ISO8601DateFormatter().date(from: "2026-07-08T00:00:00Z")!
        let out = UsageAPIClient.resolveChatGptRenewalDate(
            activeStart: nil,
            activeUntil: "2026-07-06T06:21:49+00:00",
            now: now
        )
        XCTAssertEqual(out, "2026-07-06T06:21:49+00:00")
    }

    func testResolveChatGptRenewalDateLeavesUntrustworthyShortWindowRaw() {
        let now = ISO8601DateFormatter().date(from: "2026-07-08T00:00:00Z")!
        let out = UsageAPIClient.resolveChatGptRenewalDate(
            activeStart: "2026-07-01",
            activeUntil: "2026-07-05T00:00:00Z",
            now: now
        )
        XCTAssertEqual(out, "2026-07-05T00:00:00Z")
    }

    func testResolveChatGptRenewalDatePassesMalformedAndEmptyThrough() {
        let now = ISO8601DateFormatter().date(from: "2026-07-08T00:00:00Z")!
        XCTAssertEqual(
            UsageAPIClient.resolveChatGptRenewalDate(
                activeStart: "2026-06-06", activeUntil: "not-a-date", now: now),
            "not-a-date"
        )
        XCTAssertNil(
            UsageAPIClient.resolveChatGptRenewalDate(
                activeStart: "2026-06-06", activeUntil: nil, now: now)
        )
        XCTAssertEqual(
            UsageAPIClient.resolveChatGptRenewalDate(
                activeStart: "garbage", activeUntil: "2026-07-06T00:00:00Z", now: now),
            "2026-07-06T00:00:00Z"
        )
    }
    #endif

    func testMergedModelCatalogUpdatesExistingEntryWithoutDroppingOthers() {
        let existing: [[String: Any]] = [
            ["key": "gpt-4o", "name": "GPT 4o", "role": "configured", "available": true],
            ["key": "claude-4", "name": "Claude 4", "role": "configured", "available": true],
        ]
        let incoming: [[String: Any]] = [
            ["key": "gpt-4o", "name": "GPT 4o", "role": "default", "available": true],
        ]

        let merged = DashboardDataRules.mergedModelCatalog(existing: existing, incoming: incoming)

        XCTAssertEqual(merged.count, 2)
        XCTAssertEqual(merged.first?["key"] as? String, "gpt-4o")
        let updated = merged.first { ($0["key"] as? String) == "gpt-4o" }
        XCTAssertEqual(updated?["role"] as? String, "default")
    }

    func testSortSessionsUsesStableSharedOrdering() {
        let sessions = [
            SessionInfo(id: "2", port: 9122, projectName: "Beta", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: "2026-04-11T10:02:00Z"),
            SessionInfo(id: "1", port: 9121, projectName: "Alpha", agentType: "codex-cli", alive: true, state: "processing", modelName: nil, startedAt: "2026-04-11T10:00:00Z"),
            SessionInfo(id: "3", port: 9123, projectName: "Alpha", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: "2026-04-11T10:01:00Z"),
            SessionInfo(id: "4", port: 9124, projectName: "Gateway", agentType: "openclaw", alive: true, state: "idle", modelName: nil, startedAt: nil),
        ]

        let sorted = DashboardDataRules.sortSessions(sessions)

        XCTAssertEqual(sorted.map(\.id), ["4", "3", "2", "1"])
    }

    func testSortSessionsPlacesNilStartedAtAtGroupTail() {
        // Same (project, agentType) group with one nil startedAt entry —
        // DashboardDataRules.startedAtTime(nil) == .greatestFiniteMagnitude,
        // so the nil row sorts to the end of its group. Mirrors the assumption
        // that SessionListPanel relied on before primary started borrowing
        // its anchor sibling's startedAt.
        let sessions = [
            SessionInfo(id: "nil-row", port: 9120, projectName: "AgentDeck", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: nil),
            SessionInfo(id: "older", port: 9121, projectName: "AgentDeck", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: "2026-05-11T10:00:00Z"),
            SessionInfo(id: "newer", port: 9122, projectName: "AgentDeck", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: "2026-05-11T11:00:00Z"),
        ]

        let sorted = DashboardDataRules.sortSessions(sessions)

        XCTAssertEqual(sorted.map(\.id), ["older", "newer", "nil-row"])
    }

    func testSortSessionsTieBreaksOnNaturalIdWhenStartedAtMatches() {
        // When two sessions share the same project, agentType, and startedAt
        // ms, the natural-id tie-breaker decides — and must be deterministic
        // across re-sorts so the #N suffix order stays stable on every surface
        // (this is the iPad/iOS reproduction with two AgentDeck claude-code
        // sessions started in the same second).
        let same = "2026-05-11T10:00:00Z"
        let sessions = [
            SessionInfo(id: "session-10", port: 9131, projectName: "AgentDeck", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: same),
            SessionInfo(id: "session-2", port: 9122, projectName: "AgentDeck", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: same),
        ]

        let sorted = DashboardDataRules.sortSessions(sessions)

        XCTAssertEqual(sorted.map(\.id), ["session-2", "session-10"])
    }

    func testSortSessionsOrdersByWeightAscendingBeforeEverythingElse() {
        // Weight is the primary key: negatives, then unweighted/0, then positives.
        // A weighted claude-code session must sort before an unweighted openclaw.
        // Mirrors shared session-utils sortSessions weight override.
        let sessions = [
            SessionInfo(id: "pos", port: 9122, projectName: "A", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: nil, weight: 2),
            SessionInfo(id: "oc", port: 9124, projectName: "A", agentType: "openclaw", alive: true, state: "idle", modelName: nil, startedAt: nil, weight: nil),
            SessionInfo(id: "neg", port: 9121, projectName: "A", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: nil, weight: -5),
            SessionInfo(id: "zero", port: 9123, projectName: "A", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: nil, weight: 0),
        ]

        let sorted = DashboardDataRules.sortSessions(sessions)

        // neg(-5) → [zero(0), oc(nil==0) resolved by agentType: openclaw<claude] → pos(2)
        XCTAssertEqual(sorted.map(\.id), ["neg", "oc", "zero", "pos"])
    }

    func testSortSessionsUnweightedMatchesLegacyOrdering() {
        // No weights set → identical to pre-weight ordering (backward compatible).
        let sessions = [
            SessionInfo(id: "2", port: 9122, projectName: "Beta", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: "2026-04-11T10:02:00Z"),
            SessionInfo(id: "1", port: 9121, projectName: "Alpha", agentType: "codex-cli", alive: true, state: "processing", modelName: nil, startedAt: "2026-04-11T10:00:00Z"),
            SessionInfo(id: "4", port: 9124, projectName: "Gateway", agentType: "openclaw", alive: true, state: "idle", modelName: nil, startedAt: nil),
        ]
        // Legacy primary order is agentType rank. The SSOT is
        // `agentTypeRank` in shared/src/session-utils.ts — openclaw=0,
        // claude-code=1, codex-cli=2 — mirrored by
        // `DashboardDataRules.agentTypeRank`. The original expectation swapped
        // the latter two, asserting an order neither the SSOT nor the Swift
        // mirror produces.
        XCTAssertEqual(DashboardDataRules.sortSessions(sessions).map(\.id), ["4", "2", "1"])
    }

    func testFoldCodexSessionPayloadsForDisplayCollapsesSameProject() {
        let folded = DashboardDataRules.foldCodexSessionPayloadsForDisplay([
            [
                "id": "codex:old",
                "port": 9120,
                "projectName": "AgentDeck",
                "agentType": "codex-cli",
                "alive": true,
                "state": "idle",
                "startedAt": "2026-04-11T10:00:00Z",
            ],
            [
                "id": "codex:new",
                "port": 9120,
                "projectName": "AgentDeck",
                "agentType": "codex-cli",
                "alive": true,
                "state": "processing",
                "currentTool": "exec",
                "startedAt": "2026-04-11T10:02:00Z",
            ],
            [
                "id": "codex:missing-start",
                "port": 9120,
                "projectName": "AgentDeck",
                "agentType": "codex-cli",
                "alive": true,
                "state": "processing",
                "currentTool": "stale",
            ],
            [
                "id": "claude:1",
                "port": 9121,
                "projectName": "AgentDeck",
                "agentType": "claude-code",
                "alive": true,
                "state": "idle",
            ],
        ])

        XCTAssertEqual(folded.count, 2)
        let codex = folded.first { ($0["agentType"] as? String) == "codex-cli" }
        XCTAssertEqual(codex?["id"] as? String, "codex:new")
        XCTAssertEqual(codex?["state"] as? String, "processing")
        XCTAssertEqual(codex?["currentTool"] as? String, "exec")
        XCTAssertEqual(codex?["groupSize"] as? Int, 3)
        XCTAssertEqual(codex?["foldedSessionIds"] as? [String], ["codex:old", "codex:new", "codex:missing-start"])
    }

    func testFoldCodexSessionPayloadsKeepsEmptyProjectSeparate() {
        let folded = DashboardDataRules.foldCodexSessionPayloadsForDisplay([
            ["id": "codex:a", "port": 9120, "projectName": "", "agentType": "codex-cli", "alive": true],
            ["id": "codex:b", "port": 9120, "projectName": "   ", "agentType": "codex-cli", "alive": true],
        ])

        XCTAssertEqual(folded.compactMap { $0["id"] as? String }, ["codex:a", "codex:b"])
        XCTAssertNil(folded.first?["groupSize"])
    }

    func testFoldCodexSessionPayloadsKeepsCliAndAppSeparate() {
        let folded = DashboardDataRules.foldCodexSessionPayloadsForDisplay([
            ["id": "codex:cli-1", "port": 9120, "projectName": "AgentDeck", "agentType": "codex-cli", "alive": true, "state": "processing"],
            ["id": "codex:app-1", "port": 9120, "projectName": "AgentDeck", "agentType": "codex-app", "alive": true, "state": "processing"],
            ["id": "codex:app-2", "port": 9120, "projectName": "AgentDeck", "agentType": "codex-app", "alive": true, "state": "idle"],
        ])

        let ids = Set(folded.compactMap { $0["id"] as? String })
        XCTAssertEqual(folded.count, 2)
        XCTAssertTrue(ids.contains("codex:cli-1"))
        XCTAssertTrue(ids.contains("codex:app-1"))
        let app = folded.first { ($0["agentType"] as? String) == "codex-app" }
        XCTAssertEqual(app?["groupSize"] as? Int, 2)
        XCTAssertEqual(app?["foldedSessionIds"] as? [String], ["codex:app-1", "codex:app-2"])
    }

    func testSortSessionsClampsAndComparesExtremeWeightsSafely() {
        // Out-of-range wire values clamp to the documented bounds and
        // opposite-sign extremes order without overflow (three-way compare).
        let sessions = [
            SessionInfo(id: "huge", port: 9121, projectName: "A", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: nil, weight: Int.max),
            SessionInfo(id: "tiny", port: 9122, projectName: "A", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: nil, weight: Int.min),
            SessionInfo(id: "zero", port: 9123, projectName: "A", agentType: "claude-code", alive: true, state: "idle", modelName: nil, startedAt: nil),
        ]
        XCTAssertEqual(DashboardDataRules.sortSessions(sessions).map(\.id), ["tiny", "zero", "huge"])
        XCTAssertEqual(DashboardDataRules.sessionWeight(Int.max), SessionWeightRules.max)
        XCTAssertEqual(DashboardDataRules.sessionWeight(Int.min), SessionWeightRules.min)
        XCTAssertEqual(DashboardDataRules.sessionWeight(SessionWeightRules.max), SessionWeightRules.max)
        XCTAssertEqual(DashboardDataRules.sessionWeight(SessionWeightRules.min), SessionWeightRules.min)
        XCTAssertEqual(DashboardDataRules.sessionWeight(nil), 0)
    }

    func testFoldCodexSessionPayloadsNeverFoldsDistinctWeights() {
        // Server-side fold runs BEFORE sortSessionPayloads in the Swift
        // daemon's sessions_list build — a weight-blind key would collapse two
        // pinned tabs on the wire where no client could recover them. Mirrors
        // the shared fold's weight-band key.
        let folded = DashboardDataRules.foldCodexSessionPayloadsForDisplay([
            ["id": "codex:tab-2", "port": 9120, "projectName": "AgentDeck", "agentType": "codex-cli", "alive": true, "state": "processing", "weight": 2],
            ["id": "codex:tab-1", "port": 9120, "projectName": "AgentDeck", "agentType": "codex-cli", "alive": true, "state": "idle", "weight": 1],
        ])
        XCTAssertEqual(folded.count, 2)
        let ordered = DashboardDataRules.sortSessionPayloads(folded)
        XCTAssertEqual(ordered.compactMap { $0["id"] as? String }, ["codex:tab-1", "codex:tab-2"])
    }

    func testFoldCodexSessionPayloadsStillFoldsSharedWeightBand() {
        // Both unweighted (band 0) and both explicitly weight 3 keep folding.
        let unweighted = DashboardDataRules.foldCodexSessionPayloadsForDisplay([
            ["id": "codex:a", "port": 9120, "projectName": "AgentDeck", "agentType": "codex-cli", "alive": true, "state": "idle"],
            ["id": "codex:b", "port": 9120, "projectName": "AgentDeck", "agentType": "codex-cli", "alive": true, "state": "idle", "weight": 0],
        ])
        XCTAssertEqual(unweighted.count, 1)

        let sameWeight = DashboardDataRules.foldCodexSessionPayloadsForDisplay([
            ["id": "codex:c", "port": 9120, "projectName": "AgentDeck", "agentType": "codex-cli", "alive": true, "state": "idle", "weight": 3],
            ["id": "codex:d", "port": 9120, "projectName": "AgentDeck", "agentType": "codex-cli", "alive": true, "state": "idle", "weight": 3],
        ])
        XCTAssertEqual(sameWeight.count, 1)
        XCTAssertEqual(sameWeight.first?["groupSize"] as? Int, 2)
    }

    func testOpenClawDisplayLinesKeepsOnlyDefaultModel() {
        let lines = DashboardDataRules.openClawDisplayLines([
            ModelCatalogEntry(key: "gpt-5.4", name: "GPT 5.4", role: "default", available: true),
            ModelCatalogEntry(key: "glm-4.5", name: "GLM-4.5", role: "configured", available: true),
            ModelCatalogEntry(key: "glm-4.5v", name: "GLM-4.5V", role: "fallback-1", available: true),
            ModelCatalogEntry(key: "deepseek-r1", name: "DeepSeek R1", role: "configured", available: true),
        ])

        XCTAssertEqual(lines, ["GPT 5.4"])
    }

    func testOpenClawDisplayLinesEmptyWhenNoDefaultTagged() {
        let lines = DashboardDataRules.openClawDisplayLines([
            ModelCatalogEntry(key: "glm-4.5", name: "GLM-4.5", role: "configured", available: true),
            ModelCatalogEntry(key: "glm-4.5v", name: "GLM-4.5V", role: "fallback-1", available: true),
        ])

        XCTAssertEqual(lines, [])
    }

    func testOpenClawDisplayLinesEmptyWhenDefaultUnavailable() {
        let lines = DashboardDataRules.openClawDisplayLines([
            ModelCatalogEntry(key: "gpt-5.4", name: "GPT 5.4", role: "default", available: false),
            ModelCatalogEntry(key: "glm-4.5", name: "GLM-4.5", role: "configured", available: true),
        ])

        XCTAssertEqual(lines, [])
    }
}
