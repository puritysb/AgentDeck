// IntegrationsView.swift — single source of truth for the rows that
// appear in Settings → Integrations, the Onboarding integrations pane,
// and the Dashboard SetupNeededCard. Three places used to ship three
// different copies of the same five integrations; now they all read
// from this catalog and only differ in interaction mode.
//
// The catalog also splits integrations into two groups so users can
// see at a glance which ones come from "an account/CLI you already
// signed into" versus "a paste-this-key option". This was the user
// pain that prompted the rewrite — OpenClaw worked without any input
// and Anthropic Admin needed a key, but the old UI stacked them
// identically and made every row feel equally fiddly.

import SwiftUI
#if os(macOS)
import AppKit
#endif

// MARK: - Catalog

enum IntegrationKind {
    /// Auto-detected from a CLI session, native app, or a Web UI pairing
    /// flow. The user never pastes a token here; AgentDeck reads what
    /// the other tool already stored locally.
    case accountLinked
    /// Explicit secret pasted by the user. Optional — these surface
    /// extra data AgentDeck can't infer from local state.
    case apiKey
}

struct IntegrationDescriptor: Identifiable, Hashable {
    let id: String
    let displayName: String
    let kind: IntegrationKind
    /// SF Symbol name used as a fallback when no `iconAssetName` is set,
    /// or when the asset lookup fails (iOS without bundled assets).
    let iconSystemName: String
    /// Optional brand asset bundled in the asset catalog. When present,
    /// the row prefers this over `iconSystemName` so users see the
    /// service's actual logo instead of a generic SF Symbol. Assets are
    /// template-rendered so the row can tint them with `iconTint`.
    let iconAssetName: String?
    /// Tint to apply when rendering the brand asset. Uses the agent
    /// brand palette so Claude Code reads terracotta, Codex reads
    /// slate, OpenClaw reads crayfish red — matching creature dots in
    /// the Dashboard topology rail.
    let iconTint: Color?
    /// One-line, ≤ 100 chars. Describes WHAT the integration unlocks,
    /// not HOW to set it up.
    let oneLineHelp: String
    /// 1-line setup guidance shown only when the row is in a
    /// "needs action" state.
    let connectInstructions: String?

    init(
        id: String,
        displayName: String,
        kind: IntegrationKind,
        iconSystemName: String,
        iconAssetName: String? = nil,
        iconTint: Color? = nil,
        oneLineHelp: String,
        connectInstructions: String?
    ) {
        self.id = id
        self.displayName = displayName
        self.kind = kind
        self.iconSystemName = iconSystemName
        self.iconAssetName = iconAssetName
        self.iconTint = iconTint
        self.oneLineHelp = oneLineHelp
        self.connectInstructions = connectInstructions
    }
}

enum IntegrationCatalog {
    private static let claudeOneLineHelp = "Live session telemetry through opt-in Claude Code hooks."
    private static let claudeConnectInstructions = "Enable Claude Code Hooks below. Sessions appear here after hook events arrive."
    private static let codexOneLineHelp = "Codex runs in your own terminal; AgentDeck monitors the session through hooks."
    private static let codexConnectInstructions = "The standalone dashboard still works without launching Codex from here."

    static let claudeCode = IntegrationDescriptor(
        id: "claude",
        displayName: "Claude Code",
        kind: .accountLinked,
        iconSystemName: "bolt.fill",
        iconAssetName: "CreatureClaudeCode",
        iconTint: TerrariumHUD.claudeBody,
        oneLineHelp: claudeOneLineHelp,
        connectInstructions: claudeConnectInstructions
    )

    static let codex = IntegrationDescriptor(
        id: "codex",
        displayName: "Codex (ChatGPT)",
        kind: .accountLinked,
        iconSystemName: "person.badge.key",
        // OpenAI brand mark reads clearer than the Codex creature in a
        // Settings row — users recognise "Codex = ChatGPT = OpenAI" by
        // the hex logo before they decode the creature silhouette.
        iconAssetName: "BrandOpenAI",
        iconTint: Color(red: 0.92, green: 0.92, blue: 0.94),
        oneLineHelp: codexOneLineHelp,
        connectInstructions: codexConnectInstructions
    )

