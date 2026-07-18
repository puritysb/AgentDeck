#if os(macOS)
// StateMachine.swift — Agent state machine
// Ported from shared/src/states.ts + shared/src/state-machine.ts

import Foundation

enum AgentState: String, Codable, Sendable {
    case disconnected
    case idle
    case processing
    case awaitingPermission = "awaiting_permission"
    case awaitingOption = "awaiting_option"
    case awaitingDiff = "awaiting_diff"
}

enum TransitionSource: String, Sendable {
    case hook, pty, user, `internal`
}

struct StateTransition: Sendable {
    let from: AgentState?  // nil = wildcard *
    let to: AgentState
    let trigger: String
    let source: TransitionSource
}

let stateTransitions: [StateTransition] = [
    .init(from: .disconnected, to: .idle, trigger: "session_start", source: .hook),
    .init(from: .idle, to: .processing, trigger: "user_prompt_submit", source: .hook),
    .init(from: .idle, to: .processing, trigger: "spinner_start", source: .pty),
    .init(from: .processing, to: .idle, trigger: "stop", source: .hook),
    .init(from: .processing, to: .idle, trigger: "idle_detected", source: .pty),
    .init(from: .awaitingPermission, to: .idle, trigger: "idle_detected", source: .pty),
    .init(from: .awaitingOption, to: .idle, trigger: "idle_detected", source: .pty),
    .init(from: .awaitingDiff, to: .idle, trigger: "idle_detected", source: .pty),
    .init(from: .processing, to: .awaitingPermission, trigger: "permission_prompt", source: .pty),
    .init(from: .idle, to: .awaitingPermission, trigger: "permission_prompt", source: .pty),
    .init(from: .processing, to: .awaitingOption, trigger: "option_ui_detected", source: .pty),
    .init(from: .idle, to: .awaitingOption, trigger: "option_ui_detected", source: .pty),
    .init(from: .processing, to: .awaitingDiff, trigger: "diff_ui_detected", source: .pty),
    .init(from: .idle, to: .awaitingDiff, trigger: "diff_ui_detected", source: .pty),
    .init(from: .awaitingPermission, to: .processing, trigger: "user_response", source: .user),
    .init(from: .awaitingPermission, to: .processing, trigger: "user_selection", source: .user),
    .init(from: .awaitingOption, to: .processing, trigger: "user_selection", source: .user),
    .init(from: .awaitingDiff, to: .processing, trigger: "user_response", source: .user),
    .init(from: .awaitingDiff, to: .processing, trigger: "user_selection", source: .user),
    .init(from: .awaitingPermission, to: .processing, trigger: "spinner_start", source: .pty),
    .init(from: .awaitingOption, to: .processing, trigger: "spinner_start", source: .pty),
    .init(from: .awaitingDiff, to: .processing, trigger: "spinner_start", source: .pty),
    .init(from: .processing, to: .idle, trigger: "stuck_timeout", source: .internal),
    .init(from: nil, to: .disconnected, trigger: "session_end", source: .hook),
    .init(from: nil, to: .idle, trigger: "interrupt", source: .user),
]

// Holds daemon state → runs on the daemon's executor. See DaemonActor.
@DaemonActor
final class StateMachine {
    private(set) var state: AgentState = .disconnected
    private(set) var permissionMode: String = "default"

    // Tool info
    var currentTool: String?
    var toolInput: String?
    var toolProgress: String?

    // Prompt
    var options: [[String: Any]] = []
    var promptType: String?
    var question: String?
    var navigable = false
    var cursorIndex = 0
    var suggestedPrompt: String?

    // Project / Model
    var projectName: String?
    var modelName: String?
    var effortLevel: String?
    var billingType: String = "unknown"

    // Usage
    var sessionDurationSec = 0
    var inputTokens = 0
    var outputTokens = 0
    var toolCalls = 0
    var estimatedCostUsd: Double?
    var sessionPercent: Double?
    var costSpent: Double?
    var costLimit: Double?
    var resetTime: String?
    var resetDate: String?

    // Remote
    var remoteUrl: String?

    var onStateChanged: ((AgentState, AgentState) -> Void)?
    private var stuckTimer: Task<Void, Never>?
    private let stuckTimeoutMs = 5 * 60 * 1000

    func transition(trigger: String, source: TransitionSource) -> Bool {
        guard let t = stateTransitions.first(where: { transition in
            (transition.from == nil || transition.from == state) &&
            transition.trigger == trigger &&
            transition.source == source
        }) else {
            DaemonLogger.shared.debug("SM", "No transition for \(trigger) from \(state.rawValue)")
            return false
        }

        let oldState = state
        state = t.to
        DaemonLogger.shared.debug("SM", "\(oldState.rawValue) → \(state.rawValue) [\(trigger)]")

        // Clear prompt data on state change
        if oldState != state {
            if state == .idle || state == .processing {
                clearPromptData()
            }
            resetStuckTimer()
            onStateChanged?(oldState, state)
        }
        return true
    }

    func setState(_ newState: AgentState) {
        let old = state
        state = newState
        if old != newState {
            if newState == .idle || newState == .processing { clearPromptData() }
            resetStuckTimer()
            onStateChanged?(old, newState)
        }
    }

    private func clearPromptData() {
        options = []
        promptType = nil
        question = nil
        navigable = false
        cursorIndex = 0
        suggestedPrompt = nil
    }

    private func resetStuckTimer() {
        stuckTimer?.cancel()
        if state == .processing {
            stuckTimer = Task { [weak self] in
                try? await Task.sleep(for: .milliseconds(self?.stuckTimeoutMs ?? 300_000))
                guard !Task.isCancelled else { return }
                _ = self?.transition(trigger: "stuck_timeout", source: .internal)
            }
        }
    }
}
#endif
