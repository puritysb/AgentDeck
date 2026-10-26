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
    /// Repeated observations of this exact identity, never same-project peers.
    /// Actual child-agent counts use subagentActivity instead.
    var groupSize: Int = 1
    var exitedWaiting = false
    var subagentActivity: SubagentVisualActivity = .none
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
    var subagentActivity: SubagentVisualActivity = .none
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
    var subagentActivity: SubagentVisualActivity = .none
}

// MARK: - Antigravity Creature State

struct AntigravityCreatureState: Identifiable {
    let id: String
    let projectName: String?
    let modelName: String?
    let state: AntigravityVisualState
    let homeX: Float
    let homeY: Float
    let scale: Float
    var subagentActivity: SubagentVisualActivity = .none
}

struct KiroCreatureState: Identifiable {
    let id: String
    let projectName: String?
    let modelName: String?
    let state: KiroVisualState
    let homeX: Float
    let homeY: Float
    let scale: Float
    var subagentActivity: SubagentVisualActivity = .none
}

struct HermesCreatureState: Identifiable {
    let id: String
    let projectName: String?
    let activity: HermesSwim.Activity
    var subagentActivity: SubagentVisualActivity = .none
}

// MARK: - Terrarium State (aggregate)

struct TerrariumState {
    /// Explicit Claude background-task counts, zero included; an absent key is unknown.
    var backgroundTaskCounts: [String: Int] = [:]
    var ciWaits: [String: CiWaitStatus] = [:]
    var ciWaitLabels: [String: String] = [:]
    var ciWaitingIDs: Set<String> = []
    var creatures: [AgentCreatureState] = []
    var cloudCreatures: [CloudCreatureState] = []
    var opencodeCreatures: [OpenCodeCreatureState] = []
    var antigravityCreatures: [AntigravityCreatureState] = []
    var kiroCreatures: [KiroCreatureState] = []
    var hermesCreatures: [HermesCreatureState] = []
    var crayfishState: CrayfishVisualState = .dormant
    var crayfishVisible: Bool = false
    var tetraState: TetraVisualState = .circling
    var environment: EnvironmentVisualState = .calm
    var hasError: Bool = false

    /// Pop burst positions (from ASKING exit)
    var popBurstPositions: [(x: Float, y: Float)] = []

    /// Visual id of the creature corresponding to the focused session.
    /// Renderer draws a focus halo behind this identity's matching creature.
    var focusedSessionId: String? = nil
}

// MARK: - Mapping from DashboardState