    static let openClaw = IntegrationDescriptor(
        id: "openclaw",
        displayName: "OpenClaw Gateway",
        kind: .accountLinked,
        iconSystemName: "network",
        iconAssetName: "CreatureOpenClaw",
        iconTint: Color(red: 1.0, green: 0.30, blue: 0.30),
        oneLineHelp: "Routes agent traffic through a local Gateway. Pairing happens in OpenClaw's Web UI.",
        // Phrased conditionally so it never reads as a "go install / launch
        // this companion binary" instruction — App Review 4.2.3 sensitivity.
        // The row only surfaces in attention states when a Gateway is already
        // reachable, so this copy describes the next step from there.
        connectInstructions: "When OpenClaw is running, approve this Mac in its Web UI."
    )

    static let antigravity = IntegrationDescriptor(
        id: "antigravity",
        displayName: "Antigravity",
        kind: .accountLinked,
        // Google Antigravity ships no public brand SVG we can bundle,
        // so stay on the atom glyph — reads as "physics / gravity" and
        // holds the row until we import an official mark.
        iconSystemName: "atom",
        oneLineHelp: "Plan name and remaining credits, read from the local Antigravity app.",
        connectInstructions: "Pick the Antigravity state.vscdb file once so the sandboxed app can read it."
    )

    static let anthropicAdmin = IntegrationDescriptor(
        id: "anthropic-admin",
        displayName: "Anthropic Admin API",
        kind: .apiKey,
        iconSystemName: "chart.line.uptrend.xyaxis",
        iconAssetName: "BrandAnthropic",
        iconTint: TerrariumHUD.claudeBody,
        oneLineHelp: "Org-wide token usage (today + 30 days). Separate from Pro/Max subscription quota.",
        connectInstructions: "Paste an Admin API key from console.anthropic.com/settings/keys."
    )

    static let all: [IntegrationDescriptor] = [
        claudeCode, codex, openClaw, antigravity, anthropicAdmin,
    ]
}

// MARK: - Status

enum IntegrationStatus: Equatable {
    case connected(detail: String?)
    case awaiting(detail: String)
    case failed(detail: String)
    case notConfigured(detail: String?)
    case unsupported(detail: String)

    var label: String {
        switch self {
        case .connected: return "Connected"
        case .awaiting: return "Awaiting setup"
        case .failed: return "Auth failed"
        case .notConfigured: return "Not configured"
        case .unsupported: return "Unsupported"
        }
    }

    var detail: String? {
        switch self {
        case .connected(let d), .notConfigured(let d): return d
        case .awaiting(let d), .failed(let d), .unsupported(let d): return d
        }
    }

    var tint: Color {
        switch self {
        case .connected: return TerrariumHUD.ledGreen
        case .awaiting: return TerrariumHUD.ledAmber
        case .failed, .unsupported: return TerrariumHUD.ledRed
        case .notConfigured: return TerrariumHUD.subtext
        }
    }

    var needsAttention: Bool {
        switch self {
        case .connected, .notConfigured: return false
        case .awaiting, .failed, .unsupported: return true
        }
    }
}

// MARK: - Status evaluator

/// Maps live `AgentState` + `AppPreferences` into an `IntegrationStatus`
/// per descriptor. Centralized so SettingsScreen, Onboarding and the
/// Dashboard SetupCard can't drift in their interpretation of state.
enum IntegrationStatusEvaluator {
    static func status(
        for descriptor: IntegrationDescriptor,
        state: DashboardState,
        preferences: AppPreferences,
        anthropicKeySaved: Bool
    ) -> IntegrationStatus {
        switch descriptor.id {
        case "claude":
            return claudeStatus(state: state, preferences: preferences)
        case "codex":
            return codexStatus(state: state, preferences: preferences)
        case "openclaw":
            return openClawStatus(state: state)
        case "antigravity":
            return antigravityStatus(state: state, preferences: preferences)
        case "anthropic-admin":
            return anthropicStatus(state: state, hasKey: anthropicKeySaved)
        default:
            return .notConfigured(detail: nil)
        }
    }

