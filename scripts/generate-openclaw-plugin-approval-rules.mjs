#!/usr/bin/env node
// Generate the Swift mirror of the OpenClaw plugin-approval SSOT
// (shared/src/openclaw-plugin-approval.ts).
//
//   pnpm generate-openclaw-plugin-approval-rules            regenerate the mirror
//   pnpm generate-openclaw-plugin-approval-rules --check    exit 1 if it drifted
//
// Sibling of scripts/generate-openclaw-approval-rules.mjs (exec approvals).
// The decision vocabulary (`allow-once`/`allow-always`/`deny`) is IDENTICAL
// between exec and plugin approvals — the Gateway's `isApprovalDecision`
// validates both against the same enum — so this mirror reuses the already-
// generated `ExecApprovalDecision` Swift type rather than emitting a second,
// nominally-distinct enum with the same three cases. A parser that also typed
// its own decision enum here would be exactly the kind of restated rule that
// drifts: the exec mirror already pins `allow` out of the union, and a copy
// could silently let it back in for plugin approvals alone.
//
// Only Swift is emitted, same reasoning as the exec generator: Android is a
// client that renders `question`/`options` off the session row the daemon
// already built, and never parses a Gateway frame itself.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEADER =
  'GENERATED FILE — DO NOT EDIT.\n' +
  'Source of truth: shared/src/openclaw-plugin-approval.ts\n' +
  'Regenerate: pnpm generate-openclaw-plugin-approval-rules ' +
  '(drift gated by shared/src/__tests__/openclaw-plugin-approval-rules-sync.test.ts)\n' +
  'Reuses ExecApprovalDecision from OpenClawApprovalRules.generated.swift — the\n' +
  'decision vocabulary is shared with exec approvals, not redeclared here.';

function comment(prefix) {
  return HEADER.split('\n').map((l) => `${prefix} ${l}`).join('\n');
}

/** Pull the parts of the SSOT the mirror must embed verbatim. */
export function rulesFrom(mod) {
  return {
    defaultSeverity: mod.PLUGIN_APPROVAL_DEFAULT_SEVERITY,
    // Shortcuts are not exported individually; derive them from a parsed
    // prompt so the mirror can never disagree with what the parser emits.
    shortcuts: Object.fromEntries(
      mod
        .parsePluginApprovalRequest(
          { id: 'x', request: { title: 't', description: 'd' } }, 0)
        .options.map((o) => [o.decision, o.shortcut]),
    ),
  };
}

