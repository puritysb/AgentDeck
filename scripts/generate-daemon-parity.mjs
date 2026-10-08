#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const OUTPUT = 'apple/AgentDeck/Daemon/Core/DaemonParityRules.generated.swift';
export function emitSwift(rules) {
  const boundaries = Object.entries(rules.KIRO_TURN_BOUNDARIES)
    .map(([event, state]) => `        case "${event}": return "${state}"`).join('\n');
  const legacy = Object.entries(rules.KIRO_LEGACY_BOUNDARIES)
    .map(([event, state]) => `        case "${event}": return "${state}"`).join('\n');
  return `// GENERATED — DO NOT EDIT. Source: shared/src/daemon-parity.ts
// Regenerate: pnpm generate-daemon-parity; drift gate: daemon-parity.test.ts
import Foundation

enum DaemonParityRules {
    static let takeoverYieldMs = ${rules.DAEMON_TAKEOVER_YIELD_MS}
    static let kiroObservationWindowMs = ${rules.KIRO_OBSERVATION_WINDOW_MS}
    static func kiroLegacyTurnState(_ state: String, event: String, hasToolUse: Bool) -> String {
        if event == "AssistantMessage" { return hasToolUse ? "processing" : "idle" }
        switch event {
${legacy}
        default: return state
        }
    }
    static func acceptsDaemonRuntime(isSwift: Bool?, expectingNode: Bool) -> Bool {
        !expectingNode || isSwift != true
    }
    static func kiroTurnState(_ state: String, event: String) -> String {
        switch event {
${boundaries}
        default: return state
        }
    }
}
`;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rules = await import('../shared/dist/daemon-parity.js');
  const target = fileURLToPath(new URL('../' + OUTPUT, import.meta.url));
  const next = emitSwift(rules);
  if (process.argv.includes('--check')) {
    if (fs.readFileSync(target, 'utf8') !== next) throw new Error('Daemon parity mirror drifted');
  } else fs.writeFileSync(target, next);
}