    private static func claudeStatus(state: DashboardState, preferences: AppPreferences) -> IntegrationStatus {
        // Claude is "connected" as soon as either the hook relay or the
        // OAuth token is wired up — both are independently usable signals.
        //   • Hooks on  → real-time session telemetry (sandbox-safe path
        //                  and the only one that works in the App Store
        //                  build without an external Node daemon).
        //   • OAuth on  → subscription quota fetch (direct Anthropic API;
        //                  needs the token on disk, which the sandboxed
        //                  daemon can't read — flows in via CLI relay).
        // Earlier code gated on oauthConnected alone, so App Store users
        // with working hooks still saw "not connected" despite sessions
        // flowing through the dashboard.
        let hooksOn = preferences.hooksInstalled
        let oauthOn = state.oauthConnected ?? false
        if hooksOn && oauthOn {
            return .connected(detail: "Pro/Max · hooks on")
        }
        if hooksOn {
            return .connected(detail: "Hooks on")
        }
        if oauthOn {
            return .connected(detail: "Pro/Max · hooks off")
        }
        return .awaiting(detail: "Enable Claude Code Hooks below to relay live sessions.")
    }

    private static func codexStatus(state: DashboardState, preferences: AppPreferences) -> IntegrationStatus {
        // Three independent signals can each render Codex as "Connected":
        //   • codexAuthMode  — daemon sees the user's ChatGPT login (CLI relay).
        //   • codexConfigInstalled — AgentDeck-managed notify/OTel block is
        //                  in ~/.codex/config.toml; live session telemetry
        //                  flows even without the CLI relay.
        //   • Both — show both summaries.
        let observation = preferences.codexConfigInstalled
        let auth = state.codexAuthMode.flatMap { $0.isEmpty ? nil : $0 }
        switch (observation, auth) {
        case (true, .some(let mode)):
            return .connected(detail: "\(mode) · observation on")
        case (true, .none):
            return .connected(detail: "Observation on")
        case (false, .some(let mode)):
            return .connected(detail: mode)
        case (false, .none):
            // Settings shows this row regardless, but we surface
            // `notConfigured` (vs `.awaiting`) so the Dashboard SetupCard
            // doesn't nag every fresh-install user about a CLI they may
            // not own. The card has a separate gate on `codexAuthMode`.
            return .notConfigured(detail: "Codex runs in your own terminal; sessions appear here once started, or enable Observation to relay live state.")
        }
    }

    private static func openClawStatus(state: DashboardState) -> IntegrationStatus {
        // Short deviceId (first 8 hex chars) for pairing copy so the user
        // can match what they see here against the entry OpenClaw's Web UI
        // shows when approving a new device. Nil → omit the identifier
        // entirely rather than showing a stub.
        let deviceIdHint: String = state.gatewayDeviceId
            .flatMap { $0.isEmpty ? nil : String($0.prefix(8)) }
            .map { " — deviceId `\($0)…`" } ?? ""

        switch state.gatewayAuthStatus {
        case "connected":
            return .connected(detail: "Paired through Gateway")
        case "reconnecting":
            // WebSocket dropped but Gateway TCP is still up — adapter reconnects
            // automatically. Show amber "Awaiting" instead of "Not configured" so
            // the user knows this is transient and no action is required.
            return .awaiting(detail: "Reconnecting to Gateway\(deviceIdHint)…")
        case "approval_pending", "pairing_required":
            return .awaiting(detail: "Approve this Mac in OpenClaw's Web UI (http://localhost:18789)\(deviceIdHint).")
        case "gateway_reachable":
            // WebSocket is open and we've sent connect — waiting for Gateway to
            // respond. If this state persists for >30s the Gateway is likely
            // dropping the request without a response (e.g. plugin missing /
            // protocol mismatch). Don't direct the user to Web UI here: the
            // device only appears in the pair list once Gateway has actually
            // processed our signed connect, which a wedged Gateway hasn't.
            return .awaiting(detail: "Connecting to Gateway\(deviceIdHint)…")
        case "gateway_token_missing":
            return .awaiting(detail: "Gateway is in shared-token mode but no token is set. Use \"Import token\" below to load it from a JSON config file, or paste it into Advanced.")
        case "token_mismatch":
            return .failed(detail: "Shared token doesn't match\(deviceIdHint). Re-import or paste the current value below.")
        case "connect_timeout":
            return .failed(detail: "Gateway did not answer the handshake\(deviceIdHint). In Settings → Integrations, import the current token and use \"Reconnect adapter\".")
        case "device_auth_invalid":
            // Two scenarios produce this status:
            //  ① Fresh install — this Mac's key isn't yet in OpenClaw's approved
            //     list. Resolved by approving in Web UI (normal first-pair flow).
            //  ② Stale identity — OpenClaw rejects this Mac's signature even
            //     after approval (e.g. its stored public key doesn't match the
            //     one this Mac is signing with — usually after re-installing or
            //     migrating between Debug / App Store builds whose Keychain
            //     access groups differ). Resolved by tapping "Reset pairing"
            //     in Settings → Integrations → OpenClaw to wipe the local
            //     identity, then re-approving in Web UI.
            // We can't tell ① from ② from status alone, so the copy points at
            // both paths and lets the user pick.
            return .awaiting(detail: "Pairing rejected\(deviceIdHint). Open OpenClaw's Web UI (http://localhost:18789) and approve this Mac. If it's already approved, use \"Reset pairing identity\" in Settings → OpenClaw and try again.")
        case "auth_failed":
            return .failed(detail: "Authentication error\(deviceIdHint). Try \"Reset pairing identity\" in Settings → OpenClaw, or paste a fresh shared token in Advanced.")
        case "unsupported_protocol":
            return .unsupported(detail: "Update OpenClaw Gateway to a 2026.4.14+ build.")
        default:
            if state.gatewayAvailable {
                return .awaiting(detail: "Gateway reachable. Open the OpenClaw Web UI to approve this Mac\(deviceIdHint).")
            }
            // Deliberately neutral — we don't tell the user to install or
            // launch a separate program. The row simply waits for an OpenClaw
            // Gateway to appear on its standard local port.
            return .notConfigured(detail: "No OpenClaw Gateway detected on ws://127.0.0.1:18789. This row will activate once one is reachable.")
        }
    }