export function emitSwift(rules) {
  return `${comment('//')}

import Foundation

#if os(macOS)

/// One renderable choice on a deck surface for a plugin approval. Decision
/// type is \`ExecApprovalDecision\` — the vocabulary is shared with exec
/// approvals (the Gateway validates both kinds against the same enum).
struct PluginApprovalOption: Sendable, Equatable {
    let index: Int
    let label: String
    let shortcut: String
    let decision: ExecApprovalDecision
}

/// Normalized \`plugin.approval.requested\` — the plugin-approval counterpart
/// of \`OpenClawApprovalPrompt\`. \`question\` is the request's \`title\`;
/// \`detail\` is the description plus whatever scope/tool/plugin/agent context
/// the request carried, most-decisive-first.
struct OpenClawPluginApprovalPrompt: Sendable, Equatable {
    let id: String
    let question: String
    let detail: String?
    let title: String
    let description: String
    let severity: String
    let pluginId: String?
    let toolName: String?
    let options: [PluginApprovalOption]
    let expiresAtMs: Double?
    let requestedAtMs: Double
    let sessionKey: String?
}

enum OpenClawPluginApprovalRules {

    /// Absent \`severity\` defaults to \`"${rules.defaultSeverity}"\`, matching
    /// OpenClaw's own \`buildPluginApprovalRequestMessage\` fallback
    /// (\`request.request.severity ?? "warning"\`) — not \`"info"\`.
    static let defaultSeverity = "${rules.defaultSeverity}"

    /// Parse a raw \`plugin.approval.requested\` payload.
    ///
    /// The Gateway sends \`{approvalKind: "plugin", id, request, createdAtMs,
    /// expiresAtMs}\` — every display field lives under \`request\`. The flat
    /// lookup is a compatibility path only. Returns nil only when there is no
    /// usable id: a request with no title/description still yields a prompt,
    /// because the user must keep the ability to deny something they cannot
    /// see described.
    static func parse(_ payload: [String: Any], nowMs: Double) -> OpenClawPluginApprovalPrompt? {
        let id = (payload["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !id.isEmpty else { return nil }

        var body = payload
        if let request = payload["request"] as? [String: Any] {
            for (k, v) in request { body[k] = v }
        }

        let title = firstNonEmpty([body["title"] as? String]) ?? ""
        let description = firstNonEmpty([body["description"] as? String]) ?? ""
        let severity = (body["severity"] as? String).flatMap { ["info", "warning", "critical"].contains($0) ? $0 : nil }
            ?? defaultSeverity
        let pluginId = firstNonEmpty([body["pluginId"] as? String])
        let toolName = firstNonEmpty([body["toolName"] as? String])
        let agentId = firstNonEmpty([body["agentId"] as? String])

        // Most-decisive-first — mirror of the TS SSOT: description explains
        // WHAT/WHY, then scope, tool, plugin, agent, each supporting.
        var detailParts: [String] = []
        if !description.isEmpty { detailParts.append(description) }
        if let scope = body["scope"] as? [String: Any], let scopeLine = summarizeScope(scope) {
            detailParts.append(scopeLine)
        }
        if let toolName { detailParts.append("tool: \\(toolName)") }
        if let pluginId { detailParts.append("plugin: \\(pluginId)") }
        if let agentId { detailParts.append("agent: \\(agentId)") }

        let options = resolveDecisions(body).enumerated().map { idx, decision in
            PluginApprovalOption(
                index: idx, label: decision.label, shortcut: decision.shortcut, decision: decision)
        }

        return OpenClawPluginApprovalPrompt(
            id: id,
            question: title.isEmpty ? "Approve plugin action (title not reported)" : title,
            detail: detailParts.isEmpty ? nil : detailParts.joined(separator: "\\n"),
            title: title,
            description: description,
            severity: severity,
            pluginId: pluginId,
            toolName: toolName,
            options: options,
            expiresAtMs: numeric(payload["expiresAtMs"]),
            requestedAtMs: numeric(payload["createdAtMs"]) ?? nowMs,
            sessionKey: firstNonEmpty([body["sessionKey"] as? String])
        )
    }

    /// Map a \`select_option\` index onto the decision that option represents.
    static func decision(forOptionIndex index: Int, in prompt: OpenClawPluginApprovalPrompt)
        -> ExecApprovalDecision?
    {
        prompt.options.first(where: { $0.index == index })?.decision
    }

    /// Map a \`respond\` value onto a decision. Accepts the option shortcut, the
    /// decision name, and the y/n/a spellings. Unrecognized input returns nil —
    /// an ambiguous press must never be guessed into an approval.
    static func decision(forRespondValue value: String, in prompt: OpenClawPluginApprovalPrompt)
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
        return prompt.options.contains(where: { $0.decision == mapped }) ? mapped : nil
    }

    /// Read the id out of a \`plugin.approval.removed\` payload (\`{id}\`), or nil
    /// when unreadable. This event is NOT declared in the installed package's
    /// \`.d.ts\` files — it is real wire protocol confirmed only at the string
    /// literal in OpenClaw's embedded/TUI-local approval broker
    /// (\`agent-tools.before-tool-call-*.mjs\`), a different runtime from the
    /// persisted Gateway approval manager this daemon connects through. Handled
    /// defensively rather than relied on: reconcile-via-list and the record's
    /// own expiry remain the primary close signal, exactly like exec.
    static func removedId(from payload: [String: Any]) -> String? {
        guard let id = payload["id"] as? String else { return nil }
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// Which decisions this request permits. Unlike exec, the plugin surface
    /// has no separate "decisions withheld by policy" field to subtract — only
    /// \`allowedDecisions\` (explicit list, or the full default set when
    /// empty/absent), plus the canonical fail-closed-deny guarantee: deny is
    /// always kept.
    private static func resolveDecisions(_ body: [String: Any]) -> [ExecApprovalDecision] {
        let explicit = (body["allowedDecisions"] as? [String] ?? [])
            .compactMap(ExecApprovalDecision.init(rawValue:))
        let base = explicit.isEmpty ? ExecApprovalDecision.ordered : explicit
        return base.contains(.deny) ? base : base + [.deny]
    }

    /// Short summary of a scope variant's most distinguishing field — display
    /// only, never authorization.
    private static func summarizeScope(_ scope: [String: Any]) -> String? {
        guard let kind = firstNonEmpty([scope["kind"] as? String]) else { return nil }
        if kind == "standing-grant" {
            if let command = firstNonEmpty([scope["command"] as? String]) {
                return "scope: \\(kind) (\\(command))"
            }
            return "scope: \\(kind)"
        }
        if kind == "payment" {
            if let amount = firstNonEmpty([scope["amount"] as? String]) {
                let currency = firstNonEmpty([scope["currency"] as? String])
                return "scope: payment \\(amount)" + (currency.map { " \\($0)" } ?? "")
            }
            return "scope: payment"
        }
        if let target = firstNonEmpty([scope["target"] as? String]) {
            return "scope: \\(kind) (\\(target))"
        }
        return "scope: \\(kind)"
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

export const OUTPUTS = [
  ['apple/AgentDeck/Daemon/Gateway/OpenClawPluginApprovalRules.generated.swift', emitSwift],
];

async function main() {
  const check = process.argv.includes('--check');
  const mod = await import(path.join(projectDir, 'shared/dist/openclaw-plugin-approval.js'));
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
