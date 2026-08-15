#if os(macOS)
// StateMachine.swift — Agent state machine
// Ported from shared/src/states.ts + shared/src/state-machine.ts
//
// `AgentState`, `TransitionSource`, `StateTransition` and the transition table
// itself are GENERATED into StateTransitions.generated.swift from
// shared/src/states.ts — the table is a rule set two daemons must agree on
// exactly, and a hand-kept copy of one drifts silently. Only the driver below
// (timers, prompt state, side effects on a state change) is hand-written.
// Regenerate with `pnpm generate-state-transitions`.

import Foundation

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
