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
    static let recoverySchemaVersion = ${rules.DAEMON_RECOVERY_POLICY.schemaVersion}
    static let recoveryMaxConflicts = ${rules.DAEMON_RECOVERY_POLICY.maxConflicts}
    static let recoveryPreservedFiles = ${JSON.stringify(rules.DAEMON_RECOVERY_POLICY.preservedFiles)}
    static let recoveryVersion = ${rules.DAEMON_RECOVERY_POLICY.version}
    static let recoveryFile = ${JSON.stringify(rules.DAEMON_RECOVERY_POLICY.file)}
    static let recoveryFolderName = ${JSON.stringify(rules.DAEMON_RECOVERY_POLICY.folderName)}
    static let recoveryConsentFile = ${JSON.stringify(rules.DAEMON_RECOVERY_POLICY.consentFile)}
    static let recoveryCursorFile = ${JSON.stringify(rules.DAEMON_RECOVERY_POLICY.cursorFile)}
    static let recoveryBusyTimeoutMs = ${rules.DAEMON_RECOVERY_POLICY.busyTimeoutMs}
    static let recoveryMaxRevision = ${rules.DAEMON_RECOVERY_POLICY.maxRevision}
    static let recoverySchema = ${JSON.stringify(rules.DAEMON_RECOVERY_POLICY.schema)}
    static let configurationHandoverHeader = ${JSON.stringify(rules.DAEMON_CONFIGURATION_POLICY.handoverHeader.toLowerCase())}
    static let configurationMaxBodyBytes = ${rules.DAEMON_CONFIGURATION_POLICY.maxBodyBytes}
    static let configurationMaxCounter = ${rules.DAEMON_CONFIGURATION_POLICY.maxCounter}
    static let configurationVersion = ${rules.DAEMON_CONFIGURATION_POLICY.version}
    static let configurationSubscriptionId = ${JSON.stringify(rules.DAEMON_CONFIGURATION_POLICY.subscriptionId)}
    static let configurationMaxDevices = ${rules.DAEMON_CONFIGURATION_POLICY.maxDevices}
    static let configurationMaxNameChars = ${rules.DAEMON_CONFIGURATION_POLICY.maxNameChars}
    static let configurationMaxIdBytes = ${rules.DAEMON_CONFIGURATION_POLICY.maxIdBytes}
    static let configurationAnimations = ${JSON.stringify(rules.DAEMON_CONFIGURATION_POLICY.animations)}
    static let checkpointVersion = ${rules.DAEMON_CHECKPOINT_POLICY.version}
    static let checkpointSubscriptionId = ${JSON.stringify(rules.DAEMON_CHECKPOINT_POLICY.subscriptionId)}
    static let checkpointMaxBytes = ${rules.DAEMON_CHECKPOINT_POLICY.maxBytes}
    static let receiptLimit = ${rules.DAEMON_CHECKPOINT_POLICY.receiptLimit}
    static let checkpointAckMs = ${rules.DAEMON_CHECKPOINT_POLICY.ackTimeoutMs}
    static let checkpointPrepareLeaseMs = ${rules.DAEMON_CHECKPOINT_POLICY.prepareLeaseMs}
    static let checkpointMaxCounter = ${rules.DAEMON_CHECKPOINT_POLICY.maxCounter}
    static let receiptFields = ${JSON.stringify(rules.DAEMON_CHECKPOINT_POLICY.receiptFields)}
    static let receiptStatuses = ${JSON.stringify(rules.DAEMON_CHECKPOINT_POLICY.statuses)}
    static let takeoverYieldMs = ${rules.DAEMON_TAKEOVER_YIELD_MS}
    static let kiroObservationWindowMs = ${rules.KIRO_OBSERVATION_WINDOW_MS}
    static let defaultPortWindow = ${rules.DEFAULT_DAEMON_PORT_WINDOW[0]}...${rules.DEFAULT_DAEMON_PORT_WINDOW[1]}
    static func daemonPortWindow(_ raw: String?) -> ClosedRange<Int> {
        let whitespace = CharacterSet(charactersIn: String(String.UnicodeScalarView(
            ${JSON.stringify(rules.DAEMON_PORT_WINDOW_WHITESPACE)}.compactMap { UnicodeScalar($0) })))
        let text = (raw ?? "").trimmingCharacters(in: whitespace)
        let pieces = text.components(separatedBy: "-")
        guard pieces.count == 2 else { return defaultPortWindow }
        let values = pieces.map { $0.trimmingCharacters(in: whitespace) }
        guard values.allSatisfy({ (4...5).contains($0.utf8.count) && $0.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) }),
              let lo = Int(values[0]), let hi = Int(values[1]),
              lo >= ${rules.DAEMON_PORT_WINDOW_LIMITS.min}, hi <= ${rules.DAEMON_PORT_WINDOW_LIMITS.max}, lo <= hi else { return defaultPortWindow }
        return lo...hi
    }
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
