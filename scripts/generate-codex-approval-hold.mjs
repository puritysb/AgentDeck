#!/usr/bin/env node
// Generate the Swift mirror of the Codex device-approval hold rules:
//   shared/src/codex-approval-hold.ts
//     → apple/AgentDeck/Daemon/Session/CodexApprovalHoldRules.generated.swift
//
//   pnpm generate-codex-approval-hold            regenerate the mirror
//   pnpm generate-codex-approval-hold --check    exit 1 if it drifted
//
// Requires shared to be built first (`pnpm build`), since the CLI reads the
// constants from shared/dist. The vitest sync test
// (shared/src/__tests__/codex-approval-hold-sync.test.ts) imports the emitter
// against the TS source, so drift is caught in CI even when this CLI is never
// run. Behaviour is pinned by shared/codex-approval-hold-vectors.json, which
// both suites replay.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const str = (v) => JSON.stringify(v);

export function rulesFrom(mod) {
  return {
    header: mod.CODEX_APPROVAL_HOLD_HEADER,
    denyMessage: mod.CODEX_APPROVAL_DENY_MESSAGE,
    marginMs: mod.CODEX_APPROVAL_HOLD_MARGIN_MS,
    minMs: mod.CODEX_APPROVAL_HOLD_MIN_MS,
    releasingEvents: [...mod.CODEX_APPROVAL_RELEASING_EVENTS],
    allowIndex: mod.CODEX_APPROVAL_ALLOW_INDEX,
    denyIndex: mod.CODEX_APPROVAL_DENY_INDEX,
    allowWords: [...mod.CODEX_APPROVAL_ALLOW_WORDS],
    denyWords: [...mod.CODEX_APPROVAL_DENY_WORDS],
  };
}

