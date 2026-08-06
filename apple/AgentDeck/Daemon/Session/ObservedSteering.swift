#if os(macOS)
import Foundation

/// Steering state for observed (hook-only, no PTY) Claude sessions — Swift
/// mirror of `bridge/src/observed-steering.ts` + `claude-permission-rules.ts`.
///
/// The daemon cannot type into an observed session's terminal, but Claude Code
/// hooks form a synchronous RPC channel supporting three primitives:
///
///   1. Device approval — the `/hooks/PreToolUse` route suspends (async
///      handler) until a device answers `permission_decision` or the hold
///      times out. Eligibility is decided by `beginGate` below, precision-
///      first: the FIRST gate (removed 2026-05) held every call and popped
///      Allow/Deny for tools Claude auto-approves; this one holds only calls
///      it verified Claude would genuinely prompt for, and every uncertainty
///      resolves to "don't hold".
///   2. Soft STOP — a stop flag consumed by the next PreToolUse (deny + halt
///      instruction). Not an instant Ctrl+C, but a real stop at the next tool
///      boundary. User-initiated, so zero false-popup risk.
///   3. Turn-end directives — prompts queued while processing, delivered by
///      the Stop hook as `{decision:"block", reason}`. Bounded: one directive
///      per turn end, hard queue cap, empty queue always lets the turn end.
///
/// Sandbox note: the permission-rule predictor requires POSITIVE proof that
/// the full rule surface (`~/.claude` + `<cwd>/.claude`) is readable — it
/// probes with a directory listing. In the App Store sandbox that probe
/// fails, so the gate self-disables (verdict `unknown` → never hold): a
/// project-local "Always allow" rule we cannot see must never produce a
/// device popup for an auto-approved call. Soft STOP and the directive queue
/// have no filesystem dependency and stay fully functional in the sandbox.
actor ObservedSteering {
    static let shared = ObservedSteering()

    // MARK: - Tunables

    static let gateEnabled: Bool =
        ProcessInfo.processInfo.environment["AGENTDECK_OBSERVED_APPROVAL"] != "0"

    /// Hold duration before releasing the tool call to Claude's own permission
    /// flow. Must stay well under the hook curl's --max-time 60.
    static let holdTimeoutSeconds: TimeInterval = {
        if let raw = ProcessInfo.processInfo.environment["AGENTDECK_APPROVAL_HOLD_MS"],
           let ms = Double(raw), ms > 0 {
            return min(50, max(5, ms / 1000))
        }
        return 25
    }()

    /// AskUserQuestion ask-gate: hold an interactive question so a device can
    /// answer it. This daemon cannot type into the user's terminal, so it is
    /// the only remote-answer channel it has.
    static let askGateEnabled: Bool =
        ProcessInfo.processInfo.environment["AGENTDECK_ASK_GATE"] != "0"

    /// The whole cost of this rung lands on whoever is at that terminal: their
    /// question picker does not appear until the hold releases. So it is kept
    /// short enough to be tolerable when nobody is holding a device — long
    /// enough to answer a question or two, well under the hook curl's
    /// --max-time 60, and overridable for users who live on their deck.
    static let askHoldTimeoutSeconds: TimeInterval = {
        if let raw = ProcessInfo.processInfo.environment["AGENTDECK_ASK_GATE_HOLD_MS"],
           let ms = Double(raw), ms > 0 {
            return min(50, max(5, ms / 1000))
        }
        return 20
    }()

    static let stopDenyReason =
        "AgentDeck: the user pressed STOP on their AgentDeck controller. "
        + "Halt the current work now, briefly summarize where you left off, and wait "
        + "for the user's next instruction. Do not start new tool calls."

    /// Deliver a device-answered AskUserQuestion back to Claude. Mirror of
    /// `buildAskAnswerReason` in bridge/src/observed-steering.ts.
    ///
    /// The hook contract has no field for supplying a chosen option — a
    /// PreToolUse hook may only allow, deny or defer. But a denial's reason
    /// text IS handed to the model as the tool call's feedback, the same
    /// reason-as-message channel `stopDenyReason` and the Stop-hook directive
    /// queue already ride. So the daemon denies the question and states the
    /// answer the user gave on their device. The wording must be unambiguous
    /// that these ARE the user's answers and that re-asking is wrong: read as a
    /// bare refusal, a model treats the denial as an obstacle and calls
    /// AskUserQuestion again.
    nonisolated static func askAnswerReason(answers: [(question: String, label: String)]) -> String {
        let pairs = answers
            .filter { !$0.label.isEmpty }
            .map { "Q: \($0.question)\nA: \($0.label)" }
            .joined(separator: "\n")
        return "AgentDeck: the user already answered this question on their connected "
            + "AgentDeck device, so the question picker was not shown in their terminal.\n"
            + "\(pairs)\n"
            + "These are the user's own answers. Treat them exactly as if the tool had "
            + "returned them and continue — do not call AskUserQuestion again for these "
            + "questions, and do not ask the user to repeat themselves."
    }

    private let stopTTL: TimeInterval = 600
    private let directiveTTL: TimeInterval = 3600
    private let directiveCap = 3
    /// Window for the auto-approval learner after an undecided gate release.
    private let learnWindow: TimeInterval = 8
    private let rulesCacheTTL: TimeInterval = 10

    // MARK: - State (keyed by Claude session UUID)

    private var stopRequestedAt: [String: Date] = [:]
    private var directives: [String: [(text: String, ts: Date)]] = [:]
    /// Signatures learned to be auto-approved (session "always allow" lives
    /// only in Claude's memory — this is the only way to see it).
    private var suppressed: [String: Set<String>] = [:]
    private var recentAskReleases: [String: [(tool: String, signature: String, ts: Date)]] = [:]

    /// Which kind of hook hold this is. They resolve differently: a permission
    /// gate carries a device's allow/deny, while an ask-gate carries the user's
    /// chosen options (delivered as the deny reason by the caller) and must
    /// never feed the auto-approval learner.
    enum GateKind {
        case permission
        case ask
    }

    private struct HeldGate {
        let sessionId: String
        let kind: GateKind
        let tool: String
        let signature: String
        var continuation: CheckedContinuation<String, Never>?
    }
    private var heldGates: [String: HeldGate] = [:]
    /// At most one held gate per session — parallel tool calls pass through.
    private var heldBySession: Set<String> = []

    private struct MergedRules { var allow: [String]; var deny: [String]; var ask: [String] }
    private var rulesCache: [String: (rules: MergedRules?, loadedAt: Date)] = [:]

    // MARK: - Soft STOP

    func requestStop(sessionId: String) {
        stopRequestedAt[sessionId] = Date()
    }

    func clearStop(sessionId: String) {
        stopRequestedAt[sessionId] = nil
    }

    private func stopIsFresh(_ sessionId: String) -> Bool {
        guard let at = stopRequestedAt[sessionId] else { return false }
        if Date().timeIntervalSince(at) > stopTTL {
            stopRequestedAt[sessionId] = nil
            return false
        }
        return true
    }

    /// One-shot consume by the PreToolUse deny path.
    func consumeStop(sessionId: String) -> Bool {
        guard stopIsFresh(sessionId) else { return false }
        stopRequestedAt[sessionId] = nil
        return true
    }

    // MARK: - Turn-end directive queue

    /// Returns the new queue depth, or 0 when rejected (empty text / cap hit).
    func queueDirective(sessionId: String, text: String) -> Int {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return 0 }
        let now = Date()
        var q = (directives[sessionId] ?? []).filter { now.timeIntervalSince($0.ts) < directiveTTL }
        guard q.count < directiveCap else { directives[sessionId] = q; return 0 }
        q.append((text: trimmed, ts: now))
        directives[sessionId] = q
        return q.count
    }

    /// Pop exactly one directive (the Stop hook drains one per turn end). A
    /// pending STOP outranks directives: stopping wins, the queue is dropped.
    func takeDirective(sessionId: String) -> String? {
        if stopIsFresh(sessionId) {
            directives[sessionId] = []
            return nil
        }
        let now = Date()
        var q = (directives[sessionId] ?? []).filter { now.timeIntervalSince($0.ts) < directiveTTL }
        let head = q.isEmpty ? nil : q.removeFirst()
        directives[sessionId] = q
        return head?.text
    }

    func queuedCount(sessionId: String) -> Int {
        let now = Date()
        let q = (directives[sessionId] ?? []).filter { now.timeIntervalSince($0.ts) < directiveTTL }
        directives[sessionId] = q
        return q.count
    }

    /// User re-engaged in the terminal — their own prompt supersedes anything
    /// the deck queued, and a pending STOP is moot.
    func clearOnUserPrompt(sessionId: String) -> Bool {
        let had = !(directives[sessionId] ?? []).isEmpty || stopRequestedAt[sessionId] != nil
        directives[sessionId] = []
        stopRequestedAt[sessionId] = nil
        return had
    }

    func clearSession(sessionId: String) {
        stopRequestedAt[sessionId] = nil
        directives[sessionId] = nil
        suppressed[sessionId] = nil
        recentAskReleases[sessionId] = nil
    }

    // MARK: - Auto-approval learner

    /// A permission_prompt Notification arrived — every recent undecided
    /// release was a GENUINE prompt; nothing gets learned as auto-approved.
    func notePermissionPromptShown(sessionId: String) {
        recentAskReleases[sessionId] = nil
    }

    /// PostToolUse arrived. A recent undecided release for the same tool with
    /// no permission_prompt Notification in between means Claude auto-approved
    /// (session "always allow") — suppress the signature for this session.
    func noteToolEnd(sessionId: String, tool: String?) {
        guard let tool, var recents = recentAskReleases[sessionId], !recents.isEmpty else { return }
        let now = Date()
        var kept: [(tool: String, signature: String, ts: Date)] = []
        for r in recents {
            if now.timeIntervalSince(r.ts) > learnWindow { continue }
            if r.tool == tool {
                suppressed[sessionId, default: []].insert(r.signature)
                DaemonLogger.shared.debug("Steering", "learned auto-approved signature for \(sessionId): \(r.signature)")
            } else {
                kept.append(r)
            }
        }
        recents = kept
        recentAskReleases[sessionId] = recents
    }

    // MARK: - PreToolUse gate

    /// Bash signature = first two command tokens (the granularity of Claude's
    /// own "always allow `git push`" session approvals); others = tool name.
    static func gateSignature(tool: String, commandText: String?) -> String {
        if tool == "Bash", let commandText {
            let head = commandText
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .split(separator: " ", omittingEmptySubsequences: true)
                .prefix(2).joined(separator: " ")
            return "Bash|\(head)"
        }
        return tool
    }

    private static let neverPromptTools: Set<String> = [
        "Read", "Glob", "Grep", "LS",
        "TodoWrite", "TodoRead", "NotebookRead",
        "Task", "TaskOutput", "BashOutput",
    ]
    private static let promptProneTools: Set<String> = [
        "Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch",
    ]

    /// Decide + register a hold atomically. Returns the requestId to await, or
    /// nil when this call must pass through untouched. Mirrors the Node
    /// `shouldHoldPreToolUse` — every check biased toward "don't hold".
    func beginGate(
        sessionId: String,
        tool: String,
        commandText: String?,
        permissionMode: String?,
        cwd: String?,
        clientCount: Int
    ) -> String? {
        guard Self.gateEnabled else { return nil }
        guard clientCount > 0 else { return nil }
        guard !tool.isEmpty, !tool.hasPrefix("mcp__") else { return nil }
        guard !Self.neverPromptTools.contains(tool) else { return nil }
        guard Self.promptProneTools.contains(tool) else { return nil }
        guard DaemonServer.shouldGate(permissionMode: permissionMode, tool: tool) else { return nil }
        guard !heldBySession.contains(sessionId) else { return nil }
        let signature = Self.gateSignature(tool: tool, commandText: commandText)
        if suppressed[sessionId]?.contains(signature) == true { return nil }
        switch evaluateRules(tool: tool, commandText: commandText, cwd: cwd) {
        case .deny, .allow, .unknown: return nil
        case .ask, .none: break
        }
        let requestId = UUID().uuidString.lowercased()
        heldGates[requestId] = HeldGate(
            sessionId: sessionId, kind: .permission, tool: tool, signature: signature, continuation: nil)
        heldBySession.insert(sessionId)
        return requestId
    }

    /// Register a hold for an AskUserQuestion so a device can answer it.
    ///
    /// Shares only the one-gate-per-session invariant with `beginGate` and NONE
    /// of its precision guards — deliberately. Those guards exist because
    /// PreToolUse fires for tool calls Claude auto-approves without ever asking
    /// the user, so holding one invents a decision nobody was asked for.
    /// AskUserQuestion is the opposite: its whole purpose is to prompt, it
    /// always does, and no allowlist entry suppresses it. There is no
    /// false-hold to guard against, so the permission-rule predictor is never
    /// consulted — which is precisely what lets this rung work in the App Store
    /// sandbox, where that predictor cannot read `~/.claude` and therefore
    /// disables the permission gate entirely.
    func beginAskGate(sessionId: String, clientCount: Int) -> String? {
        guard Self.askGateEnabled else { return nil }
        guard clientCount > 0 else { return nil }
        guard !heldBySession.contains(sessionId) else { return nil }
        let requestId = UUID().uuidString.lowercased()
        heldGates[requestId] = HeldGate(
            sessionId: sessionId, kind: .ask, tool: "AskUserQuestion",
            signature: "AskUserQuestion", continuation: nil)
        heldBySession.insert(sessionId)
        return requestId
    }

    /// Is this a held ask-gate (as opposed to a permission gate)? Answer
    /// routing needs the distinction: an option index must never collapse into
    /// a binary allow/deny.
    func gateKind(requestId: String) -> GateKind? {
        heldGates[requestId]?.kind
    }

    /// Suspend until a device decision or timeout. Resolves to "allow" /
    /// "deny" / "answered" / "pass" (pass = empty hook body → Claude's normal
    /// flow, which for an ask-gate means its question picker appears in the
    /// user's own terminal exactly as if the daemon had never held it).
    func awaitGate(requestId: String) async -> String {
        guard let gate = heldGates[requestId] else { return "pass" }
        let timeout = gate.kind == .ask ? Self.askHoldTimeoutSeconds : Self.holdTimeoutSeconds
        return await withCheckedContinuation { (cont: CheckedContinuation<String, Never>) in
            guard heldGates[requestId] != nil else { cont.resume(returning: "pass"); return }
            heldGates[requestId]?.continuation = cont
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                await self?.timeoutGate(requestId: requestId)
            }
        }
    }

    private func timeoutGate(requestId: String) {
        guard let gate = heldGates.removeValue(forKey: requestId) else { return }
        heldBySession.remove(gate.sessionId)
        // Undecided release arms the auto-approval learner — but only for a
        // permission gate. An unanswered question says nothing about what
        // Claude auto-approves, so learning from it would suppress real gates.
        if gate.kind == .permission {
            recentAskReleases[gate.sessionId, default: []].append(
                (tool: gate.tool, signature: gate.signature, ts: Date()))
            if recentAskReleases[gate.sessionId]!.count > 8 {
                recentAskReleases[gate.sessionId]!.removeFirst()
            }
        }
        gate.continuation?.resume(returning: "pass")
    }

    /// Device decision. Returns the affected sessionId, or nil when the
    /// requestId is unknown / already resolved. `answered` is the ask-gate's
    /// resolution: the caller supplies the chosen options as the deny reason.
    func resolveGate(requestId: String, decision: String) -> String? {
        guard decision == "allow" || decision == "deny" || decision == "answered" else { return nil }
        guard let gate = heldGates.removeValue(forKey: requestId) else { return nil }
        heldBySession.remove(gate.sessionId)
        gate.continuation?.resume(returning: decision)
        return gate.sessionId
    }

    func steeringSnapshot(sessionId: String) -> (stopRequested: Bool, queued: Int) {
        (stopIsFresh(sessionId), queuedCount(sessionId: sessionId))
    }

    // MARK: - Permission-rule predictor (mirror of claude-permission-rules.ts)

    private enum RuleVerdict { case allow, deny, ask, none, unknown }

    private static func realHome() -> String {
        String(cString: getpwuid(getuid()).pointee.pw_dir)
    }

    /// Merge permission rules from every settings file Claude Code reads for
    /// this cwd. Returns nil ("unknown") when the rule surface is not provably
    /// readable — including the sandboxed case where `~/.claude` cannot even
    /// be listed — so the caller never holds on a partial picture.
    private func loadMergedRules(cwd: String?) -> MergedRules? {
        let key = cwd ?? ""
        if let cached = rulesCache[key], Date().timeIntervalSince(cached.loadedAt) < rulesCacheTTL {
            return cached.rules
        }
        let rules = Self.readMergedRules(cwd: cwd)
        rulesCache[key] = (rules, Date())
        return rules
    }

    private static func readMergedRules(cwd: String?) -> MergedRules? {
        let fm = FileManager.default
        let home = realHome()
        // Positive readability proof: if we cannot LIST ~/.claude, a project
        // allowlist (or the user-global one) may exist unseen — verdict
        // unknown, gate stays inert. This is what keeps the App Store sandbox
        // build from ever popping a false approval.
        let homeClaude = home + "/.claude"
        if fm.fileExists(atPath: homeClaude),
           (try? fm.contentsOfDirectory(atPath: homeClaude)) == nil {
            return nil
        }
        var candidates = [
            "/Library/Application Support/ClaudeCode/managed-settings.json",
            homeClaude + "/settings.json",
            homeClaude + "/settings.local.json",
        ]
        if let cwd, !cwd.isEmpty {
            let projClaude = cwd + "/.claude"
            if fm.fileExists(atPath: projClaude),
               (try? fm.contentsOfDirectory(atPath: projClaude)) == nil {
                return nil
            }
            candidates.append(projClaude + "/settings.json")
            candidates.append(projClaude + "/settings.local.json")
        }
        var merged = MergedRules(allow: [], deny: [], ask: [])
        for file in candidates {
            guard fm.fileExists(atPath: file) else { continue }
            guard let data = try? Data(contentsOf: URL(fileURLWithPath: file)),
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                // Exists but unreadable/unparseable → can't trust our picture.
                return nil
            }
            guard let perms = parsed["permissions"] as? [String: Any] else { continue }
            merged.allow += (perms["allow"] as? [String] ?? []).compactMap { $0 }
            merged.deny += (perms["deny"] as? [String] ?? []).compactMap { $0 }
            merged.ask += (perms["ask"] as? [String] ?? []).compactMap { $0 }
        }
        return merged
    }

    private static func parseRule(_ rule: String) -> (tool: String, spec: String?)? {
        let trimmed = rule.trimmingCharacters(in: .whitespaces)
        guard let parenIdx = trimmed.firstIndex(of: "(") else {
            guard !trimmed.isEmpty, trimmed.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "_" }) else { return nil }
            return (trimmed, nil)
        }
        guard trimmed.hasSuffix(")") else { return nil }
        let tool = String(trimmed[trimmed.startIndex..<parenIdx])
        guard !tool.isEmpty else { return nil }
        let spec = String(trimmed[trimmed.index(after: parenIdx)..<trimmed.index(before: trimmed.endIndex)])
        return (tool, spec)
    }

    private static func bashSpecMatches(_ spec: String, command: String) -> Bool {
        if spec == "*" { return true }
        if spec.hasSuffix(":*") { return command.hasPrefix(String(spec.dropLast(2))) }
        return command == spec
    }

    /// Loose match (allow/deny direction): tool-name match with ANY spec
    /// counts — a loose match only suppresses a hold (safe direction).
    private static func matchesLoose(rule: (tool: String, spec: String?), tool: String, command: String?) -> Bool {
        guard rule.tool == tool else { return false }
        guard let spec = rule.spec else { return true }
        if tool == "Bash" {
            guard let command else { return true }
            if bashSpecMatches(spec, command: command) { return true }
            // Compound commands: prefix match on the first segment is enough
            // to suppress the hold.
            let first = command.components(separatedBy: CharacterSet(charactersIn: ";|&"))
                .first?.trimmingCharacters(in: .whitespaces) ?? command
            return bashSpecMatches(spec, command: first)
        }
        // Non-Bash specs (paths, domains, globs): any spec MIGHT match.
        return true
    }

    /// Strict match (ask direction): only patterns we can evaluate exactly —
    /// an ask match CAUSES a hold and must not fire on a spec we can't parse.
    private static func matchesStrict(rule: (tool: String, spec: String?), tool: String, command: String?) -> Bool {
        guard rule.tool == tool else { return false }
        guard let spec = rule.spec else { return true }
        if tool == "Bash", let command { return bashSpecMatches(spec, command: command) }
        return false
    }

    private func evaluateRules(tool: String, commandText: String?, cwd: String?) -> RuleVerdict {
        guard let rules = loadMergedRules(cwd: cwd) else { return .unknown }
        for r in rules.deny {
            if let p = Self.parseRule(r), Self.matchesLoose(rule: p, tool: tool, command: commandText) { return .deny }
        }
        for r in rules.allow {
            if let p = Self.parseRule(r), Self.matchesLoose(rule: p, tool: tool, command: commandText) { return .allow }
        }
        for r in rules.ask {
            if let p = Self.parseRule(r), Self.matchesStrict(rule: p, tool: tool, command: commandText) { return .ask }
        }
        return .none
    }
}

