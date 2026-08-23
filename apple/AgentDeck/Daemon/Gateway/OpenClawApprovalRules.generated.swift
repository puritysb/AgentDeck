// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/openclaw-approval.ts
// Regenerate: pnpm generate-openclaw-approval-rules (drift gated by shared/src/__tests__/openclaw-approval-rules-sync.test.ts)

import Foundation

#if os(macOS)

/// The decisions the OpenClaw Gateway will accept for an exec approval.
///
/// `allow` is deliberately NOT a member. The Gateway's `isApprovalDecision`
/// rejects it, and it does so before the approval id is looked up — so a resolve
/// carrying it returns INVALID_REQUEST and the approval stays pending with no
/// visible failure anywhere.
enum ExecApprovalDecision: String, CaseIterable, Sendable {
    case allowOnce = "allow-once"
    case allowAlways = "allow-always"
    case deny = "deny"

    static let ordered: [ExecApprovalDecision] = [.allowOnce, .allowAlways, .deny]

    /// Short device-facing label (Stream Deck keys, D200H cells).
    var label: String {
        switch self {
        case .allowOnce: return "Allow once"
        case .allowAlways: return "Always allow"
        case .deny: return "Deny"
        }
    }

    /// What a non-navigable `respond` press carries for this decision.
    var shortcut: String {
        switch self {
        case .allowOnce: return "y"
        case .allowAlways: return "a"
        case .deny: return "n"
        }
    }

    var allowsExecution: Bool {
        self == .allowOnce || self == .allowAlways
    }
}

/// One renderable choice on a deck surface. The decision rides the option so an
/// index press is never re-derived (and mis-derived) at the answer site.
struct ExecApprovalOption: Sendable, Equatable {
    let index: Int
    let label: String
    let shortcut: String
    let decision: ExecApprovalDecision
}

/// Normalized `exec.approval.requested` — what surfaces render and what an
/// answer maps back through.
struct OpenClawApprovalPrompt: Sendable, Equatable {
    let id: String
    let question: String
    let detail: String?
    let command: String
    let cwd: String?
    let options: [ExecApprovalOption]
    let expiresAtMs: Double?
    let requestedAtMs: Double
    let sessionKey: String?
}

enum OpenClawApprovalRules {

    /// Parse a raw `exec.approval.requested` payload.
    ///
    /// The Gateway sends `{ id, request, createdAtMs, expiresAtMs }` — every
    /// display field lives under `request`. The flat lookup is a compatibility
    /// path only, so a Gateway that inlines a field degrades instead of blanking
    /// the prompt. Returns nil only when there is no usable id: a request with no
    /// command text still yields a prompt, because the user must keep the ability
    /// to deny something they cannot see.
    static func parse(_ payload: [String: Any], nowMs: Double) -> OpenClawApprovalPrompt? {
        let id = (payload["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !id.isEmpty else { return nil }

        var body = payload
        if let request = payload["request"] as? [String: Any] {
            for (k, v) in request { body[k] = v }
        }

        let argv = (body["commandArgv"] as? [String])?.joined(separator: " ")
        let command = firstNonEmpty([
            body["command"] as? String,
            body["commandPreview"] as? String,
            argv,
        ]) ?? ""

        let cwd = firstNonEmpty([body["cwd"] as? String])
        // Most-decisive-first — mirror of the TS SSOT. A surface with room for
        // ONE supporting line takes the head, and the line that decides an
        // approval is the one saying WHY it was demanded, not the cwd (which is
        // identical for every request from a given agent and distinguishes
        // nothing).
        var detailParts: [String] = []
        let warning = firstNonEmpty([body["warningText"] as? String])
        if let warning { detailParts.append(warning) }
        if let analysis = firstNonEmpty([body["commandAnalysis"] as? String]), analysis != warning {
            detailParts.append(analysis)
        }
        if let cwd { detailParts.append("cwd: \(cwd)") }

        let options = resolveDecisions(body).enumerated().map { idx, decision in
            ExecApprovalOption(
                index: idx, label: decision.label, shortcut: decision.shortcut, decision: decision)
        }

        return OpenClawApprovalPrompt(
            id: id,
            question: command.isEmpty ? "Approve tool execution (command not reported)" : command,
            detail: detailParts.isEmpty ? nil : detailParts.joined(separator: "\n"),
            command: command,
            cwd: cwd,
            options: options,
            expiresAtMs: numeric(payload["expiresAtMs"]),
            requestedAtMs: numeric(payload["createdAtMs"]) ?? nowMs,
            sessionKey: firstNonEmpty([body["sessionKey"] as? String])
        )
    }

    /// Map a `select_option` index onto the decision that option represents.
    static func decision(forOptionIndex index: Int, in prompt: OpenClawApprovalPrompt)
        -> ExecApprovalDecision?
    {
        prompt.options.first(where: { $0.index == index })?.decision
    }

    /// Map a `respond` value onto a decision. Accepts the option shortcut, the
    /// decision name, and the y/n/a spellings hardware keys and the wake-word
    /// assistant send. Unrecognized input returns nil — an ambiguous press must
    /// never be guessed into an approval.
    static func decision(forRespondValue value: String, in prompt: OpenClawApprovalPrompt)
        -> ExecApprovalDecision?
    {
        let v = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !v.isEmpty else { return nil }
        if let byDecision = prompt.options.first(where: { $0.decision.rawValue == v }) {
            return byDecision.decision
        }
        if let byShortcut = prompt.options.first(where: { $0.shortcut == v }) {
            return byShortcut.decision
        }
        if let byLabel = prompt.options.first(where: { $0.label.lowercased() == v }) {
            return byLabel.decision
        }
        let alias: [String: ExecApprovalDecision] = [
            "y": .allowOnce, "yes": .allowOnce, "allow": .allowOnce, "once": .allowOnce,
            "a": .allowAlways, "always": .allowAlways,
            "n": .deny, "no": .deny, "reject": .deny,
        ]
        guard let mapped = alias[v] else { return nil }
        // Honor the request's own policy: a spoken "always" against a request
        // that forbids allow-always must be refused, not downgraded.
        return prompt.options.contains(where: { $0.decision == mapped }) ? mapped : nil
    }

    /// Decisions this specific request permits. The Gateway narrows them
    /// per-request (an `ask: "always"` policy drops allow-always), so never
    /// offer one it forbids. Deny is always kept: a prompt the user can only
    /// accept is not a prompt.
    private static func resolveDecisions(_ body: [String: Any]) -> [ExecApprovalDecision] {
        let allowed = (body["allowedDecisions"] as? [String] ?? [])
            .compactMap(ExecApprovalDecision.init(rawValue:))
        let base = allowed.isEmpty ? ExecApprovalDecision.ordered : allowed
        let unavailable = Set(body["unavailableDecisions"] as? [String] ?? [])
        let kept = base.filter { !unavailable.contains($0.rawValue) }
        return kept.isEmpty ? [.deny] : kept
    }

    private static func firstNonEmpty(_ values: [String?]) -> String? {
        for value in values {
            if let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
                return trimmed
            }
        }
        return nil
    }

    private static func numeric(_ value: Any?) -> Double? {
        if let d = value as? Double { return d }
        if let i = value as? Int { return Double(i) }
        if let n = value as? NSNumber { return n.doubleValue }
        return nil
    }
}

#endif
