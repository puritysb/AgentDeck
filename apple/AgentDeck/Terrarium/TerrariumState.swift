// TerrariumState.swift — Visual state mapping from DashboardState
// Ported from android TerrariumState.kt

import Foundation

// MARK: - Octopus Visual State

enum OctopusVisualState {
    case sleeping   // Curled at bottom, dim
    case floating   // Gentle bob, tentacle wave (idle)
    case working    // Swim + starburst (processing)
    case asking     // Fidget + "?" bubble (awaiting input)
}

// MARK: - Crayfish Visual State

enum CrayfishVisualState {
    case dormant    // Hidden behind rocks
    case sitting    // Idle, heartbeat glow
    case observing  // Watching, gentle fidget
    case routing    // Claws clap, signal waves
    case waiting    // Claws raised
    case sick       // Desaturated, tilted (gateway error)
}

// MARK: - Tetra Visual State

enum TetraVisualState {
    case absent
    case circling   // Boids orbit
    case streaming  // Line up, food chase
    case hovering   // Near options
}

// MARK: - Cloud Creature State

struct CloudCreatureState: Identifiable {
    let id: String
    let projectName: String?
    let modelName: String?
    let state: CloudVisualState
    let homeX: Float
    let homeY: Float
    let scale: Float
    /// Number of underlying Codex threads folded into this sprite. Each
    /// Claude Code rescue/stop-gate spawn creates a fresh codex thread, so
    /// without folding the same workspace looks like 4-5 simultaneously
    /// "acting" creatures. Render layers may surface this with a small
    /// "×N" badge or simply ignore it (default 1 = unfolded).
    var groupSize: Int = 1
    var exitedWaiting = false
}

// MARK: - Agent Creature State

struct AgentCreatureState: Identifiable {
    let id: String           // session ID
    let projectName: String?
    let modelName: String?
    let state: OctopusVisualState
    let homeX: Float
    let homeY: Float
    let scale: Float

    /// Whether this session just exited ASKING (triggers pop burst)
    var exitedAsking = false
}

// MARK: - OpenCode Creature State

struct OpenCodeCreatureState: Identifiable {
    let id: String
    let projectName: String?
    let modelName: String?
    let state: OpenCodeVisualState
    let homeX: Float
    let homeY: Float
    let scale: Float
}

// MARK: - Terrarium State (aggregate)

struct TerrariumState {
    var creatures: [AgentCreatureState] = []
    var cloudCreatures: [CloudCreatureState] = []
    var opencodeCreatures: [OpenCodeCreatureState] = []
    var crayfishState: CrayfishVisualState = .dormant
    var crayfishVisible: Bool = false
    var tetraState: TetraVisualState = .circling
    var environment: EnvironmentVisualState = .calm
    var hasError: Bool = false

    /// Pop burst positions (from ASKING exit)
    var popBurstPositions: [(x: Float, y: Float)] = []

    /// Visual id of the creature corresponding to the focused session.
    /// Resolved through codex-cli folding so a focused thread id maps to the
    /// representative cloud sprite. Renderer draws a focus halo behind the
    /// matching creature.
    var focusedSessionId: String? = nil
}

// MARK: - Mapping from DashboardState

