#!/usr/bin/env node
// Generate the Swift mirror of the hook harness-identity rule (#490):
//   shared/src/hook-harness.ts
//     → apple/AgentDeck/Daemon/Session/CodexHookHarness.generated.swift
//
//   pnpm generate-hook-harness            regenerate the mirror
//   pnpm generate-hook-harness --check    exit 1 if it drifted
//
// Requires shared to be built first (`pnpm build`), since the CLI reads the
// constants from shared/dist. The vitest sync test
// (shared/src/__tests__/hook-harness-sync.test.ts) imports the emitter against
// the TS source, so drift is caught in CI even when this CLI is never run.
// Behaviour is pinned by shared/hook-harness-vectors.json, which both suites
// replay.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Swift raw string literal; every pattern here is free of `"#`. */
function raw(value) {
  if (value.includes('"#')) throw new Error(`cannot embed ${value} in a raw Swift string`);
  return `#"${value}"#`;
}

const str = (v) => JSON.stringify(v);
const list = (values) => `[${values.map(str).join(', ')}]`;

export function rulesFrom(mod) {
  return {
    threadKeys: [...mod.CODEX_THREAD_ID_KEYS],
    notifyType: mod.CODEX_NOTIFY_TURN_COMPLETE_TYPE,
    rolloutPattern: mod.CODEX_ROLLOUT_BASENAME_PATTERN,
    prefixes: [...mod.HOOK_HARNESS_PREFIXES],
    routes: Object.entries(mod.CODEX_HOOK_ROUTES),
    fingerprintFields: Object.entries(mod.CODEX_HOOK_FINGERPRINT_FIELDS).map(([k, v]) => [k, [...v]]),
    contentFields: Object.entries(mod.CODEX_HOOK_FINGERPRINT_CONTENT_FIELDS).map(([k, v]) => [k, [...v]]),
    replayWindowMs: mod.CODEX_HOOK_REPLAY_WINDOW_MS,
  };
}

export function emitSwift(rules) {
  const routes = rules.routes.map(([k, v]) => `        ${str(k)}: ${str(v)},`).join('\n');
  const fields = rules.fingerprintFields.map(([k, v]) => `        ${str(k)}: ${list(v)},`).join('\n');
  const contentFields = rules.contentFields.map(([k, v]) => `        ${str(k)}: ${list(v)},`).join('\n');
  return `// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/hook-harness.ts
// Regenerate: pnpm generate-hook-harness (drift gated by shared/src/__tests__/hook-harness-sync.test.ts)
import Foundation

/// Which harness a hook POST came from — decided by the payload, never by the
/// endpoint name alone and never by the model (#490). Codex speaks Claude's
/// lifecycle vocabulary and can run a Claude-shaped hook command, so an
/// unprefixed hook carrying a Codex thread was ingested as a Claude Code
/// session. Behaviour is pinned by \`shared/hook-harness-vectors.json\`
/// (\`CodexHookHarnessTests\`).
enum CodexHookHarness {
    enum Route: Equatable {
        /// Ingest under the name it arrived with.
        case asPosted
        /// A Codex payload under an unprefixed name: ingest as this event.
        case codex(String)
        /// A Codex payload for an event with no Codex route: ingest nothing.
        case drop
    }

    static let threadIdKeys = ${list(rules.threadKeys)}
    static let notifyTurnCompleteType = ${str(rules.notifyType)}
    static let harnessPrefixes = ${list(rules.prefixes)}
    static let replayWindow: TimeInterval = ${rules.replayWindowMs / 1000}
    private static let rolloutBasenamePattern = ${raw(rules.rolloutPattern)}

    private static let routes: [String: String] = [
${routes}
    ]

    private static let fingerprintFields: [String: [String]] = [
${fields}
    ]

    private static let fingerprintContentFields: [String: [String]] = [
${contentFields}
    ]

    private static func nonEmpty(_ value: Any?) -> String? {
        guard let raw = value as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func stripCodexPrefix(_ id: String) -> String {
        id.hasPrefix("codex:") ? String(id.dropFirst("codex:".count)) : id
    }

    /// Bare Codex thread id named under one of Codex's thread keys.
    static func threadId(from json: [String: Any]) -> String? {
        for key in threadIdKeys {
            if let raw = nonEmpty(json[key]) { return stripCodexPrefix(raw) }
        }
        return nil
    }

    /// True when the payload carries evidence only Codex produces.
    static func isCodexPayload(_ json: [String: Any]) -> Bool {
        if threadId(from: json) != nil { return true }
        if json["type"] as? String == notifyTurnCompleteType { return true }
        // An ephemeral Codex run has no rollout: a turn id without any
        // transcript path is Codex (every Claude hook names its transcript).
        guard let tp = nonEmpty(json["transcript_path"]) else { return nonEmpty(json["turn_id"]) != nil }
        let base = tp.split(whereSeparator: { $0 == "/" || $0 == "\\\\" }).last.map(String.init) ?? ""
        return base.range(of: rolloutBasenamePattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func route(event: String, json: [String: Any]) -> Route {
        if harnessPrefixes.contains(where: { event.hasPrefix($0) }) { return .asPosted }
        guard isCodexPayload(json) else { return .asPosted }
        // Codex notify names its event in the body, whatever URL it was POSTed to.
        let key = json["type"] as? String == notifyTurnCompleteType
            ? "agentturncomplete"
            : event.lowercased().replacingOccurrences(of: "_", with: "").replacingOccurrences(of: "-", with: "")
        if let routed = routes[key] { return .codex(routed) }
        return .drop
    }

    /// One Codex event instance: event + thread + the field that tells two
    /// instances of that event apart. Nil when that field is missing — then
    /// the caller must not deduplicate.
    static func fingerprint(event: String, json: [String: Any]) -> String? {
        guard let thread = nonEmpty(json["session_id"]) ?? threadId(from: json) else { return nil }
        guard let discriminator = (fingerprintFields[event] ?? []).lazy.compactMap({ nonEmpty(json[$0]) }).first
        else { return nil }
        let key = "\\(event)|\\(stripCodexPrefix(thread))|\\(discriminator)"
        guard let contentFields = fingerprintContentFields[event] else { return key }
        let content = contentFields.lazy.compactMap { json[$0] as? String }.first { !$0.isEmpty } ?? ""
        return "\\(key)|\\(fnv1a32Utf16(content))"
    }

    /// FNV-1a (32-bit) over UTF-16 code units, 8 lowercase hex digits — the
    /// same units JavaScript's \`charCodeAt\` walks.
    static func fnv1a32Utf16(_ text: String) -> String {
        var hash: UInt32 = 0x811c9dc5
        for unit in text.utf16 {
            hash ^= UInt32(unit)
            hash = hash &* 0x01000193
        }
        let hex = String(hash, radix: 16)
        return String(repeating: "0", count: 8 - hex.count) + hex
    }
}
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Daemon/Session/CodexHookHarness.generated.swift', emitSwift],
];

async function main() {
  let mod;
  try {
    mod = await import(path.join(projectDir, 'shared/dist/hook-harness.js'));
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
    console.log(drifted ? 'hook harness mirror DRIFTED' : 'hook harness mirror in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
