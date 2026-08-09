// DevicePreviewSnapshotTests.swift — render Device Preview views to PNGs.
//
// Opt-in visual QA harness: set AGENTDECK_PREVIEW_SNAPSHOT_DIR to a writable
// directory and run this test to get one PNG per device preview (a few state
// variants for the drift-prone ones). Used to eyeball firmware-fidelity after
// editing a preview or one of the hand-maintained SSOT ports — see
// memory: device-preview-firmware-fidelity-ports. Skips (cleanly) when the
// env var is absent so CI never produces artifacts.

import XCTest
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif
@testable import AgentDeck

@MainActor
final class DevicePreviewSnapshotTests: XCTestCase {

    private lazy var outputDir: URL? = {
        // Sandbox note: the test host is the sandboxed app, so arbitrary paths
        // are not writable. Snapshots always land in the container's temp dir
        // (…/Data/tmp/agentdeck-previews); the env var only opts the run in.
        // Run via: TEST_RUNNER_AGENTDECK_PREVIEW_SNAPSHOTS=1 xcodebuild … test
        guard ProcessInfo.processInfo.environment["AGENTDECK_PREVIEW_SNAPSHOTS"] != nil else {
            return nil
        }
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("agentdeck-previews", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        NSLog("[DevicePreviewSnapshotTests] writing snapshots to %@", dir.path)
        return dir
    }()

    private func snapshot<V: View>(_ view: V, name: String, scale: CGFloat = 2) throws {
        guard let outputDir else {
            throw XCTSkip("AGENTDECK_PREVIEW_SNAPSHOTS not set — snapshot rendering skipped")
        }
        let renderer = ImageRenderer(content: view.background(Color.black))
        renderer.scale = scale
        guard let cgImage = renderer.cgImage else {
            XCTFail("ImageRenderer produced no image for \(name)")
            return
        }
        // PNG encode is platform-specific: NSBitmapImageRep (AppKit) is macOS-
        // only, so the iOS test target — which compiles this file even though
        // the snapshot harness is a dev-Mac visual-QA tool — needs the UIKit
        // path to build.
        #if os(macOS)
        let rep = NSBitmapImageRep(cgImage: cgImage)
        guard let png = rep.representation(using: .png, properties: [:]) else {
            XCTFail("PNG encode failed for \(name)")
            return
        }
        #else
        guard let png = UIImage(cgImage: cgImage).pngData() else {
            XCTFail("PNG encode failed for \(name)")
            return
        }
        #endif
        try png.write(to: outputDir.appendingPathComponent("\(name).png"))
    }

    // Note: `AgentDeck.PreviewDevice` must be fully qualified — SwiftUI ships
    // its own `PreviewDevice` type that otherwise wins the name lookup here.
    private func selection(
        _ device: AgentDeck.PreviewDevice,
        agent: PixooPreviewAgent = .claudeCode,
        state: PixooPreviewState = .processing,
        sessions: Int = 2
    ) -> DevicePreviewSelection {
        DevicePreviewSelection(agent: agent, state: state, sessionCount: sessions, device: device, animationFrame: 12)
    }

    func testRenderDevicePreviewSnapshots() throws {
        // ESP32 boards — the recently re-ported ones get state variants.
        try snapshot(Esp32Ips10Preview(selection: selection(.esp32Ips10, sessions: 4)), name: "ips10-4sess")
        try snapshot(Esp32Ips10Preview(selection: selection(.esp32Ips10, agent: .codex, sessions: 1)), name: "ips10-codex-1sess")
        try snapshot(Esp32TtgoPreview(selection: selection(.esp32Ttgo, state: .awaitingPrompt, sessions: 1)), name: "ttgo-awaiting")
        try snapshot(Esp3286BoxPreview(selection: selection(.esp32_86box, sessions: 1)), name: "86box")
        try snapshot(Esp32RoundPreview(selection: selection(.esp32Round, sessions: 1)), name: "round-amoled")
        try snapshot(Esp3235LandscapePreview(selection: selection(.esp32_35Landscape, sessions: 1)), name: "ips35-landscape")

        // InkDeck — adaptive usage band (0/1/2 provider rows).
        try snapshot(InkDeckPreview(selection: selection(.inkDeck, sessions: 2)), name: "inkdeck-2sess")
        try snapshot(InkDeckPreview(selection: selection(.inkDeck, agent: .codex, sessions: 1)), name: "inkdeck-codex-only")
        try snapshot(InkDeckPreview(selection: selection(.inkDeck, state: .disconnected, sessions: 0)), name: "inkdeck-offline")

        // Stream Deck slot — RUNNING teal vs PERM amber split.
        try snapshot(StreamDeckPlusPreview(selection: selection(.streamDeckPlus, state: .processing, sessions: 1)), name: "sdplus-running")
        try snapshot(StreamDeckPlusPreview(selection: selection(.streamDeckPlus, state: .awaitingPrompt, sessions: 1)), name: "sdplus-perm")
        try snapshot(StreamDeckPlusPreview(selection: selection(.streamDeckPlus, state: .idle, sessions: 1)), name: "sdplus-idle")

        // D200H deck — hide-if-absent usage tiles.
        try snapshot(D200HDeckPreview(selection: selection(.d200hDeck, agent: .codex, sessions: 1)), name: "d200h-codex-only")
        try snapshot(D200HDeckPreview(selection: selection(.d200hDeck, sessions: 2)), name: "d200h-2sess")

        // Antigravity — TC001 renders it as a rainbow micro mark (not a mono
        // sprite), and the Pixoo-pipeline previews route it through the real
        // renderer. These exist to eyeball the new agent reaches every surface.
        try snapshot(UlanziMatrixPreview(selection: selection(.ulanziMatrix, agent: .antigravity, sessions: 1)), name: "tc001-antigravity")
        try snapshot(UlanziMatrixPreview(selection: selection(.ulanziMatrix, agent: .antigravity, state: .idle, sessions: 1)), name: "tc001-antigravity-idle")
        try snapshot(IDotMatrixPreview(selection: selection(.iDotMatrix, agent: .antigravity, sessions: 1)), name: "idotmatrix-antigravity")
        try snapshot(D200HDeckPreview(selection: selection(.d200hDeck, agent: .antigravity, sessions: 1)), name: "d200h-antigravity")

        // D200H live-follow emulator — real sessions + usage fed straight into
        // buildSessionDeck (task 3). Distinct project names/models/states + the
        // pinned Claude 5H/7D and Codex 5H/7D usage tank tiles.
        try snapshot(D200HDeckPreview(selection: liveD200HSelection()), name: "d200h-live-emulator")

        // Pixoo-pipeline live emulator — the real DashboardState is rendered
        // verbatim through the real PixooRenderer (no synthesis), so these are
        // pixel-exact. iDotMatrix + Timebox have no @EnvironmentObject so they
        // snapshot cleanly (Pixoo 64 needs DaemonService, skipped here).
        try snapshot(IDotMatrixPreview(selection: livePixooSelection(.iDotMatrix)), name: "idotmatrix-live-emulator")
        try snapshot(TimeboxMiniPreview(selection: livePixooSelection(.timeboxMini)), name: "timebox-live-emulator")

        // Schematic-preview live emulators — InkDeck + the ESP32 boards consume
        // the shared displaySessions/displayUsageRows accessors: real project
        // cards + real Claude & Codex usage. (86Box uses PreviewMiniSessionList,
        // Round uses the tank-group HUD, IPS10 has its own office + cards pane,
        // TTGO the focused-session metric panel — all now live-aware.)
        try snapshot(InkDeckPreview(selection: livePixooSelection(.inkDeck)), name: "inkdeck-live-emulator")
        try snapshot(Esp32Ips10Preview(selection: livePixooSelection(.esp32Ips10)), name: "ips10-live-emulator")
        try snapshot(Esp3286BoxPreview(selection: livePixooSelection(.esp32_86box)), name: "86box-live-emulator")
        try snapshot(Esp32RoundPreview(selection: livePixooSelection(.esp32Round)), name: "round-live-emulator")
        try snapshot(Esp32TtgoPreview(selection: livePixooSelection(.esp32Ttgo)), name: "ttgo-live-emulator")
        // Remaining surfaces made live-aware: TC001 matrix (per-session
        // creatures), the terminal terrarium, e-ink color, and the tablet.
        try snapshot(UlanziMatrixPreview(selection: livePixooSelection(.ulanziMatrix)), name: "tc001-live-emulator")
        try snapshot(TerminalTerrariumPreview(selection: livePixooSelection(.terminalTerrarium)), name: "terminal-live-emulator")
        try snapshot(EinkColorPreview(selection: livePixooSelection(.einkColor)), name: "einkcolor-live-emulator")
        try snapshot(IPadLandscapePreview(selection: livePixooSelection(.iPadLandscape)), name: "ipad-live-emulator")
    }

    /// A realistic multi-agent daemon state for live-follow snapshots, wrapped
    /// in a selection via the production `LivePreviewData.from`. Includes both
    /// Claude and Codex usage windows so usage bands render both rows.
    private func livePixooSelection(_ device: AgentDeck.PreviewDevice) -> DevicePreviewSelection {
        var state = DashboardState()
        state.bridgeConnected = true
        state.state = .processing
        state.agentType = "claude-code"
        state.fiveHourPercent = 42
        state.sevenDayPercent = 68
        state.codexRateLimits = CodexRateLimits(
            primary: CodexRateLimitWindow(usedPercent: 23, windowMinutes: nil, resetsAt: nil, stale: false),
            secondary: CodexRateLimitWindow(usedPercent: 51, windowMinutes: nil, resetsAt: nil, stale: false),
            planType: nil, limitId: nil, credits: nil
        )
        state.siblingSessions = [
            SessionInfo(id: "s1", port: 9121, projectName: "AgentDeck", agentType: "claude-code",
                        alive: true, state: "processing", modelName: "claude-opus-4-8", startedAt: nil),
            SessionInfo(id: "s2", port: 9122, projectName: "BabelForge", agentType: "codex-cli",
                        alive: true, state: "idle", modelName: "gpt-5", startedAt: nil),
        ]
        var sel = selection(device, sessions: 2)
        sel.live = LivePreviewData.from(state)
        return sel
    }

    /// A live-follow D200H selection wired with a realistic multi-agent daemon
    /// snapshot, so the rendered deck shows true project names/models/usage.
    private func liveD200HSelection() -> DevicePreviewSelection {
        let live = LivePreviewData(
            sessions: [
                SessionInfo(id: "s1", port: 9121, projectName: "AgentDeck", agentType: "claude-code",
                            alive: true, state: "processing", modelName: "claude-opus-4-8", startedAt: nil),
                SessionInfo(id: "s2", port: 9122, projectName: "BabelForge", agentType: "codex-cli",
                            alive: true, state: "idle", modelName: "gpt-5", startedAt: nil, weight: -1),
                SessionInfo(id: "s3", port: 9123, projectName: "OpenClaw", agentType: "antigravity",
                            alive: true, state: "awaiting_permission", modelName: "gemini-3", startedAt: nil),
            ],
            topLevelState: "processing",
            focusedSessionId: "s1",
            navigable: false,
            focusedOptions: [],
            fiveHourPercent: 42, sevenDayPercent: 68, usageKnown: true,
            codexPrimaryPercent: 23, codexPrimaryStale: false,
            codexSecondaryPercent: 51, codexSecondaryStale: false
        )
        var sel = selection(.d200hDeck, sessions: 3)
        sel.live = live
        return sel
    }

    // MARK: - Live-follow mapping

    func testLiveSelectionInputsMapping() {
        var state = DashboardState()
        state.bridgeConnected = false
        let offline = DevicePreviewScreen.liveSelectionInputs(from: state)
        XCTAssertEqual(offline.state, .disconnected)
        XCTAssertEqual(offline.sessionCount, 0)

        state.bridgeConnected = true
        state.agentType = "codex-cli"
        state.state = .idle
        state.siblingSessions = [
            SessionInfo(id: "a", port: 9121, projectName: "p1", agentType: "codex-cli", alive: true, state: "processing"),
            SessionInfo(id: "b", port: 9122, projectName: "p2", agentType: "claude-code", alive: true, state: "awaiting_permission"),
            SessionInfo(id: "c", port: 9123, projectName: "p3", agentType: "claude-code", alive: false, state: "idle"),
        ]
        let mixed = DevicePreviewScreen.liveSelectionInputs(from: state)
        XCTAssertEqual(mixed.agent, .codex)
        // Awaiting wins over processing — attention beats motion.
        XCTAssertEqual(mixed.state, .awaitingPrompt)
        // Dead session excluded → 2 alive.
        XCTAssertEqual(mixed.sessionCount, 2)

        // Antigravity agentType maps to the new preview agent (was falling
        // through to Claude before it was added to the input model).
        state.agentType = "antigravity"
        XCTAssertEqual(DevicePreviewScreen.liveSelectionInputs(from: state).agent, .antigravity)

        // 3 alive clamps down to the 2-bucket; 5 alive clamps to 4.
        state.siblingSessions = (0..<3).map {
            SessionInfo(id: "s\($0)", port: 9121 + $0, projectName: "p", agentType: "claude-code", alive: true, state: "idle")
        }
        XCTAssertEqual(DevicePreviewScreen.liveSelectionInputs(from: state).sessionCount, 2)
        state.siblingSessions = (0..<5).map {
            SessionInfo(id: "s\($0)", port: 9121 + $0, projectName: "p", agentType: "claude-code", alive: true, state: "idle")
        }
        XCTAssertEqual(DevicePreviewScreen.liveSelectionInputs(from: state).sessionCount, 4)
    }

    func testSessionSlotNameWrappingMatchesLowResolutionProfile() {
        XCTAssertEqual(
            SessionSlotText.wrapSessionName(
                "Continuous Integration Validation",
                maxChars: 11
            ),
            ["Continuous", "Integration", "Validation"]
        )
        XCTAssertEqual(
            SessionSlotText.wrapSessionName("SampleProjectName", maxChars: 8),
            ["Sample", "Project", "Name"]
        )
    }

    // MARK: - Live D200H emulator input

    func testLiveD200HInputMapsRealSessionsAndUsage() throws {
        guard let input = liveD200HInput(for: liveD200HSelection()) else {
            return XCTFail("expected a live D200H input")
        }
        // Real per-session project/model/state flow through verbatim.
        XCTAssertEqual(input.sessions.map(\.projectName).sorted(), ["AgentDeck", "BabelForge", "OpenClaw"])
        XCTAssertEqual(input.sessions.first { $0.id == "s1" }?.modelName, "claude-opus-4-8")
        XCTAssertEqual(input.sessions.first { $0.id == "s3" }?.agentType, "antigravity")
        // --weight must survive the SessionInfo → D200HSession mapping, or the
        // preview's sort/fold mirror silently diverges from the physical deck.
        XCTAssertEqual(input.sessions.first { $0.id == "s2" }?.weight, -1)
        XCTAssertNil(input.sessions.first { $0.id == "s1" }?.weight)
        // The weighted Codex session sorts ahead of every unweighted session.
        let ordered = D200HLayoutModel.sortSessions(
            D200HLayoutModel.foldCodexSessionsForDisplay(input.sessions))
        XCTAssertEqual(ordered.first?.id, "s2")
        // Real usage windows forwarded verbatim.
        XCTAssertEqual(input.usage?.fiveHourPercent, 42)
        XCTAssertEqual(input.usage?.sevenDayPercent, 68)
        XCTAssertEqual(input.usage?.codexPrimaryPercent, 23)
        XCTAssertEqual(input.usage?.codexSecondaryPercent, 51)

        // The shared engine renders a session tile per project (sorted +
        // truncated by the same rules as the physical device).
        let slots = D200HLayoutModel.buildSessionDeck(input, view: D200HDeckView(mode: .list))
        let sessionLabels = slots.compactMap { slot -> String? in
            if case .session = slot.kind { return slot.label }
            return nil
        }
        XCTAssertTrue(sessionLabels.contains("AgentDeck"), "expected the real project label, got \(sessionLabels)")
        XCTAssertTrue(sessionLabels.contains("BabelForge"))
        // A pinned usage gauge tile is present (real 42% Claude 5H).
        let hasUsageGauge = slots.contains { if case .usageGauge = $0.kind { return true } else { return false } }
        XCTAssertTrue(hasUsageGauge, "expected pinned usage gauge tiles")
    }
}