    private static func antigravityStatus(state: DashboardState, preferences: AppPreferences) -> IntegrationStatus {
        if !preferences.antigravityAccessEnabled {
            return .notConfigured(detail: "Pick the state.vscdb file to grant read access.")
        }
        guard let info = state.antigravityStatus, let plan = info.planName, !plan.isEmpty else {
            return .awaiting(detail: "DB selected but no plan info yet — open Antigravity once to populate it.")
        }
        let credits = info.availableCredits.map { "\($0) cr" }
        let detail = [plan, credits].compactMap { $0 }.joined(separator: " · ")
        return .connected(detail: detail)
    }

    private static func anthropicStatus(state: DashboardState, hasKey: Bool) -> IntegrationStatus {
        guard hasKey else {
            return .notConfigured(detail: "Optional. Adds org-wide token usage when configured.")
        }
        let todayIn = state.adminApiTodayInputTokens ?? 0
        let todayOut = state.adminApiTodayOutputTokens ?? 0
        let monthIn = state.adminApiMonthInputTokens ?? 0
        let monthOut = state.adminApiMonthOutputTokens ?? 0
        let todayTotal = todayIn + todayOut
        let monthTotal = monthIn + monthOut
        if todayTotal == 0 && monthTotal == 0 {
            return .connected(detail: "Awaiting first fetch")
        }
        return .connected(detail: "Today \(formatTokens(todayTotal)) · 30d \(formatTokens(monthTotal))")
    }

    private static func formatTokens(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
        return "\(n)"
    }
}

// MARK: - Row view

/// Display modes for `IntegrationRow`. Keeps the catalog/row code
/// shared while letting each screen show only the affordances it needs.
enum IntegrationRowMode {
    /// Full Settings row: name + status + detail + connect instructions
    /// when not connected. No paste fields here — they live in
    /// `IntegrationsView` slots so this row stays platform-agnostic.
    case settings
    /// Onboarding pane: name + one-line help only. No live status,
    /// because users haven't done anything yet and we don't want to
    /// nag during the wizard.
    case onboarding
    /// Dashboard SetupCard: compact two-line variant. Caller pre-filters
    /// to rows where `status.needsAttention == true`.
    case setupCard
}

struct IntegrationRow: View {
    let descriptor: IntegrationDescriptor
    let status: IntegrationStatus
    let mode: IntegrationRowMode

    var body: some View {
        switch mode {
        case .settings: settingsBody
        case .onboarding: onboardingBody
        case .setupCard: setupCardBody
        }
    }

