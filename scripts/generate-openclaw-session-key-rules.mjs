#!/usr/bin/env node
// Generate the Swift mirror of the OpenClaw steering-key rule:
//   shared/src/openclaw-session-key.ts
//     → apple/AgentDeck/Daemon/Gateway/OpenClawSessionKeyRules.generated.swift
//
//   pnpm generate-openclaw-session-key-rules            regenerate the mirror
//   pnpm generate-openclaw-session-key-rules --check    exit 1 if it drifted
//
// Requires shared to be built first (`pnpm build`). The vitest sync test
// (shared/src/__tests__/openclaw-session-key-sync.test.ts) imports the emitter
// against the TS source, so drift is caught in CI even when this CLI is never
// run. Behaviour is pinned by shared/openclaw-session-key-vectors.json, which
// both suites replay.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function raw(value) {
  if (value.includes('"#')) throw new Error(`cannot embed ${value} in a raw Swift string`);
  return `#"${value}"#`;
}

export function rulesFrom(mod) {
  return { patterns: mod.OPENCLAW_CONVERSATION_KEY_PATTERNS };
}

export function emitSwift(rules) {
  return `// GENERATED FILE — DO NOT EDIT.
// Source of truth: shared/src/openclaw-session-key.ts
// Regenerate: pnpm generate-openclaw-session-key-rules (drift gated by shared/src/__tests__/openclaw-session-key-sync.test.ts)
import Foundation

/// Which OpenClaw Gateway session a device's prompt, stop or setting targets.
/// The activity key (whatever spoke last) still drives state; only a key with
/// a conversation shape becomes the steering key, so a cron tick, heartbeat or
/// eval run never captures the deck's next prompt. Behaviour is pinned by
/// \`shared/openclaw-session-key-vectors.json\` (\`OpenClawSessionKeyRulesTests\`).
enum OpenClawSessionKeyRules {
    static let conversationKeyPatterns: [String] = [
${rules.patterns.map((p) => `        ${raw(p)},`).join('\n')}
    ]

    private static let conversationRegexes: [NSRegularExpression] =
        conversationKeyPatterns.map { try! NSRegularExpression(pattern: $0) }

    static func isConversationKey(_ key: String?) -> Bool {
        guard let key, !key.isEmpty else { return false }
        let range = NSRange(key.startIndex..., in: key)
        return conversationRegexes.contains { $0.firstMatch(in: key, range: range) != nil }
    }

    /// The steering key from a \`sessions.list\` answer (newest first): the
    /// newest conversation key, else the newest key (previous behaviour).
    static func pickSteeringKey(_ keysNewestFirst: [String]) -> String? {
        keysNewestFirst.first(where: { isConversationKey($0) }) ?? keysNewestFirst.first
    }

    /// The steering key after an event names \`eventKey\`: a conversation key
    /// takes over; a background key only fills an empty slot.
    static func nextSteeringKey(current: String?, eventKey: String?) -> String? {
        guard let eventKey, !eventKey.isEmpty else { return current }
        if isConversationKey(eventKey) { return eventKey }
        return current ?? eventKey
    }
}
`;
}

export const OUTPUTS = [
  ['apple/AgentDeck/Daemon/Gateway/OpenClawSessionKeyRules.generated.swift', emitSwift],
];

async function main() {
  let mod;
  try {
    mod = await import(path.join(projectDir, 'shared/dist/openclaw-session-key.js'));
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
      if (prev !== next) { console.error(`DRIFT: ${rel}`); drifted = true; }
    } else if (prev !== next) {
      fs.writeFileSync(abs, next);
      console.log(`wrote ${rel}`);
    } else {
      console.log(`up-to-date ${rel}`);
    }
  }
  if (check) {
    console.log(drifted ? 'openclaw session-key rules mirror DRIFTED' : 'openclaw session-key rules mirror in sync');
    process.exit(drifted ? 1 : 0);
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