extension DashboardState {
    func toTerrariumState(previous: TerrariumState? = nil) -> TerrariumState {
        var result = TerrariumState()

        // Primary session creature (skip daemon/openclaw/codex-cli/opencode — they're not octopuses)
        let primaryIsOctopus = state != .disconnected
            && agentType != "daemon"
            && agentType != "openclaw"
            && agentType != "codex-cli"
            && agentType != "codex-app"
            && agentType != "opencode"

        // Octopus siblings (exclude daemon/openclaw/codex-cli/opencode), sorted by ID for stable positioning.
        // Also exclude the currently-focused session's id to prevent double-rendering when focus relay
        // promotes a sibling to primary (agentType → claude-code, sessionId → sibling.id).
        let siblings = siblingSessions
            .filter { $0.agentType != "daemon" && $0.agentType != "openclaw" && $0.agentType != "codex-cli" && $0.agentType != "codex-app" && $0.agentType != "opencode" }
            .filter { !(primaryIsOctopus && $0.id == sessionId) }
            .sorted { $0.id < $1.id }

        let octopusCount = (primaryIsOctopus ? 1 : 0) + siblings.count
        let slots = CreatureLayout.layoutOctopuses(count: octopusCount)

        var creatures: [AgentCreatureState] = []  // mutated later for dedup numbering
        var slotIdx = 0

        if primaryIsOctopus {
            let primaryState = mapToOctopusState(state)
            let slot = slots.first ?? CreatureSlot(x: 0.4, y: 0.45, scale: 1.0)

            // Detect ASKING exit for pop burst
            let wasAsking = previous?.creatures.first?.state == .asking
            let exitedAsking = wasAsking && primaryState != .asking

            creatures.append(AgentCreatureState(
                id: sessionId ?? "primary",
                projectName: projectName,
                modelName: modelName,
                state: primaryState,
                homeX: slot.x,
                homeY: slot.y,
                scale: slot.scale,
                exitedAsking: exitedAsking
            ))
            slotIdx = 1
        }
        // Sibling octopuses
        for (i, sibling) in siblings.enumerated() {
            guard !slots.isEmpty else { break }
            let idx = min(slotIdx + i, slots.count - 1)
            let s = slots[idx]
            let sibState = mapSiblingState(sibling.state)
            creatures.append(AgentCreatureState(
                id: sibling.id,
                projectName: sibling.projectName,
                modelName: sibling.modelName,
                state: sibState,
                homeX: s.x,
                homeY: s.y,
                scale: s.scale
            ))
        }

        // Number duplicate display names: "AgentDeck", "AgentDeck" → "AgentDeck #1", "AgentDeck #2"
        // Group by (projectName, agentType) so different creature types sharing a project name
        // don't get numbered together (matches SessionListPanel + shared session-utils.ts)
        struct NameTypeKey: Hashable { let name: String?; let type: String }
        let creatureType = "claude-code"  // all entries in `creatures` are octopuses
        let nameCounts = Dictionary(grouping: creatures, by: { NameTypeKey(name: $0.projectName, type: creatureType) }).mapValues { $0.count }
        var nameCounters: [String: Int] = [:]
        for i in creatures.indices {
            let key = NameTypeKey(name: creatures[i].projectName, type: creatureType)
            if let name = creatures[i].projectName, (nameCounts[key] ?? 0) >= 2 {
                let seq = (nameCounters[name] ?? 0) + 1
                nameCounters[name] = seq
                creatures[i] = AgentCreatureState(
                    id: creatures[i].id,
                    projectName: "\(name) #\(seq)",
                    modelName: creatures[i].modelName,
                    state: creatures[i].state,
                    homeX: creatures[i].homeX,
                    homeY: creatures[i].homeY,
                    scale: creatures[i].scale,
                    exitedAsking: creatures[i].exitedAsking
                )
            }
        }

        result.creatures = creatures

        // Cloud (Codex CLI sessions) — folded by projectName.
        //
        // Storage keeps one entry per Codex thread (APME, timeline, focus
        // relay all key off sessionId), but the user's mental model is "one
        // Codex working in this project" — Claude Code's rescue/stop-gate
        // spawns a fresh thread on every turn, which without folding shows
        // up as 4-5 simultaneous Codex creatures for what looks like a
        // single ongoing task. Group by projectName so the terrarium
        // collapses companion-task bursts into a single sprite per
        // workspace; pick the most-recent thread as the representative
        // (its sessionId is what focus-relay/state-update target).
        struct CloudFolded {
            let representative: SessionInfo
            var states: [String?]
        }
        struct CloudPrimary {
            let id: String
            let projectName: String?
            let modelName: String?
            let stateStr: String?
            let cloudState: CloudVisualState
            let startedAt: String?
        }
        func isCodexCloudAgent(_ type: String?) -> Bool {
            type == "codex-cli" || type == "codex-app"
        }

        let primaryIsCloud = state != .disconnected && isCodexCloudAgent(agentType)
        let cloudPrimary: CloudPrimary? = primaryIsCloud ? CloudPrimary(
            id: sessionId ?? "cl-primary",
            projectName: projectName,
            modelName: modelName,
            stateStr: nil,
            cloudState: mapToCloudState(state),
            startedAt: nil
        ) : nil

        let cloudSiblingsRaw = siblingSessions
            .filter { isCodexCloudAgent($0.agentType) }
            .filter { !(primaryIsCloud && $0.id == sessionId) }

        // Group key: projectName when present, else a single shared key so
        // every empty-project Codex thread folds into one cloud sprite.
        // The user's mental model is "one Codex working in this dashboard"
        // — when Companion Tasks arrive without a project tag (low-quality
        // hook payload, OTel span without `cwd` attr) they should still
        // collapse instead of stacking up as separate phantoms. Distinct
        // projects continue to render as distinct sprites.
        func cloudGroupKey(projectName: String?) -> String {
            if let p = projectName, !p.isEmpty { return p }
            return "__codex_no_project__"
        }
        func cloudStatePriority(_ s: CloudVisualState) -> Int {
            switch s {
            case .pulsing: return 3      // processing — most active
            case .waiting: return 2      // awaiting user
            case .drifting: return 1     // idle
            case .dormant: return 0      // disconnected
            }
        }

        // Build groups in encounter order: primary first (if any) under its
        // own key, then siblings appended under the same key.
        var cloudGroupOrder: [String] = []
        var cloudGroups: [String: [(id: String, projectName: String?, modelName: String?, cloudState: CloudVisualState, startedAt: String?)]] = [:]

        if let p = cloudPrimary {
            let type = agentType ?? "codex-cli"
            let key = "\(type):\(cloudGroupKey(projectName: p.projectName))"
            cloudGroupOrder.append(key)
            cloudGroups[key, default: []].append((id: p.id, projectName: p.projectName, modelName: p.modelName, cloudState: p.cloudState, startedAt: p.startedAt))
        }
        for sibling in cloudSiblingsRaw {
            let key = "\(sibling.agentType ?? "codex-cli"):\(cloudGroupKey(projectName: sibling.projectName))"
            if cloudGroups[key] == nil { cloudGroupOrder.append(key) }
            cloudGroups[key, default: []].append((
                id: sibling.id,
                projectName: sibling.projectName,
                modelName: sibling.modelName,
                cloudState: mapSiblingToCloudState(sibling.state),
                startedAt: sibling.startedAt
            ))
        }

        let cloudSlots = CreatureLayout.layoutCloudCreatures(count: cloudGroupOrder.count)
        var cloudCreatures: [CloudCreatureState] = []
        // Resolve a focused codex thread id to its representative so the
        // halo lights up the visible cloud sprite even when the focus relay
        // points at a folded thread id.
        var resolvedFocusId: String? = focusedSessionId
        for (slotIdx, key) in cloudGroupOrder.enumerated() {
            guard let members = cloudGroups[key], !members.isEmpty else { continue }
            // Aggregate state = highest-priority member.
            let aggregate = members.max(by: { cloudStatePriority($0.cloudState) < cloudStatePriority($1.cloudState) })?.cloudState ?? .drifting
            // Representative = most-recent startedAt, fallback to last-seen
            // member (encounter order preserves primary precedence).
            let representative = members.max(by: { (lhs, rhs) in
                (lhs.startedAt ?? "") < (rhs.startedAt ?? "")
            }) ?? members.last!
            let slot = cloudSlots.indices.contains(slotIdx)
                ? cloudSlots[slotIdx]
                : (cloudSlots.last ?? CreatureSlot(x: 0.50, y: 0.45, scale: 1.0))
            cloudCreatures.append(CloudCreatureState(
                id: representative.id,
                projectName: representative.projectName,
                modelName: representative.modelName,
                state: aggregate,
                homeX: slot.x,
                homeY: slot.y,
                scale: slot.scale,
                groupSize: members.count
            ))
            if let focused = focusedSessionId, members.contains(where: { $0.id == focused }) {
                resolvedFocusId = representative.id
            }
        }
        result.cloudCreatures = cloudCreatures
        result.focusedSessionId = resolvedFocusId

        // OpenCode creatures
        let primaryIsOpenCode = state != .disconnected && agentType == "opencode"
        let openCodeSiblings = siblingSessions
            .filter { $0.agentType == "opencode" }
            .filter { !(primaryIsOpenCode && $0.id == sessionId) }
            .sorted { $0.id < $1.id }
        let openCodeCount = (primaryIsOpenCode ? 1 : 0) + openCodeSiblings.count
        let openCodeSlots = CreatureLayout.layoutOpenCodeCreatures(count: openCodeCount)

        var openCodeCreatures: [OpenCodeCreatureState] = []
        var openCodeSlotIdx = 0
        if primaryIsOpenCode {
            let s = openCodeSlots.first ?? CreatureSlot(x: 0.48, y: 0.40, scale: 1.0)
            openCodeCreatures.append(OpenCodeCreatureState(
                id: sessionId ?? "oc-primary",
                projectName: projectName,
                modelName: modelName,
                state: mapToOpenCodeState(state),
                homeX: s.x, homeY: s.y, scale: s.scale
            ))
            openCodeSlotIdx = 1
        }
        for (i, sibling) in openCodeSiblings.enumerated() {
            guard !openCodeSlots.isEmpty else { break }
            let idx = min(openCodeSlotIdx + i, openCodeSlots.count - 1)
            let s = openCodeSlots[idx]
            openCodeCreatures.append(OpenCodeCreatureState(
                id: sibling.id,
                projectName: sibling.projectName,
                modelName: sibling.modelName,
                state: mapSiblingToOpenCodeState(sibling.state),
                homeX: s.x, homeY: s.y, scale: s.scale
            ))
        }
        result.opencodeCreatures = openCodeCreatures

        // Environment state — in daemon mode, derive from most active sibling
        let isDaemonLike = agentType == "daemon" ||
            (agentType != nil && siblingSessions.contains(where: { $0.agentType == agentType }))
        let effectiveState: AgentConnectionState
        if isDaemonLike && state == .disconnected {
            effectiveState = mostActiveSiblingState(siblingSessions) ?? .idle
        } else {
            effectiveState = state
        }
        result.environment = mapToEnvironment(effectiveState)
        result.hasError = gatewayHasError

        // Crayfish (OpenClaw gateway) — presence-driven SSOT. The crayfish
        // tracks the OpenClaw SESSION the daemon emits, never raw gateway
        // flags. The daemon injects an `openclaw` session iff the Gateway is
        // authenticated (DashboardDataRules.isOpenClawSessionActive), so no
        // emitted session ⇒ dormant (hidden) even if the port is reachable or
        // doctor reports an error. This keeps every surface in lockstep and
        // kills the "OpenClaw won't go away" trace.
        let ocSibling = siblingSessions.first(where: { $0.agentType == "openclaw" })
        result.crayfishVisible = ocSibling != nil

        if ocSibling == nil {
            result.crayfishState = .dormant
        } else if gatewayHasError {
            result.crayfishState = .sick
        } else {
            result.crayfishState = ocSibling!.state == "processing" ? .routing : .sitting
        }

        // Tetra state — use effectiveState so daemon mode isn't stuck on ABSENT
        if effectiveState == .processing || creatures.contains(where: { $0.state == .working }) {
            result.tetraState = .streaming
        } else if effectiveState.isAwaiting {
            result.tetraState = .hovering
        } else if effectiveState == .disconnected {
            result.tetraState = .absent
        } else {
            result.tetraState = .circling
        }

        // Pop bursts from ASKING exits
        result.popBurstPositions = creatures
            .filter { $0.exitedAsking }
            .map { (x: $0.homeX, y: $0.homeY) }

        return result
    }

