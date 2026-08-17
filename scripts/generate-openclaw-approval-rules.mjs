#!/usr/bin/env node
// Generate the Swift mirror of the OpenClaw exec-approval SSOT
// (shared/src/openclaw-approval.ts).
//
//   pnpm generate-openclaw-approval-rules            regenerate the mirror
//   pnpm generate-openclaw-approval-rules --check    exit 1 if it drifted
//
// Why the whole parser is emitted rather than just the decision names: both
// daemons TALK TO THE SAME GATEWAY, and the Gateway validates `decision`
// against its own enum BEFORE it looks the approval id up. A mirror that
// carried the vocabulary but re-implemented the payload walk by hand is exactly
// how the two implementations diverged in the first place — Node read the
// payload flat, Swift read `payload["tool"]`, and NEITHER matched
// `buildRequestedApprovalEvent`, so on both daemons the user saw an approval
// with no command on it and could not answer it.
//
// Only Swift is emitted. Android is a client: it renders `question`/`options`
// off the session row the daemon already built and submits `select_option`. It
// never parses a Gateway frame, so an approval parser there would be dead
// mirror surface.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEADER =
  'GENERATED FILE — DO NOT EDIT.\n' +
  'Source of truth: shared/src/openclaw-approval.ts\n' +
  'Regenerate: pnpm generate-openclaw-approval-rules ' +
  '(drift gated by shared/src/__tests__/openclaw-approval-rules-sync.test.ts)';

function comment(prefix) {
  return HEADER.split('\n').map((l) => `${prefix} ${l}`).join('\n');
}

/** Pull the parts of the SSOT the mirror must embed verbatim. */
export function rulesFrom(mod) {
  const decisions = [...mod.EXEC_APPROVAL_DECISIONS];
  return {
    decisions,
    display: Object.fromEntries(
      decisions.map((d) => [d, { label: mod.execApprovalDecisionLabel(d) }]),
    ),
    // Shortcuts are not exported individually; derive them from a parsed
    // prompt so the mirror can never disagree with what the parser emits.
    shortcuts: Object.fromEntries(
      mod
        .parseExecApprovalRequest({ id: 'x', request: { command: 'c' } }, 0)
        .options.map((o) => [o.decision, o.shortcut]),
    ),
  };
}

export function emitSwift(rules) {
  const caseLines = rules.decisions
    .map((d) => `    case ${swiftCaseName(d)} = "${d}"`)
    .join('\n');
  const labelLines = rules.decisions
    .map((d) => `        case .${swiftCaseName(d)}: return "${rules.display[d].label}"`)
    .join('\n');
  const shortcutLines = rules.decisions
    .map((d) => `        case .${swiftCaseName(d)}: return "${rules.shortcuts[d]}"`)
    .join('\n');
  const allLine = rules.decisions.map((d) => `.${swiftCaseName(d)}`).join(', ');

  return `${comment('//')}

import Foundation

#if os(macOS)

/// The decisions the OpenClaw Gateway will accept for an exec approval.
///
/// \`allow\` is deliberately NOT a member. The Gateway's \`isApprovalDecision\`
/// rejects it, and it does so before the approval id is looked up — so a resolve
/// carrying it returns INVALID_REQUEST and the approval stays pending with no
/// visible failure anywhere.
enum ExecApprovalDecision: String, CaseIterable, Sendable {
${caseLines}

    static let ordered: [ExecApprovalDecision] = [${allLine}]

    /// Short device-facing label (Stream Deck keys, D200H cells).
    var label: String {
        switch self {
${labelLines}
        }
    }

    /// What a non-navigable \`respond\` press carries for this decision.
    var shortcut: String {
        switch self {
${shortcutLines}
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

/// Normalized \`exec.approval.requested\` — what surfaces render and what an
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

    /// Parse a raw \`exec.approval.requested\` payload.
    ///
    /// The Gateway sends \`{ id, request, createdAtMs, expiresAtMs }\` — every
    /// display field lives under \`request\`. The flat lookup is a compatibility
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
        var detailParts: [String] = []
        if let cwd { detailParts.append("cwd: \\(cwd)") }
        let warning = firstNonEmpty([body["warningText"] as? String])
        if let warning { detailParts.append(warning) }
        if let analysis = firstNonEmpty([body["commandAnalysis"] as? String]), analysis != warning {
            detailParts.append(analysis)
        }

        let options = resolveDecisions(body).enumerated().map { idx, decision in
            ExecApprovalOption(
                index: idx, label: decision.label, shortcut: decision.shortcut, decision: decision)
        }

        return OpenClawApprovalPrompt(
            id: id,
            question: command.isEmpty ? "Approve tool execution (command not reported)" : command,
            detail: detailParts.isEmpty ? nil : detailParts.joined(separator: "\\n"),
            command: command,
            cwd: cwd,
            options: options,
            expiresAtMs: numeric(payload["expiresAtMs"]),
            requestedAtMs: numeric(payload["createdAtMs"]) ?? nowMs,
            sessionKey: firstNonEmpty([body["sessionKey"] as? String])
        )
    }

    /// Map a \`select_option\` index onto the decision that option represents.
    static func decision(forOptionIndex index: Int, in prompt: OpenClawApprovalPrompt)
        -> ExecApprovalDecision?
    {
        prompt.options.first(where: { $0.index == index })?.decision
    }

    /// Map a \`respond\` value onto a decision. Accepts the option shortcut, the
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
    /// per-request (an \`ask: "always"\` policy drops allow-always), so never
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
`;
}

function swiftCaseName(decision) {
  return decision
    .split('-')
    .map((part, i) => (i === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join('');
}

export const OUTPUTS = [
  ['apple/AgentDeck/Daemon/Gateway/OpenClawApprovalRules.generated.swift', emitSwift],
];

async function main() {
  const check = process.argv.includes('--check');
  const mod = await import(path.join(projectDir, 'shared/dist/openclaw-approval.js'));
  const rules = rulesFrom(mod);
  let drifted = false;
  for (const [rel, emit] of OUTPUTS) {
    const target = path.join(projectDir, rel);
    const next = emit(rules);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === next) continue;
    if (check) {
      console.error(`drift: ${rel}`);
      drifted = true;
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, next);
    console.log(`wrote ${rel}`);
  }
  if (drifted) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
