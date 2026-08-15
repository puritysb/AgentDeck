#if os(macOS)
// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/states.ts (State, TransitionSource, transitions)
// Regenerate: pnpm generate-state-transitions (drift gated by shared/src/__tests__/state-transitions.test.ts)

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

/// The agent state machine's transition table, mirrored from shared/src/states.ts.
///
/// NOTE for this daemon specifically: it multiplexes every observed session
/// into one machine, so — exactly like the Node daemon hub's
/// `toolActivityRecovery: false` — the driver (DaemonServer) must never EMIT
/// "tool_activity". Those rows exist because the table is a faithful mirror,
/// not because this daemon drives them.
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
    // Recovery: spinner_start from awaiting states (user responded via keyboard,
    // not a device). Only adapters that still emit parser lifecycle events
    // (OpenCode, OpenClaw) can drive these; Claude/Codex adapters forward
    // terminal_ui prompts only, so their keyboard-answer recovery is hook-based.
    .init(from: .awaitingPermission, to: .processing, trigger: "spinner_start", source: .pty),
    .init(from: .awaitingOption, to: .processing, trigger: "spinner_start", source: .pty),
    .init(from: .awaitingDiff, to: .processing, trigger: "spinner_start", source: .pty),
    // Hook exits from AWAITING_*: a prompt answered at the keyboard produces no
    // user/device action and (for Claude/Codex) no parser signal, so the
    // lifecycle hooks that keep firing are the only truthful dismissal evidence:
    // tool activity means the turn is running again, stop means the turn ended,
    // and a new user_prompt_submit means a new turn started. Without these the
    // session wedges in AWAITING_* forever once the user touches the terminal.
    .init(from: .awaitingPermission, to: .processing, trigger: "tool_activity", source: .hook),
    .init(from: .awaitingOption, to: .processing, trigger: "tool_activity", source: .hook),
    .init(from: .awaitingDiff, to: .processing, trigger: "tool_activity", source: .hook),
    .init(from: .awaitingPermission, to: .idle, trigger: "stop", source: .hook),
    .init(from: .awaitingOption, to: .idle, trigger: "stop", source: .hook),
    .init(from: .awaitingDiff, to: .idle, trigger: "stop", source: .hook),
    .init(from: .awaitingPermission, to: .processing, trigger: "user_prompt_submit", source: .hook),
    .init(from: .awaitingOption, to: .processing, trigger: "user_prompt_submit", source: .hook),
    .init(from: .awaitingDiff, to: .processing, trigger: "user_prompt_submit", source: .hook),
    // Hook-miss recovery: tool activity arriving while IDLE proves a turn is
    // running even when its user_prompt_submit was dropped.
    .init(from: .idle, to: .processing, trigger: "tool_activity", source: .hook),
    // stuck_timeout: only PROCESSING recovers after STUCK_TIMEOUT_MS (Claude hung).
    // AWAITING_* intentionally have NO wall-clock backstop — an unanswered prompt
    // is a genuine, indefinitely-valid wait (the user may be away); it only leaves
    // via a real signal (hook tool_activity/stop/user_prompt_submit, parser
    // spinner_start/idle_detected where still emitted, or a user response), and
    // a truly-dead session is reaped by liveness, not a timer. A blind awaiting
    // timer wrongly forced real prompts to IDLE and vanished them from dashboards.
    .init(from: .processing, to: .idle, trigger: "stuck_timeout", source: .internal),
    .init(from: nil, to: .disconnected, trigger: "session_end", source: .hook),
    .init(from: nil, to: .idle, trigger: "interrupt", source: .user),
]
#endif