extension DashboardState {
    func toTerrariumState(
        previous: TerrariumState? = nil,
        subagentActivityBySession: [String: SubagentVisualActivity] = [:],
        activityAvailable: Bool = true
    ) -> TerrariumState {
        var result = TerrariumState()
        // Offline history stays in the dashboard, but cannot drive live task motion.
        guard activityAvailable else { return result }
        // Every explicit count is carried, whatever the state: a zero is "the
        // tasks finished", while an absent key is "unknown". Showing pods is
        // the renderer's choice (working sessions only); hatching needs the zero.
        for session in siblingSessions {
            if let count = session.backgroundTaskCount, count >= 0 {
                result.backgroundTaskCounts[session.id] = count
            }
        }
        for session in siblingSessions where session.waitingOn != nil && !(session.state ?? "").hasPrefix("awaiting") {
            result.ciWaits[session.id] = session.waitingOn
            if let wait = session.waitingOn { result.ciWaitLabels[session.id] = CiCompanionPresentation.label(wait) }
            if session.waitingOn?.agentWaiting == true || (session.waitingOn?.phase == "failed" && session.state == "idle") { result.ciWaitingIDs.insert(session.id) }
        }

        // Primary session creature (skip daemon/openclaw/codex-cli/opencode/antigravity — they're not octopuses)
        // ALLOW-list, not a deny-list. This bucket used to be spelled as
        // "everything except the agents we happen to know about", which meant an
        // agentType this build has never heard of was drawn as a Claude octopus
        // — a session wearing another agent's identity. Daemon and dashboard
        // ship separately, so the daemon WILL send types an older dashboard does
        // not know; the correct answer for those is no creature, never someone
        // else's. Mirrors `CODING_AGENTS` in bridge/src/pixoo/pixoo-renderer.ts,
        // which has always been an allow-list.
        let primaryIsOctopus = state != .disconnected && Self.isOctopusAgent(agentType)

        // Octopus siblings (exclude daemon/openclaw/codex-cli/opencode/antigravity), sorted by ID for stable positioning.
        // Also exclude the currently-focused session's id to prevent double-rendering when focus relay
        // promotes a sibling to primary (agentType → claude-code, sessionId → sibling.id).
        let siblings = siblingSessions
            .filter { Self.isOctopusAgent($0.agentType) }
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
                exitedAsking: exitedAsking,
                subagentActivity: subagentActivityBySession[sessionId ?? "primary"] ?? .none
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
                scale: s.scale,
                subagentActivity: subagentActivityBySession[sibling.id] ?? .none
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
                    exitedAsking: creatures[i].exitedAsking,
                    subagentActivity: creatures[i].subagentActivity
                )
            }
        }

        result.creatures = creatures

        // One cloud per independent Codex identity, as in the shared roster.
        // Proven children are reduced upstream; project membership proves no relation.
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

        // Only repeated observations of the exact same id may share a sprite.
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
            let key = "\(type):\(p.id)"
            cloudGroupOrder.append(key)
            cloudGroups[key, default: []].append((id: p.id, projectName: p.projectName, modelName: p.modelName, cloudState: p.cloudState, startedAt: p.startedAt))
        }
        for sibling in cloudSiblingsRaw {
            let key = "\(sibling.agentType ?? "codex-cli"):\(sibling.id)"
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
        // Repeated observations share only their exact identity and focus.
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
            let subagentActivity = members.reduce(SubagentVisualActivity.none) {
                $0.merged(with: subagentActivityBySession[$1.id] ?? .none)
            }
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
                groupSize: members.count,
                subagentActivity: subagentActivity
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
                homeX: s.x, homeY: s.y, scale: s.scale,
                subagentActivity: subagentActivityBySession[sessionId ?? "oc-primary"] ?? .none
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
                homeX: s.x, homeY: s.y, scale: s.scale,
                subagentActivity: subagentActivityBySession[sibling.id] ?? .none
            ))
        }
        result.opencodeCreatures = openCodeCreatures

        // Antigravity creatures
        let primaryIsAntigravity = state != .disconnected && agentType == "antigravity"
        let antigravitySiblings = siblingSessions
            .filter { $0.agentType == "antigravity" }
            .filter { !(primaryIsAntigravity && $0.id == sessionId) }
            .sorted { $0.id < $1.id }
        let antigravityCount = (primaryIsAntigravity ? 1 : 0) + antigravitySiblings.count
        let antigravitySlots = CreatureLayout.layoutAntigravityCreatures(count: antigravityCount)

        var antigravityCreatures: [AntigravityCreatureState] = []
        var antigravitySlotIdx = 0
        if primaryIsAntigravity {
            let s = antigravitySlots.first ?? CreatureSlot(x: 0.70, y: 0.28, scale: 1.0)
            antigravityCreatures.append(AntigravityCreatureState(
                id: sessionId ?? "ag-primary",
                projectName: projectName,
                modelName: modelName,
                state: mapToAntigravityState(state),
                homeX: s.x, homeY: s.y, scale: s.scale,
                subagentActivity: subagentActivityBySession[sessionId ?? "ag-primary"] ?? .none
            ))
            antigravitySlotIdx = 1
        }
        for (i, sibling) in antigravitySiblings.enumerated() {
            guard !antigravitySlots.isEmpty else { break }
            let idx = min(antigravitySlotIdx + i, antigravitySlots.count - 1)
            let s = antigravitySlots[idx]
            antigravityCreatures.append(AntigravityCreatureState(
                id: sibling.id,
                projectName: sibling.projectName,
                modelName: sibling.modelName,
                state: mapSiblingToAntigravityState(sibling.state),
                homeX: s.x, homeY: s.y, scale: s.scale,
                subagentActivity: subagentActivityBySession[sibling.id] ?? .none
            ))
        }
        result.antigravityCreatures = antigravityCreatures

        // Kiro ghosts
        let isKiro: (String?) -> Bool = { $0 == "kiro-cli" || $0 == "kiro-ide" }
        let primaryIsKiro = state != .disconnected && isKiro(agentType)
        let kiroSiblings = siblingSessions
            .filter { isKiro($0.agentType) }
            .filter { !(primaryIsKiro && $0.id == sessionId) }
            .sorted { $0.id < $1.id }
        let kiroCount = (primaryIsKiro ? 1 : 0) + kiroSiblings.count
        let kiroSlots = CreatureLayout.layoutKiroCreatures(count: kiroCount)

        var kiroCreatures: [KiroCreatureState] = []
    var hermesCreatures: [HermesCreatureState] = []
        var kiroSlotIdx = 0
        if primaryIsKiro {
            let s = kiroSlots.first ?? CreatureSlot(x: 0.18, y: 0.24, scale: 1.0)
            kiroCreatures.append(KiroCreatureState(
                id: sessionId ?? "kiro-primary",
                projectName: projectName,
                modelName: modelName,
                state: mapToKiroState(state),
                homeX: s.x, homeY: s.y, scale: s.scale,
                subagentActivity: subagentActivityBySession[sessionId ?? "kiro-primary"] ?? .none
            ))
            kiroSlotIdx = 1
        }
        for (i, sibling) in kiroSiblings.enumerated() {
            guard !kiroSlots.isEmpty else { break }
            let idx = min(kiroSlotIdx + i, kiroSlots.count - 1)
            let s = kiroSlots[idx]
            kiroCreatures.append(KiroCreatureState(
                id: sibling.id,
                projectName: sibling.projectName,
                modelName: sibling.modelName,
                state: mapSiblingToKiroState(sibling.state),
                homeX: s.x, homeY: s.y, scale: s.scale,
                subagentActivity: subagentActivityBySession[sibling.id] ?? .none
            ))
        }
        result.kiroCreatures = kiroCreatures

        // Hermes is a distinct observed harness. Never infer it from provider/model.
        func hermesActivity(_ raw: String?) -> HermesSwim.Activity {
            switch raw {
            case "processing": return .working
            case "awaiting_option", "awaiting_diff", "awaiting_permission": return .waiting
            case "error": return .error
            default: return .idle
            }
        }
        let primaryHermes = agentType == "hermes" && state != .disconnected
        if primaryHermes {
            let activity: HermesSwim.Activity = state == .processing ? .working
                : state.isAwaiting ? .waiting : .idle
            result.hermesCreatures.append(.init(id: sessionId ?? "hermes-primary",
                projectName: projectName, activity: activity,
                subagentActivity: subagentActivityBySession[sessionId ?? "hermes-primary"] ?? .none))
        }
        for sibling in siblingSessions.sorted(by: { $0.id < $1.id })
            where sibling.agentType == "hermes" && sibling.alive && sibling.state != "disconnected"
                && !(primaryHermes && sibling.id == sessionId) {
            result.hermesCreatures.append(.init(id: sibling.id, projectName: sibling.projectName,
                activity: hermesActivity(sibling.state),
                subagentActivity: subagentActivityBySession[sibling.id] ?? .none))
        }

        // Environment state — in daemon mode, derive from most active sibling
        // Narrowed to the aggregate rows the comment above names. The previous
        // form matched the focused session's own row — `siblingSessions`
        // contains it — so it was true for every typed session. Here that only
        // reached the environment mood on a disconnected primary (the creature
        // lists on this surface do not consult it, unlike the Android one where
        // the same expression suppressed every primary creature), but it is the
        // same mistake and it read as intentional.
        let isDaemonLike = agentType == "daemon" ||
            (agentType == "openclaw" && siblingSessions.contains(where: { $0.agentType == "openclaw" }))
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

        // The focused state_update can arrive before its sibling roster row.
        // Permission activity owns the final projection even if that row still
        // carries an idle CI wait from the previous full snapshot.
        let permissionIDs = Set(AquariumResident.project(result).filter { $0.activity == .waiting }.map(\.id))
        result.ciWaits = result.ciWaits.filter { !permissionIDs.contains($0.key) }
        result.ciWaitLabels = result.ciWaitLabels.filter { !permissionIDs.contains($0.key) }
        result.ciWaitingIDs.subtract(permissionIDs)
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

    private func mapToAntigravityState(_ connState: AgentConnectionState) -> AntigravityVisualState {
        switch connState {
        case .disconnected: .sleeping
        case .idle: .floating
        case .processing: .working
        case .awaitingPermission, .awaitingOption, .awaitingDiff: .asking
        }
    }

    /// Agent types drawn as the octopus. SSOT-mirrored from `CODING_AGENTS`
    /// in `bridge/src/pixoo/pixoo-renderer.ts` — keep the two in step, and keep
    /// this an allow-list so an unknown agent renders as nothing rather than as
    /// Claude.
    static func isOctopusAgent(_ agentType: String?) -> Bool {
        agentType == "claude-code"
    }

    private func mapToKiroState(_ connState: AgentConnectionState) -> KiroVisualState {
        switch connState {
        case .disconnected: .sleeping
        case .idle: .floating
        case .processing: .working
        case .awaitingPermission, .awaitingOption, .awaitingDiff: .asking
        }
    }

    private func mapSiblingToKiroState(_ stateStr: String?) -> KiroVisualState {
        switch stateStr {
        case "processing": .working
        case "awaiting_permission", "awaiting_option", "awaiting_diff": .asking
        case "idle": .floating
        default: .sleeping
        }
    }

    private func mapSiblingToAntigravityState(_ stateStr: String?) -> AntigravityVisualState {
        switch stateStr {
        case "processing": .working
        case "awaiting_permission", "awaiting_option", "awaiting_diff": .asking
        case "idle": .floating
        default: .sleeping
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