/// Command queue for observed (standalone TUI) OpenCode sessions — Swift
/// mirror of `bridge/src/opencode-steering.ts`. The AgentDeck observer plugin
/// long-polls `GET /opencode/commands?sid=…` and executes returned commands
/// through OpenCode's in-process SDK client (abort / prompt injection), which
/// makes interrupt immediate and prompts deliverable even while idle.
actor OpenCodeCommandQueue {
    static let shared = OpenCodeCommandQueue()

    struct Command: Sendable {
        let type: String   // "interrupt" | "send_prompt" | "permission_respond"
        let text: String?
        /// permission_respond: the OpenCode permission id (from permission.asked).
        var permissionId: String? = nil
        /// permission_respond: device decision; the plugin maps allow→"once", deny→"reject".
        var response: String? = nil
    }

    private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<[Command], Never>
    }

    private let queueCap = 8
    private var queues: [String: [Command]] = [:]
    private var waiters: [String: [Waiter]] = [:]

    /// Queue a command; wakes a pending long-poll immediately.
    @discardableResult
    func enqueue(sessionId: String, command: Command) -> Bool {
        var q = queues[sessionId] ?? []
        guard q.count < queueCap else { return false }
        q.append(command)
        if var w = waiters[sessionId], !w.isEmpty {
            let waiter = w.removeFirst()
            waiters[sessionId] = w
            queues[sessionId] = []
            waiter.continuation.resume(returning: q)
            return true
        }
        queues[sessionId] = q
        return true
    }

    /// Long-poll: immediate when commands are queued, else hold up to waitSeconds.
    func poll(sessionId: String, waitSeconds: Double) async -> [Command] {
        if let q = queues[sessionId], !q.isEmpty {
            queues[sessionId] = []
            return q
        }
        let bounded = min(50.0, max(1.0, waitSeconds))
        let token = UUID()
        return await withCheckedContinuation { (cont: CheckedContinuation<[Command], Never>) in
            waiters[sessionId, default: []].append(Waiter(id: token, continuation: cont))
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(bounded * 1_000_000_000))
                await self?.expireWaiter(sessionId: sessionId, token: token)
            }
        }
    }

    private func expireWaiter(sessionId: String, token: UUID) {
        guard var w = waiters[sessionId], let idx = w.firstIndex(where: { $0.id == token }) else { return }
        let waiter = w.remove(at: idx)
        waiters[sessionId] = w
        waiter.continuation.resume(returning: [])
    }
}

#endif
