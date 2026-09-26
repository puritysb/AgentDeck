// SetupNeededCard.swift — Dashboard surfacer for un-wired integrations.
//
// The user pain this solves: running the macOS App Store build on a fresh
// Mac means three things commonly aren't set up — Claude Code's OAuth
// token is unreadable by the sandbox, the OpenClaw Gateway needs a shared
// token pasted in, and Claude Code hooks require explicit consent. The
// dashboard used to render the terrarium identically in all of those
// states, so users saw creatures moving around and assumed everything
// worked. This card calls out *which* integrations aren't wired and
// routes a tap directly into the macOS Settings window so the user has a
// clear entry path instead of archaeology through Help docs.
//
// Visual language matches AttentionTheaterHUD: glass-on-terrarium, amber
// accent, monospaced kerning. Sits at the bottom-leading of the monitor
// so it doesn't collide with the top-center attention theater card.

import SwiftUI

#if os(macOS)
import AppKit
#endif

struct SetupNeededCard: View {
    let items: [SetupItem]

    #if os(macOS)
    /// Needed to bounce the OpenClaw gateway adapter after an inline token
    /// import. Optional + defaulted so DEBUG previews (which never trigger the
    /// action) can construct the card without wiring a DaemonService.
    var daemonService: DaemonService? = nil
    @Environment(\.openWindow) private var openWindow
    #endif

    @State private var pulse = false
    /// Short feedback shown under an item after its inline action runs
    /// (e.g. "Token imported — reconnecting…"). The card auto-dismisses when
    /// the underlying status flips, so this is transient by nature.
    @State private var actionMessage: String? = nil

    /// Open-Settings call-to-action — macOS only. iOS hides the button
    /// because every iOS-surfaced item already routes the user back to
    /// AgentDeck on the Mac (item hint copy: "Open AgentDeck on your
    /// Mac to configure"); opening the iOS Settings sheet here would
    /// be a dead end since none of the integration editors ship on iOS.
    @ViewBuilder
    private var openSettingsButton: some View {
        #if os(macOS)
        Button {
            NSApp.activate(ignoringOtherApps: true)
            openWindow(id: "settings")
        } label: {
            settingsButtonLabel
        }
        .buttonStyle(.plain)
        #else
        EmptyView()
        #endif
    }