    private var settingsBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                integrationIcon(size: 14)
                Text(descriptor.displayName)
                    .font(.system(size: 13, weight: .semibold))
                Spacer(minLength: 8)
                statusBadge
            }
            if let detail = status.detail {
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                    .fixedSize(horizontal: false, vertical: true)
            }
            if status.needsAttention, let instructions = descriptor.connectInstructions {
                Text(instructions)
                    .font(.system(size: 10))
                    .foregroundStyle(TerrariumHUD.subtext.opacity(0.7))
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        // iOS surfaces these rows as read-only mirrors of Mac state — no
        // editor in this view tree responds to taps on iOS. Soft opacity
        // signals "informational, not interactive" without losing the
        // status badge color which is the primary information channel.
        #if os(iOS)
        .opacity(0.92)
        #endif
    }

    private var onboardingBody: some View {
        HStack(alignment: .top, spacing: 12) {
            integrationIcon(size: 20, fallbackTint: Color.accentColor)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 3) {
                Text(descriptor.displayName)
                    .font(.system(size: 14, weight: .semibold))
                Text(descriptor.oneLineHelp)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.secondary.opacity(0.08))
        )
    }

    private var setupCardBody: some View {
        HStack(alignment: .top, spacing: 8) {
            // Setup card echoes the attention tint (amber / red) over
            // the brand mark so the eye lands on "needs action" first.
            integrationIcon(size: 12, fallbackTint: status.tint, overrideTint: status.tint)
                .frame(width: 14)
            VStack(alignment: .leading, spacing: 1) {
                Text(descriptor.displayName)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(TerrariumHUD.text)
                Text(status.detail ?? status.label)
                    .font(.system(size: 10))
                    .foregroundStyle(TerrariumHUD.subtext)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var statusBadge: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(status.tint)
                .frame(width: 6, height: 6)
            Text(status.label)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(status.tint)
        }
    }

    /// Renders the integration's brand asset when available, falling
    /// back to the SF Symbol. Brand assets are template-rendered so the
    /// caller's tint (per-descriptor, or a status override for the
    /// Setup card) controls the color.
    @ViewBuilder
    private func integrationIcon(
        size: CGFloat,
        fallbackTint: Color? = nil,
        overrideTint: Color? = nil
    ) -> some View {
        let tint: Color = overrideTint
            ?? descriptor.iconTint
            ?? fallbackTint
            ?? TerrariumHUD.subtext
        if let assetName = descriptor.iconAssetName {
            Image(assetName)
                .renderingMode(.template)
                .resizable()
                .aspectRatio(contentMode: .fit)
                .frame(width: size, height: size)
                .foregroundStyle(tint)
        } else {
            Image(systemName: descriptor.iconSystemName)
                .font(.system(size: size))
                .foregroundStyle(tint)
        }
    }
}

// MARK: - List view (Settings two-group container)

/// Shows the two groups (Account integrations / Optional API keys)
/// with their explanatory header lines. Paste fields and "Choose
/// state.vscdb" affordances are passed in as builder slots so this
/// view stays free of #if AGENTDECK_APP_STORE / Keychain code.
struct IntegrationsView<AccountSlot: View, ApiKeySlot: View>: View {
    @EnvironmentObject private var stateHolder: AgentStateHolder
    @EnvironmentObject private var preferences: AppPreferences

    /// `true` when the Anthropic Admin API key is present in Keychain.
    /// Owner of this view tracks it and passes it down so we don't have
    /// to make IntegrationsView App-Store-only.
    let anthropicKeySaved: Bool

    /// Per-row inline editor (e.g. OpenClaw Advanced disclosure with
    /// the shared-token field, Antigravity database picker). Returns
    /// `EmptyView()` for rows that have no extra controls.
    @ViewBuilder let accountSlot: (IntegrationDescriptor) -> AccountSlot

    /// Inline editor for API key rows (e.g. SecureField + Save/Clear).
    @ViewBuilder let apiKeySlot: (IntegrationDescriptor) -> ApiKeySlot

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            section(
                title: "Accounts",
                hint: "AgentDeck reads local sessions; repair tools stay in each row's Advanced section.",
                rows: IntegrationCatalog.all.filter { $0.kind == .accountLinked },
                slot: { accountSlot($0) }
            )