    private func mapToOctopusState(_ connState: AgentConnectionState) -> OctopusVisualState {
        switch connState {
        case .disconnected: .sleeping
        case .idle: .floating
        case .processing: .working
        case .awaitingPermission, .awaitingOption, .awaitingDiff: .asking
        }
    }

    private func mapSiblingState(_ stateStr: String?) -> OctopusVisualState {
        switch stateStr {
        case "processing": .working
        case "awaiting_permission", "awaiting_option", "awaiting_diff": .asking
        case "idle": .floating
        default: .sleeping
        }
    }

    private func mapToCloudState(_ connState: AgentConnectionState) -> CloudVisualState {
        switch connState {
        case .disconnected: .dormant
        case .idle: .drifting
        case .processing: .pulsing
        case .awaitingPermission, .awaitingOption, .awaitingDiff: .waiting
        }
    }

    private func mapSiblingToCloudState(_ stateStr: String?) -> CloudVisualState {
        switch stateStr {
        case "processing": .pulsing
        case "awaiting_permission", "awaiting_option", "awaiting_diff": .waiting
        case "idle": .drifting
        default: .dormant
        }
    }

    private func mapToOpenCodeState(_ connState: AgentConnectionState) -> OpenCodeVisualState {
        switch connState {
        case .disconnected: .dormant
        case .idle: .drifting
        case .processing: .pulsing
        case .awaitingPermission, .awaitingOption, .awaitingDiff: .waiting
        }
    }