    private var settingsButtonLabel: some View {
        HStack(spacing: 4) {
            Text("Open Settings")
            Image(systemName: "arrow.right")
        }
        .font(.system(size: 11, weight: .semibold))
        .foregroundColor(Color.black.opacity(0.85))
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(TerrariumHUD.ledAmber)
                .shadow(color: TerrariumHUD.ledAmber.opacity(0.4), radius: 4, x: 0, y: 1)
        )
    }

    /// Per-item inline call-to-action. Only OpenClaw token-remediable failures
    /// carry one today; everything else falls through to the shared
    /// "Open Settings" button. macOS + App Store only — the import path uses
    /// NSOpenPanel + the user-selected-file entitlement, which doesn't exist on
    /// iOS (iOS items already route the user to the Mac).
    @ViewBuilder
    private func inlineAction(for item: SetupItem) -> some View {
        #if os(macOS) && AGENTDECK_APP_STORE
        if item.primaryAction == .importOpenClawToken {
            VStack(alignment: .leading, spacing: 3) {
                Button {
                    performImportOpenClawToken()
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: "tray.and.arrow.down")
                        Text("Import token")
                    }
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(Color.black.opacity(0.85))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(
                        RoundedRectangle(cornerRadius: 6)
                            .fill(TerrariumHUD.ledAmber)
                            .shadow(color: TerrariumHUD.ledAmber.opacity(0.4), radius: 4, x: 0, y: 1)
                    )
                }
                .buttonStyle(.plain)
                .help(Text(verbatim: "Pick ~/.openclaw/openclaw.json — AgentDeck saves the gateway token and reconnects."))

                if let actionMessage {
                    Text(actionMessage)
                        .font(.system(size: 9.5, design: .monospaced))
                        .foregroundStyle(TerrariumHUD.subtext)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.leading, 22) // align under the item title (icon 14 + spacing 8)
        }
        #else
        EmptyView()
        #endif
    }

    #if os(macOS) && AGENTDECK_APP_STORE
    private func performImportOpenClawToken() {
        guard let daemonService else { return }
        switch OpenClawTokenImporter.importFromConfigFile(daemonService: daemonService) {
        case .imported:
            actionMessage = "Token imported — reconnecting…"
        case .cancelled:
            break
        case .failed(let message):
            actionMessage = message
        }
    }
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "bolt.horizontal.circle")
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.ledAmber)
                Text("SETUP")
                    .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                    .kerning(1.4)
                    .foregroundStyle(TerrariumHUD.ledAmber)
                Text("·  \(items.count) item\(items.count == 1 ? "" : "s") unfinished")
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(TerrariumHUD.subtext)
                Spacer(minLength: 0)
            }

            ForEach(items) { item in
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: item.icon)
                            .font(.system(size: 10))
                            .foregroundStyle(item.tint)
                            .frame(width: 14)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(item.title)
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(TerrariumHUD.text)
                            Text(item.hint)
                                .font(.system(size: 10))
                                .foregroundStyle(TerrariumHUD.subtext)
                                .lineLimit(2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    inlineAction(for: item)
                }
            }

            openSettingsButton
        }
        .padding(10)
        .background(
            ZStack {
                RoundedRectangle(cornerRadius: 10)
                    .fill(Color.black.opacity(0.62))
                RoundedRectangle(cornerRadius: 10)
                    .stroke(TerrariumHUD.ledAmber.opacity(0.35), lineWidth: 1)
                RoundedRectangle(cornerRadius: 10)
                    .stroke(TerrariumHUD.ledAmber.opacity(pulse ? 0.18 : 0.05), lineWidth: 2)
                    .blur(radius: 3)
            }
        )
        .frame(maxWidth: 340, alignment: .leading)
        .onAppear {
            withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) {
                pulse = true
            }
        }
    }
}

struct SetupItem: Identifiable {
    let id: String
    let icon: String
    let tint: Color
    let title: String
    let hint: String
    /// Optional one-click remedy rendered inline under the item, in addition to
    /// the card's shared "Open Settings" route. Defaulted so existing call sites
    /// (and iOS) construct items unchanged.
    var primaryAction: SetupItemAction? = nil
}

/// Inline remedies a SetupItem can offer. Kept as an enum (not a closure) so
/// `SetupItem` stays `Identifiable`/value-typed and the action wiring lives in
/// the card, where `daemonService` and feedback state are in scope.
enum SetupItemAction: Equatable {
    case importOpenClawToken
}

// MARK: - Item derivation