            section(
                title: "Optional API keys",
                hint: "Paste a key only if you want extra data AgentDeck can't infer from local state.",
                rows: IntegrationCatalog.all.filter { $0.kind == .apiKey },
                slot: { apiKeySlot($0) }
            )
        }
    }

    @ViewBuilder
    private func section<Slot: View>(
        title: String,
        hint: String,
        rows: [IntegrationDescriptor],
        @ViewBuilder slot: @escaping (IntegrationDescriptor) -> Slot
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.system(size: 12, weight: .bold))
                .kerning(0.6)
                .foregroundStyle(TerrariumHUD.subtext)
            Text(hint)
                .font(.system(size: 11))
                .foregroundStyle(TerrariumHUD.subtext.opacity(0.85))
                .fixedSize(horizontal: false, vertical: true)

            ForEach(Array(rows.enumerated()), id: \.element.id) { index, descriptor in
                if index > 0 { Divider().opacity(0.4) }
                VStack(alignment: .leading, spacing: 6) {
                    IntegrationRow(
                        descriptor: descriptor,
                        status: IntegrationStatusEvaluator.status(
                            for: descriptor,
                            state: stateHolder.state,
                            preferences: preferences,
                            anthropicKeySaved: anthropicKeySaved
                        ),
                        mode: .settings
                    )
                    slot(descriptor)
                }
            }
        }
    }
}

// MARK: - Topology-rail evaluator (Dashboard + MenuBar shared)

/// Thin rail-specific evaluator that maps `DashboardState` + `AppPreferences`
/// into a `(LEDStatus, subtitle)` pair. Shares the `hooks || oauth` Claude
/// formula with `IntegrationStatusEvaluator` so the three surfaces (Settings
/// → Integrations, Dashboard `TopologyRail`, and menu-bar
/// `MenuBarTopologyList`) never drift again. Earlier drift caused the
/// menu-bar rail to show "Not connected" while the Dashboard and Settings
/// both read Claude as connected via hooks.
///
/// The rail consumers keep their own presentation logic (model catalog,
/// rate-limit chips, consumer creature dots, palette) — this evaluator only
/// decides the LED color and the short fallback subtitle.
enum ProviderRailEvaluator {
    struct RowState: Equatable {
        let status: LEDStatus
        let subtitle: String?
    }

    /// Claude is reachable when EITHER the hook relay is wired up OR the
    /// OAuth token is readable. In App Store mode the sandbox blocks
    /// `~/.claude/` OAuth reads, so hooks are the primary signal.
    static func claude(
        state: DashboardState,
        hooksInstalled: Bool
    ) -> RowState {
        let oauthOn = state.oauthConnected == true
        let oauthKnownDown = state.oauthConnected == false
        let status: LEDStatus = {
            if hooksInstalled || oauthOn { return .ok }
            if oauthKnownDown            { return .warn }
            return .dim
        }()
        let subtitle: String? = {
            if hooksInstalled && !oauthOn { return "Hooks on" }
            if oauthKnownDown             { return "Not connected" }
            return nil
        }()
        return RowState(status: status, subtitle: subtitle)
    }

    /// Returns `nil` unless the daemon actually emitted an OpenClaw session.
    ///
    /// This evaluator drives the CREATURE / topology rails only (TopologyRail,
    /// MenuBarTopologyList). Presence-driven SSOT: the daemon injects an
    /// `openclaw` session iff the Gateway is authenticated
    /// (DashboardDataRules.isOpenClawSessionActive), so gating on session
    /// presence keeps the rail crayfish in lockstep with every other surface
    /// and stops a reachable-but-unauthenticated Gateway from rendering a
    /// creature. The richer "Pairing required / Approve this Mac" ladder lives
    /// in the Settings → Integrations row (`openClawStatus`), which is the
    /// configuration surface and is intentionally NOT gated this way.
    static func openClaw(state: DashboardState) -> RowState? {
        // Presence-driven: a session only exists when the Gateway is
        // authenticated, so the rail row is .ok (or .error if the live session
        // is also erroring). The pre-pairing ladder (approval_pending /
        // pairing_required / token-missing, etc.) is intentionally NOT shown on
        // the rail — that affordance lives in the Settings → Integrations
        // `openClawStatus` row, the configuration surface for getting paired.
        guard DashboardDataRules.hasOpenClawSession(state.siblingSessions) else { return nil }
        let status: LEDStatus = state.gatewayHasError ? .error : .ok
        let subtitle: String? = state.gatewayHasError ? "Gateway error" : nil
        return RowState(status: status, subtitle: subtitle)
    }
}