    private func mapSiblingToOpenCodeState(_ stateStr: String?) -> OpenCodeVisualState {
        switch stateStr {
        case "processing": .pulsing
        case "awaiting_permission", "awaiting_option", "awaiting_diff": .waiting
        case "idle": .drifting
        default: .dormant
        }
    }

    private func mapToEnvironment(_ connState: AgentConnectionState) -> EnvironmentVisualState {
        switch connState {
        case .disconnected: .dark
        case .idle: .calm
        case .processing: .active
        case .awaitingPermission, .awaitingOption, .awaitingDiff: .alert
        }
    }

    /// In daemon mode, derive the most active state from sibling sessions.
    private func mostActiveSiblingState(_ siblings: [SessionInfo]) -> AgentConnectionState? {
        func priority(_ s: AgentConnectionState) -> Int {
            switch s {
            case .disconnected: return 0
            case .idle: return 1
            case .processing: return 2
            case .awaitingPermission, .awaitingOption, .awaitingDiff: return 3
            }
        }
        var best: AgentConnectionState? = nil
        for s in siblings {
            if s.agentType == "daemon" { continue }
            let mapped: AgentConnectionState? = switch s.state {
            case "processing": .processing
            case "awaiting_permission": .awaitingPermission
            case "awaiting_option": .awaitingOption
            case "awaiting_diff": .awaitingDiff
            case "idle": .idle
            default: nil
            }
            guard let m = mapped else { continue }
            if best == nil || priority(m) > priority(best!) {
                best = m
            }
        }
        return best
    }
}