export function emitSwift(rules) {
  const events = rules.releasingEvents.map((e) => `        ${str(e)},`).join('\n');
  const words = (list) => `[${list.map(str).join(', ')}]`;
  return `// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/codex-approval-hold.ts
// Regenerate: pnpm generate-codex-approval-hold (drift gated by shared/src/__tests__/codex-approval-hold-sync.test.ts)
#if os(macOS)
import Foundation

/// Codex device approvals — the opt-in \`PermissionRequest\` hold. What a hold
/// request means, when one is held, how long, what the hook prints and which
/// events end it; the open hold itself is an \`ObservedSteering\` gate of kind
/// \`.codexApproval\`. Codex waits for the hook before drawing its prompt, so a
/// held request is a prompt the terminal would have drawn anyway, and the
/// person at the terminal sees "Running hook" until it is released. Behaviour
/// is pinned by \`shared/codex-approval-hold-vectors.json\`
/// (\`CodexApprovalHoldTests\`).
enum CodexApprovalHoldRules {
    /// Lower-case: \`HTTPServer\` request header keys.
    static let header = ${str(rules.header)}
    static let denyMessage = ${str(rules.denyMessage)}
    /// Release this long before the command's own curl budget runs out.
    static let holdMarginMs = ${rules.marginMs}
    /// Shorter than this, a hold is a stall that no one can answer in time.
    static let holdMinMs = ${rules.minMs}
    /// The end of the turn a hold waits in releases it early (\`ended\`).
    static let releasingEvents: Set<String> = [
${events}
    ]

    /// What the hold handler prints for an outcome. Empty prints nothing,
    /// which Codex reads as no decision: its own prompt appears as if the hook
    /// were absent. Deny carries a message because Codex hands it to the model.
    static func decisionBody(_ outcome: String) -> String {
        let decision: [String: Any]
        switch outcome {
        case "allow": decision = ["behavior": "allow"]
        case "deny": decision = ["behavior": "deny", "message": denyMessage]
        default: return ""
        }
        let body: [String: Any] = [
            "hookSpecificOutput": ["hookEventName": "PermissionRequest", "decision": decision],
        ]
        guard JSONSerialization.isValidJSONObject(body),
              let data = try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]) else {
            return ""
        }
        return String(decoding: data, as: UTF8.self)
    }

    /// How long to hold a request whose command waits \`header\` seconds, given
    /// the daemon's configured hold. nil = do not hold: a header this daemon
    /// cannot read is not a budget it may spend.
    static func holdMilliseconds(header: String?, defaultMs: Int) -> Int? {
        guard let header else { return nil }
        let value = header.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (1...4).contains(value.utf8.count),
              value.utf8.allSatisfy({ $0 >= UInt8(ascii: "0") && $0 <= UInt8(ascii: "9") }),
              let seconds = Int(value) else { return nil }
        let holdMs = min(defaultMs, seconds * 1000 - holdMarginMs)
        return holdMs >= holdMinMs ? holdMs : nil
    }

    /// A deck's Allow / Deny keys answer a held approval with an option press
    /// on the session, not with \`permission_decision\`. Allow first.
    static let allowIndex = ${rules.allowIndex}
    static let denyIndex = ${rules.denyIndex}
    /// \`respond\` carries the option's shortcut.
    static let allowWords: Set<String> = ${words(rules.allowWords)}
    static let denyWords: Set<String> = ${words(rules.denyWords)}

    /// The decision an option press makes on a held approval. nil = not an
    /// Allow or a Deny, and nothing is resolved.
    static func pressDecision(type: String, index: Int?, value: String?) -> String? {
        switch type {
        case "select_option":
            if index == allowIndex { return "allow" }
            if index == denyIndex { return "deny" }
            return nil
        case "respond":
            guard let value else { return nil }
            let word = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if allowWords.contains(word) { return "allow" }
            if denyWords.contains(word) { return "deny" }
            return nil
        default:
            return nil
        }
    }

    struct Eligibility: Equatable {
        /// \`AGENTDECK_OBSERVED_APPROVAL\` kill switch, shared with Claude's hold.
        var enabled: Bool
        var clientCount: Int
        var sessionId: String
        /// A Codex background thread (ambient suggestions, memory consolidation).
        var background: Bool
        /// A headless \`codex exec\` folded under the session that launched it.
        var execChild: Bool
        /// A row shows the session; otherwise no device can show the prompt.
        var visible: Bool
        var alreadyHeld: Bool
    }

    static func decision(_ e: Eligibility) -> (hold: Bool, reason: String) {
        if !e.enabled { return (false, "disabled") }
        if e.sessionId.isEmpty { return (false, "no-session") }
        if e.background { return (false, "background-thread") }
        if e.execChild { return (false, "exec-child") }
        if e.clientCount <= 0 { return (false, "no-client") }
        if !e.visible { return (false, "not-visible") }
        // One per session: a second approval (a parallel call) passes straight
        // to its terminal prompt.
        if e.alreadyHeld { return (false, "already-held") }
        return (true, "device-approval")
    }
}
#endif
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Daemon/Session/CodexApprovalHoldRules.generated.swift', emitSwift],
];

async function main() {
  let mod;
  try {
    mod = await import(path.join(projectDir, 'shared/dist/codex-approval-hold.js'));
  } catch (err) {
    console.error(`shared/dist is missing — run \`pnpm build\` first (${err.message})`);
    process.exit(1);
  }
  const rules = rulesFrom(mod);
  const check = process.argv.includes('--check');
  let drifted = false;
  for (const [rel, emit] of OUTPUTS) {
    const abs = path.join(projectDir, rel);
    const next = emit(rules);
    const prev = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    if (check) {
      if (prev !== next) {
        console.error(`DRIFT: ${rel}`);
        drifted = true;
      }
    } else if (prev !== next) {
      fs.writeFileSync(abs, next);
      console.log(`wrote ${rel}`);
    } else {
      console.log(`up-to-date ${rel}`);
    }
  }
  if (check) {
    console.log(drifted ? 'Codex approval hold mirror DRIFTED' : 'Codex approval hold mirror in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