extension AgentStateHolder {
    /// Collect the integration gaps the dashboard Setup card should surface.
    /// Derives items from `IntegrationCatalog` so the wording stays in sync
    /// with Settings → Integrations and the Onboarding pane. Hooks consent
    /// is the one item not in the catalog (it's a sub-affordance of Claude
    /// rather than a standalone integration), so it's checked separately.
    ///
    /// Platform split:
    /// - macOS includes Claude / OpenClaw / Antigravity, plus the hooks
    ///   consent step.
    /// - iOS surfaces only the integrations the Mac side controls — pairing
    ///   and credential paste live on macOS, so iPad/iPhone just nudge the
    ///   user to fix things on their Mac.
    #if os(macOS)
    /// `@MainActor` because callers reach `DaemonService.isSelfDaemon`
    /// before invoking; we keep the annotation for symmetry with the
    /// previous signature even though we no longer take `daemonService`.
    @MainActor
    func setupNeededItems(
        preferences: AppPreferences,
        daemonService: DaemonService
    ) -> [SetupItem] {
        // When a separately-installed Node daemon owns the hub
        // (`isUsingExternalDaemon`), IT installs and receives the Claude /
        // Codex hooks (`~/.claude/settings.json`, `~/.codex/config.toml`) and
        // relays the resulting hook-driven sessions to us. Our local
        // `hooksInstalled` / `codexConfigInstalled` flags only ever flip via
        // the app's OWN in-app installer, so in this (Tier-2) topology they
        // stay false forever and the card falsely nags "hooks off" even while
        // hook-driven sessions are visibly streaming. The sandbox also blocks
        // us from reading those files to verify (App Review 2.5.2 — no
        // home-relative entitlement), so trust the daemon: the external hub is
        // authoritative for hook installation, suppress the two consent nudges.
        let externalDaemonOwnsHooks = daemonService.isUsingExternalDaemon

        let anthropicSaved = anthropicAdminKeySavedValue()
        let shouldSurfaceClaude = Self.shouldSurfaceClaudeSetup(for: state)
        let descriptors: [IntegrationDescriptor] = [
            shouldSurfaceClaude ? IntegrationCatalog.claudeCode : nil,
            IntegrationCatalog.codex,
            IntegrationCatalog.openClaw,
            IntegrationCatalog.antigravity,
        ].compactMap { $0 }
        var items: [SetupItem] = descriptors.compactMap { descriptor in
            let status = IntegrationStatusEvaluator.status(
                for: descriptor,
                state: state,
                preferences: preferences,
                anthropicKeySaved: anthropicSaved
            )
            guard status.needsAttention else { return nil }
            return SetupItem(
                id: descriptor.id,
                icon: descriptor.iconSystemName,
                tint: status.tint,
                title: descriptor.displayName,
                hint: status.detail ?? descriptor.connectInstructions ?? status.label,
                primaryAction: Self.openClawSetupAction(descriptor: descriptor, state: state)
            )
        }

        // Hooks consent — live session tokens / timeline depend on
        // `~/.claude/settings.local.json`. Respect `.declined` so users
        // who actively opted out aren't nagged; only surface for `.unknown`
        // or previously-accepted installs that have been wiped.
        if shouldSurfaceClaude,
           !externalDaemonOwnsHooks,
           !preferences.hooksInstalled,
           preferences.hookInstallConsent != .declined {
            items.append(SetupItem(
                id: "hooks",
                icon: "bolt.slash",
                tint: .yellow,
                title: "Live session hooks off",
                hint: "Enable hooks to track per-turn tokens and tool calls in real time."
            ))
        }

        // Codex observation consent. This must not depend on a prior Codex CLI
        // run: the CLI can incidentally install the same managed config block,
        // but the standalone App Store app needs a visible, user-approved path
        // before any Codex App / Codex CLI session has emitted telemetry.
        if !externalDaemonOwnsHooks,
           Self.shouldShowCodexObservationSetup(
            codexAuthMode: state.codexAuthMode,
            codexConfigInstalled: preferences.codexConfigInstalled,
            codexConfigConsent: preferences.codexConfigConsent
        ) {
            items.append(SetupItem(
                id: "codex-config",
                icon: "bolt.slash",
                tint: .yellow,
                title: "Codex live observation off",
                hint: "Enable Codex notify + OTel to track turns and tool calls in real time."
            ))
        }

        return items
    }

    /// The OpenClaw setup item earns a one-click "Import token" button only when
    /// the gateway auth failure is one a token import actually fixes. These two
    /// statuses all tell the user (in `IntegrationStatusEvaluator.openClawStatus`)
    /// to import/paste the shared token. Pairing / device-auth failures
    /// (`pairing_required`, `device_auth_invalid`, `auth_failed`) need the
    /// Web-UI-approve / reset-identity ladder that lives in Settings, so they keep
    /// the generic "Open Settings" route (`primaryAction == nil`).
    static func openClawSetupAction(descriptor: IntegrationDescriptor, state: DashboardState) -> SetupItemAction? {
        #if AGENTDECK_APP_STORE
        guard descriptor.id == IntegrationCatalog.openClaw.id else { return nil }
        switch state.gatewayAuthStatus {
        case "gateway_token_missing", "token_mismatch":
            return .importOpenClawToken
        default:
            return nil
        }
        #else
        return nil
        #endif
    }

    static func shouldShowCodexObservationSetup(
        codexAuthMode: String?,
        codexConfigInstalled: Bool,
        codexConfigConsent: AppPreferences.HookInstallConsent
    ) -> Bool {
        _ = codexAuthMode
        return !codexConfigInstalled && codexConfigConsent != .declined
    }

    static func shouldSurfaceClaudeSetup(for state: DashboardState) -> Bool {
        let visibleTypes = visibleAgentTypes(in: state)
        return visibleTypes.isEmpty || visibleTypes.contains("claude-code")
    }

    private static func visibleAgentTypes(in state: DashboardState) -> Set<String> {
        var types = Set<String>()
        func add(_ raw: String?) {
            guard let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !value.isEmpty,
                  value != "daemon",
                  value != "monitor" else { return }
            types.insert(value)
        }
        if state.state != .disconnected {
            add(state.agentType)
        }
        for session in state.siblingSessions where session.alive {
            add(session.agentType)
        }
        return types
    }
    #else
    func setupNeededItems(preferences: AppPreferences) -> [SetupItem] {
        let anthropicSaved = anthropicAdminKeySavedValue()
        let descriptors = Self.iOSSetupDescriptors
        return descriptors.compactMap { descriptor in
            let status = IntegrationStatusEvaluator.status(
                for: descriptor,
                state: state,
                preferences: preferences,
                anthropicKeySaved: anthropicSaved
            )
            guard status.needsAttention else { return nil }
            // iOS users can't fix any of this here — point them at the Mac.
            let macHint = "Open AgentDeck on your Mac to configure. Changes flow here automatically."
            return SetupItem(
                id: descriptor.id,
                icon: descriptor.iconSystemName,
                tint: status.tint,
                title: descriptor.displayName,
                hint: status.detail ?? macHint
            )
        }
    }
    #endif

    /// iOS is a read-only dashboard client: Claude hook installation and OAuth
    /// ownership live on the paired Mac. In particular, an empty Claude
    /// session list is not evidence that hooks are missing. The iOS-local
    /// `hooksInstalled` preference is never populated, so evaluating the
    /// Claude descriptor here turns every idle Mac into a false SETUP alert.
    ///
    /// Keep only integrations whose daemon reports an explicit, durable setup
    /// state. OpenClaw qualifies via `gatewayAuthStatus`; Claude currently has
    /// no equivalent hook-readiness field in the wire protocol.
    static var iOSSetupDescriptors: [IntegrationDescriptor] {
        [IntegrationCatalog.openClaw]
    }

    /// Anthropic Admin key presence — Keychain on App Store, env on CLI.
    /// Checked once per `setupNeededItems` call so the catalog evaluator
    /// can render a meaningful "Connected" detail when applicable.
    private func anthropicAdminKeySavedValue() -> Bool {
        #if os(macOS)
        return AnthropicAdminApiClient.shared.hasKey()
        #else
        return false
        #endif
    }
}

// MARK: - Preview helpers

#if DEBUG && os(macOS)
struct SetupNeededCard_Previews: PreviewProvider {
    static var previews: some View {
        SetupNeededCard(
            items: [
                SetupItem(id: "claude", icon: "bolt.badge.clock", tint: .orange,
                          title: "Claude quota unavailable",
                          hint: "App Store build can't read Claude's OAuth token. Session monitoring still works through approved hooks."),
                SetupItem(id: "openclaw", icon: "lock.shield", tint: .red,
                          title: "OpenClaw needs a shared token",
                          hint: "Paste the OPENCLAW_GATEWAY_TOKEN value in Settings → Services → OpenClaw."),
                SetupItem(id: "hooks", icon: "bolt.slash", tint: .yellow,
                          title: "Live session hooks off",
                          hint: "Enable hooks to track per-turn tokens and tool calls in real time.")
            ]
        )
        .padding(30)
        .background(TerrariumHUD.bg)
    }
}
#endif
